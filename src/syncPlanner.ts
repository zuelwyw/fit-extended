/**
 * 六类文件处理规则的纯计划生成器。
 *
 * 约束（开发计划 P2）：
 * - 输入只有快照、共同状态与规则；输出操作计划。无网络写、无文件写、无持久化。
 * - 补缺/覆盖/镜像按**当前双方存在性与内容**决定，不看来源相对历史是否变化。
 * - 单向更新与两种双向规则按共同状态区分单方/双方改动；无共同状态不猜历史。
 * - 双方结果相同不报冲突；只有按规则确需裁决的分歧才交用户决策。
 * - 不按修改时间判胜负。
 */

import { ContentDigest } from "./util/contentDigest";
import { BlobSha, CommitSha } from "./util/hashing";
import { CommonState } from "./commonState";
import {
	Conflict,
	DependencyGroup,
	ExcludedPath,
	PlanCounts,
	PlanOperation,
	RuleKind,
	SyncDirection,
	SyncIdentity,
	SyncPlan,
	operationId
} from "./syncTypes";
import { ScopeContext } from "./scopeContext";
import { fitLogger } from "./logger";

export type ContentFact = { digest: ContentDigest; binary: boolean; size: number };

/** 按需读取内容摘要；只在确实需要比较内容时调用。 */
export type ContentReader = {
	read(side: "local" | "remote", path: string): Promise<ContentFact>;
};

export type LocalSnapshot = { state: Record<string, BlobSha>; excluded: ExcludedPath[]; unreadable: Array<{ path: string; error: string }> };
export type RemoteSnapshot = { state: Record<string, BlobSha>; excluded: ExcludedPath[]; unreadable: Array<{ path: string; error: string }> };

export type PlanInput = {
	rule: RuleKind;
	/** 单向规则必填；双向规则忽略 */
	direction?: SyncDirection;
	identity: SyncIdentity;
	remoteCommitSha: CommitSha;
	rulesFingerprint: string;
	local: LocalSnapshot;
	remote: RemoteSnapshot;
	commonState: CommonState;
	reader: ContentReader;
	/** 单条路径两侧都读不到内容时的处理：生成冲突而不是写删 */
	/**
	 * 旧版插件的两份缓存（localSha / lastFetchedRemoteSha）。
	 *
	 * 仅用于回答"这一侧自上次同步后改过没有"，用于在缺少共同状态时还原基线；
	 * 绝不当成"两端一致"的证据，也不写进共同状态。
	 */
	legacyBaseline?: Map<string, { localSha?: string; remoteSha?: string }>;
	maxConcurrentReads?: number;
	/**
	 * Git 对象口径快速路径（D1，可选）。
	 *
	 * 对本地实际字节按 Git blob 对象格式（"blob <len>\0<bytes>"）计算 SHA-1，
	 * 与远端快照已携带的不可变 blob OID 比较。相等即"本地字节就是远端 blob"，
	 * 无需任何远端内容 GET。只在未加密时由调用方提供：
	 * 加密用户远端 blob 是密文，明文对象 hash 必然不等，绝不能参与比较。
	 * 返回 false 不构成"内容不同"的证据，调用方回退逐文件比较。
	 */
	localGitBlobHash?: (path: string, remoteBlobSha: BlobSha) => Promise<boolean>;
	/** 检查进度回调（低频：阶段+计数，不含路径与内容）。 */
	onProgress?: (stage: string, completed: number, total: number) => void;
};

type Side = "local" | "remote";
type Presence = { present: true; sha: BlobSha } | { present: false };

function targetOf(direction: SyncDirection): Side {
	return direction === "upload" ? "remote" : "local";
}

function sideLabel(side: Side): string {
	return side === "local" ? "本地" : "远端";
}

/** 限制内容读取的并发，避免大库一次性读爆内存。 */
class ReadLimiter {
	private active = 0;
	private readonly queue: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>(resolve => this.queue.push(resolve));
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

class Facts {
	private readonly cache = new Map<string, Promise<ContentFact | { error: string }>>();
	constructor(
		private readonly reader: ContentReader,
		private readonly limiter: ReadLimiter
	) {}

	get(side: Side, path: string): Promise<ContentFact | { error: string }> {
		const key = `${side}:${path}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.limiter.run(async () => {
				try {
					return await this.reader.read(side, path);
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			});
			this.cache.set(key, pending);
		}
		return pending;
	}

	async digest(side: Side, path: string): Promise<{ digest: ContentDigest } | { error: string }> {
		const fact = await this.get(side, path);
		return "error" in fact ? fact : { digest: fact.digest };
	}
}

function isError(value: ContentFact | { error: string }): value is { error: string } {
	return "error" in value;
}

/** 文件/目录同路径碰撞检测：某路径同时是另一路径的目录前缀。 */
function findCollisions(paths: Iterable<string>): Map<string, string> {
	const set = new Set(paths);
	const collisions = new Map<string, string>();
	for (const path of set) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			if (set.has(prefix)) {
				collisions.set(prefix, `路径与目录同名：${prefix} 既作为文件又作为 ${path} 的上级目录`);
			}
		}
	}
	return collisions;
}

export async function generatePlan(input: PlanInput): Promise<SyncPlan> {
	const { rule, commonState, reader } = input;
	const direction = input.direction ?? null;
	if (rule === "add-missing" || rule === "update-one-way" || rule === "overwrite" || rule === "mirror") {
		if (!direction) throw new Error(`规则 ${rule} 需要明确的操作方向`);
	}
	if (rule === "merge-no-delete" || rule === "two-way-delete") {
		if (direction) throw new Error(`双向规则 ${rule} 不接受方向参数`);
	}

	const facts = new Facts(reader, new ReadLimiter(input.maxConcurrentReads ?? 4));

	const localPaths = Object.keys(input.local.state);
	const remotePaths = Object.keys(input.remote.state);
	const allPaths = Array.from(new Set([...localPaths, ...remotePaths])).sort();

	const presence = (side: Side, path: string): Presence =>
		side === "local"
			? (path in input.local.state ? { present: true, sha: input.local.state[path] } : { present: false })
			: (path in input.remote.state ? { present: true, sha: input.remote.state[path] } : { present: false });

	const operations: PlanOperation[] = [];
	const conflicts: Conflict[] = [];
	const adoptable: Array<{ path: string; local: BlobSha; remote: BlobSha; digest: ContentDigest }> = [];
	const confirmedAbsent: string[] = [];
	const unreadable: Array<{ path: string; side: Side; error: string }> = [
		...input.local.unreadable.map(entry => ({ path: entry.path, side: "local" as Side, error: entry.error })),
		...input.remote.unreadable.map(entry => ({ path: entry.path, side: "remote" as Side, error: entry.error }))
	];

	const pushWrite = (side: Side, path: string, reason: "add" | "update") => {
		operations.push({ id: operationId(side === "local" ? "write-local" : "write-remote", path), kind: side === "local" ? "write-local" : "write-remote", path, reason });
	};
	const pushDelete = (side: Side, path: string) => {
		operations.push({ id: operationId(side === "local" ? "delete-local" : "delete-remote", path), kind: side === "local" ? "delete-local" : "delete-remote", path });
	};

	/**
	 * 内容是否一致；读取失败则记为不可判定。
	 *
	 * 快速路径（D1）：两侧都在快照中、提供 localGitBlobHash 且远端 OID 可用时，
	 * 先对本地字节算 Git blob hash 与远端 OID 比对——相等则确认一致，零远端请求。
	 * 不相等不作为"不同"的证据，回退原逐文件摘要比较（保证六模式/冲突语义不变）。
	 */
	const sameContent = async (path: string): Promise<boolean | { error: string }> => {
		if (input.localGitBlobHash) {
			const localPresence = presence("local", path);
			const remotePresence = presence("remote", path);
			if (localPresence.present && remotePresence.present) {
				try {
					if (await input.localGitBlobHash(path, remotePresence.sha)) return true;
				} catch {
					// 快速路径计算失败（读取失败/口径异常）：静默回退，不当作结论。
				}
			}
		}
		const local = await facts.get("local", path);
		if (isError(local)) return local;
		const remote = await facts.get("remote", path);
		if (isError(remote)) return remote;
		return local.digest === remote.digest;
	};

	const conflictOf = async (path: string, kind: Conflict["kind"], detail: string): Promise<void> => {
		const local = await facts.get("local", path);
		const remote = await facts.get("remote", path);
		const localFact = isError(local) ? undefined : local;
		const remoteFact = isError(remote) ? undefined : remote;
		const binary = Boolean(localFact?.binary || remoteFact?.binary);
		conflicts.push({
			path,
			kind,
			binary,
			detail,
			...(localFact
				? { local: { ...localFact, present: presence("local", path).present } }
				: { local: { present: presence("local", path).present, digest: "" as ContentDigest, binary: false, size: 0 } }),
			...(remoteFact
				? { remote: { ...remoteFact, present: presence("remote", path).present } }
				: { remote: { present: presence("remote", path).present, digest: "" as ContentDigest, binary: false, size: 0 } })
		});
		fitLogger.log(`[SyncPlan] 冲突 ${kind}: ${path}`, { detail });
	};

	const remoteUnreadablePaths = new Set(input.remote.unreadable.map(entry => entry.path));
	const localUnreadablePaths = new Set(input.local.unreadable.map(entry => entry.path));

	// 进度：低频（每 25 条或结尾一次），只有阶段名+计数，不含路径与内容。
	const reportProgress = (completed: number) => {
		input.onProgress?.("compare", completed, allPaths.length);
	};
	const PROGRESS_STRIDE = 25;

	let compared = 0;
	for (const path of allPaths) {
		compared++;
		if (input.onProgress && (compared % PROGRESS_STRIDE === 0 || compared === allPaths.length)) reportProgress(compared);
		const local = presence("local", path);
		const remote = presence("remote", path);

		// 任何一侧读取失败：不排写删，明确列为待确认项。
		if (localUnreadablePaths.has(path) || remoteUnreadablePaths.has(path)) {
			continue;
		}

		const common = commonState.lookup(path);
		/**
		 * 解析后的共同状态：
		 * - 有记录 → 用记录；
		 * - 无记录但整体已建立 → 该路径此前不存在（absent），因此单边出现可判为新增；
		 * - 无记录且从未建立 → null，任何历史推断都不成立，凡需历史语义的分歧交用户决策。
		 */
		type ResolvedHistory =
			| { presence: "same"; digest: ContentDigest }
			| { presence: "absent" }
			| { presence: "unknown"; reason: string }
			| null;
		let resolved: ResolvedHistory = common.known
			? common.entry
			: commonState.established
				? { presence: "absent" as const }
				: null;
		/**
		 * 历史结论是否不可用：无记录且从未建立，或该路径被显式记为 unknown
		 * （冲突未决 / 读取失败 / 执行失败 / 结果待确认）。
		 *
		 * unknown 必须与"没有历史"同样对待：它绝不能落进"无记录即此前不存在"
		 * 的 absent 推断，否则一次部分执行就会把未决路径当成新增补到另一端。
		 */
		/**
		 * 旧版插件的两份缓存只用来回答"这一侧自上次同步后改过没有"。
		 *
		 * 它**不是**共同状态，也不能证明两端内容相同：缓存里的远端 blob 与当前
		 * 远端 OID 相等时只能说明远端未变，本地 SHA 相等时只能说明本地未变。
		 * 由此可以还原出"上次同步时的基线"是哪一侧的内容：
		 * - 只有本地改过 → 基线 = 当前远端内容（于是按"本地做了修改"更新远端）
		 * - 只有远端改过 → 基线 = 当前本地内容（于是按"远端做了修改"更新本地）
		 * - 两侧都没改却仍不同 → 上次就没同步成功，仍交用户决策
		 * - 两侧都改过 → 真冲突（both-modified）
		 *
		 * 这样升级后旧缓存不会因为"没有被采纳为共同状态"就退化成把所有差异
		 * 都报成冲突。
		 */
		if ((resolved === null || resolved.presence === "unknown") && input.legacyBaseline) {
			const legacy = input.legacyBaseline.get(path);
			if (legacy && local.present && remote.present) {
				const localChanged = legacy.localSha !== undefined && local.sha !== legacy.localSha;
				const remoteChanged = legacy.remoteSha !== undefined && remote.sha !== legacy.remoteSha;
				// 两侧都改过：这才是真正的"双改冲突"。覆盖/镜像按来源取值，不受影响。
				if (localChanged && remoteChanged
					&& (rule === "update-one-way" || rule === "merge-no-delete" || rule === "two-way-delete")) {
					await conflictOf(path, "both-modified", "两侧相对上次同步都改过，且内容不同；需你决定采用哪一侧。");
					continue;
				}
				if (localChanged !== remoteChanged) {
					// 把"未变的那一侧的当前内容"当成基线内容。
					const stableSide = localChanged ? "remote" : "local";
					const stableFact = await facts.get(stableSide, path);
					if (!isError(stableFact)) {
						resolved = { presence: "same", digest: stableFact.digest };
					}
				}
			}
		}

		const historyUnusable = resolved === null || resolved.presence === "unknown";
		const historyReason = resolved !== null && resolved.presence === "unknown"
			? `该路径上次未能确认（${resolved.reason}）`
			: "尚无共同状态";

		const noteAdoptable = async () => {
			if (!local.present || !remote.present) return;
			const fact = await facts.get("local", path);
			if (isError(fact)) return;
			adoptable.push({ path, local: local.sha, remote: remote.sha, digest: fact.digest });
		};

		/**
		 * D2 快速判定：已有带绑定的 same 结论，且两端快照值与绑定证据完全一致。
		 *
		 * 绑定证据：确认一致时远端的 Git blob OID + 本地扫描 SHA（同算法快照值）。
		 * 远端快照 OID 未变 ⇒ 远端 blob 未变（Git 对象不可变）；本地 SHA 未变 ⇒ 本地
		 * 内容未变。两者都成立时两端仍是确认过的同一内容 → 无需任何内容读取。
		 * 任一快照值对不上 ⇒ 证据失效，回退正常判定流程（绝不据此判"不同"）。
		 * 返回 true 时同时把路径加入 adoptable（沿用既定结论的 digest）。
		 */
		const unchangedByBinding = (path: string, entry: { presence: string; digest: ContentDigest; blobSha?: string; localSha?: string }): boolean => {
			if (entry.presence !== "same" || !entry.blobSha || !entry.localSha) return false;
			const localPresence = presence("local", path);
			const remotePresence = presence("remote", path);
			if (!localPresence.present || !remotePresence.present) return false;
			if (remotePresence.sha !== entry.blobSha || localPresence.sha !== entry.localSha) return false;
			const already = adoptable.some(a => a.path === path);
			if (!already) adoptable.push({ path, local: localPresence.sha, remote: remotePresence.sha, digest: entry.digest });
			return true;
		};

		// ---- 补缺：只补目标缺失，目标已有同名文件绝不覆盖 ----
		if (rule === "add-missing") {
			const dir = direction as SyncDirection;
			const source = dir === "upload" ? local : remote;
			const target = dir === "upload" ? remote : local;
			const targetSide = targetOf(dir);
			if (source.present && !target.present) pushWrite(targetSide, path, "add");
			continue;
		}

		// ---- 覆盖：来源存在即按来源取值；目标独有保留 ----
		if (rule === "overwrite" || rule === "mirror") {
			const dir = direction as SyncDirection;
			const source = dir === "upload" ? local : remote;
			const target = dir === "upload" ? remote : local;
			const targetSide = targetOf(dir);
			if (source.present) {
				if (!target.present) {
					pushWrite(targetSide, path, "add");
				} else {
					const same = await sameContent(path);
					if (typeof same === "object") {
						unreadable.push({ path, side: "local", error: same.error });
						continue;
					}
					if (!same) {
						// 覆盖/镜像里已经明确按来源取值，不额外升格为冲突裁决。
						pushWrite(targetSide, path, "update");
					}
				}
			} else if (rule === "mirror" && target.present) {
				// 镜像删除目标独有文件；被排除对象已不在快照内，不会被删。
				pushDelete(targetSide, path);
			}
			continue;
		}

		// ---- 单向更新：按共同状态判断双方改动 ----
		if (rule === "update-one-way") {
			const dir = direction as SyncDirection;
			const sourceSide: Side = dir === "upload" ? "local" : "remote";
			const targetSide = targetOf(dir);
			const source = dir === "upload" ? local : remote;
			const target = dir === "upload" ? remote : local;

			if (!source.present && !target.present) continue;

			// 来源删除：单向更新不传播删除，保留目标。
			if (!source.present) continue;

			// 来源有、目标缺失
			if (!target.present) {
				if (historyUnusable) {
					// 无可用历史：无法区分"目标从未有过"与"目标主动删除"。
					// 不猜历史，交用户决策（补缺模式不适用这条，它只看存在性）。
					await conflictOf(path, "no-baseline-differs", historyReason + "，无法判断目标端缺失是主动删除还是从未有过。");
					continue;
				}
				const entry = resolved;
				if (entry === null || entry.presence === "unknown") continue;
				if (entry.presence === "absent") {
					// 上一次确认双方都没有，现在来源新增 → 补上。
					pushWrite(targetSide, path, "add");
					continue;
				}
				const sourceDigest = await facts.digest(sourceSide, path);
				if ("error" in sourceDigest) {
					unreadable.push({ path, side: sourceSide, error: sourceDigest.error });
					continue;
				}
				if (sourceDigest.digest === entry.digest) {
					// 目标主动删除、来源未修改 → 保持删除。
					continue;
				}
				// 目标删除且来源修改：修改—删除冲突，交用户决策。
				await conflictOf(path, "modify-delete", "目标端已删除该文件，来源端此后又修改了它；无法自动判定。");
				continue;
			}

			// 双方都存在
			if (historyUnusable) {
				const same = await sameContent(path);
				if (typeof same === "object") {
					unreadable.push({ path, side: "local", error: same.error });
					continue;
				}
				if (same) {
					await noteAdoptable();
				} else {
					// 无共同状态且同名内容不同：不自动覆盖。
					await conflictOf(path, "no-baseline-differs", "没有可用的共同状态，双方同名内容不同；按规则不得自动覆盖。");
				}
				continue;
			}
			const entry = resolved;
			if (entry === null || entry.presence === "unknown") continue;
			if (entry.presence === "absent") {
				// 双方都存在但记录为共同删除：来源重新创建，目标也有 → 按内容是否一致处理。
				const same = await sameContent(path);
				if (typeof same === "object") {
					unreadable.push({ path, side: "local", error: same.error });
					continue;
				}
				if (!same) await conflictOf(path, "no-baseline-differs", "共同状态为双方已删除，但两端现在都有不同内容。");
				else await noteAdoptable();
				continue;
			}
			// D2：绑定证据未变（远端 OID + 本地 SHA 均与确认时一致）→ 两端仍是当时内容，零读取。
			if (unchangedByBinding(path, entry)) continue;
			const sourceDigest = await facts.digest(sourceSide, path);
			const targetDigest = await facts.digest(targetSide, path);
			if ("error" in sourceDigest) {
				unreadable.push({ path, side: sourceSide, error: sourceDigest.error });
				continue;
			}
			if ("error" in targetDigest) {
				unreadable.push({ path, side: targetSide, error: targetDigest.error });
				continue;
			}
			const sourceChanged = sourceDigest.digest !== entry.digest;
			const targetChanged = targetDigest.digest !== entry.digest;
			if (!sourceChanged && !targetChanged) continue;
			if (!targetChanged) {
				if (sourceChanged) pushWrite(targetSide, path, "update");
				continue;
			}
			if (!sourceChanged) {
				// 仅目标修改：单向更新保留目标。
				continue;
			}
			if (sourceDigest.digest === targetDigest.digest) continue; // 双方结果相同
			await conflictOf(path, "both-modified", "双方都修改了该文件且内容不同。");
			continue;
		}

		// ---- 双向：合并（不传播删除） ----
		if (rule === "merge-no-delete") {
			if (!local.present && !remote.present) continue;
			// 一端缺失、另一端仍有 → 补回（允许复活）；双方都没有不从历史恢复。
			if ((local.present && !remote.present) || (remote.present && !local.present)) {
				// 不传播删除：单边存在一律补到另一端，与共同状态无关。
				// 该规则下"另一端没有"不可能是需要尊重的删除，因此无需历史即可判定。
				pushWrite(local.present ? "remote" : "local", path, "add");
				continue;
			}
			// 双方都在：比较相对共同状态的改动
			if (historyUnusable) {
				const same = await sameContent(path);
				if (typeof same === "object") {
					unreadable.push({ path, side: "local", error: same.error });
					continue;
				}
				if (same) await noteAdoptable();
				else await conflictOf(path, "no-baseline-differs", "没有可用的共同状态，双方同名内容不同；不自动选一方。");
				continue;
			}
			const entry = resolved;
			if (entry === null || entry.presence === "unknown") continue;
			if (entry.presence === "absent") {
				// 共同状态为已删除，但两端现在都在：按内容是否一致处理。
				const same = await sameContent(path);
				if (typeof same === "object") {
					unreadable.push({ path, side: "local", error: same.error });
					continue;
				}
				if (!same) await conflictOf(path, "both-modified", "共同状态为已删除，两端现都有不同内容。");
				else await noteAdoptable();
				continue;
			}
			// D2：绑定证据未变 → 两端仍是确认过的同一内容，零读取。
			if (unchangedByBinding(path, entry)) continue;
			const localDigest = await facts.digest("local", path);
			const remoteDigest = await facts.digest("remote", path);
			if ("error" in localDigest) {
				unreadable.push({ path, side: "local", error: localDigest.error });
				continue;
			}
			if ("error" in remoteDigest) {
				unreadable.push({ path, side: "remote", error: remoteDigest.error });
				continue;
			}
			const localChanged = localDigest.digest !== entry.digest;
			const remoteChanged = remoteDigest.digest !== entry.digest;
			if (!localChanged && !remoteChanged) continue;
			if (localChanged && !remoteChanged) {
				pushWrite("remote", path, "update");
				continue;
			}
			if (!localChanged && remoteChanged) {
				pushWrite("local", path, "update");
				continue;
			}
			if (localDigest.digest === remoteDigest.digest) continue;
			await conflictOf(path, "both-modified", "双方都修改了该文件且内容不同。");
			continue;
		}

		// ---- 双向：传播删除 ----
		if (rule === "two-way-delete") {
			if (!local.present && !remote.present) {
				if (common.known && common.entry.presence === "same") {
					// 双方都已删除，确认共同删除状态（不推进也不恢复内容）。
					confirmedAbsent.push(path);
				}
				continue;
			}
			if (local.present && remote.present) {
				if (historyUnusable) {
					const same = await sameContent(path);
					if (typeof same === "object") {
						unreadable.push({ path, side: "local", error: same.error });
						continue;
					}
					if (same) await noteAdoptable();
					else await conflictOf(path, "no-baseline-differs", "没有可用的共同状态，双方同名内容不同；首次同步不得把差异当成已知删除或修改。");
					continue;
				}
				const entry = resolved;
				if (entry === null || entry.presence === "unknown") continue;
				if (entry.presence === "absent") {
					// 记录为共同删除，但两端都有：来源重新创建，另一端也有 → 内容一致才算同步。
					const same = await sameContent(path);
					if (typeof same === "object") {
						unreadable.push({ path, side: "local", error: same.error });
						continue;
					}
					if (!same) await conflictOf(path, "both-modified", "共同状态为双方已删除，两端现在都有不同内容。");
					continue;
				}
				if (entry.presence !== "same") continue;
				// D2：绑定证据未变 → 两端仍是确认过的同一内容，零读取。
				if (unchangedByBinding(path, entry)) continue;
				const localDigest = await facts.digest("local", path);
				const remoteDigest = await facts.digest("remote", path);
				if ("error" in localDigest) {
					unreadable.push({ path, side: "local", error: localDigest.error });
					continue;
				}
				if ("error" in remoteDigest) {
					unreadable.push({ path, side: "remote", error: remoteDigest.error });
					continue;
				}
				const localChanged = localDigest.digest !== entry.digest;
				const remoteChanged = remoteDigest.digest !== entry.digest;
				if (!localChanged && !remoteChanged) continue;
				if (localChanged && !remoteChanged) {
					pushWrite("remote", path, "update");
					continue;
				}
				if (!localChanged && remoteChanged) {
					pushWrite("local", path, "update");
					continue;
				}
				if (localDigest.digest === remoteDigest.digest) continue;
				await conflictOf(path, "both-modified", "双方都修改了该文件且内容不同。");
				continue;
			}

			// 一端存在、另一端缺失：需要共同状态区分"新增"与"删除"。
			const presentSide: Side = local.present ? "local" : "remote";
			const missingSide: Side = local.present ? "remote" : "local";
			if (historyUnusable) {
				// 无法判定是删除还是新增：不猜，交用户决策。
				await conflictOf(path, "no-baseline-differs", `仅有${sideLabel(presentSide)}存在该文件且${historyReason}，无法区分这是新增还是另一端的删除。`);
				continue;
			}
			const entry = resolved;
			if (entry === null || entry.presence === "unknown") continue;
			if (entry.presence === "absent") {
				// 确认双方曾都删除，现在一端新增 → 补到另一端。
				pushWrite(missingSide, path, "add");
				continue;
			}
			if (entry.presence !== "same") continue;
			const presentDigest = await facts.digest(presentSide, path);
			if ("error" in presentDigest) {
				unreadable.push({ path, side: presentSide, error: presentDigest.error });
				continue;
			}
			if (presentDigest.digest === entry.digest) {
				// 存在端未改，缺失端是主动删除 → 传播删除。
				pushDelete(presentSide, path);
				continue;
			}
			await conflictOf(path, "modify-delete", `${sideLabel(missingSide)}已删除该文件，${sideLabel(presentSide)}此后修改了它；删改冲突不自动选胜方。`);
			continue;
		}
	}

	// 路径碰撞：无法直接执行的情况按冲突处理，不独立乱序执行。
	// 碰撞可能来自跨端结构不同（一端是文件、另一端把它当目录），即使本轮没有
	// 计划操作也要如实报告，否则用户会在执行时才撞上。
	const plannedPaths = operations.map(op => op.path);
	const collisions = findCollisions([...allPaths, ...plannedPaths]);
	const dependencyGroups: DependencyGroup[] = [];
	if (collisions.size > 0) {
		const blocked = new Set<string>();
		for (const [path, detail] of collisions) {
			blocked.add(path);
			conflicts.push({
				path,
				kind: "path-collision",
				binary: false,
				detail
			});
		}
		if (blocked.size > 0) {
			for (let i = operations.length - 1; i >= 0; i--) {
				const op = operations[i];
				if (blocked.has(op.path) || Array.from(blocked).some(prefix => op.path.startsWith(`${prefix}/`))) {
					operations.splice(i, 1);
				}
			}
		}
	}

	// 依赖组：同一路径只允许一个操作；父子路径同时有操作时不得独立执行。
	const byPath = new Map<string, PlanOperation[]>();
	for (const op of operations) {
		const list = byPath.get(op.path) ?? [];
		list.push(op);
		byPath.set(op.path, list);
	}
	for (const [path, ops] of byPath) {
		if (ops.length > 1) {
			dependencyGroups.push({ id: `path:${path}`, members: ops.map(op => op.id), reason: "同一路径存在多个操作，必须一起选择或一起放弃" });
		}
	}

	const excluded: ExcludedPath[] = [...input.local.excluded, ...input.remote.excluded];
	const conflictsCount = conflicts.length;
	const counts: PlanCounts = {
		writeRemote: operations.filter(op => op.kind === "write-remote").length,
		writeLocal: operations.filter(op => op.kind === "write-local").length,
		deleteRemote: operations.filter(op => op.kind === "delete-remote").length,
		deleteLocal: operations.filter(op => op.kind === "delete-local").length,
		conflicts: conflictsCount,
		excluded: excluded.length,
		unreadable: unreadable.length
	};

	return {
		rule,
		direction,
		identity: input.identity,
		remoteCommitSha: input.remoteCommitSha,
		rulesFingerprint: input.rulesFingerprint,
		operations,
		conflicts,
		excluded,
		unreadable,
		dependencyGroups,
		localState: { ...input.local.state },
		remoteState: { ...input.remote.state },
		adoptable,
		confirmedAbsent,
		mirrorComplete: false,
		counts
	};
}

/** 计划中可立即确认建立共同状态的同内容路径（首次扫描）。 */
export function adoptableDigests(plan: SyncPlan): string[] {
	return plan.adoptable.map(entry => entry.path);
}

export { ScopeContext };
