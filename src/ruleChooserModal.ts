/**
 * 规则选择弹窗：单向入口在此选择四类规则与方向，双向入口选择两类规则。
 *
 * 只是"选规则"，不在这里计算任何同步结果——规则由计划生成器统一执行。
 */

import { App, Modal, Setting } from "obsidian";
import { RuleKind, SyncDirection } from "./syncTypes";

export type RuleChoice = {
	rule: RuleKind;
	direction?: SyncDirection;
};

type Option = {
	rule: RuleKind;
	direction?: SyncDirection;
	label: string;
	description: string;
};

const ONE_WAY_OPTIONS: Option[] = [
	{
		rule: "add-missing", direction: "upload",
		label: "上传：仅补充远端缺失文件",
		description: "本地有、远端没有才写入。远端已有同名文件绝不覆盖，远端独有文件保留。"
	},
	{
		rule: "update-one-way", direction: "upload",
		label: "上传：单向更新远端",
		description: "按上次共同状态只把本地改动写到远端；远端单方修改保留；双方都改且不同则报冲突。"
	},
	{
		rule: "overwrite", direction: "upload",
		label: "上传：单向覆盖远端",
		description: "远端有同名的文件一律以本地内容为准；远端独有文件保留。"
	},
	{
		rule: "mirror", direction: "upload",
		label: "上传：单向镜像远端",
		description: "使远端与本地一致，包括删除远端独有的同步范围内文件；被忽略对象不删。"
	},
	{
		rule: "add-missing", direction: "pull",
		label: "拉取：仅补充本地缺失文件",
		description: "远端有、本地没有才写入。本地已有同名文件绝不覆盖，本地独有文件保留。"
	},
	{
		rule: "update-one-way", direction: "pull",
		label: "拉取：单向更新本地",
		description: "按上次共同状态只把远端改动写到本地；本地单方修改保留；双方都改且不同则报冲突。"
	},
	{
		rule: "overwrite", direction: "pull",
		label: "拉取：单向覆盖本地",
		description: "本地有同名的文件一律以远端内容为准；本地独有文件保留。"
	},
	{
		rule: "mirror", direction: "pull",
		label: "拉取：单向镜像本地",
		description: "使本地与远端一致，包括删除本地独有的同步范围内文件；被忽略对象不删。"
	}
];

const TWO_WAY_OPTIONS: Option[] = [
	{
		rule: "two-way-delete",
		label: "双向同步（传播删除）",
		description: "基于共同状态交换新增、修改和删除。删改冲突交你决策，不自动判任一方获胜。"
	},
	{
		rule: "merge-no-delete",
		label: "双向合并（不传播删除）",
		description: "交换新增与修改；一端缺失、另一端仍有则补回。改名按路径处理，旧路径保留。"
	}
];

export class RuleChooserModal extends Modal {
	private chosen: Option;
	private resolveChoice!: (value: RuleChoice | null) => void;
	private settled = false;
	readonly result = new Promise<RuleChoice | null>(resolve => { this.resolveChoice = resolve; });

	private readonly options: Option[];

	constructor(app: App, private readonly bidirectional: boolean, preferredDirection?: SyncDirection) {
		super(app);
		this.modalEl.addClass("fit-operation-modal");
		// 从"上传"/"拉取"按钮进入时只列该方向的规则：
		// 两个入口本来就代表方向，再让用户在一次上传里看到"拉取"选项是冗余且误导的。
		this.options = bidirectional
			? TWO_WAY_OPTIONS
			: preferredDirection
				? ONE_WAY_OPTIONS.filter(option => option.direction === preferredDirection)
				: ONE_WAY_OPTIONS;
		this.chosen = this.options[0];
	}

	show(): Promise<RuleChoice | null> {
		this.open();
		return this.result;
	}

	private finish(value: RuleChoice | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveChoice(value);
		this.close();
	}

	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice(null);
		}
		this.contentEl.empty();
	}

	onOpen(): void {
		const options = this.options;
		const direction = options[0]?.direction;
		this.titleEl.setText(
			this.bidirectional
				? "双向同步：选择本次规则"
				: direction === "upload" ? "上传到 GitHub：选择规则" : "从 GitHub 拉取：选择规则"
		);

		const fieldset = this.contentEl.createEl("fieldset", { cls: "fit-operation-choices" });
		for (const [index, option] of options.entries()) {
			const label = fieldset.createEl("label", { cls: "fit-operation-choice" });
			const input = label.createEl("input", {
				attr: { type: "radio", name: "fit-rule-choice", value: `${option.rule}:${option.direction ?? "both"}` }
			});
			input.checked = index === 0;
			input.addEventListener("change", () => { if (input.checked) this.chosen = option; });
			const copy = label.createDiv({ cls: "fit-operation-choice-copy" });
			copy.createEl("strong", { text: option.label });
			copy.createDiv({ text: option.description });
		}

		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("取消").onClick(() => this.finish(null)))
			.addButton(button => button.setCta().setButtonText("检查并预览").onClick(() =>
				this.finish({ rule: this.chosen.rule, direction: this.chosen.direction })));
	}
}
