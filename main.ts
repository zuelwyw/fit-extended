/**
 * Obsidian Plugin Entry Point
 *
 * Defines the FitPlugin class and related types for Obsidian plugin integration.
 */

import { Notice, Plugin, SettingTab } from 'obsidian';
import { Fit } from '@/fit';
import FitNotice from '@/fitNotice';
import FitSettingTab from '@/fitSetting';
import { fitLogger } from '@/logger';
import { CommitSha } from '@/util/hashing';
import { FileStates } from '@/util/changeTracking';
import { handleCriticalError } from '@/util/errorHandling';
import { GitHubConnection } from '@/remotes/githubConnection';
import * as Encryption from "@/encryption";
import { ConflictCleanupRunner } from '@/conflictCleanup';
import { CleanupOptionsModal, ConflictPreviewModal } from '@/operationModals';
import { SyncService } from '@/syncService';
import { PlanReviewModal, ReviewResult } from '@/planReviewModal';
import { SyncPlan, RuleKind, SyncDirection } from '@/syncTypes';
import { RuleChooserModal, RuleChoice } from '@/ruleChooserModal';
import { ExecutionReport } from '@/syncExecutor';
import { CommonStateSnapshot } from '@/commonState';
import { runVaultOpenCheck } from '@/vaultOpenCheck';

/**
 * Plugin configuration interface
 * Settings are persisted in Obsidian's plugin data storage
 */
export interface FitSettings {
	// TODO: When adding support for multiple remote providers (GitLab, Gitea),
	// consider using a discriminated union structure:
	// remote: { provider: "github", pat: string, owner: string, ... }
	//       | { provider: "gitlab", token: string, project: string, ... }
	//       | { provider: "gitea", token: string, owner: string, ... }
	// This would allow type-safe, provider-specific settings.
	// See RemoteVaultProvider type in src/vault.ts for provider enum.
	encryptionPassword: string;
	pat: string;
	owner: string;       // Owner of the repo (may differ from authenticated user for contributor repos)
	avatarUrl: string;
	repo: string;
	branch: string;
	deviceName: string;
	/**
	 * 打开知识库时自动检查变化（默认关闭）。
	 *
	 * 只生成待审计划，不自动执行同步。与旧 autoSync 无关：
	 * 旧字段保留在类型里只为兼容已存配置，不再被消费。
	 */
	checkOnVaultOpen: boolean
	/** @deprecated 旧定时同步字段，仅为兼容已存配置保留，不再消费 */
	checkEveryXMinutes: number
	/** @deprecated 旧自动同步字段，仅为兼容已存配置保留，不再消费 */
	autoSync: "on" | "off" | "muted" | "remind"
	notifyChanges: boolean
	notifyConflicts: boolean
	enableDebugLogging: boolean
}

const DEFAULT_SETTINGS: FitSettings = {
	encryptionPassword: "",
	pat: "",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "",
	checkOnVaultOpen: false,
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	notifyConflicts: true,
	enableDebugLogging: true
};


/**
 * Local state persistence interface
 * Tracks sync state between plugin sessions to enable incremental sync
 */
export interface LocalStores {
	localSha: FileStates                   // File path -> SHA cache
	lastFetchedCommitSha: CommitSha | null // Last synced commit
	lastFetchedRemoteSha: FileStates       // Remote file path -> SHA cache
}

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
};

/** 默认一键同步规则：双向同步、传播删除，且必须先审阅再执行。 */
export const DEFAULT_SYNC_RULE: RuleKind = "two-way-delete";


/**
 * FIT Plugin - Obsidian integration layer for sync engine.
 *
 * Thin integration layer between Obsidian and the FIT sync engine.
 * Handles Obsidian-specific concerns only:
 * - Plugin lifecycle (load/unload)
 * - Settings UI and persistence
 * - Ribbon icons and commands
 * - Auto-sync scheduling
 * - Delegating to FitSync for all business logic
 *
 * Architecture:
 * - **Role**: Obsidian plugin lifecycle manager and UI coordinator
 * - **Delegates to**: FitSync (sync orchestration), Fit (data access)
 * - **Manages**: User settings, auto-sync intervals, UI notifications
 *
 * @see FitSync - The sync orchestrator (contains business logic)
 * @see Fit - Data access layer for local/remote storage
 */
export default class FitPlugin extends Plugin {
	settings: FitSettings;
	settingTab: FitSettingTab;
	localStore: LocalStores;
	fit: Fit;
	conflictCleanup: ConflictCleanupRunner;
	syncService: SyncService;
	githubConnection: GitHubConnection | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;
	logger = fitLogger; // Explicit reference to singleton for future refactoring
	private activeSyncRequests = 0; // Track number of active sync attempts
	private lastGithubConnectionPat: string | null = null; // Track PAT changes
	private activeManualSyncRequests = 0; // Track number of active manual sync attempts
	private currentSyncNotice: FitNotice | null = null; // The active sync notice (shared by concurrent requests)
	/** 共同状态的持久化镜像（写入 plugin data，与扫描缓存分开） */
	commonStateSnapshot: CommonStateSnapshot | null = null;
	/** 打开知识库检查生成的待审计划（复用，不重扫、不自动执行） */
	pendingPlan: SyncPlan | null = null;
	/** 短期运行互斥标志（同步流程专用，不暴露给用户） */
	private syncInFlight = false;

	// if settings not configured, open settings to let user quickly setup
	// Note: this is not a stable feature and might be disabled at any point in the future
	openPluginSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const appWithSetting = this.app as any as {
			setting: {
				open(): void;
				openTabById(id: string): SettingTab | null;
			}
		};
		appWithSetting.setting.open();
		appWithSetting.setting.openTabById("fit-extended");
	}

	checkSettingsConfigured(): boolean {
		const actionItems: Array<string> = [];
		if (this.settings.pat === "") {
			actionItems.push("填写 GitHub 个人访问令牌");
		}
		if (this.settings.owner === "") {
			actionItems.push("选择或填写仓库所有者");
		}
		if (this.settings.repo === "") {
			actionItems.push("选择或填写要同步的仓库");
		}
		if (this.settings.branch === "") {
			actionItems.push("选择要同步的分支");
		}

		if (actionItems.length > 0) {
			const initialMessage = "设置尚未完成，请先处理以下事项：\n" + actionItems.join("\n");
			const settingsNotice = new FitNotice(this.fit, ["static"], initialMessage);
			this.openPluginSettings();
			settingsNotice.remove("static");
			return false;

		}

		this.fit.loadSettings(this.settings);
		return true;
	}

	/**
	 * 保存同步状态：共同状态与扫描缓存分开写。
	 * 只保存摘要/提交标识等最小元数据，不保存历史内容副本。
	 */
	saveSyncStateCallback = async (update: {
		commonState: CommonStateSnapshot;
		localSha: Record<string, string>;
		lastFetchedRemoteSha: Record<string, string>;
	}): Promise<void> => {
		await this.loadLocalStore();
		this.commonStateSnapshot = update.commonState;
		// 扫描缓存照旧保存（减少重复 I/O），但不再充当"已同步"的依据。
		this.localStore = {
			...this.localStore,
			localSha: update.localSha as FileStates,
			lastFetchedRemoteSha: update.lastFetchedRemoteSha as FileStates
		};
		await this.saveLocalStore();
	};

	// use of arrow functions to ensure this refers to the FitPlugin class
	saveLocalStoreCallback = async (localStore: Partial<LocalStores>): Promise<void> => {
		await this.loadLocalStore();
		this.localStore = {...this.localStore, ...localStore};
		await this.saveLocalStore();
	};

	// ============================================================================
	// RUN STATE
	// ============================================================================

	/**
	 * 是否已有同步操作在运行。
	 *
	 * 只做短期运行互斥：不建立用户可见的暂停/恢复状态机。
	 */
	/**
	 * 是否已有同步操作在运行。
	 *
	 * 只看本流程自身的短期互斥与冲突清理状态——不再依赖旧 FitSync 的 syncing 标志
	 * （那条管线已不再被调用，看它等于永远放行，快速点击可同时准备/执行）。
	 */
	isOperationRunning(): boolean {
		return this.syncInFlight || this.conflictCleanup.busy;
	}

	/**
	 * 短期运行互斥：在第一次 await 之前占用，finally 释放。
	 *
	 * 不是用户可见的暂停/恢复状态机，只防同一次会话内的重入。
	 * @returns 拿到运行权时返回 true
	 */
	private tryAcquireSync(): boolean {
		if (this.isOperationRunning()) return false;
		this.syncInFlight = true;
		return true;
	}

	private releaseSync(): void {
		this.syncInFlight = false;
	}

	// ============================================================================
	// PUBLIC ENTRY POINTS (User-triggered sync operations)
	// ============================================================================

	/**
	 * Entry point: 默认一键同步。
	 *
	 * 固定为「双向同步、传播删除 → 先审阅 → 执行」，与需求和默认值一致。
	 */
	triggerManualSync = async (): Promise<void> => {
		await this.runReviewedSync({ rule: DEFAULT_SYNC_RULE });
	};

	/**
	 * 统一同步入口：检查 → 计划 → 审阅（逐项/决策）→ 执行 → 逐项结果。
	 *
	 * 所有规则共用这一个流程；界面只提交模式、方向、勾选集合与决策。
	 */
	private async runReviewedSync(choice: RuleChoice): Promise<void> {
		// 互斥在**第一次 await 之前**占用：否则快速双击会两个流程同时准备。
		if (!this.tryAcquireSync()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		try {
			await this.runReviewedSyncUnlocked(choice);
		} finally {
			this.releaseSync();
		}
	}

	/**
	 * 已持有互斥时的准备与执行主体。
	 *
	 * 供已经占用互斥的入口复用（规则选择入口需要先弹选择框再准备），
	 * 因此这里不再重复抢锁，避免自己把自己挡在门外。
	 */
	private async runReviewedSyncUnlocked(choice: RuleChoice): Promise<void> {
		{
			if (!this.checkSettingsConfigured()) return;
			await this.loadLocalStore();

			const notice = new FitNotice(this.fit, ["loading"], "正在检查两端状态…");
			let plan: SyncPlan;
			try {
				plan = await this.syncService.plan(
					choice.rule,
					choice.direction,
					this.localStore,
					// 进度只报阶段与计数，不含路径和内容：大库检查时提示持续可见地推进，
					// 避免用户面对长时间不变的"正在检查"。
					(stage, completed, total) => {
						const label = stage === "compare" ? "正在比较两端内容" : "正在检查两端状态";
						notice.setMessage(total > 0 ? `${label}（${completed}/${total}）…` : `${label}…`);
					}
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notice.setMessage(`检查失败：${message}`, true);
				return;
			}
			notice.remove("done");

			if (plan.operations.length === 0 && plan.conflicts.length === 0) {
				new Notice(plan.excluded.length > 0
					? `没有需要同步的变化（按规则排除 ${plan.excluded.length} 项）。`
					: '没有需要同步的变化：两端已一致。');
				return;
			}

			const review = await new PlanReviewModal(this.app, plan, path => this.previewConflictSides(path), path => this.conflictMetaSides(path)).show();
			if (review === null) return;
			await this.executeReviewedPlan(plan, review);
		}
	}

	/**
	 * 读取冲突路径两侧的正文，供审阅弹窗按需预览。
	 *
	 * 只读、截断；读取失败返回 undefined（界面显示"无法读取"），
	 * 不让一条读不到的路径把整个审阅弹窗打断。
	 */
	private async previewConflictSides(path: string): Promise<{ local?: string; remote?: string }> {
		const PREVIEW_LIMIT = 4000;
		const read = async (load: () => Promise<{ toPlainText(): string }>): Promise<string | undefined> => {
			try {
				const text = (await load()).toPlainText();
				return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n…（已截断）` : text;
			} catch {
				return undefined;
			}
		};
		return {
			local: await read(() => this.fit.localVault.readFileContent(path)),
			remote: await read(() => this.fit.remoteVault.readFileContent(path))
		};
	}

	/**
	 * 冲突两侧的最后修改时间。
	 *
	 * 本地取文件 stat.mtime；远端用"该路径最后一次提交时间"（Git 不保存文件 mtime）。
	 * 任一读取失败返回 null，界面显示"未知"，不猜。
	 */
	private async conflictMetaSides(path: string): Promise<{ local?: number | null; remote?: string | null }> {
		let local: number | null = null;
		try {
			const stat = await this.fit.localVault.vault.adapter.stat(path);
			local = (stat as { mtime?: number } | null)?.mtime ?? null;
		} catch {
			local = null;
		}
		let remote: string | null = null;
		try {
			const vault = this.fit.remoteVault as unknown as { lastCommitTimeOf?(p: string): Promise<string | null> };
			remote = vault.lastCommitTimeOf ? await vault.lastCommitTimeOf(path) : null;
		} catch {
			remote = null;
		}
		return { local, remote };
	}

	/**
	 * 执行一份已审阅的计划。
	 *
	 * 入口（手动默认、规则选择、启动检查的待审计划）共用这一步，
	 * 不各自复制执行逻辑。
	 */
	private async executeReviewedPlan(plan: SyncPlan, review: ReviewResult): Promise<void> {
		const running = new FitNotice(this.fit, ["loading"], "正在执行所选操作…");
		const controller = new AbortController();
		running.addButton("中止", () => {
			controller.abort();
			running.setMessage("已请求中止，正在收尾…");
		});
		let report: ExecutionReport;
		try {
			report = await this.syncService.execute(
				plan, review.selected, review.decisions, this.localStore,
				(stage, completed, total) => running.setMessage(`${stage}（${completed}/${total}）…`),
				controller.signal
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			running.setMessage(`执行失败：${message}`, true);
			return;
		}
		running.remove("done");
		this.pendingPlan = null;
		this.showExecutionReport(report, plan);
	}

	/**
	 * 逐项结果展示：如实区分已完成、失败、结果待确认与未选。
	 * 不虚报成功，也不把未选项算进本次同步。
	 */
	private showExecutionReport(report: ExecutionReport, plan: SyncPlan): void {
		if (report.rejected) {
			new Notice(`未执行：${report.rejected.reason}`, 0);
			return;
		}
		const lines: string[] = [];
		if (report.succeeded.length > 0) lines.push(`已完成 ${report.succeeded.length} 项`);
		if (report.failed.length > 0) lines.push(`失败 ${report.failed.length} 项`);
		if (report.uncertain.length > 0) lines.push(`结果待确认 ${report.uncertain.length} 项`);
		if (report.skipped.length > 0) lines.push(`未选 ${report.skipped.length} 项（未视为已同步）`);
		if (plan.rule === "mirror") {
			lines.push(report.mirrorComplete ? "镜像已完整执行" : "镜像未完整执行：本次只处理了所选项目");
		}
		if (lines.length === 0) lines.push("没有执行任何操作");

		const failedDetail = report.failed.slice(0, 3).map(item => `· ${item.path}: ${item.outcome.status === "failed" ? item.outcome.error : ""}`);
		const uncertainDetail = report.uncertain.slice(0, 3).map(item => `· ${item.path}: 需先核对实际状态，不要直接重试`);
		const body = [lines.join("；"), ...failedDetail, ...uncertainDetail].join("\n");
		const sticky = report.failed.length > 0 || report.uncertain.length > 0 || Boolean(report.persistError);
		if (report.persistError) {
			// 关键：写入结果已发生，只是状态没记住。必须讲清"做了什么"和"下次先核对"。
			new Notice(
				`${body}\n\n同步结果未保存：${report.persistError}\n` +
				`上述文件/远端改动已经发生，不会被撤销。下次操作前请先重新检查，插件会按实际状态核对，不盲目重复执行。`,
				0
			);
		} else {
			new Notice(body, sticky ? 0 : 8000);
		}
		fitLogger.log("[Plugin] 执行结果", {
			succeeded: report.succeeded.length,
			failed: report.failed.length,
			uncertain: report.uncertain.length,
			skipped: report.skipped.length,
			mirrorComplete: report.mirrorComplete,
			...(report.persistError ? { persistError: report.persistError } : {})
		});
	}

	/**
	 * 入口：显式选择规则与方向（单向四类 / 双向两类）。
	 * @param preferredDirection 从上传/拉取按钮进入时预选方向
	 */
	triggerSyncWithRuleChoice = async (bidirectional: boolean, preferredDirection?: SyncDirection): Promise<void> => {
		if (!this.tryAcquireSync()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		try {
			if (!this.checkSettingsConfigured()) return;
			const choice = await new RuleChooserModal(this.app, bidirectional, preferredDirection).show();
			if (choice === null) return;
			// 已在互斥内：直接走内部准备流程，避免二次抢占自己。
			await this.runReviewedSyncUnlocked(choice);
		} finally {
			this.releaseSync();
		}
	};

	/**
	 * Entry point: 双向同步（选择传播删除或不传播删除）。
	 *
	 * 旧的"同步后顺带清理冲突副本"不再作为同步路径的一部分：
	 * 冲突副本清理是独立的历史兼容功能，同步流程不依赖它。
	 */
	triggerBidirectionalSyncWithOptions = async (): Promise<void> => {
		await this.triggerSyncWithRuleChoice(true);
	};

	/**
	 * Entry point: one-way upload with per-run unique-file choice.
	 */
	triggerDirectionalUpload = async (): Promise<void> => {
		await this.runDirectionalOperation('upload');
	};

	/**
	 * Entry point: one-way pull with per-run unique-file choice.
	 */
	triggerDirectionalPull = async (): Promise<void> => {
		await this.runDirectionalOperation('pull');
	};

	private async runDirectionalOperation(direction: SyncDirection): Promise<void> {
		// 单向入口统一走四类规则的审阅流程；方向由调用入口决定。
		await this.triggerSyncWithRuleChoice(false, direction);
	}

	/**
	 * Entry point: standalone conflict cleanup with per-run scope choice.
	 */
	triggerConflictCleanup = async (): Promise<void> => {
		if (this.isOperationRunning()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		if (!this.checkSettingsConfigured()) return;
		const notice = new FitNotice(this.fit, [], '正在准备冲突清理');
		await this.startConflictCleanupFlow(null, null);
		notice.remove('done');
	};

	/**
	 * Shared flow: choose scope, list candidate files, confirm, delete.
	 * @param conflictFiles - paths written by the last sync; null means standalone flow
	 */
	private async startConflictCleanupFlow(conflictFiles: string[] | null, _scope: 'last' | null): Promise<void> {
		const options = await new CleanupOptionsModal(this.app, this.conflictCleanup.hasLastConflictSet || conflictFiles !== null).show();
		if (options === null) return;
		if (options.scope === 'last' && conflictFiles !== null) {
			this.conflictCleanup.recordConflicts(conflictFiles.map(path => ({ path, type: 'ADDED' as const })));
		}
		let files;
		try {
			files = await this.conflictCleanup.listConflictFiles(conflictFiles !== null && options.scope === 'last' ? 'last' : options.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`冲突清理：${message}`);
			return;
		}
		const confirmed = await new ConflictPreviewModal(this.app, files, options.scope).show();
		if (confirmed === null) return;
		if (confirmed.selected.length === 0) {
			new Notice('未勾选任何副本，未删除任何文件。');
			return;
		}
		const result = await this.conflictCleanup.cleanupConflicts(options.scope, confirmed.selected);
		if (result.failed.length > 0) {
			const failedList = result.failed.map(entry => `${entry.path}: ${entry.error}`).join('\n');
			new Notice(`冲突清理完成，但有 ${result.failed.length} 项失败：\n${failedList}`);
		} else {
			new Notice(`冲突清理完成：已删除 ${result.deleted.length} 个文件。`);
		}
	}

	loadRibbonIcons() {
		// Pull from remote then Push to remote if no clashing changes detected during pull
		// TODO: Update title from "GitHub" to selected remote service when other services are supported.
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', '同步到 GitHub', this.triggerManualSync);
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el');
		this.fitPullRibbonIconEl = this.addRibbonIcon('download', '从 GitHub 拉取（单向）', () => this.triggerDirectionalPull());
		this.fitPullRibbonIconEl.addClass('fit-pull-ribbon-el');
		this.fitPushRibbonIconEl = this.addRibbonIcon('upload', '上传到 GitHub（单向）', () => this.triggerDirectionalUpload());
		this.fitPushRibbonIconEl.addClass('fit-push-ribbon-el');
	}

	/**
	 * 打开知识库时的自动检查。
	 *
	 * 只有开关打开时才做一次检查并生成待审计划；**不执行同步**，
	 * 也不注册任何周期任务。保存设置不会重新触发"打开"事件。
	 */
	/**
	 * 打开知识库时的自动检查。
	 *
	 * 只检查、只生成计划，**不执行同步**。计划会被保留下来，用户可直接
	 * 打开该待审计划进入审阅（不重新扫描）。无差异时只记日志，不打扰用户。
	 */
	async checkOnVaultOpenIfEnabled(): Promise<void> {
		if (!this.settings.checkOnVaultOpen) return;
		if (!this.checkSettingsConfigured()) return;
		if (this.isOperationRunning()) return;
		try {
			await this.loadLocalStore();
			await runVaultOpenCheck({
				enabled: () => this.settings.checkOnVaultOpen,
				configured: () => this.checkSettingsConfigured(),
				busy: () => this.isOperationRunning(),
				plan: () => this.syncService.plan(DEFAULT_SYNC_RULE, undefined, this.localStore),
				setPending: plan => { this.pendingPlan = plan; },
				notify: message => { new Notice(message, 10000); },
				log: (message, data) => fitLogger.log(message, data)
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fitLogger.log(`[Plugin] 打开知识库检查失败: ${message}`, { error });
		}
	}

	/**
	 * 打开待审计划：复用启动检查生成的计划，不再重新扫描。
	 * 没有待审计划时退化为一次新的检查（同样只生成计划，不执行）。
	 */
	triggerReviewPendingPlan = async (): Promise<void> => {
		if (!this.tryAcquireSync()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		try {
			if (!this.checkSettingsConfigured()) return;
			let plan = this.pendingPlan;
			if (!plan) {
				await this.loadLocalStore();
				try {
					plan = await this.syncService.plan(DEFAULT_SYNC_RULE, undefined, this.localStore);
				} catch (error) {
					new Notice(`检查失败：${error instanceof Error ? error.message : String(error)}`);
					return;
				}
			}
			if (plan.operations.length === 0 && plan.conflicts.length === 0) {
				this.pendingPlan = null;
				new Notice('没有需要同步的变化：两端已一致。');
				return;
			}
			const reviewed = plan;
			const review = await new PlanReviewModal(this.app, reviewed).show();
			if (review === null) return;
			this.pendingPlan = null;
			await this.executeReviewedPlan(reviewed, review);
		} finally {
			this.releaseSync();
		}
	};

	async onload() {
		try {
			// Initialize logger with vault and plugin directory for cross-platform diagnostics
			// This is done first so the logger is available if later initialization steps fail.
			if (this.manifest.dir) {
				fitLogger.configure(this.app.vault, this.manifest.dir);
			}

			await this.loadSettings();
			fitLogger.setEnabled(this.settings.enableDebugLogging);

			fitLogger.log('[Plugin] Starting plugin initialization');

			await this.loadLocalStore();

			Encryption.init(this);

			this.githubConnection = this.settings.pat
				? new GitHubConnection(this.settings.pat)
				: null;
			this.fit = new Fit(this.settings, this.localStore, this.app.vault);
			this.conflictCleanup = new ConflictCleanupRunner(this.fit);
			this.syncService = new SyncService(this.fit, this.saveSyncStateCallback, this.app);
			this.settingTab = new FitSettingTab(this.app, this);
			this.loadRibbonIcons();

			// Add command to command palette for fit sync
			this.addCommand({
				id: 'fit-sync',
				name: 'Fit 双向同步',
				callback: this.triggerManualSync
			});
			this.addCommand({
				id: 'fit-sync-options',
				name: 'Fit 双向同步（可选冲突清理）',
				callback: this.triggerBidirectionalSyncWithOptions
			});
			this.addCommand({
				id: 'fit-review-pending',
				name: 'Fit 审阅待同步计划（打开知识库检查结果）',
				callback: this.triggerReviewPendingPlan
			});
			this.addCommand({
				id: 'fit-sync-two-way',
				name: 'Fit 双向同步（选择传播删除或不传播）',
				callback: () => this.triggerSyncWithRuleChoice(true)
			});
			this.addCommand({
				id: 'fit-upload',
				name: 'Fit 单向上传（仅上传到 GitHub）',
				callback: this.triggerDirectionalUpload
			});
			this.addCommand({
				id: 'fit-pull',
				name: 'Fit 单向拉取（仅从 GitHub 下载）',
				callback: this.triggerDirectionalPull
			});
			this.addCommand({
				id: 'fit-cleanup-conflicts',
				name: 'Fit 清理冲突副本（_fit/）',
				callback: this.triggerConflictCleanup
			});

			// This adds a settings tab so the user can configure various aspects of the plugin
			this.addSettingTab(new FitSettingTab(this.app, this));

			// 打开知识库只检查、不执行；开关默认关闭，不注册任何周期任务。
			void this.checkOnVaultOpenIfEnabled();

			fitLogger.log('[Plugin] Plugin initialization completed successfully');
		} catch (error) {
			handleCriticalError('插件加载失败', error, {
				logger: fitLogger,
				showNotice: true
			});
			throw error;
		}
	}

	onunload() {
		// 不再有周期任务需要清理（定时同步已移除）。
	}

	async loadSettings() {
		const userSetting = await this.loadData();
		const settings = Object.assign({}, DEFAULT_SETTINGS, userSetting);
		const settingsObj: FitSettings = Object.keys(DEFAULT_SETTINGS).reduce(
			(obj, key: keyof FitSettings) => {
				if (settings.hasOwnProperty(key)) {
					if (key == "checkEveryXMinutes") {
						obj[key] = Number(settings[key]);
					}
					else if (key === "notifyChanges" || key === "notifyConflicts" || key === "enableDebugLogging" || key === "checkOnVaultOpen") {
						obj[key] = Boolean(settings[key]);
					}
					else {
						obj[key] = settings[key];
					}
				}
				return obj;
			}, {} as FitSettings);
		this.settings = settingsObj;
	}

	async loadLocalStore() {
		const localStore = Object.assign({}, DEFAULT_LOCAL_STORE, await this.loadData());
		const localStoreObj: LocalStores = Object.keys(DEFAULT_LOCAL_STORE).reduce(
			(obj, key: keyof LocalStores) => {
				if (localStore.hasOwnProperty(key)) {
					obj[key] = localStore[key];
				}
				return obj;
			}, {} as LocalStores);
		this.localStore = localStoreObj;
	}

	// allow saving of local stores property, passed in properties will override existing stored value
	async saveLocalStore() {
		const data = Object.assign({}, DEFAULT_LOCAL_STORE, await this.loadData());
		await this.saveData({...data, ...this.localStore});
		// sync local store to Fit class as well upon saving
		this.fit.loadLocalStore(this.localStore);
	}

	async saveSettings() {
		const data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		await this.saveData({...data, ...this.settings});
		// 保存设置不重新触发"打开知识库"事件，也不注册周期任务。
		// sync settings to Fit class as well upon saving
		this.fit.loadSettings(this.settings);

		// Update GitHubConnection only when PAT changes
		if (this.settings.pat !== this.lastGithubConnectionPat) {
			if (this.settings.pat) {
				this.githubConnection = new GitHubConnection(this.settings.pat);
				this.lastGithubConnectionPat = this.settings.pat;
			} else {
				this.githubConnection = null;
				this.lastGithubConnectionPat = null;
			}
		}
	}
}
