/**
 * _fit/ 冲突副本清理（历史兼容功能，独立于同步主流程）。
 *
 * 需求要求默认同步流程不再依赖"先写冲突副本再清理"的做法；该功能保留为
 * 独立的显式命令：只删除 _fit/ 下的副本，永不删除原路径正文，也不向远端传播删除。
 *
 * 本模块从原 `directionalOperations.ts` 中拆出，只保留真正被生产使用的能力
 * （清理 + 上次清单），不再携带旧的单向计划/执行代码。
 */

import { Fit } from "./fit";
import { FileChange } from "./util/changeTracking";
import { fitLogger } from "./logger";

/** 冲突副本与其原路径文件的对照信息，供用户决定覆盖方向 */
export type ConflictPair = {
	/** _fit/ 内副本路径 */
	path: string;
	/** 原路径（无 _fit/ 前缀） */
	originalPath: string;
	size: number;
	/** 副本最后修改时间（epoch ms） */
	mtime: number;
	/** 原路径文件是否存在 */
	originalExists: boolean;
	/** 原路径文件最后修改时间（不存在时为 null） */
	originalMtime: number | null;
	/** 原路径文件大小（不存在时为 null） */
	originalSize: number | null;
};

export type ConflictCleanupResult = {
	deleted: string[];
	failed: Array<{ path: string; error: string }>;
	folderWarnings: string[];
};

const FIT_PREFIX = "_fit/";

export class ConflictCleanupRunner {
	private running = false;
	private lastConflictPaths: string[] = [];

	constructor(private fit: Fit) {}

	get busy(): boolean { return this.running; }
	get hasLastConflictSet(): boolean { return this.lastConflictPaths.length > 0; }

	recordConflicts(changes: FileChange[]): void {
		this.lastConflictPaths = Array.from(new Set(changes
			.filter(change => change.path.startsWith(FIT_PREFIX) && change.type !== "REMOVED")
			.map(change => change.path))).sort();
	}

	async listConflictFiles(scope: "last" | "all"): Promise<ConflictPair[]> {
		if (scope === "last" && !this.hasLastConflictSet) {
			throw new Error("本次插件运行期间没有可用的上次同步冲突清单，请改选「全部冲突副本」。");
		}
		const candidates = scope === "last"
			? [...this.lastConflictPaths]
			: this.fit.localVault.vault.getFiles().map(file => file.path).filter(path => path.startsWith(FIT_PREFIX));
		const result = await Promise.all(Array.from(new Set(candidates)).sort().map(async (path): Promise<ConflictPair | null> => {
			const stat = await this.fit.localVault.vault.adapter.stat(path);
			if (!stat) return null;
			if (stat.type !== "file") throw new Error(`冲突清理只处理文件，不处理文件夹：${path}`);
			// 原路径对照信息：帮助用户判断"用副本覆盖原文件"还是"保留原文件"
			const originalPath = path.slice(FIT_PREFIX.length);
			const originalStat = await this.fit.localVault.vault.adapter.stat(originalPath);
			const originalIsFile = originalStat?.type === "file";
			return {
				path,
				originalPath,
				size: stat.size,
				mtime: stat.mtime,
				originalExists: originalIsFile,
				originalMtime: originalIsFile ? originalStat.mtime : null,
				originalSize: originalIsFile ? originalStat.size : null
			};
		}));
		return result.filter((entry): entry is ConflictPair => entry !== null);
	}

	async cleanupConflicts(scope: "last" | "all", selectedPaths?: string[]): Promise<ConflictCleanupResult> {
		if (this.running) throw new Error("另一个同步操作正在运行。");
		this.running = true;
		try {
			const files = await this.listConflictFiles(scope);
			// 只删除用户勾选的项；未勾选的一律保留
			const selected = selectedPaths
				? files.filter(({ path }) => selectedPaths.includes(path))
				: files;
			const settled = await Promise.allSettled(selected.map(({ path }) => this.fit.localVault.applyChanges([], [path])));
			const deleted: string[] = [];
			const failed: Array<{ path: string; error: string }> = [];
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") deleted.push(selected[index].path);
				else failed.push({ path: selected[index].path, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
			});
			const folderWarnings: string[] = [];
			const folders = new Set<string>();
			for (const { path } of selected) {
				let parent = path.slice(0, path.lastIndexOf("/"));
				while (parent.startsWith(FIT_PREFIX) && parent.length > FIT_PREFIX.length) {
					folders.add(parent);
					parent = parent.slice(0, parent.lastIndexOf("/"));
				}
			}
			if (selected.length > 0) folders.add("_fit");
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
