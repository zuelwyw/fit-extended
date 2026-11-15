import { App, Modal, Setting } from "obsidian";
import { ConflictPair } from "./conflictCleanup";
import { SyncDirection } from "./syncTypes";

abstract class OptionsModal<T> extends Modal {
	protected resolved = false;
	private resolvePromise!: (value: T | null) => void;
	readonly result = new Promise<T | null>(resolve => { this.resolvePromise = resolve; });

	constructor(app: App) {
		super(app);
		this.modalEl.addClass("fit-operation-modal");
	}

	/**
	 * 打开对话框并返回用户的选择结果。
	 * 必须由调用方在子类字段初始化完成后调用：构造函数不自动 open，
	 * 否则子类参数尚未赋值时 onOpen 会读到 undefined。
	 */
	show(): Promise<T | null> {
		this.open();
		return this.result;
	}

	protected finish(value: T | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolvePromise(value);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolvePromise(null);
		}
	}

	protected addChoices<T extends string>(
		choices: Array<{ value: T; label: string; description: string }>,
		onChange: (value: T) => void,
		groupName: string = "default"
	): void {
		const fieldset = this.contentEl.createEl("fieldset", { cls: "fit-operation-choices" });
		for (const [index, choice] of choices.entries()) {
			const label = fieldset.createEl("label", { cls: "fit-operation-choice" });
			// radio 的 name 必须按组隔离：同一对话框里两组单选共用 name 会导致全组互斥（四选一）
			const input = label.createEl("input", { attr: { type: "radio", name: `fit-choice-${this.constructor.name}-${groupName}`, value: choice.value } });
			input.checked = index === 0;
			input.addEventListener("change", () => { if (input.checked) onChange(choice.value); });
			const copy = label.createDiv({ cls: "fit-operation-choice-copy" });
			copy.createEl("strong", { text: choice.label });
			copy.createDiv({ text: choice.description });
		}
	}

	protected addActions(confirmLabel: string, onConfirm: () => void): void {
		new Setting(this.contentEl).addButton(button => button.setButtonText("取消").onClick(() => this.finish(null)))
			.addButton(button => button.setCta().setButtonText(confirmLabel).onClick(onConfirm));
	}
}

export type BidirectionalOptions = { cleanup: "none" | "last" | "all" };
export class BidirectionalOptionsModal extends OptionsModal<BidirectionalOptions> {
	private cleanup: BidirectionalOptions["cleanup"] = "none";
	onOpen(): void {
		this.titleEl.setText("双向同步：选择冲突副本处理");
		this.contentEl.createEl("p", { text: "同步仍按原规则将远端冲突版本写入 _fit/。清理只删除冲突副本，不合并正文。选择只影响本次操作。" });
		this.addChoices([
			{ value: "none", label: "仅同步，保留冲突副本", description: "不进入清理流程。" },
			{ value: "last", label: "同步后清理本次产生的副本", description: "只清理本轮实际写入的 _fit/ 文件，历史副本保留。" },
			{ value: "all", label: "同步后清理全部冲突副本", description: "包括历史遗留及尚未人工合并的 _fit/ 文件。" }
		], value => { this.cleanup = value; });
		this.addActions("开始双向同步", () => this.finish({ cleanup: this.cleanup }));
	}
}

export type Scope = "last" | "all";

export class CleanupOptionsModal extends OptionsModal<{ scope: Scope }> {
	private selectedScope: Scope = "last";
	constructor(app: App, hasLastConflictSet: boolean) {
		super(app);
		this.hasLastConflictSet = hasLastConflictSet;
	}
	private hasLastConflictSet: boolean;
	onOpen(): void {
		this.titleEl.setText("清理 _fit/ 冲突副本");
		this.contentEl.createEl("p", { text: "只处理本地 _fit/ 内文件，不删除原路径正文，也不向远端传播删除。" });
		this.addChoices([
			{ value: "last", label: "仅上次同步产生的副本", description: this.hasLastConflictSet ? "只处理当前插件运行期间最近一次成功双向同步写入的文件。" : "本次运行尚无可用清单；选择后将显示提示，不会删除文件。" },
			{ value: "all", label: "全部 _fit/ 冲突副本", description: "包括历史遗留及尚未人工合并的文件。" }
		], value => { this.selectedScope = value; });
		this.addActions("扫描并预览", () => this.finish({ scope: this.selectedScope }));
	}
}

function formatTime(epochMs: number): string {
	const d = new Date(epochMs);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 冲突副本预览：每个副本展示副本与原路径文件的修改时间和大小，
 * 给出覆盖方向判断参考；删除按勾选逐项进行，原路径正文不在删除范围。
 */
export class ConflictPreviewModal extends OptionsModal<{ scope: Scope; selected: string[] }> {
	private selectedPaths = new Set<string>();
	private confirmButton: { setDisabled: (b: boolean) => void } | null = null;
	constructor(app: App, private files: ConflictPair[], private previewScope: Scope) {
		super(app);
	}
	onOpen(): void {
		this.titleEl.setText("处理 _fit/ 冲突副本");
		if (this.files.length === 0) {
			this.contentEl.createEl("p", { text: "所选范围内没有冲突副本。" });
			this.addActions("关闭", () => this.finish({ scope: this.previewScope, selected: [] }));
			return;
		}

		this.contentEl.createEl("p", { text: "每个副本是冲突时另一端的内容。对照修改时间与大小决定：把副本内容复制回原文件（采用副本），或保留原文件后删除副本。删除只作用于勾选的副本，原路径正文与远端均不受影响。" });

		const list = this.contentEl.createDiv({ cls: "fit-operation-file-list" });
		for (const file of this.files) {
			this.selectedPaths.add(file.path);
			const row = list.createDiv({ cls: "fit-operation-conflict-item" });

			// 勾选：决定是否删除该副本
			const checkLabel = row.createEl("label", { cls: "fit-operation-conflict-check" });
			const check = checkLabel.createEl("input", { attr: { type: "checkbox" } });
			check.checked = true;
			check.addEventListener("change", () => {
				if (check.checked) this.selectedPaths.add(file.path);
				else this.selectedPaths.delete(file.path);
				this.confirmButton?.setDisabled(this.selectedPaths.size === 0);
			});
			checkLabel.createSpan({ text: "删除副本" });

			const info = row.createDiv({ cls: "fit-operation-conflict-info" });
			info.createEl("code", { text: file.path });
			info.createDiv({ cls: "fit-operation-conflict-meta", text: `副本：${formatTime(file.mtime)}，${file.size} B` });

			// 原路径对照与覆盖方向参考
			const orig = info.createDiv({ cls: "fit-operation-conflict-meta" });
			if (file.originalExists && file.originalMtime !== null && file.originalSize !== null) {
				orig.setText(`原文件：${formatTime(file.originalMtime)}，${file.originalSize} B`);
				// 覆盖方向参考：只比较时间与大小，供用户参考，不做决定
				let hint: string;
				if (file.mtime > file.originalMtime) {
					hint = "副本修改时间较新——若远端版本是你要的内容，可把副本复制回原路径覆盖";
				} else if (file.mtime < file.originalMtime) {
					hint = "原文件修改时间较新——原文件可能已含合并结果，副本通常可直接删除";
				} else {
					hint = "两者修改时间相同——对照内容后自行判断";
				}
				info.createDiv({ cls: "fit-operation-conflict-hint", text: hint });
			} else {
				orig.setText("原文件已不存在——副本是这份内容的唯一本地残留，删除前请确认不需要");
			}
		}

		this.addActions("删除勾选的副本", () => this.finish({ scope: this.previewScope, selected: Array.from(this.selectedPaths) }));
		// 拿到确认按钮引用以支持空勾选时禁用
		const buttons = this.modalEl.querySelectorAll("button");
		buttons.forEach(b => { if (b.textContent === "删除勾选的副本") this.confirmButton = { setDisabled: (d: boolean) => (b.disabled = d) }; });
	}
}

export class BaselineConfirmModal extends OptionsModal<{ confirmed: boolean }> {
	constructor(app: App, private direction: SyncDirection) {
		super(app);
	}
	onOpen(): void {
		this.titleEl.setText("尚无同步基线");
		this.contentEl.createEl("p", {
			text: `本插件实例还没有同步记录（独立于原 Fit 插件，配置不会自动继承），因此无法判断哪些文件有改动。`
		});
		this.contentEl.createEl("p", {
			cls: "fit-operation-warning",
			text: "继续只会读取两端当前状态并记录为基线，不上传、不删除、不覆盖任何文件。"
		});
		this.contentEl.createEl("p", {
			cls: "fit-operation-summary",
			text: "基线建立后即可正常使用增量：后续操作只处理真正变化的文件。注意：本次不会执行任何同步动作，需重新选择操作范围。"
		});
		this.addActions("建立基线（零上传）", () => this.finish({ confirmed: true }));
	}
}
