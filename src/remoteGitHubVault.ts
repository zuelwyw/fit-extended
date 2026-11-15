/**
 * GitHub Remote Vault
 *
 * Implements IVault for GitHub repository trees.
 * Encapsulates all GitHub API operations for file state management.
 */

import { LocalStores } from "@main";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { ApplyChangesResult, IVault, VaultError, VaultReadResult } from "./vault";
import { FileChange, FileStates } from "./util/changeTracking";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { Content, FileContent } from "./util/contentEncoding";
import { detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import { createTimeoutSignal, isTimeoutAbort, CHECK_REQUEST_TIMEOUT_MS } from "./util/requestTimeout";
import { fitLogger } from "./logger";
import { detectSuspiciousCorrespondence } from "./util/pathPattern";
import { createLazyQueue, BLOB_CREATION_RATE } from "./util/rateLimiter";
import { createCommitOnBranch, ConditionalCommitOutcome } from "./remotePublish";
import * as Encryption from "./encryption";

/**
 * Represents a node in GitHub's git tree structure
 * Maps to GitHub API tree object format
 */
export type TreeNode = {
	path: string,
	mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined
} & (
	| { type: "commit", sha: CommitSha | null }
	| { type: "blob", sha: BlobSha | null }
	| { type: "tree", sha: TreeSha | null }
	| { type: undefined, sha: null }
);

/**
 * Remote vault implementation for GitHub repositories.
 *
 * Encapsulates GitHub-specific operations:
 * - Fetching repository tree state via Octokit
 * - Computing file SHAs from GitHub blobs
 * - Remote change detection
 * - Push/commit operations for applying changes
 *
 * Architecture:
 * - Read operations: Fetch tree state from GitHub API
 * - Write operations: Create blobs/trees/commits and update refs
 * - No filtering logic: Caller (Fit) is responsible for filtering paths before calling vault methods
 *
 * Future: Create RemoteGitLabVault, RemoteGiteaVault as additional implementations.
 */
export class RemoteGitHubVault implements IVault<"remote"> {
	private octokit: Octokit;
	private owner: string;
	private repo: string;
	private branch: string;
	private headers: {[k: string]: string};
	private deviceName: string;
	private repoExistsCache: boolean | null = null;

	// Internal cache for remote state optimization
	// Avoids redundant API calls when remote hasn't changed
	private latestKnownCommitSha: CommitSha | null = null;
	private latestKnownState: FileStates | null = null;

	constructor(
		pat: string,
		owner: string,
		repo: string,
		branch: string,
		deviceName: string
	) {
		// Use Octokit with retry plugin for enhanced rate limiting handling
		const OctokitWithRetry = Octokit.plugin(retry);
		this.octokit = new OctokitWithRetry({
			auth: pat
			// Retry plugin operates silently - users will simply experience fewer rate limit errors
			// Future: Could add verbose logging option to plugin settings
		});

		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
		this.deviceName = deviceName;

		// Headers to disable GitHub API caching (prevents read-after-write inconsistency)
		// See: https://github.com/octokit/octokit.js/issues/890
		this.headers = {
			"If-None-Match": '',
			'X-GitHub-Api-Version': '2022-11-28'
		};
	}

	// ===== Accessors =====

	getOwner(): string {
		return this.owner;
	}

	getRepo(): string {
		return this.repo;
	}

	getBranch(): string {
		return this.branch;
	}

	// ===== Error Handling =====

	/**
	 * Wrap octokit errors and convert to VaultError for consistent error handling.
	 *
	 * @param error - The error from octokit
	 * @param notFoundStrategy - How to handle 404 errors:
	 *   - 'repo': 404 means repository doesn't exist
	 *   - 'repo-or-branch': 404 could be repo or branch (calls checkRepoExists to distinguish)
	 *   - 'ignore': Don't treat 404 specially, re-throw as generic error
	 */
	private async wrapOctokitError(
		error: unknown,
		notFoundStrategy: 'repo' | 'repo-or-branch' | 'ignore'
	): Promise<never> {
		const errorObj = error as { status?: number | null; response?: unknown; message?: string; request?: unknown };

		// Non-Octokit errors (plugin bugs, ReferenceErrors, etc.) — re-throw without misclassifying as network.
		// Octokit errors always have a numeric status (HTTP errors) or a 'request' property (network failures).
		const hasNumericStatus = typeof errorObj.status === 'number';
		const hasOctokitRequest = error != null && typeof error === 'object' && 'request' in error;
		if (!hasNumericStatus && !hasOctokitRequest) {
			throw error;
		}

		// No status or no response indicates network/connectivity issue
		if (errorObj.status === null || errorObj.status === undefined || !errorObj.response) {
			throw VaultError.network(
				errorObj.message || "无法连接 GitHub API",
				{ originalError: error }
			);
		}

		// 404: Resource not found - handle based on strategy
		if (errorObj.status === 404 && notFoundStrategy !== 'ignore') {
			let detailMessage: string;

			if (notFoundStrategy === 'repo') {
				detailMessage = `Repository '${this.owner}/${this.repo}' not found`;
			} else {
				// repo-or-branch: Try to distinguish
				try {
					detailMessage = await this.checkRepoExists()
						? `Branch '${this.branch}' not found on repository '${this.owner}/${this.repo}'`
						: `Repository '${this.owner}/${this.repo}' not found`;
				} catch (_repoError) {
					// checkRepoExists failed (403, network, etc.) - use generic message
					detailMessage = `Repository '${this.owner}/${this.repo}' or branch '${this.branch}' not found`;
				}
			}

			throw VaultError.remoteNotFound(detailMessage, { originalError: error });
		}

		// 403 细分：GitHub 二级限流（内容创建 ≤80/分钟、≤500/小时）不是认证失败，
		// 误判会误导用户去检查令牌。官方文档要求按 retry-after / x-ratelimit-reset 退避重试。
		const isRateLimit403 = errorObj.status === 403
			&& typeof errorObj.message === 'string'
			&& /rate limit|secondary rate/i.test(errorObj.message);
		if (isRateLimit403) {
			const headers = (errorObj as { response?: { headers?: Record<string, unknown> } }).response?.headers ?? {};
			const retryAfter = Number(headers['retry-after'] ?? 0);
			const reset = Number(headers['x-ratelimit-reset'] ?? 0);
			const waitSeconds = retryAfter > 0
				? retryAfter
				: reset > 0 ? Math.max(60, reset - Math.floor(Date.now() / 1000)) : 60;
			throw VaultError.network(
				`GitHub 二级限流（内容创建请求过多），约 ${waitSeconds} 秒后可重试`,
				{ originalError: error }
			);
		}

		// 401/403: Authentication/authorization failures
		if (errorObj.status === 401 || errorObj.status === 403) {
			throw VaultError.authentication(
				errorObj.message || 'Authentication failed',
				{ originalError: error }
			);
		}

		// Other errors: re-throw as-is
		throw error;
	}

	// ===== Read Operations =====

	/**
	 * 检查阶段的读取请求：带真实中止的超时。
	 *
	 * 为什么不复用 Promise.race：race 只是"不再等待"，底层连接还在跑，
	 * 用户看到失败但请求仍在消耗配额。这里把 AbortSignal 透传给 Octokit，
	 * 超时直接中断连接。超时归为"检查失败、未执行同步"——读取没有任何写入，
	 * 不能进入发布结果不明（uncertain）的语义。
	 */
	private async requestWithCheckTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const timeout = createTimeoutSignal(CHECK_REQUEST_TIMEOUT_MS);
		try {
			return await run(timeout.signal);
		} catch (error) {
			if (isTimeoutAbort(error)) {
				throw VaultError.network(
					'检查超时：读取远端状态超过 30 秒未响应，已中止；未执行任何同步。',
					{ originalError: error }
				);
			}
			throw error;
		} finally {
			timeout.cancel();
		}
	}

	/**
	 * Fetch commit SHA and tree SHA in one API call
	 * More efficient than separate getRef() + getCommit() calls
	 */
	public async getLatestCommitAndTreeSha(): Promise<{ commitSha: CommitSha; treeSha: TreeSha }> {
		try {
			const {data: commit} = await this.requestWithCheckTimeout(signal => this.octokit.request(
				`GET /repos/{owner}/{repo}/commits/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref: this.branch,
					headers: this.headers,
					signal
				}));
			return {
				commitSha: commit.sha as CommitSha,
				treeSha: commit.commit.tree.sha as TreeSha
			};
		} catch (error) {
			if (error instanceof VaultError) throw error;
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	/**
	 * Get the git tree for a given tree SHA
	 */
	private async getTree(tree_sha: TreeSha): Promise<TreeNode[]> {
		try {
			const { data: tree } = await this.requestWithCheckTimeout(signal => this.octokit.request(
				`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
					owner: this.owner,
					repo: this.repo,
					tree_sha,
					recursive: 'true',
					headers: this.headers,
					signal
				}));
			// GitHub 对超大仓的递归树会返回 truncated:true，此时 tree 只是**部分**内容。
			// 把它当成完整存在性集合会让镜像把"没返回的路径"当成目标独有而删除，
			// 也会让基线少记路径。必须明确失败，绝不静默按不完整树规划。
			if ((tree as { truncated?: boolean }).truncated) {
				throw VaultError.network(
					`远端树被 GitHub 截断（tree ${tree_sha}），无法作为完整存在性集合使用。` +
					`请缩小仓库范围或改用非递归方式后重试；本次未生成计划、未改动任何文件。`,
					{ originalError: new Error('tree truncated') }
				);
			}
			return tree.tree as TreeNode[];
		} catch (error) {
			if (error instanceof VaultError) throw error;
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}


	/**
	 * 该路径最后一次提交的时间（ISO 字符串）。
	 *
	 * Git 树只存内容，不存文件 mtime；远端"最后修改时间"的唯一可靠来源是
	 * 按路径过滤的提交历史。只用于审阅时给用户一个判断依据，失败返回 null，
	 * 不抛异常、不编造时间。
	 */
	async lastCommitTimeOf(path: string): Promise<string | null> {
		const target = Encryption.isEnabled() ? await Encryption.encryptPath(path) : path;
		try {
			const { data } = await this.octokit.request(
				`GET /repos/{owner}/{repo}/commits`, {
					owner: this.owner,
					repo: this.repo,
					path: target,
					per_page: 1,
					headers: this.headers
				});
			const entry = Array.isArray(data) ? data[0] : undefined;
			const date = entry?.commit?.committer?.date ?? entry?.commit?.author?.date;
			return typeof date === "string" ? date : null;
		} catch {
			return null;
		}
	}

	/**
	 * Read file content from GitHub by path.
	 *
	 * Note: Returns file content as of the last readFromSource() call. Does NOT force a
	 * fresh remote fetch. Caller should call readFromSource() first if they need the
	 * latest remote state.
	 *
	 * @param path - File path to read
	 * @throws Error if remote state not yet fetched or file not found in remote state
	 */
	async readFileContent(path: string): Promise<FileContent> {
		// Look up blob SHA from cached state
		if (this.latestKnownState === null) {
			throw new Error(
				`Remote repository state not yet loaded. Cannot read file '${path}'. ` +
				`Sync operation should call readFromSource() first.`
			);
		}

		const blobSha = this.latestKnownState[path];
		if (!blobSha) {
			throw new Error(
				`File '${path}' does not exist in remote repository ` +
				`(commit ${this.latestKnownCommitSha || 'unknown'} on ${this.owner}/${this.repo}).`
			);
		}

		// Fetch blob content from GitHub
		// GitHub API ALWAYS returns content as base64, regardless of file type
		try {
			// 读取请求带真实中止超时（D4）：不是 race 假超时，底层连接被 abort，
			// 没有后台扫描残留。超时错误归为检查失败，不与发布 uncertain 混用。
			const timeout = createTimeoutSignal(CHECK_REQUEST_TIMEOUT_MS);
			let data: { content?: unknown; encoding?: unknown };
			try {
				const result = await this.octokit.request(
					`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
						owner: this.owner,
						repo: this.repo,
						file_sha: blobSha,
						headers: this.headers,
						signal: timeout.signal
					});
				data = result.data;
			} finally {
				timeout.cancel();
			}
			if (typeof data.content !== 'string') {
				// 保留 API 实际报告的编码：这是排查超大文件/异常 blob 的唯一线索。
				throw new Error(
					`无法读取「${path}」：blob 内容类型为 ${typeof data.content}（编码：'${String(data.encoding ?? 'unknown')}'）. ` +
					`GitHub 可能不支持该 blob 格式。`
				);
			}
			let content = data.content;
			if (Encryption.isEnabled()) {
				content = await Encryption.decryptContent(content);
			}
			return FileContent.fromBase64(content);
		} catch (error) {
			// 检查超时（D4）：读取没有写入任何内容，明确报"检查超时，未执行同步"，
			// 不进入 uncertain（那是发布结果不明的专用语义）。
			if (isTimeoutAbort(error)) {
				throw VaultError.network('检查超时：读取远端内容超过 30 秒未响应，已中止；未执行任何同步。', { originalError: error });
			}
			// Blob not found (404) is a data error, not a vault-level error
			// Network/auth errors still converted to VaultError
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	// ===== Write Operations =====

	/**
	 * Create a blob on GitHub from content
	 */
	private static readonly BLOB_MAX_RETRIES = 3;

	private static sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * 内容生成请求受 GitHub 二级限流约束（≤80/分钟）。
	 * 收到限流响应时按 retry-after 指示退避后重试，最多 BLOB_MAX_RETRIES 次。
	 */
	private async createBlob(content: string, encoding: string): Promise<BlobSha> {
		for (let attempt = 0; ; attempt++) {
			try {
				let payload = content;
				let payloadEncoding = encoding;
				if (Encryption.isEnabled()) {
					if (payloadEncoding === "utf-8") {
						payloadEncoding = "base64";
						payload = Content.encodeToBase64(payload);
					}
					payload = await Encryption.encryptContent(payload);
				}
				const {data: blob} = await withSlowOperationMonitoring(
					this.octokit.request(
						`POST /repos/{owner}/{repo}/git/blobs`, {
							owner: this.owner,
							repo: this.repo,
							content: payload,
							encoding: payloadEncoding,
							headers: this.headers
						}),
					'GitHub blob creation'
				);
				return blob.sha as BlobSha;
			} catch (error) {
				const err = error as { status?: number; message?: string };
				const isRateLimited = err.status === 403
					&& typeof err.message === 'string'
					&& /rate limit|secondary rate/i.test(err.message);
				if (isRateLimited && attempt < RemoteGitHubVault.BLOB_MAX_RETRIES) {
					// 逐步退避：60s → 120s → 240s，符合官方"指数退避"建议
					const backoffMs = 60_000 * Math.pow(2, attempt);
					fitLogger.log(`[RemoteVault] Blob creation rate limited; backing off ${backoffMs / 1000}s (attempt ${attempt + 1}/${RemoteGitHubVault.BLOB_MAX_RETRIES})`);
					await RemoteGitHubVault.sleep(backoffMs);
					continue;
				}
				return await this.wrapOctokitError(error, 'repo');
			}
		}
	}

	/**
	 * Create a tree node for a file change.
	 * Creates blob from content and returns tree node, or null if no change needed.
	 *
	 * @param path - File path
	 * @param content - File content (base64 for binary, raw text otherwise) or null for deletion
	 * @param currentState - Current remote FileStates (for optimization - skip if unchanged)
	 * @returns TreeNode to include in commit, or null if no change needed
	 */
	private async createTreeNodeFromContent(
		path: string,
		content: FileContent | null,
		currentState: FileStates
	): Promise<TreeNode | null> {
		// Deletion case (content is null)
		if (content === null) {
			// Skip deletion if file doesn't exist on remote
			if (!(path in currentState)) {
				return null;
			}
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null  // null SHA indicates deletion
			};
		}

		// Addition/modification case
		const rawContentObj = content.toRaw();
		const rawContent = rawContentObj.content;
		const encoding = rawContentObj.encoding === 'base64' ? 'base64' : 'utf-8';
		const blobSha = await this.createBlob(rawContent, encoding);

		// Skip if file on remote is identical
		if (currentState[path] === blobSha) {
			return null;
		}

		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		};
	}

	/**
	 * Create a new tree from tree nodes
	 * @returns Object with treeSha and optional userWarning if encoding corruption detected
	 */
	private async createTree(
		treeNodes: TreeNode[],
		base_tree_sha: TreeSha
	): Promise<{ treeSha: TreeSha; userWarning?: string }> {
		try {
			// Diagnostic logging: capture intended paths BEFORE any corruption (Issue #51)
			// Tree nodes are created correctly in JavaScript memory (UTF-16 strings)
			// Corruption happens during HTTP request encoding (JSON serialization → bytes)
			const pathsWeIntendedToSend = treeNodes.map(n => n.path).filter(Boolean);
			let updatedTree: TreeNode[] = treeNodes;

			if (Encryption.isEnabled()) {
				updatedTree = await Promise.all(
					treeNodes.map(async (node) => ({
						...node,
						path: await Encryption.encryptPath(node.path)
					}))
				);
			}

			const {data: newTree} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/trees`, {
					owner: this.owner,
					repo: this.repo,
					tree: updatedTree,
					base_tree: base_tree_sha,
					headers: this.headers
				}
			);

			// Diagnostic logging: compare INTENDED paths vs echoed paths to detect encoding corruption
			// GitHub echoes back what it received, so if it differs from what we intended to send,
			// we know corruption happened during the request (UTF-8→GBK encoding issue)
			// Note: GitHub API does NOT guarantee response order, so we match by pattern instead of index
			const echoedPaths = newTree.tree?.map((n: {path?: string}) => n.path).filter((p): p is string => !!p) ?? [];
			const suspiciousMatches: Array<{intended: string, echoed: string, pattern: string}> = [];

			const intendedPathsSet = new Set(pathsWeIntendedToSend);
			const echoedPathsSet = new Set(echoedPaths);

			// Find paths that were intended but are not present verbatim in the echoed response.
			// These are candidates for having been corrupted.
			for (const intended of intendedPathsSet) {
				if (echoedPathsSet.has(intended)) {
					continue; // Path was sent and received correctly.
				}

				// This path is missing. Check if any of the echoed paths are a corrupted version of it.
				for (const echoed of echoedPathsSet) {
					const match = detectSuspiciousCorrespondence(intended, echoed);
					if (match) {
						suspiciousMatches.push({ intended, echoed, pattern: match.pattern });
						// Once a match is found, we can stop checking this intended path against other echoed paths.
						break;
					}
				}
			}

			let userWarning: string | undefined;

			if (suspiciousMatches.length > 0) {
				const enc = new TextEncoder();
				const details = suspiciousMatches.map(({intended, echoed, pattern}) => ({
					intended,
					echoed,
					pattern,
					intendedBytes: Array.from(enc.encode(intended)),
					echoedBytes: Array.from(enc.encode(echoed))
				}));

				fitLogger.log(
					`🔴 [RemoteVault] Encoding corruption detected during upload!\n` +
					`Attempted to upload ${suspiciousMatches.length} file(s) but GitHub received different paths:\n` +
					suspiciousMatches.map(({intended, echoed, pattern}) =>
						`  - Intended: "${intended}" → Received: "${echoed}"\n    Pattern match: "${pattern}" = "${pattern}" ✅`
					).join('\n') +
					`\nThis indicates UTF-8→GBK corruption during request encoding. See logs and Issue #51.`,
					{ details, issue: 'https://github.com/joshuakto/fit/issues/51' }
				);

				// Create user warning for immediate notification
				userWarning = `🔴 Upload Encoding Corruption Detected!\n` +
					`${suspiciousMatches.length} file(s) uploaded with corrupted names to GitHub.\n` +
					`Check debug logs immediately and report to Issue #51.\n\n` +
					`Affected files:\n` +
					suspiciousMatches.map(({intended, echoed}) =>
						`  • "${intended}" became "${echoed}"`
					).join('\n');
			}

			return { treeSha: newTree.sha as TreeSha, userWarning };
		} catch (error) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Create a commit pointing to a tree
	 */
	public async createCommit(treeSha: TreeSha, parentSha: CommitSha): Promise<CommitSha> {
		const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
		try {
			const { data: createdCommit } = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/commits`, {
					owner: this.owner,
					repo: this.repo,
					message,
					tree: treeSha,
					parents: [parentSha],
					headers: this.headers
				});
			return createdCommit.sha as CommitSha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo');
		}
	}

	/**
	 * Update branch reference to point to new commit
	 */
	public async updateRef(sha: string, ref: string = `heads/${this.branch}`): Promise<string> {
		try {
			const { data: updatedRef } = await this.octokit.request(
				`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					sha,
					headers: this.headers
				});
			return updatedRef.object.sha;
		} catch (error: unknown) {
			return await this.wrapOctokitError(error, 'repo-or-branch');
		}
	}

	// ===== GitHub Utility Operations (not part of IVault) =====

	/**
	 * Check if repository exists and is accessible
	 * Result is cached to avoid repeated API calls during error handling.
	 * @returns true if repository exists, false if 404 (not found)
	 * @throws VaultError for non-404 errors (auth, network, etc.)
	 */
	private async checkRepoExists(): Promise<boolean> {
		if (this.repoExistsCache !== null) {
			return this.repoExistsCache;
		}

		try {
			await this.octokit.request(`GET /repos/{owner}/{repo}`, {
				owner: this.owner,
				repo: this.repo,
				headers: this.headers
			});
			this.repoExistsCache = true;
			return true;
		} catch (error) {
			const errorObj = error as { status?: number };
			if (errorObj.status === 404) {
				this.repoExistsCache = false;
				return false;
			}
			// Non-404 errors: wrap and throw
			return await this.wrapOctokitError(error, 'ignore');
		}
	}

	// ===== IVault Implementation =====

	/**
	 * Apply a batch of changes to remote (creates commit and pushes)
	 * This is the primary write operation - creates a single commit with all changes
	 * Accepts PlainTextContent for text files or Base64Content for binary files
	 *
	 * @param options.clashPaths - Ignored by RemoteVault (no _fit/ concept on remote)
	 */
	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>,
		_options?: { clashPaths?: Set<string> },
		onProgress?: (completed: number, total: number) => void
	): Promise<ApplyChangesResult<"remote">> {
		// Note: clashPaths is ignored - remote doesn't have _fit/ directory concept
		// Get current state using cache when available
		const { state: currentState, commitSha: parentCommitSha, treeSha: parentTreeSha } = await this.readFromSource();

		// 惰性任务：只在轮到它时才真正发起 blob 创建请求。
		// 旧实现先构造全部 Promise 再按间隔 await 结果，请求早已全部发出，
		// 注释里的速率上限从未生效（GitHub 二级限流 ≤80 次/分钟）。
		const operations: Array<{
			path: string;
			sizeBytes: number | null;
			run: () => Promise<TreeNode | null>;
		}> = [];

		for (const {path, content} of filesToWrite) {
			operations.push({
				path,
				sizeBytes: content.size(),
				run: () => this.createTreeNodeFromContent(path, content, currentState)
			});
		}

		for (const path of filesToDelete) {
			// 删除不产生 blob 请求，但仍保留在队列里以统一进度与错误处理。
			operations.push({
				path,
				sizeBytes: null,
				run: () => this.createTreeNodeFromContent(path, null, currentState)
			});
		}

		const queue = createLazyQueue(BLOB_CREATION_RATE.minIntervalMs, BLOB_CREATION_RATE.maxInFlight);
		const results = [];
		for (let i = 0; i < operations.length; i++) {
			const operation = operations[i];
			results.push(await queue.run(async () => operation.run()).then(
				(value: TreeNode | null) => ({ status: 'fulfilled' as const, value }),
				(reason: unknown) => ({ status: 'rejected' as const, reason })
			));
			onProgress?.(i + 1, operations.length);
		}

		// Extract successful nodes and collect per-file errors
		const treeNodes: TreeNode[] = [];
		const perFileErrors: Array<{ path: string; error: unknown }> = [];

		results.forEach((result, index) => {
			const { path, sizeBytes } = operations[index];
			if (result.status === 'fulfilled' && result.value !== null) {
				treeNodes.push(result.value);
			} else if (result.status === 'rejected') {
				let error = result.reason;
				// Enhance 422 errors (input too large) with file size
				if (sizeBytes !== null) {
					const errorObj = error as { status?: number };
					if (errorObj.status === 422) {
						const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
						const enhancedError = error instanceof Error ? error : new Error(String(error));
						enhancedError.message = `${enhancedError.message} (file size: ${sizeMB} MB)`;
						error = enhancedError;
					}
				}
				perFileErrors.push({ path, error });
			}
		});

		// If any files failed, throw VaultError with per-file details
		if (perFileErrors.length > 0) {
			const failedPaths = perFileErrors.map(e => e.path);
			throw VaultError.network(
				`Failed to process ${perFileErrors.length} file(s) for remote upload`,
				{ errors: perFileErrors, failedPaths }
			);
		}

		// If no changes needed, return empty result (currentState already from cache)
		if (treeNodes.length === 0) {
			return {
				changes: [],
				commitSha: parentCommitSha,
				treeSha: parentTreeSha,
				newState: currentState
			};
		}

		// Create tree, commit, and update ref
		const { treeSha: newTreeSha, userWarning } = await this.createTree(treeNodes, parentTreeSha);
		const newCommitSha = await this.createCommit(newTreeSha, parentCommitSha);
		await this.updateRef(newCommitSha);

		// Build file operation records and construct new state from known changes
		const changes: FileChange[] = [];
		const newState: FileStates = { ...currentState };

		for (const node of treeNodes) {
			if (!node.path) continue;

			// All nodes should be blobs (type:"blob") from createTreeNodeFromContent
			// which only creates blob nodes for files
			let changeType: "ADDED" | "MODIFIED" | "REMOVED";
			if (node.sha === null) {
				// Deletion
				changeType = "REMOVED";
				delete newState[node.path];
			} else if (node.path in currentState) {
				// Modification - node.sha is BlobSha for blob nodes
				changeType = "MODIFIED";
				newState[node.path] = node.sha as BlobSha;
			} else {
				// Addition - node.sha is BlobSha for blob nodes
				changeType = "ADDED";
				newState[node.path] = node.sha as BlobSha;
			}

			changes.push({ path: node.path, type: changeType });
		}

		// Update cache to avoid redundant fetches later
		this.latestKnownCommitSha = newCommitSha;
		this.latestKnownState = newState;

		return {
			changes,
			commitSha: newCommitSha,
			treeSha: newTreeSha,
			newState,
			userWarning
		};
	}

	/**
	 * 严格条件发布：绑定审阅时的分支头。
	 *
	 * 走 GitHub 官方 createCommitOnBranch + expectedHeadOid；头不匹配时整体失败，
	 * 不退回无条件 PATCH ref。不适用（空仓库/无期望头）时返回 unavailable，
	 * 由上层决定是否走单独建分支流程——绝不静默降级。
	 */
	async publishConditional(
		filesToWrite: Array<{ path: string; content: FileContent }>,
		filesToDelete: string[],
		expectedHeadOid: CommitSha,
		message: { headline: string; body?: string }
	): Promise<ConditionalCommitOutcome> {
		const outcome = await createCommitOnBranch(
			{ graphql: (query, variables) => this.octokit.graphql(query, variables) as Promise<never> },
			{
				owner: this.owner,
				repo: this.repo,
				branch: this.branch,
				expectedHeadOid,
				additions: filesToWrite.map(file => ({ path: file.path, content: file.content })),
				deletions: filesToDelete,
				message,
				// 复用既有加密语义：内容与路径都与 createBlob / createTree 一致，
				// 否则启用加密的用户会在这条管线上明文写入、并删不掉旧密文路径。
				transform: {
					isEncryptionEnabled: () => Encryption.isEnabled(),
					encryptContent: base64 => Encryption.encryptContent(base64),
					encryptPath: path => Encryption.encryptPath(path)
				}
			}
		);
		if (outcome.status === "committed") {
			// 提交已建立：缓存失效，下次读取必须重新拉树，避免用旧头部生成计划。
			this.latestKnownCommitSha = outcome.commitSha;
			this.latestKnownState = null;
		}
		return outcome;
	}

	async clear(): Promise<LocalStores | null> {
		const { commitSha, treeSha } = await this.getLatestCommitAndTreeSha();

		if (treeSha === EMPTY_TREE_SHA) return null;

		const newCommit = await this.createCommit(EMPTY_TREE_SHA, commitSha);
		await this.updateRef(newCommit);

		return {
			localSha: {},
			lastFetchedCommitSha: newCommit,
			lastFetchedRemoteSha: {},
		};
	}

	// ===== Metadata =====

	/**
	 * Check if path should be included in state tracking.
	 *
	 * RemoteGitHubVault can track all paths - no storage limitations.
	 * Always returns true since GitHub can store any file.
	 *
	 * Note: Sync policy filtering (e.g., excluding _fit/, .obsidian/) is handled
	 * by the caller (Fit), not by the vault.
	 */
	shouldTrackState(path: string): boolean {
		return true;
	}

	/**
	 * Fetch tree from GitHub at the latest commit and return it with commit SHA.
	 * Implements IVault.readFromSource().
	 *
	 * Uses internal caching to avoid redundant API calls when remote hasn't changed.
	 * If the latest commit SHA matches the cached SHA, returns cached state immediately.
	 * Uses internal caching to avoid redundant API calls when remote hasn't changed.
	 * If the latest commit SHA matches the cached SHA, returns cached state immediately.
	 */
	async readFromSource(ignoreCache: boolean = false): Promise<VaultReadResult<"remote">> {
		const { commitSha, treeSha } = await this.getLatestCommitAndTreeSha();

		// Return cached state if remote hasn't changed
		if (!ignoreCache && commitSha === this.latestKnownCommitSha && this.latestKnownState !== null) {
			fitLogger.log(`... 📦 [RemoteVault] Using cached state (${commitSha.slice(0, 7)})`);
			return { state: { ...this.latestKnownState }, commitSha, treeSha };
		}

		// Fetch fresh state from GitHub
		if (ignoreCache || this.latestKnownCommitSha === null) {
			fitLogger.log(`... ⬇️ [RemoteVault] Fetching initial state from GitHub (${commitSha.slice(0, 7)})...`);
		} else {
			fitLogger.log(`... ⬇️ [RemoteVault] New commit detected (${commitSha.slice(0, 7)}), fetching tree...`);
		}
		// Monitor for slow GitHub API operations
		const newState = await withSlowOperationMonitoring(
			this.buildStateFromTree(treeSha),
			`Remote vault tree fetch from GitHub`,
			{ warnAfterMs: 10000 }
		);

		// Update cache
		this.latestKnownCommitSha = commitSha;
		this.latestKnownState = newState;

		// Log completion with normalization diagnostics
		const normalizationInfo = detectNormalizationIssues(Object.keys(newState), 'remote (GitHub)');
		fitLogger.log(
			`... ☁️ [RemoteVault] Fetched ${Object.keys(newState).length} files`,
			normalizationInfo ? { nfdPaths: normalizationInfo.nfdCount } : undefined
		);

		return { state: { ...newState }, commitSha, treeSha };
	}

	/**
	 * Build FileStates from a tree SHA without reading commit metadata.
	 * Used after applyChanges() to construct state from the new tree.
	 *
	 * @param treeSha - Tree SHA to read
	 * @returns FileStates mapping paths to blob SHAs
	 */
	private async buildStateFromTree(treeSha: TreeSha): Promise<FileStates> {
		// Check if this is the empty tree - skip getTree() call (would return 404)
		const remoteTree: TreeNode[] = treeSha === EMPTY_TREE_SHA
			? []
			: await this.getTree(treeSha);

		const state: FileStates = {};
		const failedPaths: Array<{path: string, error: unknown}> = [];

		for (const node of remoteTree) {
			// Only include blobs (files), skip trees (directories)
			if (node.type === "blob" && node.path && node.sha) {
				let path = node.path;
				try {
					if (Encryption.isEnabled()) {
						path = await Encryption.decryptPath(path);
					}
					// TODO: Should this notice if there's a collision overwriting same path?
					state[path] = node.sha;
				} catch (error) {
					if (error instanceof ReferenceError) throw error;
					failedPaths.push({ path: path, error });
					fitLogger.log(`❌ [RemoteVault] Failed to process file: ${path}`, error);
				}
			}
		}

		// If any files failed, throw a VaultError with details
		if (failedPaths.length > 0) {
			throw new VaultError(
				'network',
				`Failed to process ${failedPaths.length} file(s) from remote vault: ${failedPaths.map(f => f.path).join(', ')}`,
				{
					originalError: failedPaths[0].error,
					failedPaths: failedPaths.map(f => f.path),
					errors: failedPaths.map(f => ({ path: f.path, error: f.error }))
				}
			);
		}

		return state;
	}

}
