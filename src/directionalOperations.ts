import { Fit } from "./fit";
import { FileChange, FileStates, compareFileStates } from "./util/changeTracking";
import { FileContent } from "./util/contentEncoding";
import { CommitSha } from "./util/hashing";
import { LocalVault } from "./localVault";
import FitNotice from "./fitNotice";
import { fitLogger } from "./logger";
import { SyncResult, SyncErrors } from "./syncResult";
import { VaultError } from "./vault";

export type SyncDirection = "upload" | "pull";
/** 写入模式：overwrite 覆盖同名差异文件；addOnly 只补新增，不动目标端已存在的文件 */
export type DirectionalWriteMode = "overwrite" | "addOnly";
export type DirectionalPlan = {
	direction: SyncDirection;
	writeMode: DirectionalWriteMode;
	deleteUnique: boolean;
	changes: FileChange[];
	localState: FileStates;
	remoteState: FileStates;
	remoteCommitSha: CommitSha;
	/** 本次是否为建立基线的全量操作 */
	baselineMissing?: boolean;
};
export type ConflictCleanupResult = {
	deleted: string[];
	failed: Array<{ path: string; error: string }>;
	folderWarnings: string[];
};

function sameState(left: FileStates, right: FileStates): boolean {
	const leftPaths = Object.keys(left);
	const rightPaths = Object.keys(right);
	return leftPaths.length === rightPaths.length && leftPaths.every(path => left[path] === right[path]);
}

/** 基线缺失判定：来源端的缓存基线为空，说明无法做增量比对 */
export function isBaselineMissing(fit: Fit, direction: SyncDirection): boolean {
	const baseline = direction === "upload" ? fit.localSha : fit.lastFetchedRemoteSha;
	return !baseline || Object.keys(baseline).length === 0;
}

/**
 * 增量变更集：以缓存基线（localSha / lastFetchedRemoteSha）为准。
 *
 * 注意：本地 SHA 与远端 Git blob SHA 算法不同，不能互相比较，
 * 因此两个方向各自与自己那一侧的历史基线比较。
 * upload → 本地当前状态 vs localSha；pull → 远端当前状态 vs lastFetchedRemoteSha。
 *
 * 此函数不读取任何文件内容（SHA 在 readFromSource 扫描阶段已算出）。
 */
function incrementalChanges(fit: Fit, direction: SyncDirection, currentState: FileStates, useBaseline: boolean): FileChange[] {
	if (!useBaseline) return [];
	const baseline = direction === "upload" ? fit.localSha : fit.lastFetchedRemoteSha;
	return compareFileStates(currentState, baseline ?? {});
}

/**
 * Directional operations always compare current file content, not the previous
 * sync cache. This keeps their preview correct on a fresh installation and when
 * a user deliberately chooses a one-way overwrite.
 */
export async function prepareDirectionalOperation(
	fit: Fit,
	direction: SyncDirection,
	writeMode: DirectionalWriteMode = "overwrite",
	deleteUnique: boolean = false,
	acceptFullBaseline: boolean = false
): Promise<DirectionalPlan> {
	const [{ state: localState }, { state: remoteState, commitSha: remoteCommitSha }] = await Promise.all([
		fit.localVault.readFromSource(),
		fit.remoteVault.readFromSource(true)
	]);
	const source = direction === "upload" ? localState : remoteState;
	const target = direction === "upload" ? remoteState : localState;
	// 同步范围必须与双向同步保持一致：既受同步策略约束（_fit/、.obsidian/），
	// 也受本地可跟踪能力约束（以 . 开头的隐藏文件，如 .gitignore、.gitattributes）。
	const isSyncablePath = (path: string) => fit.shouldSyncPath(path) && fit.localVault.shouldTrackState(path);

	// 基线缺失时无法做增量：调用方必须先向用户提示并取得确认，
	// 确认后以 acceptFullBaseline=true 再调用一次，此时把所有来源端文件视为待写入。
	const baselineMissing = isBaselineMissing(fit, direction);
	if (baselineMissing && !acceptFullBaseline) {
		throw new Error("本次插件运行尚无同步基线，无法判断哪些文件有改动。请确认后再执行（首次将上传全部可同步文件以建立基线）。");
	}

	const incremental = incrementalChanges(fit, direction, source, !baselineMissing);
	const changes: FileChange[] = [];

	if (baselineMissing) {
		// 建立基线：来源端全部可同步文件按新增处理，但不读取内容做比较
		for (const path of Object.keys(source).filter(isSyncablePath)) {
			changes.push({ path, type: "ADDED" });
		}
	} else {
		// 增量：只取基线中确实变化的文件，再按写入模式过滤
		const sourcePaths = new Set(Object.keys(source).filter(isSyncablePath));
		for (const change of incremental) {
			if (!sourcePaths.has(change.path) || !isSyncablePath(change.path)) continue;
			if (change.type === "ADDED") {
				changes.push({ path: change.path, type: "ADDED" });
			} else if (change.type === "MODIFIED" && writeMode === "overwrite") {
				// addOnly 模式跳过同名修改：目标端已存在的文件一律不改动
				changes.push({ path: change.path, type: "MODIFIED" });
			}
		}
	}

	// 删除目标端独有文件：只比对路径集合，不读取任何内容
	if (deleteUnique) {
		const sourcePathSet = new Set(Object.keys(source));
		for (const path of Object.keys(target)) {
			if (!sourcePathSet.has(path) && isSyncablePath(path)) {
				changes.push({ path, type: "REMOVED" });
			}
		}
	}
	changes.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
	return { direction, writeMode, deleteUnique, changes, localState, remoteState, remoteCommitSha, baselineMissing };
}

export class DirectionalOperationRunner {
	private running = false;
	private lastConflictPaths: string[] = [];

	constructor(private fit: Fit, private saveLocalStore: (store: {
		localSha: FileStates;
		lastFetchedCommitSha: CommitSha | null;
		lastFetchedRemoteSha: FileStates;
	}) => Promise<void>) {}

	get busy(): boolean { return this.running; }
	get hasLastConflictSet(): boolean { return this.lastConflictPaths.length > 0; }

	/**
	 * 零上传采纳基线：只读取两端当前状态并记录为同步基线，不写任何文件。
	 * 此后增量判定即可正常工作，日常操作只会传输真正变化的文件。
	 */
	async adoptBaseline(notice: FitNotice): Promise<void> {
		if (this.running) throw new Error("另一个同步操作正在运行。");
		this.running = true;
		try {
			notice.setMessage("正在读取两端状态以建立基线…");
			const [localRead, remoteRead] = await Promise.all([
				this.fit.localVault.readFromSource(),
				this.fit.remoteVault.readFromSource(true)
			]);
			notice.setMessage("正在记录基线…");
			await this.saveLocalStore({
				localSha: this.fit.filterSyncedState(localRead.state),
				lastFetchedCommitSha: remoteRead.commitSha,
				lastFetchedRemoteSha: remoteRead.state
			});
			fitLogger.log("[DirectionalSync] Baseline adopted (zero upload)", {
				localFiles: Object.keys(localRead.state).length,
				remoteFiles: Object.keys(remoteRead.state).length,
				commitSha: remoteRead.commitSha
			});
			notice.setMessage("基线已建立");
		} finally {
			this.running = false;
		}
	}

	recordConflicts(changes: FileChange[]): void {
		this.lastConflictPaths = Array.from(new Set(changes
			.filter(change => change.path.startsWith("_fit/") && change.type !== "REMOVED")
			.map(change => change.path))).sort();
	}

	private async validatePlan(plan: DirectionalPlan): Promise<void> {
		const [{ state: currentLocal }, { commitSha: currentRemoteCommit }] = await Promise.all([
			this.fit.localVault.readFromSource(),
			this.fit.remoteVault.readFromSource(true)
		]);
		if (currentRemoteCommit !== plan.remoteCommitSha) {
			throw new Error("预览之后远端分支已变化，未改动任何文件；请重新准备本次操作。");
		}
		if (!sameState(currentLocal, plan.localState)) {
			throw new Error("预览之后本地文件已变化，未改动任何文件；请重新准备本次操作。");
		}
	}

	async execute(plan: DirectionalPlan, notice: FitNotice): Promise<SyncResult> {
		if (this.running) return { success: false, error: SyncErrors.alreadySyncing() };
		this.running = true;
		try {
			await this.validatePlan(plan);
			notice.setMessage(plan.direction === "upload" ? "正在上传所选本地状态" : "正在拉取所选远端状态");
			let localOps: FileChange[] = [];
			let remoteOps: FileChange[] = [];
			let newLocalState = plan.localState;
			let newRemoteState = plan.remoteState;
			let newCommitSha = plan.remoteCommitSha;

			if (plan.direction === "upload") {
				const writes = await Promise.all(plan.changes.filter(change => change.type !== "REMOVED").map(async change => ({
					path: change.path,
					content: await this.fit.localVault.readFileContent(change.path)
				})));
				const deletions = plan.changes.filter(change => change.type === "REMOVED").map(change => change.path);
				const total = writes.length + deletions.length;
				// blob 创建受 GitHub 二级限流（≤80/分钟），全程可能持续数分钟；向用户报告进度
				const result = await this.fit.remoteVault.applyChanges(writes, deletions, undefined, (completed) => {
					notice.setMessage(`正在上传（${completed}/${total}）…`);
				});
				remoteOps = result.changes;
				newRemoteState = result.newState;
				newCommitSha = result.commitSha;
			} else {
				const writes = await Promise.all(plan.changes.filter(change => change.type !== "REMOVED").map(async change => ({
					path: change.path,
					content: await this.fit.remoteVault.readFileContent(change.path)
				})));
				const deletions = plan.changes.filter(change => change.type === "REMOVED").map(change => change.path);
				const result = await this.fit.localVault.applyChanges(writes, deletions);
				localOps = result.changes;
				newLocalState = { ...plan.localState, ...await result.newBaselineStates };
				for (const deletion of deletions) delete newLocalState[deletion];
			}
			await this.saveLocalStore({
				localSha: this.fit.filterSyncedState(newLocalState),
				lastFetchedCommitSha: newCommitSha,
				lastFetchedRemoteSha: newRemoteState
			});
			notice.setMessage(plan.direction === "upload" ? "上传完成" : "拉取完成");
			return {
				success: true,
				changeGroups: [
					{ heading: "本地文件更新：", changes: localOps },
					{ heading: "远端文件更新：", changes: remoteOps }
				],
				clash: []
			};
		} catch (error) {
			fitLogger.log(`[DirectionalSync] ${plan.direction} failed`, { error });
			if (error instanceof VaultError) return { success: false, error };
			return { success: false, error: SyncErrors.unknown(error instanceof Error ? error.message : String(error), { originalError: error }) };
		} finally {
			this.running = false;
		}
	}

	async listConflictFiles(scope: "last" | "all"): Promise<Array<{ path: string; size: number }>> {
		if (scope === "last" && !this.hasLastConflictSet) {
			throw new Error("本次插件运行期间没有可用的上次同步冲突清单，请改选「全部冲突副本」。");
		}
		const candidates = scope === "last"
			? [...this.lastConflictPaths]
			: this.fit.localVault.vault.getFiles().map(file => file.path).filter(path => path.startsWith("_fit/"));
		const result = await Promise.all(Array.from(new Set(candidates)).sort().map(async path => {
			const stat = await this.fit.localVault.vault.adapter.stat(path);
			if (!stat) return null;
			if (stat.type !== "file") throw new Error(`冲突清理只处理文件，不处理文件夹：${path}`);
			return { path, size: stat.size };
		}));
		return result.filter((entry): entry is { path: string; size: number } => entry !== null);
	}

	async cleanupConflicts(scope: "last" | "all"): Promise<ConflictCleanupResult> {
		if (this.running) throw new Error("另一个同步操作正在运行。");
		this.running = true;
		try {
			const files = await this.listConflictFiles(scope);
			const settled = await Promise.allSettled(files.map(({ path }) => this.fit.localVault.applyChanges([], [path])));
			const deleted: string[] = [];
			const failed: Array<{ path: string; error: string }> = [];
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") deleted.push(files[index].path);
				else failed.push({ path: files[index].path, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
			});
			const folderWarnings: string[] = [];
			const folders = new Set<string>();
			for (const { path } of files) {
				let parent = path.slice(0, path.lastIndexOf("/"));
				while (parent.startsWith("_fit/") && parent.length > "_fit/".length) {
					folders.add(parent);
					parent = parent.slice(0, parent.lastIndexOf("/"));
				}
			}
			if (files.length > 0) folders.add("_fit");
			for (const folder of Array.from(folders).sort((a, b) => b.length - a.length)) {
				try { await this.fit.localVault.vault.adapter.rmdir(folder, false); }
				catch (error) {
					const stat = await this.fit.localVault.vault.adapter.stat(folder);
					if (stat && this.fit.localVault.vault.getFiles().some(file => file.path.startsWith(`${folder}/`))) continue;
					if (stat) folderWarnings.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (scope === "last") this.lastConflictPaths = this.lastConflictPaths.filter(path => !deleted.includes(path));
			fitLogger.log("[ConflictCleanup] Finished", { scope, deleted, failed, folderWarnings });
			return { deleted, failed, folderWarnings };
		} finally {
			this.running = false;
		}
	}
}
