import { Notice } from "obsidian";
import { ChangeOperation, FileChange, FileClash, LocalClashState } from "./util/changeTracking";

export function extractExtension(path: string): string | undefined {
	return path.match(/[^.]+$/)?.[0];
}

// Using file extension to determine encoding of files (works in most cases)
export function setEqual<T>(arr1: Array<T>, arr2: Array<T>) {
	const set1 = new Set(arr1);
	const set2 = new Set(arr2);
	const isEqual = set1.size === set2.size && [...set1].every(value => set2.has(value));
	return isEqual;
}

export function showFileChanges(records: Array<{heading: string, changes: FileChange[]}>): void {
	console.log(records);
	if (records.length === 0 || records.every(r=>r.changes.length===0)) {return;}
	const fileOpsNotice = new Notice("", 0);
	records.map(recordSet => {
		if (recordSet.changes.length === 0) {return;}
		const heading = fileOpsNotice.noticeEl.createEl("span", {
			cls: "file-changes-heading"
		});
		heading.setText(`${recordSet.heading}\n`);
		const fileChanges: Record<ChangeOperation, string[]> = {
			ADDED: [],
			MODIFIED: [],
			REMOVED: []
		};
		for (const op of recordSet.changes) {
			fileChanges[op.type].push(op.path);
		}
		for (const [changeType, paths] of Object.entries(fileChanges)) {
			if (paths.length === 0) {continue;}
			const heading = fileOpsNotice.noticeEl.createEl("span");
			heading.setText(`${changeType === "ADDED" ? "新增" : changeType === "MODIFIED" ? "修改" : "删除"}\n`);
			heading.addClass(`file-changes-subheading`);
			for (const path of paths) {
				const listItem = fileOpsNotice.noticeEl.createEl("li", {
					cls: "file-update-row"
				});
				listItem.setText(`${path}`);
				listItem.addClass(`file-${changeType}`);
			}
		}
	});
}

export function showUnappliedConflicts(clashedFiles: Array<FileClash>): void {
	if (clashedFiles.length === 0) {return;}
	const localStatusMap: Record<LocalClashState, string> = {
		ADDED: "create",
		MODIFIED: "change",
		REMOVED: "delete",
		untracked: "untracked",
		protected: "protected"
	};
	const remoteStatusMap: Record<ChangeOperation, string> = {
		ADDED:  "create",
		MODIFIED: "change",
		REMOVED: "delete"
	};
	const conflictNotice = new Notice("", 0);
	const heading = conflictNotice.noticeEl.createEl("span");
	heading.setText(`变更冲突：\n`);
	heading.addClass(`file-changes-subheading`);
	const conflictStatus = conflictNotice.noticeEl.createDiv({
		cls: "file-conflict-row"
	});
	conflictStatus.createDiv().setText("本地");
	conflictStatus.createDiv().setText("远端");
	for (const clash of clashedFiles) {
		const conflictItem = conflictNotice.noticeEl.createDiv({
			cls: "file-conflict-row"
		});
		conflictItem.createDiv({
			cls: `file-conflict-${localStatusMap[clash.localState]}`
		});
		conflictItem.createDiv("div")
			.setText(clash.path);
		conflictItem.createDiv({
			cls: `file-conflict-${remoteStatusMap[clash.remoteOp]}`
		});
	}
	const footer = conflictNotice.noticeEl.createDiv({
		cls: "file-conflict-row"
	});
	footer.setText("说明：");
	footer.style.fontWeight = "bold";
	conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
		.setText("远端变更副本保存在 _fit");
	conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
		.setText("发生冲突时 _fit 中的副本会被覆盖，请把需要的改动复制到 _fit 之外。");

	// Add explanatory notes for special local states
	const hasProtected = clashedFiles.some(c => c.localState === 'protected');
	const hasUntracked = clashedFiles.some(c => c.localState === 'untracked');

	if (hasProtected) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("受保护：被同步策略排除的路径（.obsidian/、_fit/）");
	}
	if (hasUntracked) {
		conflictNotice.noticeEl.createEl("li", {cls: "file-conflict-note"})
			.setText("未跟踪：无法确认本地状态，详情见日志");
	}
}
