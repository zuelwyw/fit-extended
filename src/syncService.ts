/**
 * 同步服务：六类规则 + 人工审阅共用的唯一流程。
 *
 * 流程固定为：检查（扫描两端 + 规则上下文）→ 计划 → 审阅（勾选/决策）→ 执行 → 逐项结果。
 * 界面层只传"模式、方向、勾选集合、决策"，不在这里之外再算一套规则。
 *
 * 这里同时是"真实两端"的适配层：把 LocalVault / RemoteGitHubVault 包成扫描器，
 * 把执行端口接到具体读写上。计划生成与执行逻辑本身分别在各纯模块里。
 */

import { App } from "obsidian";
import { Fit } from "./fit";
import { fitLogger } from "./logger";
import { CommonState, fromLegacyLocalStore, CommonStateSnapshot } from "./commonState";
import { ScopeContext } from "./scopeContext";
import { RuleKind, SyncDirection, SyncPlan, SyncIdentity } from "./syncTypes";
import { scanAndPlan, SideScanner, SideSnapshot, buildPorts } from "./syncScanner";
import { executePlan, ExecutionReport, applyOutcomesToCommonState, adoptInitialCommonState } from "./syncExecutor";
import { BlobSha, CommitSha } from "./util/hashing";
import * as Encryption from "./encryption";
import { LocalVault } from "./localVault";
import { digestFileContent } from "./util/contentDigest";
import { gitBlobHash } from "./util/gitObjectHash";
import { contentToArrayBuffer } from "./util/obsidianHelpers";
import { ReviewDecision } from "./planReviewModal";

/** 一次同步的状态载体：共同状态 + 上次扫描缓存，分开保存。 */
/** 共享规则探测的并发上限：只读 stat，不涉及网络。 */
const METADATA_PROBE_CONCURRENCY = 8;
/** 本地文件读取/哈希的并发上限：Obsidian 的 adapter 读取是异步 I/O。 */
const LOCAL_SCAN_CONCURRENCY = 8;

/** 有界并发地跑一组异步任务（顺序无关时使用）。 */
async function mapLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let index = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const current = index++;
			if (current >= items.length) return;
			await run(items[current]);
		}
	});
	await Promise.all(workers);
}

/** 远端发布看门狗：超过这个时间没返回就标为结果待确认，不假装成功或失败。 */
export const PUBLISH_WATCHDOG_MS = 120_000;

export type SyncStateStore = {
	commonState?: Partial<CommonStateSnapshot> | null;
	/** 旧字段：仅作迁移来源，不再作为一致性依据 */
	localSha?: Record<string, string>;
	lastFetchedRemoteSha?: Record<string, string>;
	lastFetchedCommitSha?: CommitSha | null;
};

export type PersistState = (update: {
	commonState: CommonStateSnapshot;
	localSha: Record<string, BlobSha>;
	lastFetchedRemoteSha: Record<string, BlobSha>;
}) => Promise<void>;

export class SyncService {
	constructor(
		private readonly fit: Fit,
		private readonly persist: PersistState,
		private readonly app?: App
	) {}

	private identity(): SyncIdentity {
		return {
			owner: this.fit.remoteVault.getOwner(),
			repo: this.fit.remoteVault.getRepo(),
			branch: this.fit.remoteVault.getBranch()
		};
	}

	/**
	 * 读取规则上下文。
	 *
	 * 只编辑共享 .gitignore；本机排除与全局规则若能读到就只读参与匹配。
	 * 移动端没有系统 Git，读不到就明确标为不可访问，不用插件缓存冒充。
	 */
	async scopeContext(overrides: {
		sharedIgnoreContent?: string;
		/** 候选路径：让子目录 .gitignore 按需读取（不传则嵌套规则不可达） */
		candidatePaths?: readonly string[];
	} = {}): Promise<ScopeContext> {
		const adapter = this.fit.localVault.vault.adapter;
		const input: Parameters<typeof ScopeContext.create>[1] = {};
		if (overrides.sharedIgnoreContent !== undefined) input.sharedIgnoreContent = overrides.sharedIgnoreContent;
		if (overrides.candidatePaths) input.candidatePaths = overrides.candidatePaths;
		// 共享控制元数据（.gitignore/.gitattributes）需要被读写比较：
		// Obsidian 索引看不到隐藏文件，只有显式开启才能经 adapter 读到真实内容。
		input.includeSharedControlMetadata = true;

		// 个人全局忽略规则通常位于知识库之外，插件运行环境读不到；
		// 只有显式注入（桌面端由上层读取）才参与匹配。
		return ScopeContext.create(adapter, input);
	}

	/**
	 * 用旧版插件的两份缓存还原"上次同步基线"，只用于判断哪一侧改过。
	 *
	 * 之所以不把它当共同状态：缓存里的本地 SHA 与远端 blob OID 算法不同，
	 * 不能互相比较，也不能证明"两端相同"。这里只取同一算法在时间上的前后值。
	 */
	private legacyBaselineOf(store: SyncStateStore): Map<string, { localSha?: string; remoteSha?: string }> | undefined {
		const local = store.localSha;
		const remote = store.lastFetchedRemoteSha;
		if (!local && !remote) return undefined;
		const map = new Map<string, { localSha?: string; remoteSha?: string }>();
		for (const [path, sha] of Object.entries(local ?? {})) {
			if (typeof sha === "string") map.set(path, { ...(map.get(path) ?? {}), localSha: sha });
		}
		for (const [path, sha] of Object.entries(remote ?? {})) {
			if (typeof sha === "string") map.set(path, { ...(map.get(path) ?? {}), remoteSha: sha });
		}
		return map.size > 0 ? map : undefined;
	}

	private commonStateFor(identity: SyncIdentity, store: SyncStateStore): CommonState {
		if (store.commonState) {
			const state = CommonState.create(identity, store.commonState);
			// 旧双份缓存不得冒充共同状态：仅在没有任何记录时提示丢弃
			if (state.size === 0 && !state.established && (store.localSha || store.lastFetchedRemoteSha)) {
				const { droppedPaths } = fromLegacyLocalStore(
					{ localSha: store.localSha, lastFetchedRemoteSha: store.lastFetchedRemoteSha },
					identity
				);
				if (droppedPaths.length > 0) {
					fitLogger.log("[SyncService] 旧缓存不采纳为共同状态，按未知处理", { paths: droppedPaths.length });
				}
			}
			return state;
		}
		// 从未写过新格式：旧缓存一律不采纳
		return CommonState.create(identity, fromLegacyLocalStore(
			{ localSha: store.localSha, lastFetchedRemoteSha: store.lastFetchedRemoteSha },
			identity
		).snapshot);
	}

	/**
	 * 本地扫描器：候选路径不做忽略过滤，交给 ScopeContext 统一判定。
	 * 路径集合与状态来自同一次枚举 + 同一批计算，天然一致。
	 */
	private localScanner(onProgress?: (stage: string, completed: number, total: number) => void): SideScanner & { snapshotState(): Promise<Record<string, BlobSha>> } {
		const vault = this.fit.localVault.vault;
		let cached: Promise<SideSnapshot> | null = null;
		const build = async (): Promise<SideSnapshot> => {
			// 与生产 LocalVault.readFromSource 保持一致：直接使用 getFiles() 的结果。
			// 这里若额外用 `instanceof TFile` 过滤，遇到子类/代理对象会把真实文件丢掉，
			// 而丢掉的路径既不在 state 也不在 paths，等价于"确认不存在"——很危险。
			const files = vault.getFiles();
			const indexedPaths = files.map(file => file.path);
			// 共享控制元数据（.gitignore/.gitattributes）是隐藏文件，Obsidian 索引看不到，
			// 但它们是"唯一的忽略规则来源"，必须按 P1.5 经 adapter 真实枚举进快照。
			// 候选目录必须取**两端**路径的祖先：远端独有目录里的本地规则同样要参与，
			// 否则镜像会把它们当成"来源没有"而删掉远端副本（M2）。
			const control = await this.enumerateSharedControlMetadata(await this.candidateDirsForMetadata());
			const controlPaths = control.found;
			const allPaths = Array.from(new Set([...indexedPaths, ...controlPaths]));

			const state: Record<string, BlobSha> = {};
			// 未加密时同一次读取里顺手算 Git blob OID：计划阶段判定"是否与远端 blob 相同"
			// 就不必再读一遍文件（之前每个文件被读两次）。
			const wantBlobOid = !Encryption.isEnabled();
			const gitBlobShas: Record<string, BlobSha> = {};
			// stat 失败但内容可能存在的规则文件，直接计入不可读。
			const unreadable: Array<{ path: string; error: string }> = [...control.unreadable];
			let done = 0;
			onProgress?.("读取本地文件", 0, allPaths.length);
			await mapLimited(allPaths, LOCAL_SCAN_CONCURRENCY, async path => {
				try {
					const content = await this.fit.localVault.readFileContent(path);
					state[path] = await LocalVault.fileSha1(path, content);
					if (wantBlobOid) {
						try {
							gitBlobShas[path] = await gitBlobHash(contentToArrayBuffer(content.toBase64()));
						} catch {
							// 算不出来只是少一条快速路径，不影响正确性。
						}
					}
				} catch (error) {
					// 读失败必须上报，不能静默丢键——否则 planner 会把"读不到"当成"不存在"，
					// 镜像据此删掉远端实际存在的同名文件。
					const message = error instanceof Error ? error.message : String(error);
					unreadable.push({ path, error: message });
					fitLogger.log(`[SyncService] 本地读取失败（按不可读处理，不参与写删）: ${path}`, error);
				}
				done++;
				if (done % 25 === 0 || done === allPaths.length) {
					onProgress?.("读取本地文件", done, allPaths.length);
				}
			});
			return { paths: allPaths, state, unreadable, ...(wantBlobOid ? { gitBlobShas } : {}) };
		};
		return {
			snapshot: async () => {
				if (!cached) cached = build();
				return cached;
			},
			snapshotState: async () => (await (cached ?? (cached = build()))).state,
			isReadable: (path: string) => this.fit.localVault.shouldTrackState(path),
			read: async (path: string) => this.fit.localVault.readFileContent(path)
		};
	}

	/**
	 * 经 adapter 枚举共享控制元数据文件。
	 *
	 * 这些文件是隐藏文件，不在 Obsidian 索引里，但它们是 Git 忽略规则的唯一共享来源
	 * （需求 §5）。只探测根目录与候选路径涉及的目录，不做全库遍历；
	 * 私有排除（.git/info/exclude）与 Obsidian 内部目录不在其中，仍不可同步。
	 */
	/**
	 * 共享规则枚举用的候选路径：本地索引 + 远端当前快照。
	 *
	 * 与计划使用同一份远端读取结果（`readFromSource`），不再二次拉取，
	 * 避免路径集合与状态来自不同快照。
	 */
	private async candidateDirsForMetadata(): Promise<string[]> {
		const localPaths = this.fit.localVault.vault.getFiles().map(file => file.path);
		let remotePaths: string[] = [];
		try {
			remotePaths = Object.keys((await this.fit.remoteVault.readFromSource(true)).state);
		} catch (error) {
			// 远端读不到时只用本地路径：不阻断，但也不会凭空多枚举目录。
			fitLogger.log('[SyncService] 共享规则枚举时无法读取远端路径，仅使用本地路径', error);
		}
		return Array.from(new Set([...localPaths, ...remotePaths]));
	}

	private async enumerateSharedControlMetadata(
		candidatePaths: string[]
	): Promise<{ found: string[]; unreadable: Array<{ path: string; error: string }> }> {
		const adapter = this.fit.localVault.vault.adapter;
		const dirs = new Set<string>(['']);
		for (const path of candidatePaths) {
			const segments = path.split('/');
			for (let i = 1; i < segments.length; i++) {
				dirs.add(segments.slice(0, i).join('/'));
			}
		}
		const found: string[] = [];
		const unreadable: Array<{ path: string; error: string }> = [];
		const candidates: string[] = [];
		for (const dir of Array.from(dirs).sort()) {
			// 只探测 .gitignore：需求里"共享规则文件"指的是它。
			// .gitattributes 不是忽略规则，也不在需求范围内，探它等于每个目录多一次 stat。
			for (const name of ['.gitignore']) {
				candidates.push(dir === '' ? name : `${dir}/${name}`);
			}
		}
		// 串行 stat 在目录多的库上会明显拖慢"检查"这一段：并发探测，结果顺序不影响语义。
		await mapLimited(candidates, METADATA_PROBE_CONCURRENCY, async path => {
			try {
				const stat = await adapter.stat(path);
				if (stat && stat.type === 'file') found.push(path);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// stat 失败 ≠ 不存在：必须上报为不可读，否则会被当成"来源没有该文件"，
				// 镜像据此删掉远端真实存在的共享规则（M1）。
				if (isNotFoundError(message)) return; // ENOENT：确认不存在，属未配置
				unreadable.push({ path, error: message });
				fitLogger.log(`[SyncService] 共享规则文件 stat 失败，按不可读处理: ${path}`, error);
			}
		});
		return { found, unreadable };
	}

	/**
	 * 远端扫描器：一次 readFromSource 同时提供路径集合与状态，二者同源。
	 * 绝不再分别调用两次（否则跨分支变化时会拼出混合快照）。
	 */
	private remoteScanner(): SideScanner {
		return {
			snapshot: async () => {
				const read = await this.fit.remoteVault.readFromSource(true);
				return { paths: Object.keys(read.state), state: read.state };
			},
			isReadable: () => true,
			read: async (path: string) => this.fit.remoteVault.readFileContent(path)
		};
	}

	/**
	 * 检查并生成计划（零副作用：不写文件、不发布提交）。
	 */
	async plan(
		rule: RuleKind,
		direction?: SyncDirection,
		store: SyncStateStore = {},
		onProgress?: (stage: string, completed: number, total: number) => void
	): Promise<SyncPlan> {
		const identity = this.identity();
		const commonState = this.commonStateFor(identity, store);
		const local = this.localScanner(onProgress);
		const remote = this.remoteScanner();
		// 候选路径必须是**两端**路径的并集：
		// 只有远端存在的目录，其共享 .gitignore 同样是本机要遵守的规则；
		// 只给本地索引会漏掉这些目录的规则，导致本该被忽略的远端文件被上传/删除。
		onProgress?.("读取远端状态", 0, 1);
		const [localSnapshotForScope, remoteSnapshotForScope] = await Promise.all([
			local.snapshot(),
			remote.snapshot()
		]);
		onProgress?.("读取远端状态", 1, 1);
		onProgress?.("解析忽略规则", 0, 1);
		const candidatePaths = Array.from(new Set([
			...localSnapshotForScope.paths,
			...remoteSnapshotForScope.paths
		]));
		const scope = await this.scopeContext({ candidatePaths });
		// 规则不完整（有目录规则读失败）时不得继续规划：否则会把"被忽略"当"参与同步"。
		scope.assertComplete();
		onProgress?.("解析忽略规则", 1, 1);

		// D1 快速路径仅在**未加密**时启用：加密用户远端 blob 是密文，
		// 明文字节的 Git 对象 hash 与密文 OID 必然不等，绝不能参与比较。
		// 加密时缺省该函数 → planner 自动回退逐文件摘要比较（安全回退）。
		const encryptionEnabled = Encryption.isEnabled();
		const blobShas = localSnapshotForScope.gitBlobShas;
		const localGitBlobHash = encryptionEnabled || !blobShas ? undefined : async (path: string, remoteBlobSha: BlobSha) =>
			blobShas[path] === remoteBlobSha;

		const { plan } = await scanAndPlan({
			rule,
			direction,
			identity,
			local,
			remote,
			scope,
			commonState,
			localGitBlobHash,
			legacyBaseline: this.legacyBaselineOf(store),
			onProgress,
			remoteHead: async () => {
				const read = await this.fit.remoteVault.readFromSource(true);
				return { commitSha: read.commitSha, state: read.state };
			}
		});

		// D2：检查本身零副作用（不写文件、不建提交），但**已核验的共同状态可以落盘**：
		// 计划无任何操作且无未决冲突时，扫描结论（adoptable 的 digest + blob OID 绑定、
		// confirmedAbsent）全部来自本次两端快照的直接证据，持久化它们不会改变任何用户
		// 文件，却能避免下一次检查重复全量内容比较。有操作或有未决冲突时不采纳——
		// 那些路径没有确定结论，必须走审阅流程后再由 execute 推进。
		if (plan.operations.length === 0 && plan.conflicts.length === 0) {
			try {
				adoptInitialCommonState(commonState, plan);
				await this.persist({
					commonState: commonState.toJSON(),
					localSha: localSnapshotForScope.state,
					lastFetchedRemoteSha: remoteSnapshotForScope.state
				});
				fitLogger.log("[SyncService] 检查无变化：已保存核验的共同状态", {
					adopted: plan.adoptable.length,
					confirmedAbsent: plan.confirmedAbsent.length
				});
			} catch (error) {
				// 保存失败只影响下次检查的快速路径，不影响本次结论：如实记录，不中断。
				fitLogger.log("[SyncService] 无变化检查的状态保存失败（不影响本次结果）", error);
			}
		}
		return plan;
	}

	/**
	 * 重验扫描阶段的可采纳结论。
	 *
	 * 只保留"此刻两端仍存在且内容一致"的路径；任何一条不再成立都退回未取得结论，
	 * 避免把执行前的旧扫描结果当成事实写进共同状态。
	 */
	private async revalidateAdoptable(plan: SyncPlan): Promise<{
		adoptable: SyncPlan["adoptable"];
		changed: string[];
	}> {
		const adoptable: SyncPlan["adoptable"] = [];
		const changed: string[] = [];
		const localNow = await this.localScanner().snapshotState();
		const remoteNow = await this.fit.remoteVault.readFromSource(true);
		for (const entry of plan.adoptable) {
			if (!(entry.path in localNow) || !(entry.path in remoteNow.state)) {
				changed.push(entry.path);
				continue;
			}
			try {
				const [localContent, remoteContent] = await Promise.all([
					this.fit.localVault.readFileContent(entry.path),
					this.fit.remoteVault.readFileContent(entry.path)
				]);
				const [localDigest, remoteDigest] = await Promise.all([
					digestFileContent(localContent),
					digestFileContent(remoteContent)
				]);
				if (localDigest === remoteDigest) {
					// 必须保存"刚刚验证过的摘要"，而不是旧扫描结果：
					// 若预览后双方都变成同一个新内容，旧 digest 已不成立，
					// 存旧值会让下一次扫描把当前内容误判为"被改动"。
					adoptable.push({ ...entry, digest: localDigest });
				} else {
					changed.push(entry.path);
				}
			} catch (error) {
				fitLogger.log(`[SyncService] 重验可采纳路径失败，按未确认处理: ${entry.path}`, error);
				changed.push(entry.path);
			}
		}
		return { adoptable, changed };
	}

	/**
	 * 核对哪些"写成功"的路径确实两端内容一致。
	 *
	 * 只有两端都存在、且同一口径摘要相等，才算确认一致。
	 * 读不到内容（例如远端树未包含该路径）一律不算确认。
	 */
	/**
	 * 确认"写入后两端确实一致"。
	 *
	 * 不再逐文件回读两端内容：
	 * - 远端：条件提交被服务端接受后，该提交里的 blob 就是本地发出去的字节
	 *   （Git 内容寻址），再读一遍只是重复请求；
	 * - 本地：写入结果由 applyChanges 逐项返回，失败项已记为 failed。
	 *
	 * 因此这里只要求：刷新后的两端快照里都还有该路径，且我们手上有写入内容的摘要。
	 * 任一条不满足就不推进共同状态。
	 */
	private async confirmSamePaths(
		report: ExecutionReport,
		localAfter: Record<string, BlobSha>,
		remoteAfter: Record<string, BlobSha>
	): Promise<string[]> {
		const confirmed: string[] = [];
		for (const item of report.succeeded) {
			if (item.kind !== "write-local" && item.kind !== "write-remote") continue;
			if (!item.digest) continue;
			if (!(item.path in localAfter) || !(item.path in remoteAfter)) continue;
			confirmed.push(item.path);
		}
		return confirmed;
	}

	/**
	 * 执行选中的操作，并只推进实际成功项的共同状态。
	 *
	 * 冲突决策为"本地/远端"时，会转成对应的写/删动作；手工草稿在当前轻量实现里
	 * 不直接写文件（避免把未校验文本覆盖进笔记），而是明确记为需人工处理。
	 */
	async execute(
		plan: SyncPlan,
		selected: string[],
		decisions: Record<string, ReviewDecision>,
		store: SyncStateStore = {},
		onProgress?: (stage: string, completed: number, total: number) => void,
		/** 用户中止信号 */
		signal?: AbortSignal
	): Promise<ExecutionReport> {
		const identity = this.identity();
		const commonState = this.commonStateFor(identity, store);
		const localPathsNow = this.fit.localVault.vault.getFiles().map(file => file.path);
		const remotePathsNow = Object.keys((await this.fit.remoteVault.readFromSource(true)).state);
		const candidateNow = Array.from(new Set([...localPathsNow, ...remotePathsNow]));
		const scope = await this.scopeContext({ candidatePaths: candidateNow });
		// 执行前同样要求规则完整：不完整就整次拒绝，不按残缺规则写删。
		scope.assertComplete();

		// 冲突决策转成动作：采用本地 → 写远端；采用远端 → 写本地
		const decisionOps = buildDecisionOperations(plan, decisions);
		const allOps = [...plan.operations, ...decisionOps];
		const effectivePlan: SyncPlan = {
			...plan,
			operations: allOps,
			counts: plan.counts
		};

		const selectedSet = new Set([...selected, ...decisionOps.map(op => op.id)]);

		// 同一次执行内复用扫描器：否则执行前复核、发布前读内容、收尾核对会各自
		// 触发一次全库重扫（大库上是数量级的性能差异）。
		const localScanner = this.localScanner();
		const ports = buildPorts({
			identity: () => this.identity(),
			localHead: async () => localScanner.snapshotState(),
			// 单条本地路径的即时状态：直接查 Vault，不复用扫描缓存。
			localPathState: async (path) => {
				const abstract = this.fit.localVault.vault.getAbstractFileByPath(path);
				try {
					const content = await this.fit.localVault.readFileContent(path);
					const sha = await LocalVault.fileSha1(path, content);
					return { present: Boolean(abstract) || true, sha };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					// 读失败与"不存在"必须区分：不存在的读取会报找不到文件。
					if (/not found|ENOENT|does not exist/i.test(message)) return { present: false };
					throw error;
				}
			},
			remoteHead: async () => (await this.fit.remoteVault.readFromSource(true)).commitSha,
			remoteHeadState: async () => (await this.fit.remoteVault.readFromSource(true)).state,
			rulesFingerprint: async () => {
				// 复核规则是否变化时只需要计划里涉及的目录：规则若变了，指纹必然变。
				// 这里不再重新枚举本地全库、也不额外拉一次远端树（那是白花一次请求）。
				const fresh = await this.scopeContext({
					candidatePaths: Array.from(new Set([
						...Object.keys(plan.localState),
						...Object.keys(plan.remoteState)
					]))
				});
				fresh.assertComplete();
				return fresh.fingerprint();
			},
			readLocal: async (path) => this.fit.localVault.readFileContent(path),
			readRemote: async (path) => this.fit.remoteVault.readFileContent(path),
			writeLocal: async (path, content) => {
				// builder 已保证 content 一定是 FileContent（手工结果由执行器构造）。
				await this.fit.localVault.applyChanges([{ path, content }], []);
			},
			deleteLocal: async (path) => {
				await this.fit.localVault.applyChanges([], [path]);
			},
			publish: async (actions) => {
				// builder 已把手工结果折进 content：这里不再有第二套内容通道。
				// 发布是唯一可能长时间无响应的写请求：给它一个看门狗。
				// 超时不谎报成功也不谎报失败，明确标成"结果待确认"。
				let timer: ReturnType<typeof setTimeout> | undefined;
				const outcome = await Promise.race([
					this.fit.remoteVault.publishConditional(
						actions.additions,
						actions.deletions,
						plan.remoteCommitSha,
						{ headline: `Sync from ${new Date().toLocaleString()}（${describeRuleShort(plan.rule)}）` }
					),
					new Promise<null>(resolve => {
						timer = setTimeout(() => resolve(null), PUBLISH_WATCHDOG_MS);
					})
				]);
				if (timer) clearTimeout(timer);
				if (outcome === null) {
					return {
						status: "uncertain",
						detail: `远端发布超过 ${Math.round(PUBLISH_WATCHDOG_MS / 1000)} 秒未返回。请求可能仍在进行：请先在 GitHub 上确认是否已产生提交，不要直接重试。`
					};
				}
				if (outcome.status === "committed") {
					return {
						status: "committed",
						commitSha: outcome.commitSha,
						committedPaths: [...actions.additions.map(a => a.path), ...actions.deletions]
					};
				}
				if (outcome.status === "head-changed") return { status: "head-changed" };
				if (outcome.status === "unavailable") return { status: "failed", error: outcome.reason };
				return { status: "uncertain", detail: "发布结果未确认" };
			},
			onProgress
		});

		onProgress?.("准备执行", 0, 1);
		const report = await executePlan(effectivePlan, { selected: selectedSet, rule: plan.rule, signal }, ports);

		// 计划里可确认的同内容路径 + 本次成功项，一起推进共同状态。
		// 收尾（重扫、核对、持久化）整体包在 try 里：这些步骤失败只影响"状态是否记住"，
		// 不能把已经取得的逐项结果丢掉。
		if (!report.rejected) {
			// 收尾不再做"核对结果"：不重扫本地、不重读远端树、不回读任何文件。
			// 与原版 FIT 一致——写入接口成功 + 写入时的内容摘要即可作为新状态，
			// 回读只增加请求数，不能提供额外保证。
			const bothAbsent = computeBothAbsentFromPlan(effectivePlan, report, decisionOps);
			const confirmedSame = report.succeeded
				.filter(item => (item.kind === "write-local" || item.kind === "write-remote") && item.digest)
				.map(item => item.path);

			const uncertain = collectUncertainPaths(effectivePlan, report, decisions);
			// 扫描阶段得到的"两端一致"结论不再在这里采纳：那是预览时的快照，
			// 执行期间可能已变化。零变化的检查会在 plan() 里采纳，那里没有时间差。
			adoptInitialCommonState(
				commonState, plan, uncertain,
				"本次未取得确定结论（失败/待确认/冲突未决）",
				report.skipped,
				false
			);
			const { advanced, withheld } = applyOutcomesToCommonState(commonState, report, bothAbsent, confirmedSame);

			// 基线只随真正同步成功的路径变化：这些路径从旧缓存里移除，
			// 下次检查以共同状态为准（缓存再留着反而会误导"哪一侧改过"）。
			const advancedPaths = new Set([...advanced, ...bothAbsent]);
			const nextLocalSha = { ...(store.localSha ?? {}) } as Record<string, BlobSha>;
			const nextRemoteSha = { ...(store.lastFetchedRemoteSha ?? {}) } as Record<string, BlobSha>;
			for (const path of advancedPaths) {
				delete nextLocalSha[path];
				delete nextRemoteSha[path];
			}

			let persistError: string | undefined;
			try {
				await this.persist({
					commonState: commonState.toJSON(),
					localSha: nextLocalSha,
					lastFetchedRemoteSha: nextRemoteSha
				});
			} catch (error) {
				persistError = error instanceof Error ? error.message : String(error);
				fitLogger.log("[SyncService] 状态保存失败：已完成的操作结果仍然有效", { error: persistError });
			}
			fitLogger.log("[SyncService] 执行完成", {
				advanced: advanced.length,
				withheld: withheld.length,
				rejected: false,
				mirrorComplete: report.mirrorComplete,
				...(persistError ? { persistError } : {})
			});
			if (persistError) return { ...report, persistError };
		}
		return report;
	}
}

/**
 * 本轮没有取得确定结论的路径。
 *
 * 包括：未选中的操作、失败/待确认的操作、以及仍未决策的冲突。
 * 这些路径在共同状态里必须保持 unknown，不得被解释为"此前不存在"。
 */
export function collectUncertainPaths(
	plan: SyncPlan,
	report: ExecutionReport,
	decisions: Record<string, ReviewDecision>
): string[] {
	const uncertain = new Set<string>();
	for (const item of report.items) {
		if (item.outcome.status !== "succeeded") uncertain.add(item.path);
	}
	// 未选项也进入 uncertain：adoptInitialCommonState 会再判断它是否已有合法历史，
	// 有历史则保留旧 base，初始未知则持久 unknown。不能在这里直接丢弃，
	// 否则"从未确认过的未选项"会被下游推断成 absent。
	for (const path of report.skipped) uncertain.add(path);
	for (const conflict of plan.conflicts) {
		if (!decisions[conflict.path]) uncertain.add(conflict.path);
	}
	return Array.from(uncertain);
}

/** 冲突决策 → 具体写操作。 */
export function buildDecisionOperations(plan: SyncPlan, decisions: Record<string, ReviewDecision>) {
	const ops: SyncPlan["operations"] = [];
	for (const conflict of plan.conflicts) {
		const decision = decisions[conflict.path];
		if (!decision) continue;
		if (decision.action === "local") {
			// 采用本地内容 → 覆盖远端
			if (conflict.local?.present) ops.push({ id: `write-remote:${conflict.path}`, kind: "write-remote", path: conflict.path, reason: "update" });
			else ops.push({ id: `delete-remote:${conflict.path}`, kind: "delete-remote", path: conflict.path });
		} else if (decision.action === "remote") {
			if (conflict.remote?.present) ops.push({ id: `write-local:${conflict.path}`, kind: "write-local", path: conflict.path, reason: "update" });
			else ops.push({ id: `delete-local:${conflict.path}`, kind: "delete-local", path: conflict.path });
		} else if (decision.action === "manual" && conflict.binary) {
			// 二进制不得冒充文本合并：逻辑层同样拒绝，避免绕过界面直接伪造手工结果。
			fitLogger.log(`[SyncService] 拒绝二进制手工文本合并: ${conflict.path}`);
		} else if (decision.action === "manual") {
			// 手工结果是用户确认的最终内容，必须真正写入：
			// - 双向规则：最终状态是"两端都等于该内容"，因此两端都写；
			// - 单向规则：只写目标端，绝不反向改写来源端。
			const text = decision.manualText;
			const bidirectional = plan.rule === "merge-no-delete" || plan.rule === "two-way-delete";
			const writeRemote = bidirectional || plan.direction === "upload";
			const writeLocal = bidirectional || plan.direction === "pull";
			// reason 必须反映"预览时该端是否存在"：存在=update（校验 SHA），
			// 不存在=add（校验此刻仍不存在）。用固定的 update 会让"预览后新建同名文件"
			// 被当成更新而覆盖掉用户刚创建的内容。
			if (writeRemote) {
				ops.push({
					id: `write-remote:${conflict.path}`, kind: "write-remote", path: conflict.path,
					reason: conflict.remote?.present ? "update" : "add", manualText: text
				});
			}
			if (writeLocal) {
				ops.push({
					id: `write-local:${conflict.path}`, kind: "write-local", path: conflict.path,
					reason: conflict.local?.present ? "update" : "add", manualText: text
				});
			}
		}
	}
	return ops;
}

/**
 * 删除后两端都不存在、可确认共同删除的路径。
 *
 * 不再回读两端：用**计划里的快照**判断另一端本来就不存在。删掉这一侧后
 * 两端都不存在即成立——回读一次远端树只能确认同一个事实，代价是一次请求。
 */
function computeBothAbsentFromPlan(
	plan: SyncPlan,
	report: ExecutionReport,
	decisionOps: SyncPlan["operations"]
): string[] {
	const deleted = [...plan.operations, ...decisionOps].filter(
		op => op.kind === "delete-local" || op.kind === "delete-remote"
	);
	const succeededDeletes = new Set(
		report.succeeded.filter(item => item.kind === "delete-local" || item.kind === "delete-remote").map(item => item.path)
	);
	return deleted
		.map(op => op.path)
		.filter(path => succeededDeletes.has(path))
		// 另一端在计划快照里本来就没有这个路径，删掉这一侧即"双方都不存在"。
		.filter(path => !(path in plan.localState) || !(path in plan.remoteState));
}

function describeRuleShort(rule: RuleKind): string {
	switch (rule) {
		case "add-missing": return "补缺";
		case "update-one-way": return "单向更新";
		case "overwrite": return "单向覆盖";
		case "mirror": return "镜像";
		case "merge-no-delete": return "合并";
		case "two-way-delete": return "双向";
	}
}

/**
 * 判断 stat/读取错误是否表示"确认不存在"。
 *
 * 只有明确的 not found / ENOENT 才算；EACCES、EIO 等属于"读不到但可能存在"，
 * 必须按不可读处理，不能当成缺失（否则镜像会误删远端同名文件）。
 */
export function isNotFoundError(message: string): boolean {
	return /ENOENT|no such file|not found|does not exist/i.test(message);
}
