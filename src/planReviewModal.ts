/**
 * 计划审阅弹窗（人工审阅 = 第七项能力）
 *
 * 纪律：
 * - 只是"提交模式 + 勾选集合 + 决策结果"，不在弹窗里再算一套同步规则。
 * - 未决冲突不能被"全选"裁成某一方：冲突项必须显式决策才算就绪。
 * - 二进制不冒充文本合并：只提供文件类型、大小与版本选择。
 * - 长清单分组 + 折叠，不把所有附件内容加载进 DOM。
 */

import { App, Modal, Setting } from "obsidian";
import { fitLogger } from "./logger";
import { Conflict, PlanOperation, SyncPlan } from "./syncTypes";
import {
	ReviewSelection, initialSelection, selectNone, selectAllSafe, toggleOperation,
	setDecision, readiness, finalizeSelection
} from "./reviewSelection";

/**
 * 冲突决策。
 *
 * 手工值故意用 `manualText` 而不是 `draft`：它一旦出现就代表"用户明确选择了手工结果"，
 * 因此**空字符串也是合法内容**（空文件是真实存在的文件状态）。
 * 不能用 trim() 非空来判定"是否选了手工"——那会把"明确写成空文件"当成未决策。
 */
export type ReviewDecision =
	| { action: "local" }
	| { action: "remote" }
	/** 手工结果：manualText 是用户确认的最终内容（可为空字符串） */
	| { action: "manual"; manualText: string };

export type ReviewResult = {
	/** 已勾选的操作 id */
	selected: string[];
	/** 每个冲突的决策；没决策的冲突不会出现在这里 */
	decisions: Record<string, ReviewDecision>;
};

export type { ReviewSelection };

/** 展示用时间；未知一律显示"未知"，不编造。 */
function formatTime(value: number | string | null | undefined): string {
	if (value === null || value === undefined) return "未知";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}

/** 单侧内容预览：只在用户主动展开时读取，且截断，避免把大文件塞进 DOM。 */
function renderPreviewSide(container: HTMLElement, label: string, content: string | null | undefined): void {
	const block = container.createDiv({ cls: "fit-conflict-preview-side" });
	block.createDiv({ cls: "fit-conflict-preview-label", text: label });
	if (content === null) {
		block.createDiv({ cls: "fit-operation-conflict-meta", text: "该侧不存在此文件。" });
		return;
	}
	if (content === undefined) {
		block.createDiv({ cls: "fit-operation-conflict-meta", text: "无法读取（可能是二进制或读取失败）。" });
		return;
	}
	const pre = block.createEl("pre", { cls: "fit-conflict-preview-text" });
	pre.textContent = content;
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export class PlanReviewModal extends Modal {
	private storedSelection: ReviewSelection = selectNone();

	/**
	 * 选择集访问器。
	 *
	 * 真实环境里出现过存进来的选择集缺少 selected / decisions 的情况（两次崩溃分别
	 * 报 reading 'has' 和 reading '<路径>'）。界面不该因为状态容器的形状不对就崩，
	 * 这里统一归一化：缺失的字段按"未勾选 / 未决策"补齐。
	 */
	private get selection(): ReviewSelection {
		const raw = this.storedSelection as ReviewSelection | undefined;
		const selected = raw?.selected instanceof Set ? raw.selected : new Set<string>();
		const decisions = raw?.decisions ?? {};
		if (raw?.selected !== selected || raw?.decisions !== decisions) {
			fitLogger.log("[ReviewModal] 选择集形状异常，已归一化", {
				keys: Object.keys(raw ?? {}),
				selectedType: typeof raw?.selected,
				decisionsType: typeof raw?.decisions
			});
			this.storedSelection = { selected, decisions };
		}
		return this.storedSelection;
	}

	private set selection(value: ReviewSelection) {
		this.storedSelection = value;
	}
	private resolveResult!: (value: ReviewResult | null) => void;
	private settled = false;
	readonly result = new Promise<ReviewResult | null>(resolve => { this.resolveResult = resolve; });

	constructor(
		app: App,
		private readonly plan: SyncPlan,
		/**
		 * 按需读取冲突两侧的正文，用于"查看两端内容"。不传则不显示预览入口
		 * （测试或无法安全读取内容的场景）。null 表示该侧不存在。
		 */
		private readonly previewLoader?: (path: string) => Promise<{ local?: string; remote?: string }>,
		/** 两侧最后修改时间：本地取文件 stat，远端取该路径最后一次提交时间 */
		private readonly metaLoader?: (path: string) => Promise<{ local?: number | null; remote?: string | null }>
	) {
		super(app);
		this.modalEl.addClass("fit-operation-modal");
	}

	show(): Promise<ReviewResult | null> {
		// 默认选中"可安全执行"的操作；冲突项不自动进入选择集（见 reviewSelection）。
		this.selection = initialSelection(this.plan);
		this.open();
		return this.result;
	}

	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolveResult(null);
		}
		this.contentEl.empty();
	}

	private finish(value: ReviewResult | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveResult(value);
		this.close();
	}

	private updateReadyState(): void {
		const state = readiness(this.plan, finalizeSelection(this.plan, this.selection));
		this.confirmButton?.setDisabled(!state.ready);
	}

	/**
	 * 取某条冲突的决策。
	 *
	 * 这里必须容忍选择集缺少 decisions 的情况：真实环境里出现过
	 * "decisions 为 undefined" 导致整块冲突区渲染中断（界面只剩一个单选框）。
	 * 渲染不应该因为状态容器的一个字段缺失就整体崩掉。
	 */
	private decisionFor(path: string): ReviewDecision | undefined {
		const selection = this.selection as ReviewSelection | undefined;
		const decisions = selection?.decisions as Record<string, ReviewDecision> | undefined;
		if (!decisions) {
			fitLogger.log("[ReviewModal] 选择集缺少 decisions，按未决策处理（诊断）", {
				selectionKeys: Object.keys(selection ?? {})
			});
			return undefined;
		}
		return decisions[path];
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("审阅同步计划");

		const counts = this.plan.counts;
		contentEl.createEl("p", {
			cls: "fit-operation-summary",
			text: `规则：${describeRule(this.plan)}；方向：${describeDirection(this.plan)}。`
		});
		contentEl.createEl("p", {
			cls: "fit-operation-summary",
			text: `上传 ${counts.writeRemote}、写入本地 ${counts.writeLocal}、删除远端 ${counts.deleteRemote}、删除本地 ${counts.deleteLocal}；冲突 ${counts.conflicts}；排除 ${counts.excluded}${counts.unreadable > 0 ? `；待确认 ${counts.unreadable}` : ""}。`
		});
		// 每一段独立兜底：任何一段渲染失败都不能把后面的内容和底部按钮一起吞掉。
		// 失败时把原因直接写在界面上——静默失败会让用户只看到一个残缺的弹窗。
		this.renderGuarded(contentEl, "文件操作", () => this.renderOperations(contentEl));
		this.renderGuarded(contentEl, "冲突", () => this.renderConflicts(contentEl));
		this.renderGuarded(contentEl, "排除项", () => this.renderExcluded(contentEl));
		this.renderActions(contentEl);
	}

	private renderGuarded(container: HTMLElement, label: string, render: () => void): void {
		try {
			render();
		} catch (error) {
			const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			fitLogger.log(`[ReviewModal] ${label} 渲染失败`, error);
			container.createEl("p", {
				cls: "fit-operation-warning",
				text: `${label}区渲染失败：${message}。请把这句话连同 debug.log 反馈，界面其余部分仍可使用。`
			});
		}
	}

	private renderOperations(container: HTMLElement): void {
		const details = container.createEl("details", { cls: "fit-operation-change-group" });
		details.open = true;
		details.createEl("summary", { text: `文件操作 ${this.plan.operations.length} 项` });
		const list = details.createDiv({ cls: "fit-operation-file-list" });

		if (this.plan.operations.length === 0) {
			list.createEl("span", { text: "没有需要执行的文件操作。" });
			return;
		}

		const groups: Array<[string, PlanOperation[]]> = [
			["上传到远端", this.plan.operations.filter(op => op.kind === "write-remote")],
			["写入本地", this.plan.operations.filter(op => op.kind === "write-local")],
			["删除远端", this.plan.operations.filter(op => op.kind === "delete-remote")],
			["删除本地", this.plan.operations.filter(op => op.kind === "delete-local")]
		];
		for (const [heading, ops] of groups) {
			if (ops.length === 0) continue;
			list.createDiv({ cls: "fit-operation-choice-name", text: `${heading}（${ops.length}）` });
			for (const op of ops) {
				const row = list.createEl("label", { cls: "fit-operation-choice" });
				const checkbox = row.createEl("input", { attr: { type: "checkbox", "data-operation-id": op.id } });
				checkbox.checked = this.selection.selected.has(op.id);
				checkbox.addEventListener("change", () => {
					this.selection = toggleOperation(this.selection, this.plan, op.id, checkbox.checked);
					// 依赖组联动后回写勾选状态，避免界面与选择集不一致
					checkbox.checked = this.selection.selected.has(op.id);
					this.updateReadyState();
				});
				row.createEl("span", { text: op.path });
			}
		}
	}

	private renderConflicts(container: HTMLElement): void {
		if (this.plan.conflicts.length === 0) return;
		const details = container.createEl("details", { cls: "fit-operation-change-group" });
		details.open = true;
		details.createEl("summary", { text: `需要你决策的冲突 ${this.plan.conflicts.length} 项` });

		this.plan.conflicts.forEach((conflict, index) => {
			// 分组名必须唯一：用路径做 slug 时中文会被 \W 整体替换成 '-'，
			// 多个中文路径会落到同一个 radio 组（选了 A，B 的圆点被清空）。
			const groupName = `fit-conflict-${index}`;
			const box = details.createDiv({ cls: "fit-operation-conflict-item" });
			box.createEl("code", { text: conflict.path });
			// 单条冲突的渲染异常只影响这一条：否则一个坏条目会让后面所有冲突和
			// 底部操作按钮一起消失（界面只剩一个孤立的单选框）。
			try {
				// 只有"路径与目录同名"这种无法执行的情形需要原因说明；
				// "双方都修改""内容不同"之类只是复述，删掉。
				if (conflict.kind === "path-collision") {
					box.createDiv({ cls: "fit-operation-conflict-meta", text: describeConflict(conflict) });
				}
				this.renderSideRows(box, conflict);

				if (conflict.binary) {
					// 二进制不提供文本合并，只给版本选择
					box.createDiv({
						cls: "fit-operation-conflict-meta",
						text: "二进制文件，不提供文本编辑：只能选择采用本地或采用远端整个版本。"
					});
					this.renderVersionChoices(box, conflict, groupName);
					return;
				}

				this.renderVersionChoices(box, conflict, groupName);
				this.renderManualDraft(box, conflict, groupName);
				this.renderPreview(box, conflict);
			} catch (error) {
				const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				fitLogger.log(`[ReviewModal] 冲突项渲染失败: ${conflict.path}`, error);
				box.createEl("p", {
					cls: "fit-operation-warning",
					text: `该冲突项渲染失败：${message}（选择集字段：${
						Object.keys(this.selection ?? {}).join("/") || "空"
					}）`
				});
			}
		});
	}

	/**
	 * 冲突两侧的可比事实：是否存在、大小。
	 *
	 * 只显示"存在/存在"时用户无法判断该选哪边——大小是最小可得的客观依据，
	 * 而且不需要把正文读进弹窗。
	 */
	/**
	 * 两侧事实行：存在性、大小、最后修改时间，并标出更大/更新的一侧。
	 *
	 * 时间异步到达后再补标签——用户做选择真正需要的是"哪边更新、哪边更大"，
	 * 只列原始事实等于把比较工作丢回给用户。
	 */
	private renderSideRows(container: HTMLElement, conflict: Conflict): void {
		const rows: Record<"local" | "remote", HTMLElement> = {
			local: this.renderSideRow(container, "本地", conflict.local),
			remote: this.renderSideRow(container, "远端", conflict.remote)
		};
		if (!this.metaLoader) return;

		void this.metaLoader(conflict.path)
			.then(meta => {
				const localTime = this.fillSideTime(rows.local, meta.local);
				const remoteTime = this.fillSideTime(rows.remote, meta.remote);
				this.markNewer(rows, localTime, remoteTime);
				this.markLarger(rows, conflict);
			})
			.catch(() => {
				rows.local.createEl("span", { cls: "fit-conflict-side-time", text: "修改时间未知" });
				rows.remote.createEl("span", { cls: "fit-conflict-side-time", text: "修改时间未知" });
			});
	}

	private renderSideRow(container: HTMLElement, label: string, info: Conflict["local"]): HTMLElement {
		const row = container.createDiv({ cls: "fit-conflict-side" });
		const text = info?.present
			? `${label}：存在，${formatBytes(info.size)}`
			: `${label}：不存在`;
		row.createEl("span", { text });
		return row;
	}

	/** 写入时间文本并返回时间戳（无法比较时返回 null）。 */
	private fillSideTime(row: HTMLElement, value: number | string | null | undefined): number | null {
		const time = row.createEl("span", { cls: "fit-conflict-side-time" });
		if (value === null || value === undefined) {
			time.setText("，修改时间未知");
			return null;
		}
		time.setText(`，最后修改 ${formatTime(value)}`);
		const parsed = new Date(value).getTime();
		return Number.isNaN(parsed) ? null : parsed;
	}

	private markNewer(rows: Record<"local" | "remote", HTMLElement>, local: number | null, remote: number | null): void {
		if (local === null || remote === null || local === remote) return;
		const newer = local > remote ? "local" : "remote";
		rows[newer].addClass("is-newer");
		rows[newer].createEl("span", { cls: "fit-conflict-badge is-newer", text: "更新" });
	}

	private markLarger(rows: Record<"local" | "remote", HTMLElement>, conflict: Conflict): void {
		const localSize = conflict.local?.present ? conflict.local.size : -1;
		const remoteSize = conflict.remote?.present ? conflict.remote.size : -1;
		if (localSize < 0 || remoteSize < 0 || localSize === remoteSize) return;
		const larger = localSize > remoteSize ? "local" : "remote";
		rows[larger].createEl("span", { cls: "fit-conflict-badge is-larger", text: "更大" });
	}

	private renderPreview(container: HTMLElement, conflict: Conflict): void {
		if (!this.previewLoader) return;
		const path = conflict.path;
		const wrapper = container.createDiv({ cls: "fit-conflict-preview" });
		const button = wrapper.createEl("button", { cls: "fit-conflict-preview-toggle", text: "查看两端内容" });
		const output = wrapper.createDiv({ cls: "fit-conflict-preview-body" });
		// 用 class 折叠而不是 hidden 属性：该区块有 display:grid，
		// 会覆盖 [hidden] 的 display:none，导致展开后再也收不回去。
		output.addClass("is-collapsed");
		let loaded = false;
		button.addEventListener("click", () => {
			if (loaded) {
				const collapsed = output.classList.toggle("is-collapsed");
				button.textContent = collapsed ? "查看两端内容" : "隐藏内容";
				return;
			}
			loaded = true;
			button.disabled = true;
			button.textContent = "正在读取…";
			void this.previewLoader?.(path).then(result => {
				output.empty();
				// 存在性以计划为准：不存在显示"不存在"，存在但读不到显示"无法读取"。
				renderPreviewSide(output, "本地", conflict.local?.present ? result.local : null);
				renderPreviewSide(output, "远端", conflict.remote?.present ? result.remote : null);
				output.removeClass("is-collapsed");
				button.textContent = "隐藏内容";
				button.disabled = false;
			}).catch(error => {
				loaded = false;
				button.disabled = false;
				button.textContent = "查看两端内容";
				output.createDiv({
					cls: "fit-operation-conflict-meta",
					text: `读取失败：${error instanceof Error ? error.message : String(error)}`
				});
				output.removeClass("is-collapsed");
			});
		});
	}

	private renderVersionChoices(container: HTMLElement, conflict: Conflict, groupName: string): void {
		const choices: Array<{ value: ReviewDecision["action"]; label: string }> = [
			{ value: "local", label: "采用本地版本" },
			{ value: "remote", label: "采用远端版本" },
			{ value: "manual", label: "手工编辑结果" }
		];
		const fieldset = container.createEl("fieldset", { cls: "fit-operation-choices" });
		for (const choice of choices) {
			const label = fieldset.createEl("label", { cls: "fit-operation-choice" });
			const input = label.createEl("input", { attr: { type: "radio", name: groupName, value: choice.value } });
			input.checked = this.decisionFor(conflict.path)?.action === choice.value;
			input.addEventListener("change", () => {
				if (!input.checked) return;
				if (choice.value === "manual") {
					const previous = this.decisionFor(conflict.path);
					// 选中"手工"即视为已决策：内容先取已有草稿，默认空字符串（合法内容）。
					const manualText = previous?.action === "manual" ? previous.manualText : "";
					this.selection = setDecision(this.selection, conflict.path, { action: "manual", manualText });
					const area = container.querySelector(`textarea[data-conflict-path="${CSS.escape(conflict.path)}"]`) as HTMLTextAreaElement | null;
					if (area && area.value !== manualText) area.value = manualText;
				} else {
					this.selection = setDecision(this.selection, conflict.path, { action: choice.value });
				}
				this.renderManualVisibility(container, conflict);
				this.updateReadyState();
			});
			// 用 createEl("span") 而不是 createSpan：后者依赖 Obsidian 的 DOM 扩展，
			// 缺失时会在渲染中途抛错——整段冲突区（含其余选项、输入框、操作按钮）
			// 会一起消失，界面只剩一个孤立的单选框。
			label.createEl("span", { cls: "fit-operation-choice-label", text: choice.label });
		}
	}

	/** 手工输入框只在选中"手工编辑结果"时出现，避免每个冲突都撑高界面。 */
	private renderManualVisibility(container: HTMLElement, conflict: Conflict): void {
		const wrapper = container.querySelector(
			`[data-manual-for="${CSS.escape(conflict.path)}"]`
		) as HTMLElement | null;
		if (!wrapper) return;
		wrapper.hidden = this.decisionFor(conflict.path)?.action !== "manual";
	}

	private renderManualDraft(container: HTMLElement, conflict: Conflict, groupName: string): void {
		// 手工结果只在内存，确认前不覆盖任何文件；确认后经同一执行流程写入目标端。
		const existing = this.decisionFor(conflict.path);
		const targetHint = this.plan.rule === "merge-no-delete" || this.plan.rule === "two-way-delete"
			? "双向：写入后两端都应为该内容"
			: `单向：写入${this.plan.direction === "upload" ? "远端" : "本地"}，不改写来源端`;
		const wrapper = container.createDiv({
			cls: "fit-operation-manual",
			attr: { "data-manual-for": conflict.path }
		});
		wrapper.hidden = existing?.action !== "manual";
		wrapper.createDiv({ cls: "fit-operation-conflict-meta", text: `手工结果将写入：${describeManualTarget(this.plan)}（${targetHint}）。留空表示把该文件写为空内容。` });
		const area = wrapper.createEl("textarea", {
			cls: "fit-conflict-draft",
			attr: { "data-conflict-path": conflict.path }
		});
		area.rows = 6;
		area.placeholder = "手工编辑结果（可为空；确认后按上面的目标端写入）";
		if (existing?.action === "manual") area.value = existing.manualText;
		area.addEventListener("input", () => {
			// 输入即为手工决策：即使内容为空字符串也照样生效。
			this.selection = setDecision(this.selection, conflict.path, { action: "manual", manualText: area.value });
			// 同步把单选切到"手工"，避免界面与决策不一致
			const radios = container.querySelectorAll(`input[name="${groupName}"]`);
			radios.forEach(radio => {
				(radio as HTMLInputElement).checked = (radio as HTMLInputElement).value === "manual";
			});
			this.updateReadyState();
		});
	}

	private renderExcluded(container: HTMLElement): void {
		if (this.plan.excluded.length === 0) return;
		const details = container.createEl("details", { cls: "fit-operation-change-group" });
		details.createEl("summary", { text: `按规则排除 ${this.plan.excluded.length} 项（不参与本次同步）` });
		const list = details.createDiv({ cls: "fit-operation-file-list" });
		const byReason = new Map<string, string[]>();
		for (const entry of this.plan.excluded) {
			const list2 = byReason.get(entry.reason) ?? [];
			list2.push(entry.source ? `${entry.path}（${entry.source}${entry.rule ? `: ${entry.rule}` : ""}）` : entry.path);
			byReason.set(entry.reason, list2);
		}
		for (const [reason, paths] of byReason) {
			list.createDiv({ cls: "fit-operation-choice-name", text: `${describeExcludeReason(reason)}（${paths.length}）` });
			for (const path of paths.slice(0, 50)) list.createEl("code", { cls: "fit-operation-file", text: path });
			if (paths.length > 50) list.createEl("span", { text: `……另有 ${paths.length - 50} 项` });
		}
	}

	private confirmButton: { setDisabled: (value: boolean) => void } | null = null;

	private syncCheckboxes(container: HTMLElement): void {
		container.querySelectorAll('.fit-operation-file-list input[type="checkbox"]').forEach(el => {
			const input = el as HTMLInputElement;
			const id = input.dataset.operationId;
			if (id) input.checked = this.selection.selected.has(id);
		});
	}

	private renderActions(container: HTMLElement): void {
		const bar = container.createDiv({ cls: "fit-operation-actions" });

		// 次级操作合成一行：勾选范围 + 冲突批量定边。
		// 没有文件操作时不存在"勾选范围"这回事，两个按钮不出现。
		const bulk = new Setting(bar);
		if (this.plan.operations.length > 0) {
			bulk.addButton(button => button.setButtonText("取消全部勾选")
				.onClick(() => {
					this.selection = selectNone();
					this.syncCheckboxes(container);
					this.syncConflictControls(container);
					this.updateReadyState();
				}))
				.addButton(button => button.setButtonText("勾选全部文件操作")
					.onClick(() => {
						this.selection = selectAllSafe(this.plan, this.selection);
						this.syncCheckboxes(container);
						this.updateReadyState();
					}));
		}
		if (this.plan.counts.conflicts > 0) {
			bulk.addButton(button => button.setButtonText("冲突全部采用本地")
				.onClick(() => this.decideAllConflicts(container, "local")))
				.addButton(button => button.setButtonText("冲突全部采用远端")
					.onClick(() => this.decideAllConflicts(container, "remote")));
		}
		// 两者都没有时（理论上不会同时为空）移除空行，避免出现空白条
		if (this.plan.operations.length === 0 && this.plan.counts.conflicts === 0) {
			bulk.settingEl.remove();
		}

		new Setting(bar)
			.addButton(button => button.setButtonText("关闭").onClick(() => this.finish(null)))
			.addButton(button => {
				this.confirmButton = button;
				button.setCta().setButtonText("执行所选").onClick(() => {
					const finalized = finalizeSelection(this.plan, this.selection);
					if (!readiness(this.plan, finalized).ready) return;
					this.finish({ selected: Array.from(finalized.selected), decisions: { ...finalized.decisions } });
				});
			});

		this.updateReadyState();
	}

	/** 把所有未决/已决冲突统一设为某一侧。这是用户显式动作，不是自动裁决。 */
	private decideAllConflicts(container: HTMLElement, action: "local" | "remote"): void {
		for (const conflict of this.plan.conflicts) {
			this.selection = setDecision(this.selection, conflict.path, { action });
		}
		this.syncConflictControls(container);
		this.updateReadyState();
	}

	/** 决策改动后回写单选与手工框显隐，避免界面与决策不一致。 */
	private syncConflictControls(container: HTMLElement): void {
		this.plan.conflicts.forEach((conflict, index) => {
			const decision = this.decisionFor(conflict.path);
			const group = `fit-conflict-${index}`;
			container.querySelectorAll(`input[name="${group}"]`).forEach(el => {
				const radio = el as HTMLInputElement;
				radio.checked = decision?.action === radio.value;
			});
			const wrapper = container.querySelector(
				`[data-manual-for="${CSS.escape(conflict.path)}"]`
			) as HTMLElement | null;
			if (wrapper) wrapper.hidden = decision?.action !== "manual";
		});
	}

}

export function describeRule(plan: SyncPlan): string {
	switch (plan.rule) {
		case "add-missing": return "仅补充缺失文件";
		case "update-one-way": return "单向更新";
		case "overwrite": return "单向覆盖";
		case "mirror": return "单向镜像";
		case "merge-no-delete": return "双向合并（不传播删除）";
		case "two-way-delete": return "双向同步（传播删除）";
	}
}

export function describeDirection(plan: SyncPlan): string {
	if (plan.rule === "merge-no-delete" || plan.rule === "two-way-delete") return "双向";
	return plan.direction === "upload" ? "本地 → 远端" : "远端 → 本地";
}

export function describeConflict(conflict: Conflict): string {
	switch (conflict.kind) {
		case "both-modified": return "双方都修改且内容不同";
		case "modify-delete": return "一端修改、另一端删除";
		case "no-baseline-differs": return "没有共同状态且双方内容不同";
		case "path-collision": return "路径与目录同名，无法直接执行";
	}
}

export function describeExcludeReason(reason: string): string {
	switch (reason) {
		case "reserved": return "插件保留区";
		case "git-metadata": return "Git 元数据";
		case "obsidian-settings": return "Obsidian 设置/主题/插件";
		case "control-metadata": return "控制元数据（规则文件）";
		case "ignored": return "被忽略规则匹配";
		case "local-unreadable-hidden": return "本地无法读取的隐藏路径";
		case "outside-vault": return "越出知识库边界";
		default: return reason;
	}
}

/**
 * 手工结果写入的目标端。
 *
 * 单向规则不能反向改写来源端；双向规则的最终状态是"双方都等于用户确认的结果"。
 */
export function describeManualTarget(plan: SyncPlan): string {
	if (plan.rule === "merge-no-delete" || plan.rule === "two-way-delete") return "两端（本地与远端）";
	return plan.direction === "upload" ? "远端" : "本地";
}
