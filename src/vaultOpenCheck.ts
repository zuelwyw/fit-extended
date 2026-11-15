/**
 * 打开知识库时的检查（与 Obsidian 插件生命周期解耦，便于测试）。
 *
 * 需求（docs/需求说明.md §4）：
 * - 开关默认关闭；开启后打开知识库自动**检查**并生成待审计划；
 * - **不自动执行同步**；关闭开关不影响手动同步；
 * - 发现差异时保留计划供用户直接打开审阅，不重新扫描。
 *
 * 这里不注册任何周期任务——定时同步已按要求移除。
 */

import { SyncPlan } from "./syncTypes";

export type VaultOpenCheckDeps = {
	enabled(): boolean;
	configured(): boolean;
	busy(): boolean;
	/** 生成计划（只读：不写文件、不发布提交） */
	plan(): Promise<SyncPlan>;
	/** 保存待审计划，供用户稍后打开 */
	setPending(plan: SyncPlan | null): void;
	/** 用户可见提示（无差异时不调用） */
	notify(message: string): void;
	log(message: string, data?: Record<string, unknown>): void;
};

export type VaultOpenCheckResult =
	| { status: "skipped"; reason: "disabled" | "not-configured" | "busy" }
	| { status: "no-changes" }
	| { status: "planned"; plan: SyncPlan };

/**
 * 执行一次打开检查。
 *
 * 只生成计划、只保存计划；**任何分支都不会执行同步**。
 */
export async function runVaultOpenCheck(deps: VaultOpenCheckDeps): Promise<VaultOpenCheckResult> {
	if (!deps.enabled()) return { status: "skipped", reason: "disabled" };
	if (!deps.configured()) return { status: "skipped", reason: "not-configured" };
	if (deps.busy()) return { status: "skipped", reason: "busy" };

	const plan = await deps.plan();
	if (plan.operations.length === 0 && plan.conflicts.length === 0) {
		deps.setPending(null);
		deps.log("[Plugin] 打开知识库检查：没有需要同步的变化");
		return { status: "no-changes" };
	}
	deps.setPending(plan);
	deps.log("[Plugin] 打开知识库检查：已生成待审计划", {
		operations: plan.operations.length,
		conflicts: plan.conflicts.length
	});
	deps.notify(
		`检测到 ${plan.operations.length} 项待同步变化、${plan.conflicts.length} 项冲突。执行「Fit 审阅待同步计划」查看，不会自动同步。`
	);
	return { status: "planned", plan };
}
