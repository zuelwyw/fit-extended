/**
 * Obsidian Plugin Entry Point
 *
 * Defines the FitPlugin class and related types for Obsidian plugin integration.
 */

import { Notice, Plugin, SettingTab } from 'obsidian';
import { Fit } from '@/fit';
import FitNotice from '@/fitNotice';
import FitSettingTab from '@/fitSetting';
import { FitSync } from '@/fitSync';
import { showFileChanges, showUnappliedConflicts } from '@/utils';
import { fitLogger } from '@/logger';
import { CommitSha } from '@/util/hashing';
import { FileStates } from '@/util/changeTracking';
import { handleCriticalError } from '@/util/errorHandling';
import { GitHubConnection } from '@/remotes/githubConnection';
import * as Encryption from "@/encryption";
import { DirectionalOperationRunner, prepareDirectionalOperation, SyncDirection } from '@/directionalOperations';
import { BaselineConfirmModal, BidirectionalOptionsModal, CleanupOptionsModal, ConflictPreviewModal, DirectionOptionsModal, PlanPreviewModal } from '@/operationModals';
import { SyncResult } from '@/syncResult';

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
	checkEveryXMinutes: number
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

/**
 * Discriminated union representing the outcome of a sync operation.
 * Separates business logic (sync result) from UI lifecycle management.
 */
type SuccessfulSync = Extract<SyncResult, { success: true }>;
type SyncOutcome =
	| { status: 'success'; result: SuccessfulSync }
	| { status: 'already-syncing' }
	| { status: 'error'; error: { type: string; message: string; details?: Record<string, unknown> } }
	| { status: 'not-configured' };

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
};


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
	fitSync: FitSync;
	directionalRunner: DirectionalOperationRunner;
	githubConnection: GitHubConnection | null;
	autoSyncIntervalId: number | null;
	fitPullRibbonIconEl: HTMLElement;
	fitPushRibbonIconEl: HTMLElement;
	fitSyncRibbonIconEl: HTMLElement;
	logger = fitLogger; // Explicit reference to singleton for future refactoring
	private activeSyncRequests = 0; // Track number of active sync attempts
	private lastGithubConnectionPat: string | null = null; // Track PAT changes
	private activeManualSyncRequests = 0; // Track number of active manual sync attempts
	private currentSyncNotice: FitNotice | null = null; // The active sync notice (shared by concurrent requests)

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

	// use of arrow functions to ensure this refers to the FitPlugin class
	saveLocalStoreCallback = async (localStore: Partial<LocalStores>): Promise<void> => {
		await this.loadLocalStore();
		this.localStore = {...this.localStore, ...localStore};
		await this.saveLocalStore();
	};

	// ============================================================================
	// BUSINESS LOGIC LAYER
	// ============================================================================

	/**
	 * Execute sync operation with plugin-level concerns:
	 * - Settings validation
	 * - Local store loading
	 * - Result processing (notifications, error formatting)
	 * - Notice updates
	 */
	private async executeSync(triggerType: 'manual' | 'auto'): Promise<SyncOutcome> {
		if (!this.checkSettingsConfigured()) {
			return { status: 'not-configured' };
		}
		await this.loadLocalStore();

		const syncStartTime = Date.now();
		fitLogger.log(`🚀 [SYNC START] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		const syncResult = await this.fitSync.sync(this.currentSyncNotice!);

		if (syncResult.success) {
			const duration = Date.now() - syncStartTime;
			const totalOps = syncResult.changeGroups.reduce((sum, g) => sum + g.changes.length, 0);
			const hasConflicts = syncResult.clash.length > 0;

			fitLogger.log(
				`✅ [SYNC COMPLETE] ${hasConflicts ? 'Success with conflicts' : 'Success'}`,
				{
					duration: `${(duration / 1000).toFixed(2)}s`,
					totalOperations: totalOps,
					conflicts: syncResult.clash.length,
					...(totalOps > 0 && { changes: syncResult.changeGroups }),
					...(hasConflicts && { unresolvedConflicts: syncResult.clash })
				}
			);

			return { status: 'success', result: syncResult };
		} else {
			// Handle already-syncing case - this is expected for concurrent requests
			if (syncResult.error.type === 'already-syncing') {
				fitLogger.log('[Plugin] Sync already in progress', { triggerType });
				return { status: 'already-syncing' };
			}

			// Generate user-friendly message from structured sync error
			const errorMessage = this.fitSync.getSyncErrorMessage(syncResult.error);

			// Log detailed error information for debugging AND to file
			fitLogger.log('[Plugin] Sync failed', {
				type: syncResult.error.type,
				message: errorMessage,
				details: syncResult.error.details || {}
			});

			console.error(`Sync failed: ${errorMessage}`, {
				type: syncResult.error.type,
				...(syncResult.error.details || {})
			});

			return {
				status: 'error',
				error: {
					type: syncResult.error.type,
					message: errorMessage,
					details: syncResult.error.details
				}
			};
		}
	}

	// ============================================================================
	// UI LIFECYCLE MANAGEMENT
	// ============================================================================

	/**
	 * Handle sync start event - manages UI state when a sync request begins.
	 * Only creates notice/animation on the first active request.
	 */
	private onSyncStart(triggerType: 'manual' | 'auto'): void {
		// Track this sync attempt
		this.activeSyncRequests++;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests++;
		}

		// "Real" start = first request - create shared notice
		if (this.activeSyncRequests === 1) {
			this.currentSyncNotice = new FitNotice(
				this.fit,
				["loading"],
				triggerType === 'manual' ? "Initiating sync" : "Auto syncing",
				triggerType === 'manual' ? undefined : 0,  // Auto-sync: hide immediately on success
				triggerType === 'auto' && this.settings.autoSync === "muted"
			);
		}

		// Show animation if this is the first manual sync request
		if (triggerType === 'manual' && this.activeManualSyncRequests === 1) {
			this.fitSyncRibbonIconEl.addClass('animate-icon');
		}
	}

	/**
	 * Handles cleanup when a sync fails with an error.
	 * Unlike onSyncEnd, this does NOT nullify the notice reference,
	 * allowing error notices to remain visible until the user dismisses them.
	 */
	private onSyncError(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}

		// Note: We do NOT nullify this.currentSyncNotice here,
		// keeping the error notice alive for the user to dismiss manually.
	}

	/**
	 * Handle sync end event - manages UI state when a sync request completes.
	 * Only cleans up notice/animation on the last active request.
	 */
	private onSyncEnd(triggerType: 'manual' | 'auto'): void {
		// Decrement counters
		this.activeSyncRequests--;
		if (triggerType === 'manual') {
			this.activeManualSyncRequests--;
		}

		// "Real" end = last request completes - clean up shared notice
		// Note: executeSync already handled success/error display, we just clean up the reference
		if (this.activeSyncRequests === 0) {
			this.currentSyncNotice = null;
		}

		// Clear animation when all manual sync attempts complete
		if (this.activeManualSyncRequests === 0) {
			this.fitSyncRibbonIconEl.removeClass('animate-icon');
		}
	}

	// ============================================================================
	// COORDINATION LAYER (Decorator Pattern)
	// ============================================================================

	/**
	 * Wraps sync execution with UI lifecycle events (notice, animation).
	 * This is the "decorator" that adds UI coordination to the core sync operation.
	 */
	isOperationRunning(): boolean {
		return this.fitSync.syncing || this.directionalRunner.busy;
	}

	private async executeSyncWithUICoordination(triggerType: 'manual' | 'auto', cleanup: 'none' | 'ask' = 'none'): Promise<void> {
		if (this.isOperationRunning()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		fitLogger.log(`[Plugin] ${triggerType === 'manual' ? 'Manual' : 'Auto'} sync requested`);

		this.onSyncStart(triggerType);

		let outcome: SyncOutcome;
		try {
			outcome = await this.executeSync(triggerType);
		} catch (error) {
			// Catch any unhandled exceptions (programming errors, unexpected failures)
			const errorMsg = error instanceof Error ? error.message : String(error);
			const fullMessage = `同步意外失败：${errorMsg}`;

			fitLogger.log('[Plugin] Unhandled sync error', {
				error: errorMsg,
				stack: error instanceof Error ? error.stack : undefined
			});

			console.error(fullMessage, error);

			// Show error in notice and clean up state
			this.currentSyncNotice?.setMessage(fullMessage, true);
			this.onSyncError(triggerType);
			return;
		}

		// Handle all sync outcomes with centralized UI lifecycle management
		switch (outcome.status) {
			case 'success':
				// Show optional notifications
				if (this.settings.notifyConflicts) {
					showUnappliedConflicts(outcome.result.clash);
				}
				if (this.settings.notifyChanges) {
					showFileChanges(outcome.result.changeGroups);
				}

				// Show success completion state in notice
				if (triggerType === 'auto') {
					this.currentSyncNotice!.remove(); // Auto-sync hides notice completely
				} else {
					this.currentSyncNotice!.remove("done"); // Manual shows success state briefly
				}

				// Clean up and nullify notice reference (success can nullify)
				this.onSyncEnd(triggerType);

				// Optional conflict cleanup after a successful manual sync
				if (triggerType === 'manual' && cleanup === 'ask' && outcome.result.conflictFiles && outcome.result.conflictFiles.length > 0) {
					this.currentSyncNotice = new FitNotice(this.fit, [], "正在准备冲突清理");
					await this.startConflictCleanupFlow(outcome.result.conflictFiles, 'last');
					this.currentSyncNotice?.remove('done');
					this.currentSyncNotice = null;
				}
				break;

			case 'already-syncing':
				// Don't modify the notice - it's being used by the active sync
				// The concurrent request just logs and returns (no cleanup needed)
				break;

			case 'not-configured':
				// Settings check failed, sync didn't start
				// No notice to clean up (onSyncStart didn't create one if settings invalid)
				this.onSyncError(triggerType);
				break;

			case 'error':
				// Show sticky error notice
				this.currentSyncNotice!.setMessage(`同步失败：${outcome.error.message}`, true);

				// Clean up state WITHOUT nullifying the error notice reference
				this.onSyncError(triggerType);
				break;
		}
	}

	// ============================================================================
	// PUBLIC ENTRY POINTS (User-triggered sync operations)
	// ============================================================================

	/**
	 * Entry point: User clicks ribbon icon or uses command palette
	 */
	triggerManualSync = async (): Promise<void> => {
		await this.executeSyncWithUICoordination('manual');
	};

	/**
	 * Entry point: Bidirectional sync with per-run conflict cleanup choice.
	 */
	triggerBidirectionalSyncWithOptions = async (): Promise<void> => {
		if (this.isOperationRunning()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		if (!this.checkSettingsConfigured()) return;
		const options = await new BidirectionalOptionsModal(this.app).show();
		if (options === null) return;
		await this.executeSyncWithUICoordination('manual', options.cleanup === 'none' ? 'none' : 'ask');
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
		if (this.isOperationRunning()) {
			new Notice('已有 FIT 操作正在运行，请稍后再试。');
			return;
		}
		if (!this.checkSettingsConfigured()) return;
		await this.loadLocalStore();
		const options = await new DirectionOptionsModal(this.app, direction).show();
		if (options === null) return;
		let plan;
		try {
			plan = await prepareDirectionalOperation(this.fit, direction, options.writeMode, options.deleteUnique);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// 无基线时不再"全量上传建基线"：零上传采纳基线后回到选项流程
			if (message.includes('尚无同步基线')) {
				const confirm = await new BaselineConfirmModal(this.app, direction).show();
				if (confirm === null) return;
				const baselineNotice = new FitNotice(this.fit, [], '建立基线');
				try {
					await this.directionalRunner.adoptBaseline(baselineNotice);
					baselineNotice.remove('done');
				} catch (baselineError) {
					baselineNotice.setMessage(`建立基线失败：${baselineError instanceof Error ? baselineError.message : String(baselineError)}`, true);
					return;
				}
				new Notice('基线已建立，请重新选择本次操作范围。');
				return;
			}
			new Notice(`无法准备${direction === 'upload' ? '上传' : '拉取'}：${message}`);
			return;
		}
		if (plan.changes.length === 0) {
			new Notice(direction === 'upload'
				? '没有需要上传的内容：本地可同步文件已与所选远端状态一致。'
				: '没有需要拉取的内容：远端可同步文件已与所选本地状态一致。');
			return;
		}
		const confirmed = await new PlanPreviewModal(this.app, plan).show();
		if (confirmed === null) return;
		const notice = new FitNotice(this.fit, [direction === 'upload' ? 'fit-push-ribbon-el' : 'fit-pull-ribbon-el'], direction === 'upload' ? '正在上传' : '正在拉取');
		const result = await this.directionalRunner.execute(confirmed, notice);
		this.showDirectionalResult(result, notice);
	}

	private showDirectionalResult(result: SyncResult, notice: FitNotice): void {
		if (result.success) {
			if (this.settings.notifyChanges) {
				showFileChanges(result.changeGroups);
			}
			notice.remove('done');
		} else {
			const errorMessage = result.error.type === 'already-syncing'
				? '已有 FIT 操作正在运行。'
				: this.fitSync.getSyncErrorMessage(result.error);
			notice.setMessage(`${result.error.type === 'already-syncing' ? '操作已跳过' : '操作失败'}：${errorMessage}`, true);
		}
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
		const options = await new CleanupOptionsModal(this.app, this.directionalRunner.hasLastConflictSet || conflictFiles !== null).show();
		if (options === null) return;
		if (options.scope === 'last' && conflictFiles !== null) {
			this.directionalRunner.recordConflicts(conflictFiles.map(path => ({ path, type: 'ADDED' as const })));
		}
		let files;
		try {
			files = await this.directionalRunner.listConflictFiles(conflictFiles !== null && options.scope === 'last' ? 'last' : options.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`冲突清理：${message}`);
			return;
		}
		const confirmed = await new ConflictPreviewModal(this.app, files, options.scope).show();
		if (confirmed === null) return;
		if (files.length === 0) {
			new Notice('没有需要删除的冲突副本。');
			return;
		}
		const result = await this.directionalRunner.cleanupConflicts(options.scope);
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
	 * Entry point: Scheduled sync triggered (usually via timer)
	 */
	async handleAutoSyncTimer() {
		if (!(this.settings.autoSync === "off") && this.checkSettingsConfigured()) {
			if (this.settings.autoSync === "on" || this.settings.autoSync === "muted") {
				await this.executeSyncWithUICoordination('auto');
			} else if (this.settings.autoSync === "remind") {
				const { changes } = await this.fit.getRemoteChanges();
				if (changes.length > 0) {
					const initialMessage = "检测到远端更新，请拉取最新变更。";
					const intervalNotice = new FitNotice(this.fit, ["static"], initialMessage);
					intervalNotice.remove("static");
				}
			}
		}
	}

	async startOrUpdateAutoSyncInterval() {
		// Clear existing interval if it exists
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		// Check remote every X minutes (set in settings)
		this.autoSyncIntervalId = window.setInterval(async () => {
			await this.handleAutoSyncTimer();
		}, this.settings.checkEveryXMinutes * 60 * 1000);
	}

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
			this.fitSync = new FitSync(this.fit, this.saveLocalStoreCallback);
			this.directionalRunner = new DirectionalOperationRunner(this.fit, this.saveLocalStoreCallback);
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

			// register interval to repeat auto check
			await this.startOrUpdateAutoSyncInterval();

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
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
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
					else if (key === "notifyChanges" || key === "notifyConflicts" || key === "enableDebugLogging") {
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
		// update auto sync interval with new setting
		this.startOrUpdateAutoSyncInterval();
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
