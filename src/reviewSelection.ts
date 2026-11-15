/**
 * 审阅选择的纯逻辑（与 DOM 无关，便于测试）。
 *
 * 这些规则决定了"哪些项会被执行"，属于会改变结果的东西，必须可单测：
 * - 默认选择：只选不涉及冲突的操作。
 * - 全选：不得把未决冲突裁成某一方，因此冲突路径不进选择集。
 * - 依赖组：同组要么全选要么全不选，不能只执行一半。
 * - 就绪判定：存在未决冲突或（无冲突但一项未选）时不可执行。
 */

import { Conflict, DependencyGroup, PlanOperation, SyncPlan } from "./syncTypes";
import { ReviewDecision } from "./planReviewModal";

/** 选择集可能在外部被替换成缺字段的对象；读取路径一律走这两个守卫。 */
function selectedOf(selection: ReviewSelection): Set<string> {
	return selection?.selected instanceof Set ? selection.selected : new Set<string>();
}

function decisionsOf(selection: ReviewSelection): Record<string, ReviewDecision> {
	return selection?.decisions ?? {};
}

export type ReviewSelection = {
	selected: Set<string>;
	decisions: Record<string, ReviewDecision>;
};

export function initialSelection(plan: SyncPlan): ReviewSelection {
	const conflicted = new Set(plan.conflicts.map(conflict => conflict.path));
	const selected = new Set<string>();
	for (const op of plan.operations) {
		if (!conflicted.has(op.path)) selected.add(op.id);
	}
	return { selected, decisions: {} };
}

export function selectNone(): ReviewSelection {
	return { selected: new Set(), decisions: {} };
}

export function selectAllSafe(plan: SyncPlan, selection: ReviewSelection): ReviewSelection {
	const conflicted = new Set(plan.conflicts.map(conflict => conflict.path));
	const selected = new Set<string>();
	for (const op of plan.operations) {
		if (!conflicted.has(op.path)) selected.add(op.id);
	}
	return { ...selection, selected };
}

export function toggleOperation(selection: ReviewSelection, plan: SyncPlan, operationId: string, checked: boolean): ReviewSelection {
	const selected = new Set(selectedOf(selection));
	if (checked) selected.add(operationId);
	else selected.delete(operationId);
	return applyDependencyGroups(plan, { ...selection, selected });
}

/**
 * 依赖组联动：同组被部分选中时补齐为全选。
 * 与删除同路径的写操作必须一起执行或一起放弃，否则会留下不一致的中间状态。
 */
export function applyDependencyGroups(plan: SyncPlan, selection: ReviewSelection): ReviewSelection {
	const selected = new Set(selectedOf(selection));
	for (const group of plan.dependencyGroups as DependencyGroup[]) {
		const chosen = group.members.filter(id => selected.has(id));
		if (chosen.length === 0 || chosen.length === group.members.length) continue;
		for (const id of group.members) selected.add(id);
	}
	return { ...selection, selected };
}

export function setDecision(selection: ReviewSelection, path: string, decision: ReviewDecision | null): ReviewSelection {
	const decisions = { ...decisionsOf(selection) };
	if (decision === null) delete decisions[path];
	else decisions[path] = decision;
	return { ...selection, decisions };
}

export function unresolvedConflicts(plan: SyncPlan, selection: ReviewSelection): Conflict[] {
	const decisions = decisionsOf(selection);
	return plan.conflicts.filter(conflict => !decisions[conflict.path]);
}

export type Readiness =
	| { ready: true }
	| { ready: false; reason: "unresolved-conflicts" | "nothing-selected"; count?: number };

export function readiness(plan: SyncPlan, selection: ReviewSelection): Readiness {
	const unresolved = unresolvedConflicts(plan, selection);
	if (unresolved.length > 0) return { ready: false, reason: "unresolved-conflicts", count: unresolved.length };
	if (selection.selected.size === 0 && plan.conflicts.length === 0) {
		// 冲突全部决策后即使没有普通操作，也允许执行（决策本身会产生动作）
		return { ready: false, reason: "nothing-selected" };
	}
	return { ready: true };
}

/**
 * 决策是否可用。
 *
 * 手工结果只看"用户是否明确选择了手工"，不看内容是否非空：
 * 空文件是合法的真实内容，用 trim() 非空判定会把它误判成未决策并静默丢弃。
 */
export function isDecisionUsable(decision: ReviewDecision | undefined): boolean {
	if (!decision) return false;
	if (decision.action === "manual") return typeof decision.manualText === "string";
	return true;
}

/** 把弹窗结果整理成执行器需要的形态：丢弃空白手工草稿对应的决策。 */
export function finalizeSelection(plan: SyncPlan, selection: ReviewSelection): ReviewSelection {
	const decisions: Record<string, ReviewDecision> = {};
	for (const [path, decision] of Object.entries(decisionsOf(selection))) {
		if (isDecisionUsable(decision)) decisions[path] = decision;
	}
	return { selected: selectedOf(selection), decisions };
}

export function operationLabel(operation: PlanOperation): string {
	switch (operation.kind) {
		case "write-remote": return operation.reason === "add" ? "新增到远端" : "更新远端";
		case "write-local": return operation.reason === "add" ? "新增到本地" : "更新本地";
		case "delete-remote": return "删除远端";
		case "delete-local": return "删除本地";
	}
}
