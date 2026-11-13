import FitPlugin from "@main";
import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import { setEqual } from "./utils";
import { GitHubOwnerSuggest, GitHubRepoSuggest } from "./util/obsidianHelpers";
import { VaultError } from "./vault";
import { fitLogger } from "./logger";
import FitNotice from "./fitNotice";
import * as Encryption from "./encryption";

type RefreshCheckPoint = "repo(0)" | "branch(1)" | "link(2)" | "initialize" | "withCache";

/**
 * Settings UI for Fit plugin.
 *
 * Sections:
 * - GitHub authentication (PAT token)
 * - Repository configuration (owner/repo/branch)
 * - Local settings (file exclusions, ignored files)
 * - Debug logging toggle
 *
 * Implementation notes:
 * - Owner/repo inputs use AbstractInputSuggest (mobile-friendly autocomplete)
 * - GitHubConnection provides repo discovery and branch listing
 * - Settings saves and branch fetching are debounced (500ms) to reduce API calls
 */
export default class FitSettingTab extends PluginSettingTab {
	plugin: FitPlugin;
	authenticating: boolean;
	authUserAvatar: HTMLDivElement;
	authUserHandle: HTMLSpanElement;
	patSetting: Setting;
	authUserSetting: Setting;
	ownerSetting: Setting;
	repoSetting: Setting;
	existingRepos: Array<string>;
	existingBranches: Array<string>;
	repoLink: string;
	private saveSettingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private repoFetchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private suggestedOwners: Array<string> = [];
	private suggestedRepos: Array<string> = [];
	private authenticateButtonComponent: { setDisabled: (disabled: boolean) => void } | null = null;
	private refreshButton: HTMLElement | null = null;
	private ownerInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;
	private repoInputComponent: { setPlaceholder: (placeholder: string) => void; setValue: (value: string) => void } | null = null;
	private ownerSuggest: GitHubOwnerSuggest | null = null;
	private repoSuggest: GitHubRepoSuggest | null = null;

	constructor(app: App, plugin: FitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.repoLink = this.getLatestLink();
		this.authenticating = false;
		this.existingRepos = [];
		this.existingBranches = [];
	}

	/**
	 * Update input placeholders to reflect current authentication state.
	 * Call after authentication succeeds or when GitHubConnection becomes available.
	 */
	private updatePlaceholders() {
		const isAuthenticated = !!this.plugin.githubConnection;

		if (this.ownerInputComponent) {
			this.ownerInputComponent.setPlaceholder(
				isAuthenticated ? '所有者用户名' : '在上方验证后自动填充'
			);
		}
		if (this.repoInputComponent) {
			this.repoInputComponent.setPlaceholder(
				isAuthenticated ? '仓库名称' : '在上方验证后获取建议'
			);
		}
	}

	/**
	 * Clear authentication UI state only (not persistent settings).
	 * Call this when authentication fails temporarily.
	 * For permanent PAT removal, caller should also clear settings separately.
	 */
	private clearAuthState = () => {
		// Clear only UI state, preserve settings so they work when auth is restored
		this.plugin.settings.avatarUrl = "";
		this.existingBranches = [];
		this.existingRepos = [];
		this.authUserAvatar.empty();
		this.authUserAvatar.removeClass('cat');
		this.authUserAvatar.removeClass('error');
		this.authUserAvatar.addClass('empty');
		this.authUserHandle.setText("未验证");

		// Don't clear input values - user's settings remain intact
		// They can still see what owner/repo/branch they had configured
	};

	/**
	 * Update button enabled/disabled states based on current authentication status.
	 * Call this whenever PAT or authentication state changes.
	 */
	private updateButtonStates = () => {
		const isAuthenticated = !!this.plugin.githubConnection;

		if (this.authenticateButtonComponent) {
			this.authenticateButtonComponent.setDisabled(this.authenticating || !this.plugin.githubConnection);
		}

		if (this.refreshButton) {
			this.refreshButton.toggleClass('is-disabled', !isAuthenticated);
			if (!isAuthenticated) {
				this.refreshButton.setAttribute('aria-disabled', 'true');
			} else {
				this.refreshButton.removeAttribute('aria-disabled');
			}
		}
	};

	/**
	 * Debounced save settings for manual entry fields.
	 * Waits 500ms after user stops typing before saving.
	 */
	private debouncedSaveSettings = () => {
		if (this.saveSettingsDebounceTimer) {
			clearTimeout(this.saveSettingsDebounceTimer);
		}
		this.saveSettingsDebounceTimer = setTimeout(async () => {
			this.saveSettingsDebounceTimer = null;
			await this.plugin.saveSettings();
		}, 500);
	};

	/**
	 * Debounced fetch repos for owner changes.
	 * Waits 500ms after user stops typing before fetching repos to avoid performance issues.
	 */
	private debouncedFetchReposForOwner = (owner: string) => {
		if (this.repoFetchDebounceTimer) {
			clearTimeout(this.repoFetchDebounceTimer);
		}
		this.repoFetchDebounceTimer = setTimeout(async () => {
			this.repoFetchDebounceTimer = null;
			if (owner && this.plugin.githubConnection) {
				try {
					this.existingRepos = await this.plugin.githubConnection.getReposForOwner(owner);
					if (this.repoSuggest) {
						this.repoSuggest.updateSuggestions(this.existingRepos);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.plugin.logger.log(`[FitSettings] Could not fetch repos for owner '${owner}': ${errorMsg}`, { error });
					this.existingRepos = [];
					if (this.repoSuggest) {
						this.repoSuggest.updateSuggestions([]);
					}
				}
			}
		}, 500);
	};

	/**
	 * Debounced refresh for repo owner/name changes.
	 * Waits 500ms after user stops typing before fetching branches.
	 */
	private debouncedRefreshBranches = () => {
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
		}
		this.refreshDebounceTimer = setTimeout(async () => {
			this.refreshDebounceTimer = null;
			// Only refresh if both owner and repo are filled in
			if (this.plugin.settings.owner && this.plugin.settings.repo) {
				await this.refreshFields('branch(1)');
			}
		}, 500);
	};

	getLatestLink = (): string => {
		const {owner: owner, repo, branch} = this.plugin.settings;
		if (owner.length > 0 && repo.length > 0 && branch.length > 0) {
			return `https://github.com/${owner}/${repo}/tree/${branch}`;
		}
		return "";
	};

	handleUserFetch = async () => {
		this.authenticating = true;
		this.authUserAvatar.removeClass('error');
		this.authUserAvatar.empty();
		this.authUserAvatar.removeClass('empty');
		this.authUserAvatar.addClass('cat');
		try {
			// Guard: githubConnection is null when no PAT configured
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot authenticate without PAT token');
				this.authUserAvatar.removeClass('cat');
				this.authUserAvatar.addClass('error');
				this.authUserHandle.setText('请在上方填入 PAT 令牌');
				return;
			}
			const {owner: authUser, avatarUrl} = await this.plugin.githubConnection.getAuthenticatedUser();
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });

			// Detect if authUser changed by checking the displayed handle
			const previousAuthUser = this.authUserHandle.textContent;
			const authUserChanged = previousAuthUser !== "未验证" && previousAuthUser !== authUser;
			this.authUserHandle.setText(authUser);

			const previousOwner = this.plugin.settings.owner;
			const ownerInputEmpty = !previousOwner || previousOwner.trim() === '';
			this.plugin.settings.avatarUrl = avatarUrl;

			// Pre-fill or update owner when:
			// 1. Owner input is empty (first time or user cleared it), OR
			// 2. AuthUser changed and owner was still empty
			if (ownerInputEmpty || (authUserChanged && ownerInputEmpty)) {
				this.plugin.settings.owner = authUser;
				// Update owner input value directly
				if (this.ownerInputComponent) {
					this.ownerInputComponent.setValue(authUser);
				}
			}

			await this.plugin.saveSettings();

			// Update placeholders to reflect authenticated state
			this.updatePlaceholders();

			// Refresh repos/branches if owner was just filled or changed
			if (ownerInputEmpty && this.plugin.settings.owner) {
				if (this.plugin.settings.repo) {
					await this.refreshFields('branch(1)');
				} else {
					await this.refreshFields('repo(0)');
				}
			}
		} catch (error) {
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.addClass('error');

			// Provide specific error message based on error type
			let errorMessage = "验证失败，请确认令牌未过期。";
			if (error instanceof Error) {
				if (error.message.includes("network") || error.message.includes("reach")) {
					errorMessage = "网络错误，请检查网络后重试。";
				} else if (error.message.includes("Authentication") || error.message.includes("401") || error.message.includes("403")) {
					errorMessage = "验证失败，请检查 PAT 令牌。";
				}
			}

			this.authUserHandle.setText(errorMessage);
			// Clear remoteVault to allow re-creation on next auth attempt
			this.plugin.fit.clearRemoteVault();
			this.clearAuthState();
			await this.plugin.saveSettings();
			await this.refreshFields('initialize');

			// Update placeholders after clearing auth state
			this.updatePlaceholders();
		} finally {
			this.authenticating = false;
			this.updateButtonStates();
		}
	};

	githubUserInfoBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading()
			.setName("GitHub 用户信息")
			.addButton(button => {
				this.authenticateButtonComponent = button;
				button
					.setCta()
					.setButtonText("验证用户")
					.setDisabled(this.authenticating || !this.plugin.githubConnection)
					.onClick(async ()=>{
						if (this.authenticating) return;
						await this.handleUserFetch();
					});
			});
		this.authUserSetting = new Setting(containerEl)
			.setDesc("在下方填入个人访问令牌以完成验证。若还没有 GitHub 账号，可在此注册。")
			.addExtraButton(button=>button
				.setIcon('github')
				.setTooltip("在 github.com 注册")
				.onClick(async ()=>{
					window.open("https://github.com/signup", "_blank");
				}));
		this.authUserSetting.nameEl.addClass('fit-avatar-container');
		this.authUserAvatar = this.authUserSetting.nameEl.createDiv({cls: 'fit-avatar-container empty'});
		this.authUserHandle = this.authUserSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
		this.authUserHandle.setText("未验证");

		// Try to get authenticated user info from GitHubConnection (cached)
		if (this.plugin.githubConnection) {
			this.plugin.githubConnection.getAuthenticatedUser().then(({owner, avatarUrl}) => {
				this.authUserAvatar.removeClass('empty');
				this.authUserAvatar.empty();
				this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });
				this.authUserHandle.setText(owner);
			}).catch(() => {
				// Authentication failed, keep "Unauthenticated" state
			});
		}
		// hide the control element to make space for authUser
		this.authUserSetting.controlEl.addClass('fit-avatar-display-text');

		this.patSetting = new Setting(containerEl)
			.setName('GitHub 个人访问令牌')
			.setDesc('请确保权限包含 Contents: "Read and write"。建议：限定到所选仓库，并设置过期时间。')
			.addText(text => text
				.setPlaceholder('GitHub 个人访问令牌')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					const hadPat = !!this.plugin.settings.pat;
					this.plugin.settings.pat = value;

					// Clear authentication state when PAT is removed
					if (hadPat && !value) {
						this.clearAuthState();
						// When PAT is explicitly removed, also clear repo settings
						this.plugin.settings.owner = "";
						this.plugin.settings.repo = "";
						this.plugin.settings.branch = "";
						// Clear input values to reflect empty settings
						if (this.ownerInputComponent) {
							this.ownerInputComponent.setValue('');
						}
						if (this.repoInputComponent) {
							this.repoInputComponent.setValue('');
						}
					}

					await this.plugin.saveSettings();

					// Update button states after PAT change
					this.updateButtonStates();

					// Update placeholders to reflect new auth state
					this.updatePlaceholders();
				}))
			.addExtraButton(button=>button
				.setIcon('external-link')
				.setTooltip("创建令牌")
				.onClick(async ()=>{
					window.open(
						"https://github.com/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write",
						'_blank');
				}));
	};

	repoInfoBlock = async () => {
		const {containerEl} = this;
		const isAuthenticated = !!this.plugin.githubConnection;
		new Setting(containerEl).setHeading().setName("仓库信息")
			.setDesc(isAuthenticated
				? "验证后会自动填充建议。点击刷新可更新列表。"
				: "在上方验证后可获取所有者/仓库建议，也可手动填写。")
			.addExtraButton(button => {
				this.refreshButton = button.extraSettingsEl;
				button
					.setTooltip("刷新仓库与分支列表")
					.setDisabled(!isAuthenticated)
					.setIcon('refresh-cw')
					.onClick(async () => {
						await this.refreshFields('repo(0)');
					});
			});

		new Setting(containerEl)
			.setDesc("请确保已在浏览器中登录 GitHub。")
			.addExtraButton(button => button
				.setIcon('github')
				.setTooltip("新建仓库")
				.onClick(() => {
					window.open(`https://github.com/new`, '_blank');
				}));

		// Repository owner combo box (supports both dropdown suggestions and freeform text)
		this.ownerSetting = new Setting(containerEl)
			.setName('仓库所有者')
			.setDesc(isAuthenticated
				? '拥有该仓库的 GitHub 用户名或组织。可从建议中选择，也可自定义填写。'
				: '手动填写，或在上方验证后查看建议。');

		// Create AbstractInputSuggest for owner suggestions (better mobile UX than datalist)
		this.ownerSetting.addText(text => {
			this.ownerInputComponent = text;
			text.setPlaceholder(isAuthenticated ? '所有者用户名' : '在上方验证后自动填充')
				.setValue(this.plugin.settings.owner)
				.onChange(async (value) => {
					const ownerChanged = value !== this.plugin.settings.owner;
					this.plugin.settings.owner = value;

					if (ownerChanged) {
						// Clear dependent fields whenever the owner changes
						this.plugin.settings.repo = '';
						this.plugin.settings.branch = '';
						this.repoInputComponent?.setValue('');
						this.existingRepos = [];

						// Update repo suggestions when owner changes
						if (this.repoSuggest) {
							this.repoSuggest.updateSuggestions([]);
						}

						// If authenticated, debounced fetch repos for the new owner
						if (value && this.plugin.githubConnection) {
							this.debouncedFetchReposForOwner(value);
						}
					}

					this.debouncedSaveSettings();
				});

			// Initialize AbstractInputSuggest for owner input
			try {
				this.ownerSuggest = new GitHubOwnerSuggest(
					this.app,
					text.inputEl
				);
				// Populate with current suggestions if available
				if (this.suggestedOwners.length > 0) {
					this.ownerSuggest.updateSuggestions(this.suggestedOwners);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Failed to initialize owner suggestions: ${errorMsg}`, { error });
				console.error('[FitSettings] Failed to initialize GitHubOwnerSuggest:', error);
			}
		});

		// Repository name combo box (supports both dropdown suggestions and freeform text)
		this.repoSetting = new Setting(containerEl)
			.setName('仓库名称')
			.setDesc(isAuthenticated
				? '选择用于同步的仓库，或自定义填写。刷新可查看最新仓库。'
				: '在上方验证后查看仓库建议，或自定义填写。');

		// Create AbstractInputSuggest for repo suggestions (better mobile UX than datalist)
		this.repoSetting.addText(text => {
			this.repoInputComponent = text;
			text.setPlaceholder(isAuthenticated ? '仓库名称' : '在上方验证后获取建议')
				.setValue(this.plugin.settings.repo)
				.onChange((value) => {
					this.plugin.settings.repo = value;
					this.debouncedSaveSettings();
					this.debouncedRefreshBranches();
				});

			// Initialize AbstractInputSuggest for repo input
			try {
				this.repoSuggest = new GitHubRepoSuggest(
					this.app,
					text.inputEl
				);
				// Populate with current suggestions if available
				if (this.existingRepos.length > 0) {
					this.repoSuggest.updateSuggestions(this.existingRepos);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Failed to initialize repo suggestions: ${errorMsg}`, { error });
				console.error('[FitSettings] Failed to initialize GitHubRepoSuggest:', error);
			}
		});

		new Setting(containerEl)
			.setName('分支名称')
			.setDesc('先填写上方仓库信息，再刷新以查看现有分支。')
			.addDropdown(dropdown => {
				dropdown.selectEl.addClass('branch-dropdown');
				dropdown.setDisabled(this.existingBranches.length === 0);
				this.existingBranches.map(repo=>dropdown.addOption(repo, repo));
				dropdown.setValue(this.plugin.settings.branch);
				dropdown.onChange(async (value) => {
					const branchChanged = value !== this.plugin.settings.branch;
					if (branchChanged) {
						this.plugin.settings.branch = value;
						await this.plugin.saveSettings();
						await this.refreshFields('link(2)');
					}
				});
			});

		this.repoLink = this.getLatestLink();
		const linkDisplay = new Setting(containerEl)
			.setName("在 GitHub 上查看你的库")
			.setDesc(this.repoLink)
			.addExtraButton(button => button
				.setDisabled(this.repoLink.length === 0)
				.setTooltip("在 GitHub 打开")
				.setIcon('external-link')
				.onClick(() => {
					console.log(`opening ${this.repoLink}`);
					window.open(this.repoLink, '_blank');
				})
			);
		linkDisplay.descEl.addClass("link-desc");

		let textComponent: TextComponent;
		let visible = false;
		const defaultType = "password";

		function message(notice: FitNotice, string: string, error: unknown = null) {
			const loggerPrefix = "[FitSettings] ";
			if (error) {
				const msg = error instanceof Error ? error.message : String(error);
				fitLogger.log(loggerPrefix + string, error);
				notice.setMessage(`${string}: ${msg}`, true);
			} else {
				fitLogger.log(loggerPrefix + string);
				notice.setMessage(string);
			}
		}

		const setting = new Setting(containerEl)
			.setName("加密密码（仅高级）")
			.setDesc(
				"⚠️ 用于加密远端数据的密码。留空即关闭加密。\n\n" +
				"安全迁移步骤（改动前请先阅读）：\n" +
				"1. 确认所有设备的库中文件一致；\n" +
				"2. 在所有设备上以相同方式配置并应用此项；\n" +
				"3. 在其中一台设备上点击「清空仓库」删除全部远端文件，再与仓库同步；\n" +
				"4. 在其余每台设备上点击「同步本地缓存」更新缓存；\n" +
				"5. 完成。此后才能修改库中文件并正常同步。"
			)
			.addText(text => {
				text.setPlaceholder("密码");
				text.setValue(this.plugin.settings.encryptionPassword);
				text.inputEl.type = defaultType;
				textComponent = text;
			});

		setting.descEl.style.whiteSpace = "pre-wrap";

		setting.addExtraButton(button => button
			.setIcon("eye")
			.setTooltip("切换可见性")
			.onClick(() => {
				visible = !visible;
				textComponent.inputEl.type = visible ? "text" : "password";
				button.setIcon(visible ? "eye-off" : "eye");
			}));

		setting.addExtraButton(button => button
			.setIcon("arrow-right")
			.setTooltip("应用密码")
			.onClick(async () => {
				const value = textComponent.getValue();
				this.plugin.settings.encryptionPassword = value;
				await this.plugin.saveSettings();
				Encryption.clearCache();
				fitLogger.log("[FitSettings] Password has been applied");
				new FitNotice(
					this.plugin.fit,
					["done"],
					"密码已应用",
					5000,
					false
				);
			}));

		new Setting(containerEl)
			.setName('同步本地缓存')
			.setDesc('将远端状态重新读入本地缓存。（仅高级用途：加密迁移或缓存恢复）')
			.addExtraButton(button => button
				.setIcon('refresh-cw')
				.setTooltip("Sync local cache")
				.onClick(async () => {
					button.setDisabled(true);

					const notice = new FitNotice(
						this.plugin.fit,
						["done"],
						"正在更新缓存……",
						5000,
						false
					);

					try {
						const { state } = await this.plugin.fit.remoteVault.readFromSource(true);

						await this.plugin.saveLocalStoreCallback({
							lastFetchedRemoteSha: state,
						});

						message(notice, "缓存已更新");
						notice.remove("done", 5000);
					} catch (e) {
						message(notice, "更新缓存失败", e);
						notice.remove("error", 5000);
					} finally {
						button.setDisabled(false);
					}
				}));

		new Setting(containerEl)
			.setName('清空仓库')
			.setDesc('删除仓库中的全部文件，历史提交不受影响。（仅高级用途：加密迁移）')
			.addExtraButton(button => button
				.setIcon('trash-2')
				.setTooltip("Clear repository")
				.onClick(async () => {
					button.setDisabled(true);

					const notice = new FitNotice(
						this.plugin.fit,
						["loading"],
						"正在清空仓库……",
						undefined,
						false
					);

					try {
						const applied = await this.plugin.fitSync.clear();
						message(notice, applied ? "仓库已清空" : "没有可清空的内容");
						notice.remove("done", 5000);
					} catch (e) {
						message(notice, "清空仓库失败", e);
						notice.remove("error", 5000);
					} finally {
						button.setDisabled(false);
					}
				}));
	};

	localConfigBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading().setName("本地配置");
		new Setting(containerEl)
			.setName('设备名称')
			.setDesc('用此设备名称签署提交信息。')
			.addText(text => text
				.setPlaceholder('设备名称')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName("自动同步")
			.setDesc(`远端有更新时自动同步你的库。（静默：后台同步不显示通知，但文件变更与冲突通知除外）`)
			.addDropdown(dropdown => {
				dropdown
					.addOption('off', '关闭')
					.addOption('muted', '静默')
					.addOption('remind', '仅提醒')
					.addOption('on', '开启')
					.setValue(this.plugin.settings.autoSync ? this.plugin.settings.autoSync : 'off')
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value as "off" | "muted" | "remind" | "on";
						checkIntervalSlider.settingEl.addClass(value === "off" ? "clear" : "restore");
						checkIntervalSlider.settingEl.removeClass(value === "off" ? "restore" : "clear");
						await this.plugin.saveSettings();
					});
			});

		const checkIntervalSlider = new Setting(containerEl)
			.setName('自动检查间隔')
			.setDesc(`每 ${this.plugin.settings.checkEveryXMinutes} 分钟在后台自动检查远端变更。`)
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.checkEveryXMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.checkEveryXMinutes = value;
					await this.plugin.saveSettings();
					checkIntervalSlider.setDesc(`每 ${value} 分钟在后台自动检查远端变更。`);
				})
			);

		if (this.plugin.settings.autoSync === "off") {
			checkIntervalSlider.settingEl.addClass("clear");
		}
	};

	noticeConfigBlock = () => {
		const {containerEl} = this;
		const groupEl = containerEl.createDiv({cls: "fit-notice-group"});
		groupEl.createDiv({text: "通知显示", cls: "fit-notice-group-heading"});

		const makeItem = (
			name: string,
			getValue: () => boolean,
			setValue: (v: boolean) => Promise<void>,
			renderPreview: (el: HTMLElement) => void
		) => {
			const item = groupEl.createDiv({cls: "fit-notice-radio-item"});
			item.createDiv({text: name, cls: "fit-notice-radio-name"});

			const radioRow = item.createDiv({cls: "fit-notice-radio-row"});
			const groupName = `fit-radio-${name.replace(/\W+/g, "-").toLowerCase()}`;

			const showLabel = radioRow.createEl("label", {cls: "fit-notice-radio-option"});
			const showInput = showLabel.createEl("input");
			showInput.type = "radio";
			showInput.name = groupName;
			showInput.checked = getValue();
			showLabel.createSpan({text: "显示通知"});

			const hideLabel = radioRow.createEl("label", {cls: "fit-notice-radio-option"});
			const hideInput = hideLabel.createEl("input");
			hideInput.type = "radio";
			hideInput.name = groupName;
			hideInput.checked = !getValue();
			hideLabel.createSpan({text: "不显示"});

			const previewEl = item.createDiv({cls: "fit-notice-preview-content"});
			if (getValue()) {
				renderPreview(previewEl);
			} else {
				previewEl.hide();
			}

			showInput.addEventListener("change", async () => {
				await setValue(true);
				previewEl.empty();
				renderPreview(previewEl);
				previewEl.show();
			});
			hideInput.addEventListener("change", async () => {
				await setValue(false);
				previewEl.hide();
			});
		};

		makeItem(
			"文件变更",
			() => this.plugin.settings.notifyChanges,
			async (v) => { this.plugin.settings.notifyChanges = v; await this.plugin.saveSettings(); },
			(el) => {
				el.createDiv({text: "远端变更", cls: "file-changes-heading"});
				el.createDiv({text: "新增", cls: "file-changes-subheading"});
				el.createEl("li", {text: "笔记/示例.md", cls: "file-update-row file-ADDED"});
				el.createDiv({text: "修改", cls: "file-changes-subheading"});
				el.createEl("li", {text: "日记/今天.md", cls: "file-update-row file-MODIFIED"});
			}
		);

		makeItem(
			"变更冲突",
			() => this.plugin.settings.notifyConflicts,
			async (v) => { this.plugin.settings.notifyConflicts = v; await this.plugin.saveSettings(); },
			(el) => {
				el.createDiv({text: "变更冲突：", cls: "file-changes-subheading"});
				const headerRow = el.createDiv({cls: "file-conflict-row"});
				headerRow.createDiv().setText("本地");
				headerRow.createDiv();
				headerRow.createDiv().setText("远端");
				const row = el.createDiv({cls: "file-conflict-row"});
				row.createDiv({cls: "file-conflict-change"});
				row.createDiv().setText("想法/会议记录.md");
				row.createDiv({cls: "file-conflict-delete"});
			}
		);

		// Debug logging setting
		new Setting(containerEl)
			.setName("启用调试日志")
			.setDesc(`将详细同步日志写入 ${this.plugin.manifest.dir}/debug.log，便于排查问题与提交缺陷报告。`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
					// Update logger immediately
					const { fitLogger } = await import('./logger');
					fitLogger.setEnabled(value);
					if (value) {
						fitLogger.log('[Settings] Debug logging enabled');
					}
				}));
	};

	// TODO: This method does too much and has confusing checkpoint-based control flow.
	// Consider splitting into separate methods: refreshOwners(), refreshRepos(), refreshBranches(), updateLink()
	// Then callers can explicitly request what they need instead of using magic strings like "repo(0)"
	refreshFields = async (refreshFrom: RefreshCheckPoint) => {
		const {containerEl} = this;
		const branch_dropdown = containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const link_el = containerEl.querySelector('.link-desc') as HTMLElement;

		if (refreshFrom === "repo(0)") {
			// Guard: Cannot fetch from API without githubConnection
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot refresh repos without PAT token');
				return;
			}

			// Fetch owners and update owner suggestions
			try {
				this.suggestedOwners = await this.plugin.githubConnection.getAccessibleOwners();
				if (this.ownerSuggest) {
					this.ownerSuggest.updateSuggestions(this.suggestedOwners);
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Could not fetch accessible owners: ${errorMsg}`, { error });
				this.suggestedOwners = [];
				if (this.ownerSuggest) {
					this.ownerSuggest.updateSuggestions([]);
				}
			}

			// Fetch repos for current owner and update repo suggestions
			if (this.plugin.settings.owner) {
				try {
					this.existingRepos = await this.plugin.githubConnection.getReposForOwner(this.plugin.settings.owner);
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					this.plugin.logger.log(`[FitSettings] Could not fetch repos for owner '${this.plugin.settings.owner}': ${errorMsg}`, { error });
					this.existingRepos = [];
				}
			} else {
				this.existingRepos = [];
			}
			if (this.repoSuggest) {
				this.repoSuggest.updateSuggestions(this.existingRepos);
			}
		}

		if (refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			// Guard: Cannot fetch from API without githubConnection
			if (!this.plugin.githubConnection) {
				this.plugin.logger.log('[FitSettings] Cannot refresh branches without PAT token');
				branch_dropdown.empty();
				this.existingBranches = [];
			} else if (this.plugin.settings.repo === "" || this.plugin.settings.owner === "") {
				branch_dropdown.empty();
				this.existingBranches = [];
			} else {
				try {
					const latestBranches = await this.plugin.githubConnection.getBranches(this.plugin.settings.owner, this.plugin.settings.repo);
					if (!setEqual<string>(this.existingBranches, latestBranches)) {
						branch_dropdown.empty();
						this.existingBranches = latestBranches;
						this.existingBranches.map(branch => {
							branch_dropdown.add(new Option(branch, branch));
						});
						// if original branch not in the updated existing branch, -1 will be returned
						const selectedBranchIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
						// setting selectedIndex to -1 to indicate no options selected
						branch_dropdown.selectedIndex = selectedBranchIndex;
						if (selectedBranchIndex===-1){
							this.plugin.settings.branch = "";
						}
					}
				} catch (error) {
					// Repository not found or inaccessible - clear branch dropdown
					branch_dropdown.empty();
					this.existingBranches = [];
					// Only log unexpected errors; 404s are expected as user types incomplete repo names
					if (!(error instanceof VaultError && error.type === 'remote_not_found')) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						this.plugin.logger.log(`[FitSettings] Could not fetch branches for ${this.plugin.settings.owner}/${this.plugin.settings.repo}: ${errorMsg}`, { error });
					}
				}
			}
			branch_dropdown.disabled = false;
		}

		if (refreshFrom === "link(2)" || refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			this.repoLink = this.getLatestLink();
			link_el.innerText = this.repoLink;
		}

		if (refreshFrom === "initialize") {
			branch_dropdown.empty();
			if (this.plugin.settings.branch) {
				branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
			}
			link_el.innerText = this.getLatestLink();
		}

		if (refreshFrom === "withCache") {
			// Update suggest instances with cached data
			if (this.ownerSuggest) {
				this.ownerSuggest.updateSuggestions(this.suggestedOwners);
			}
			if (this.repoSuggest) {
				this.repoSuggest.updateSuggestions(this.existingRepos);
			}

			branch_dropdown.empty();
			if (this.existingBranches.length > 0) {
				this.existingBranches.forEach(branch => {
					branch_dropdown.add(new Option(branch, branch));
				});
				if (this.plugin.settings.branch === "") {
					branch_dropdown.selectedIndex = -1;
				} else {
					branch_dropdown.selectedIndex = this.existingBranches.indexOf(this.plugin.settings.branch);
					if (branch_dropdown.selectedIndex === -1) {
						this.plugin.logger.log(`[FitSettings] Selected branch ${this.plugin.settings.branch} not found in existing branches`, { existingBranches: this.existingBranches });
					}
				}
			} else if (this.plugin.settings.branch !== "") {
				branch_dropdown.add(new Option(this.plugin.settings.branch, this.plugin.settings.branch));
			}
		}
	};


	/**
	 * Settings block with per-run operation buttons. Every button opens the same
	 * option modal as its command palette counterpart; no choices are persisted.
	 */
	syncActionsBlock(): void {
		const { containerEl } = this;
		new Setting(containerEl).setHeading().setName("同步操作");
		const run = (action: () => Promise<void>) => async () => {
			try { await action(); } catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.plugin.logger.log(`[FitSettings] Operation failed: ${message}`, { error });
			}
		};
		new Setting(containerEl)
			.setName("双向同步")
			.setDesc("双向同步；可另行选择是否在同步后清理冲突副本（每次操作时选择）。")
			.addButton(button => button.setCta().setButtonText("同步…").onClick(run(async () => this.plugin.triggerBidirectionalSyncWithOptions())));
		new Setting(containerEl)
			.setName("单向上传")
			.setDesc("把本地新增和修改上传到 GitHub；可选择删除远端独有文件（每次操作时选择）。")
			.addButton(button => button.setButtonText("上传…").onClick(run(async () => this.plugin.triggerDirectionalUpload())));
		new Setting(containerEl)
			.setName("单向拉取")
			.setDesc("把远端新增和修改下载到本地库；可选择删除本地独有文件（每次操作时选择）。")
			.addButton(button => button.setButtonText("拉取…").onClick(run(async () => this.plugin.triggerDirectionalPull())));
		new Setting(containerEl)
			.setName("清理冲突副本")
			.setDesc("删除 _fit/ 下的冲突副本；每次可选择范围。原路径文件永不删除。")
			.addButton(button => button.setButtonText("清理…").onClick(run(async () => this.plugin.triggerConflictCleanup())));
	}

	async display(): Promise<void> {
		const {containerEl} = this;

		containerEl.empty();

		this.syncActionsBlock();
		this.githubUserInfoBlock();
		this.repoInfoBlock();
		this.localConfigBlock();
		this.noticeConfigBlock();
		this.refreshFields("withCache");
	}
}
