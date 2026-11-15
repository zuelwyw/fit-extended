/**
 * 计划扫描器：把"真实两端"包装成计划生成器要的快照与内容读取器。
 *
 * 之所以单独一层：
 * - 计划生成必须是纯函数（generatePlan），不能自己去碰网络或磁盘；
 * - 扫描（含范围判定、忽略规则、共同状态）是有副作用的边界，集中在这里；
 * - 执行器通过 ports 注入，测试可直接替换，不需要真实 Obsidian 或 GitHub。
 */

import { FileContent } from "./util/contentEncoding";
import { digestFileContent, ContentDigest } from "./util/contentDigest";
import { BlobSha, CommitSha } from "./util/hashing";
import { fitLogger } from "./logger";
import { ScopeContext } from "./scopeContext";
import { ExcludedPath, SyncIdentity, SyncPlan, RuleKind, SyncDirection } from "./syncTypes";
import { CommonState } from "./commonState";
import { ContentFact, PlanInput, generatePlan } from "./syncPlanner";
import { ExecutionPorts } from "./syncExecutor";

/**
 * 一次不可变快照：路径集合与内容状态必须来自**同一次读取**。
 *
 * 为什么必须绑在一起：若路径集合与状态分别用两次独立请求获取，期间远端推进
 * 会让"旧快照的路径集合"配"新快照的状态/提交"，头检查仍能通过，
 * 但新出现的远端路径会缺席——镜像据此把新路径当成目标独有而删除。
 */
export type SideSnapshot = {
	paths: string[];
	state: Record<string, BlobSha>;
	/**
	 * 扫描时读不到内容的路径及原因。
	 *
	 * 三态必须一路传到底：**存在**（在 state 里）、**确认不存在**（不在 paths 也不在 state）、
	 * **读失败**（在 paths 里但不在 state 里，并出现在这里）。
	 * 把"读失败"当成"不存在"会让镜像删掉远端实际存在的文件。
	 */
	unreadable?: Array<{ path: string; error: string }>;
	/** 路径 → 本地字节按 Git blob 对象格式算出的 OID（未加密时提供，供零请求比对） */
	gitBlobShas?: Record<string, BlobSha>;
};

/** 一端的能力：产出不可变快照、判定可读、读取内容。 */
export type SideScanner = {
	/** 全部候选路径与内容状态的**同一份**快照（未过滤） */
	snapshot(): Promise<SideSnapshot>;
	/** 该路径能否被这一端读取（本地隐藏路径为 false） */
	isReadable(path: string): boolean;
	/** 读取内容（仅在确实需要比较时调用） */
	read(path: string): Promise<FileContent>;
};

/** 判断内容是否二进制：与生产读取路径一致（空字节启发 + fatal 解码）。 */
export function isBinaryContent(content: FileContent): boolean {
	try {
		const text = content.toPlainText();
		// 空字节是可靠的二进制信号（与 Git 的启发式一致）
		return text.slice(0, 8192).includes("\u0000");
	} catch {
		// 非法 UTF-8：二进制
		return true;
	}
}

export type ScanResult = {
	plan: SyncPlan;
	/** 双方同名同内容的路径（首次可采纳为共同状态） */
	adoptableCount: number;
};

export type ScanInput = {
	rule: RuleKind;
	direction?: SyncDirection;
	identity: SyncIdentity;
	local: SideScanner;
	remote: SideScanner;
	scope: ScopeContext;
	commonState: CommonState;
	/** 旧缓存仅用于还原"上次同步基线"，不参与一致性判定 */
	legacyBaseline?: Map<string, { localSha?: string; remoteSha?: string }>;
	/** 远端头：发布必须绑定它 */
	remoteHead(): Promise<{ commitSha: CommitSha; state: Record<string, BlobSha> }>;
	maxConcurrentReads?: number;
	/**
	 * D1 快速路径：本地字节按 Git blob 对象格式计算 hash 与远端 OID 比对。
	 * 调用方（SyncService）仅在**未加密**时提供；加密时缺省即自动回退逐文件比较。
	 */
	localGitBlobHash?: (path: string, remoteBlobSha: BlobSha) => Promise<boolean>;
	/** 检查进度回调（低频，不含路径/内容）。 */
	onProgress?: (stage: string, completed: number, total: number) => void;
};

/**
 * 扫描两端并生成计划。
 *
 * 范围判定用 ScopeContext；被排除的路径只记原因，不进入计划输入——
 * 因此镜像不会把"被忽略而排除"误当成"来源没有该文件"去删除。
 */
export async function scanAndPlan(input: ScanInput): Promise<ScanResult> {
	// 远端：一次读取同时给出路径集合、状态与提交——不允许两次独立 fetch 再拼接。
	// 本地：快照本身天然一致（同一进程内枚举 + 计算）。
	const [localSnapshot, remoteSnapshot, remoteInfo] = await Promise.all([
		input.local.snapshot(),
		input.remote.snapshot(),
		input.remoteHead()
	]);

	const localExcluded: ExcludedPath[] = [];
	const remoteExcluded: ExcludedPath[] = [];
	const localState: Record<string, BlobSha> = {};
	const remoteState: Record<string, BlobSha> = {};

	const localAll = localSnapshot.state;
	// 交叉核对：远端快照与 remoteHead() 必须描述同一棵树。
	// 若不一致说明期间远端推进，本次计划不可信，明确失败而不是按混合状态规划。
	for (const path of Object.keys(remoteSnapshot.state)) {
		if (remoteInfo.state[path] !== remoteSnapshot.state[path]) {
			throw new Error(
				"远端在扫描期间发生变化：路径集合与内容状态来自不同快照，本次未生成计划、未改动任何文件；请重新检查。"
			);
		}
	}
	if (Object.keys(remoteSnapshot.state).length !== Object.keys(remoteInfo.state).length) {
		throw new Error(
			"远端在扫描期间发生变化：两次读取的路径数量不一致，本次未生成计划、未改动任何文件；请重新检查。"
		);
	}
	const remoteAll = remoteSnapshot.state;

	const localUnreadable: Array<{ path: string; error: string }> = [...(localSnapshot.unreadable ?? [])];
	const remoteUnreadable: Array<{ path: string; error: string }> = [...(remoteSnapshot.unreadable ?? [])];

	for (const path of localSnapshot.paths) {
		const decision = input.scope.decide(path, input.local.isReadable(path));
		if (decision.kind === "excluded") {
			localExcluded.push(decision.excluded);
			continue;
		}
		const sha = localAll[path];
		if (sha) {
			localState[path] = sha;
		} else {
			// 路径存在但拿不到状态：明确列为读失败，绝不当作"不存在"。
			localUnreadable.push({ path, error: "扫描时无法读取该路径的内容或状态" });
		}
	}
	for (const path of remoteSnapshot.paths) {
		const decision = input.scope.decide(path, true);
		if (decision.kind === "excluded") {
			remoteExcluded.push(decision.excluded);
			continue;
		}
		const sha = remoteAll[path];
		if (sha) {
			remoteState[path] = sha;
		} else {
			remoteUnreadable.push({ path, error: "扫描时无法读取该路径的内容或状态" });
		}
	}

	const reader = {
		async read(side: "local" | "remote", path: string): Promise<ContentFact> {
			const content = side === "local" ? await input.local.read(path) : await input.remote.read(path);
			return {
				digest: await digestFileContent(content),
				binary: isBinaryContent(content),
				size: content.size()
			};
		}
	};

	const fingerprint = await input.scope.fingerprint();
	const planInput: PlanInput = {
		rule: input.rule,
		direction: input.direction,
		identity: input.identity,
		remoteCommitSha: remoteInfo.commitSha,
		rulesFingerprint: fingerprint,
		local: { state: localState, excluded: localExcluded, unreadable: localUnreadable },
		remote: { state: remoteState, excluded: remoteExcluded, unreadable: remoteUnreadable },
		commonState: input.commonState,
		legacyBaseline: input.legacyBaseline,
		reader,
		maxConcurrentReads: input.maxConcurrentReads
	};
	const plan = await generatePlan({
		...planInput,
		localGitBlobHash: input.localGitBlobHash,
		onProgress: input.onProgress
	});
	fitLogger.log("[Scan] 计划已生成", {
		rule: input.rule,
		operations: plan.operations.length,
		conflicts: plan.conflicts.length,
		excluded: plan.excluded.length
	});
	return { plan, adoptableCount: plan.adoptable.length };
}

/**
 * 从真实适配器构造执行端口。
 *
 * 注意：远端发布走 publishRemote，由调用方注入严格条件发布实现；
 * 这里只组装，不决定发布策略。
 */
export type ExecutionDeps = {
	identity(): SyncIdentity;
	/** 全库本地状态（用于计划失效复核；不用于逐条前置校验） */
	localHead(): Promise<Record<string, BlobSha>>;
	/** 单条本地路径的即时状态：存在则给 SHA，不存在给 null；读失败抛错 */
	localPathState(path: string): Promise<{ present: boolean; sha?: string }>;
	remoteHead(): Promise<string>;
	/** 远端全库状态（即时读取） */
	remoteHeadState(): Promise<Record<string, BlobSha>>;
	rulesFingerprint(): Promise<string>;
	readLocal(path: string): Promise<FileContent>;
	readRemote(path: string): Promise<FileContent>;
	writeLocal(path: string, content: FileContent): Promise<void>;
	deleteLocal(path: string): Promise<void>;
	publish(actions: { additions: Array<{ path: string; content: FileContent }>; deletions: string[] }): Promise<
		| { status: "committed"; commitSha: string; committedPaths: string[]; digests?: Record<string, ContentDigest> }
		| { status: "head-changed" }
		| { status: "failed"; error: string }
		| { status: "uncertain"; detail: string }
	>;
	onProgress?(stage: string, completed: number, total: number): void;
};

/**
 * 组装执行端口：把"路径级动作"翻译成具体读写。
 * 远端内容的读取发生在发布前（需要把本地内容写进提交），本地内容在写本地前读取。
 */
export function buildPorts(deps: ExecutionDeps): ExecutionPorts {
	return {
		currentIdentity: async () => deps.identity(),
		currentRemoteHead: async () => deps.remoteHead(),
		currentRulesFingerprint: async () => deps.rulesFingerprint(),
		currentPathState: async (paths) => {
			// 三态契约：存在→SHA，确认不存在→null，读不到→不放进结果。
			// 逐条即时读取，不做全库重扫：复核只关心这几条路径。
			const localResult: Record<string, string | null> = {};
			for (const path of paths) {
				const state = await deps.localPathState(path);
				if ("error" in state) continue;
				localResult[path] = state.present ? state.sha ?? null : null;
			}
			return { local: localResult, remote: {} };
		},
		peekPath: async (side, path) => {
			// 即时读取单条路径：不复用任何执行期缓存，也不做全库重扫。
			try {
				if (side === "local") return await deps.localPathState(path);
				// 远端：每次重新读取头与树，确保看到最新状态。
				const state = await deps.remoteHeadState();
				return { present: path in state, ...(path in state ? { sha: state[path] } : {}) };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
		writeLocal: async (path, explicit) => {
			// 显式内容（手工结果）必须原样写入；只有没给内容时才回读远端。
			// 这里曾丢掉第二参数，导致手工编辑在真实链路上被远端旧内容覆盖。
			const content = explicit ?? await deps.readRemote(path);
			await deps.writeLocal(path, content);
		},
		deleteLocal: async (path) => deps.deleteLocal(path),
		publishRemote: async (actions) => {
			const digests: Record<string, ContentDigest> = {};
			const additions = await Promise.all(actions.additions.map(async addition => {
				const content = addition.content ?? await deps.readLocal(addition.path);
				// 顺手算摘要：发布本来就要读这些内容，不需要事后回读远端。
				try {
					digests[addition.path] = await digestFileContent(content);
				} catch {
					// 算不出来就不带：该路径不推进共同状态。
				}
				return { path: addition.path, content };
			}));
			const result = await deps.publish({ additions, deletions: actions.deletions });
			return result.status === "committed" ? { ...result, digests } : result;
		},
		digestOf: async (side, path) => {
			// 真实 RemoteGitHubVault 在发布成功后会清空 latestKnownState，
			// 此时 readFileContent 会抛"状态尚未加载"。这不是失败，而是缓存契约：
			// 先刷新一次远端状态再读，才能拿到刚提交内容的真实摘要。
			// 不刷新会让"远端写成功"永远拿不到 digest，基线永不推进（T6）。
			if (side === "remote") {
				try {
					return digestFileContent(await deps.readRemote(path));
				} catch (error) {
					fitLogger.log(`[SyncScanner] 远端内容暂不可读，尝试刷新后重读: ${path}`, error);
					await deps.remoteHeadState();
					return digestFileContent(await deps.readRemote(path));
				}
			}
			return digestFileContent(await deps.readLocal(path));
		},
		onProgress: deps.onProgress
	};
}

/** 供测试使用的摘要计算入口（避免各处重复写 TextEncoder 样板）。 */
export async function digestOfPath(read: () => Promise<FileContent>): Promise<ContentDigest> {
	return digestFileContent(await read());
}
