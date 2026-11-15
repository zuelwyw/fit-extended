/**
 * 共同状态（common state）
 *
 * 与"扫描缓存"严格区分：
 * - 扫描缓存：上次扫描看到的本地 SHA / 远端 blob SHA，只用于减少重复工作。
 * - 共同状态：该路径上**已经确认**双方一致的内容摘要，或已经确认双方都删除。
 *
 * 为什么不能混用：零上传采纳基线会把两端各自的状态各自记一遍，那只说明"各自
 * 长这样"，不说明"两边一样"。若把这种记录当成共同状态，首次扫描时同名不同内容
 * 的文件就会在一端修改后被误判成"另一端单方修改"，从而被悄悄覆盖。
 *
 * 内容摘要用同口径（util/contentDigest），不用本地 SHA，也不用 Git blob SHA。
 */

import { ContentDigest, isContentDigest } from "./util/contentDigest";

export const COMMON_STATE_VERSION = 2;

export type CommonStateEntry =
	/**
	 * 双方在该路径上一致，digest 为该内容。
	 *
	 * 可选绑定（D2 快速路径证据，缺省表示仅有摘要结论）：
	 * - blobSha：确认一致时远端快照给出的 **Git blob OID**（不可变对象标识）；
	 * - localSha：确认一致时本地扫描器（LocalVault.fileSha1）的值。
	 * 下次检查先比对这两条：远端快照 OID 未变且本地 SHA 未变 → 两端仍是当时的
	 * 内容 → 无需任何内容读取即可判定"无操作"。这是**结论复用**，不是把不同
	 * 算法的 SHA 互拷：比较发生在同算法快照值之间（快照 OID vs 记录 OID、
	 * 快照本地 SHA vs 记录本地 SHA），digest 只作为内容口径的原始凭证保存。
	 * 未选/失败/未知路径不得带绑定（由写入点控制）。
	 */
	| { presence: "same"; digest: ContentDigest; blobSha?: string; localSha?: string }
	/** 双方都确认不存在该路径 */
	| { presence: "absent" }
	/**
	 * 已尝试判定但结论不成立：冲突未决、读取失败、执行失败或结果待确认。
	 *
	 * 这条记录存在的意义：让该路径**永远不会**落进"无记录且整体已建立 → 视为 absent"
	 * 的推断里。否则一次部分执行就会把无法判定的路径当成"此前不存在"，
	 * 下次把它当作新增补到另一端，等于静默覆盖另一端真实的删除。
	 */
	| { presence: "unknown"; reason: string };

/** 仓库身份：共同状态不能跨仓库/分支复用。 */
export type StateIdentity = { owner: string; repo: string; branch: string };

export type CommonStateSnapshot = {
	version: number;
	identity: StateIdentity;
	/**
	 * 是否已经建立过共同状态。
	 *
	 * 必须显式记录，不能用"entries 为空"代替：空知识库/空仓库是合法的已建立状态，
	 * 与"从未建立"在语义上完全不同——前者可以把单边出现解释为新增，后者不能。
	 */
	established: boolean;
	entries: Record<string, CommonStateEntry>;
};

export type UnknownReason =
	| "no-entry"
	| "legacy-record"
	| "identity-mismatch"
	| "version-mismatch";

export type CommonStateLookup =
	| { known: true; entry: CommonStateEntry }
	| { known: false; reason: UnknownReason };

const EMPTY_DIGEST = "sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709" as ContentDigest;

export function emptySnapshot(identity: StateIdentity, established = false): CommonStateSnapshot {
	return { version: COMMON_STATE_VERSION, identity, established, entries: {} };
}

/**
 * 从旧格式（localSha / lastFetchedRemoteSha 双份缓存）迁移。
 *
 * 旧记录里同时存在同名路径**不能**证明两边一致（这正是零上传采纳基线的产物），
 * 所以一律不采纳为共同状态：保留空表并让调用方按"未知"处理，绝不悄悄全量上传。
 */
export function fromLegacyLocalStore(
	legacy: { localSha?: Record<string, string>; lastFetchedRemoteSha?: Record<string, string> },
	identity: StateIdentity
): { snapshot: CommonStateSnapshot; droppedPaths: string[] } {
	const localPaths = Object.keys(legacy.localSha ?? {});
	const remotePaths = Object.keys(legacy.lastFetchedRemoteSha ?? {});
	const droppedPaths = Array.from(new Set([...localPaths, ...remotePaths])).sort();
	// 两条缓存为空表示新装：没有任何可丢弃的信息。
	return { snapshot: emptySnapshot(identity), droppedPaths };
}

export class CommonState {
	private constructor(private snapshot: CommonStateSnapshot) {}

	static create(identity: StateIdentity, snapshot?: Partial<CommonStateSnapshot> | null): CommonState {
		if (!snapshot || typeof snapshot !== "object") return new CommonState(emptySnapshot(identity));
		const entries: Record<string, CommonStateEntry> = {};
		// 版本或身份不符的旧数据整体视为未知：不能跨仓库/分支复用，也不做局部猜测。
		const usable = snapshot.version === COMMON_STATE_VERSION
			&& snapshot.identity?.owner === identity.owner
			&& snapshot.identity?.repo === identity.repo
			&& snapshot.identity?.branch === identity.branch;
		if (usable && snapshot.entries) {
			for (const [path, entry] of Object.entries(snapshot.entries)) {
				if (!entry || typeof entry !== "object") continue;
				if (entry.presence === "absent") {
					entries[path] = { presence: "absent" };
				} else if (entry.presence === "unknown") {
					entries[path] = { presence: "unknown", reason: String((entry as { reason?: unknown }).reason ?? "未确认") };
				} else if (entry.presence === "same" && isContentDigest(entry.digest)) {
					// 绑定字段只在类型合法时保留；缺失或非法按"无绑定"处理，不影响结论本身。
					const raw = entry as { blobSha?: unknown; localSha?: unknown };
					const blobSha = typeof raw.blobSha === "string" && raw.blobSha.length > 0 ? raw.blobSha : undefined;
					const localSha = typeof raw.localSha === "string" && raw.localSha.length > 0 ? raw.localSha : undefined;
					entries[path] = { presence: "same", digest: entry.digest, ...(blobSha ? { blobSha } : {}), ...(localSha ? { localSha } : {}) };
				}
			}
		}
		return new CommonState({ version: COMMON_STATE_VERSION, identity, established: usable && snapshot.established === true, entries });
	}

	get identity(): StateIdentity { return this.snapshot.identity; }
	/** 是否已建立（首次扫描前为 false：此时任何单边存在都不能当成新增或删除）。 */
	get established(): boolean { return this.snapshot.established; }

	/**
	 * 标记为已建立：表示"已对整库做过一次扫描并给出结论"。
	 *
	 * 之所以可以据此推断"无记录即此前不存在"，是因为所有无法判定的路径
	 * 都由 {@link recordUnknown} 显式记了 unknown，不会落到这条推断上。
	 * 调用方必须在记录完本轮全部结论之后才调用本方法。
	 */
	markEstablished(): void { this.snapshot.established = true; }
	get size(): number { return Object.keys(this.snapshot.entries).length; }

	lookup(path: string): CommonStateLookup {
		const entry = this.snapshot.entries[path];
		if (!entry) return { known: false, reason: "no-entry" };
		return { known: true, entry };
	}

	/**
	 * 记录共同状态。
	 *
	 * 只应由"实际成功的操作"调用：未选、失败、结果待确认的项目不得推进状态。
	 */
	recordSame(paths: Array<{ path: string; digest: ContentDigest; blobSha?: string; localSha?: string }>): void {
		for (const { path, digest, blobSha, localSha } of paths) {
			this.snapshot.entries[path] = {
				presence: "same",
				digest,
				...(blobSha ? { blobSha } : {}),
				...(localSha ? { localSha } : {})
			};
		}
	}

	recordAbsent(paths: string[]): void {
		for (const path of paths) {
			this.snapshot.entries[path] = { presence: "absent" };
		}
	}

	/**
	 * 标记为未确认：冲突未决、读取失败、执行失败或结果待确认。
	 *
	 * 必须覆盖已有记录——该路径此刻的真实状态确实不成立，
	 * 留着旧的"已一致"记录只会让下次判定引用过期结论。
	 */
	recordUnknown(paths: string[], reason: string): void {
		for (const path of paths) {
			this.snapshot.entries[path] = { presence: "unknown", reason };
		}
	}

	/**
	 * 仅在"该路径还没有确定结论"时才标记 unknown。
	 *
	 * 用于**未选**的项目：用户这次没勾选它，并不代表此前已确认的事实失效。
	 * 若无条件覆盖，下次会把"一侧已确认改动"变成假冲突，抹掉有效历史。
	 */
	markUnknownIfUndecided(paths: string[], reason: string): Array<{ path: string; kept: "same" | "absent" }> {
		const kept: Array<{ path: string; kept: "same" | "absent" }> = [];
		for (const path of paths) {
			const existing = this.snapshot.entries[path];
			if (existing && existing.presence !== "unknown") {
				kept.push({ path, kept: existing.presence });
				continue;
			}
			this.snapshot.entries[path] = { presence: "unknown", reason };
		}
		return kept;
	}

	/** 该路径是否有确定结论（same / absent）。 */
	isDefinite(path: string): boolean {
		const entry = this.snapshot.entries[path];
		return entry !== undefined && entry.presence !== "unknown";
	}

	/** 清除单条记录（例如执行时发现该路径已变化，无法确认一致性）。 */
	forget(paths: string[]): void {
		for (const path of paths) delete this.snapshot.entries[path];
	}

	toJSON(): CommonStateSnapshot {
		return {
			version: COMMON_STATE_VERSION,
			identity: this.snapshot.identity,
			established: this.snapshot.established,
			entries: { ...this.snapshot.entries }
		};
	}

	/** 供测试与诊断：除空文件外的所有已记录路径。 */
	paths(): string[] {
		return Object.keys(this.snapshot.entries).sort();
	}
}

export const EMPTY_CONTENT_DIGEST = EMPTY_DIGEST;
