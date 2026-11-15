/**
 * 共用执行器：手工审阅 → 逐项执行 → 只推进实际成功项的共同状态。
 *
 * 关键纪律（开发计划 P3）：
 * 1. 确认前零应用：取消、全不选、计划失效都不写任何文件、不发布远端提交。
 * 2. 执行前复核：仓库/分支身份、远端头、本地相关路径、规则指纹全部要绑定计划。
 * 3. 逐项结果：未选、失败、结果待确认的项目**不推进**共同状态。
 * 4. 远端发布绑定审阅时的分支头，不能换新头重放旧计划。
 * 5. 部分失败如实报告，不跨端承诺原子回滚。
 */

import { ContentDigest } from "./util/contentDigest";
import { FileContent } from "./util/contentEncoding";
import { VaultError } from "./vault";
import { fitLogger } from "./logger";
import { CommonState } from "./commonState";
import { SyncPlan, SyncIdentity, PlanOperation } from "./syncTypes";
import { ScopeContext } from "./scopeContext";

export type ItemOutcome =
	/** 该路径的文件变更已确实完成 */
	| { status: "succeeded" }
	/** 明确失败 */
	| { status: "failed"; error: string }
	/**
	 * 结果待确认：请求可能已生效（响应丢失、提交后本地失败），
	 * 再次操作前必须先核对实际状态，不盲重试。
	 */
	| { status: "uncertain"; detail: string };

export type ExecutedItem = {
	operationId: string;
	path: string;
	kind: PlanOperation["kind"];
	outcome: ItemOutcome;
	/** 成功且可确认内容时的最终摘要，用于推进共同状态 */
	digest?: ContentDigest;
};

export type ExecutionReport = {
	/** 计划是否因过期被整体拒绝（此时没有任何文件被改动） */
	rejected?: { reason: string };
	items: ExecutedItem[];
	/** 只包含实际成功项 */
	succeeded: ExecutedItem[];
	failed: ExecutedItem[];
	uncertain: ExecutedItem[];
	/** 用户没选的项（不视为已同步） */
	skipped: string[];
	/** 镜像是否真的完成整库一致（部分选择时为 false） */
	mirrorComplete: boolean;
	/**
	 * 状态持久化失败的信息。
	 *
	 * 文件/远端结果已经发生，只是"记住它们"这一步失败：报告仍然返回，
	 * 由上层明确提示并在下次操作前核对实际状态，不能把已完成的写入说成失败。
	 */
	persistError?: string;
};

/** 执行所需的外部能力，全部由上层注入，执行器本身不直接碰网络或磁盘。 */
export type ExecutionPorts = {
	/** 复核仓库/分支身份 */
	currentIdentity(): Promise<SyncIdentity>;
	/** 复核远端头 */
	currentRemoteHead(): Promise<string>;
	/** 复核规则指纹 */
	currentRulesFingerprint(): Promise<string>;
	/**
	 * 读取当前本地/远端相关路径状态（用于执行前复核与写入前置校验）。
	 *
	 * 必须能区分三态，否则无法发现"预览后文件被删除"：
	 * - 有 SHA：该路径存在且状态为该 SHA
	 * - `null`：**确认不存在**
	 * - 缺省（undefined）：读不到，无法判断（不能当成不存在，也不能当成没变化）
	 */
	currentPathState(paths: string[]): Promise<{
		local: Record<string, string | null>;
		remote: Record<string, string | null>;
	}>;
	/**
	 * 逐条即时读取某一路径的当前状态（**不得复用执行开始的缓存**）。
	 *
	 * 远端发布可能耗时数分钟，期间用户或其他插件会改文件。前置校验必须看到
	 * 此刻的真实状态，否则"写前校验"只是把旧缓存再读一遍，等于没有校验。
	 * 只读这一条路径，不做全库重扫。
	 */
	peekPath?: (side: "local" | "remote", path: string) => Promise<{ present: boolean; sha?: string } | { error: string }>;
	/**
	 * 真正执行一条本地写。
	 *
	 * 显式内容只走这一个参数（`content`），与远端发布的 `content` 同类型：
	 * 之前用 string/FileContent 两套表示，适配层丢掉了第二参数，
	 * 导致手工结果在真实链路上永远不生效。现在只有一种表示。
	 */
	writeLocal(path: string, content?: FileContent): Promise<void>;
	/** 真正执行一条本地删 */
	deleteLocal(path: string): Promise<void>;
	/** 远端发布：一次性提交本次所有已选远端动作，绑定 expectedHead */
	publishRemote(actions: { additions: Array<{ path: string; content?: FileContent }>; deletions: string[] }): Promise<
		| { status: "committed"; commitSha: string; committedPaths: string[]; digests?: Record<string, ContentDigest> }
		| { status: "head-changed" }
		| { status: "failed"; error: string }
		| { status: "uncertain"; detail: string }
	>;
	/** 写入完成后的内容摘要（用于推进共同状态） */
	digestOf(side: "local" | "remote", path: string): Promise<ContentDigest>;
	onProgress?(stage: string, completed: number, total: number): void;
};

/** 计划过期复核：任何一项不符都整体拒绝，且不改动任何文件。 */
export async function verifyPlanStillValid(
	plan: SyncPlan,
	ports: ExecutionPorts,
	/** 只复核本次真正会执行到的路径；不传则复核计划里的全部路径 */
	pathsToCheck?: string[]
): Promise<string | null> {
	const identity = await ports.currentIdentity();
	if (identity.owner !== plan.identity.owner || identity.repo !== plan.identity.repo || identity.branch !== plan.identity.branch) {
		return `仓库或分支已变更（预览时为 ${plan.identity.owner}/${plan.identity.repo}@${plan.identity.branch}），未改动任何文件；请重新检查。`;
	}
	const head = await ports.currentRemoteHead();
	if (head !== plan.remoteCommitSha) {
		return "预览之后远端分支已变化，未改动任何文件；请重新检查后再执行。";
	}
	const fingerprint = await ports.currentRulesFingerprint();
	if (fingerprint !== plan.rulesFingerprint) {
		return "预览之后忽略规则已变化，计划已失效，未改动任何文件；请重新检查。";
	}
	// 只比较计划涉及的路径：无关文件的改动不应让计划失效。
	const paths = pathsToCheck ?? Array.from(new Set(plan.operations.map(op => op.path)));
	const current = await ports.currentPathState(paths);
	for (const path of paths) {
		const plannedSha = plan.localState[path];
		// 三态：有值=存在、null=确认不存在、undefined=读不到。
		const hasKey = Object.prototype.hasOwnProperty.call(current.local, path);
		if (!hasKey) {
			// 读不到不能当成"没变化"：无法确认前置条件，保守拒绝。
			return `无法确认本地路径当前状态（${path}），未改动任何文件；请重新检查后再执行。`;
		}
		const currentSha = current.local[path];
		if (plannedSha === undefined && currentSha === null) {
			// 计划里本就不存在、现在确认仍不存在：一致。
			continue;
		}
		if (currentSha !== plannedSha) {
			const detail = currentSha === null
				? "预览之后该本地文件已被删除"
				: plannedSha === undefined ? "预览之后该本地路径被创建" : "预览之后本地文件已变化";
			return `${detail}（${path}），未改动任何文件；请重新检查后再执行。`;
		}
	}
	return null;
}

/**
 * 把发布阶段抛出的异常分类成结构化结果。
 *
 * 判定原则（不谎报、不盲重试）：
 * - 认证失败、参数/权限拒绝 → 明确 failed（服务端已拒绝，没有写入）；
 * - 其余无法确定是否已写入的（网络中断、响应丢失、缺少提交标识）→ uncertain，
 *   要求先查证远端实际状态再决定是否重试；
 * - 失败的判定必须是保守的：没有确凿"未写入"证据时一律 uncertain。
 */
/**
 * 从 GitHub 的响应里提取服务器真正说的话。
 *
 * GraphQL 的错误不体现在 HTTP 状态上：返回 200，但 body 里有 errors[]。
 * 只报 "Something went wrong" 等于没报——把 type 与 message 原样带出来，
 * 用户才知道是权限、分支保护、还是载荷不合法。
 */
export function describeGitHubError(error: unknown): string {
	const parts: string[] = [];
	if (error instanceof Error && error.message) parts.push(error.message);
	const detail = error as {
		status?: number;
		errors?: Array<{ message?: string; type?: string; path?: string[] }>;
		response?: { status?: number; data?: { message?: string; errors?: Array<{ message?: string; type?: string }> } };
	} | null;
	const status = detail?.status ?? detail?.response?.status;
	if (typeof status === "number" && !/\b\d{3}\b/.test(parts[0] ?? "")) {
		parts.unshift(`HTTP ${status}`);
	}
	const graphQl = detail?.errors ?? detail?.response?.data?.errors;
	if (Array.isArray(graphQl) && graphQl.length > 0) {
		const messages = graphQl
			.map(entry => [entry.type, entry.message].filter(Boolean).join(": "))
			.filter(text => text.length > 0);
		if (messages.length > 0) parts.push(messages.join("；"));
	} else if (detail?.response?.data?.message) {
		parts.push(detail.response.data.message);
	}
	return parts.filter(Boolean).join(" — ") || "GitHub 未返回错误详情";
}

export function classifyPublishError(error: unknown): Awaited<ReturnType<ExecutionPorts["publishRemote"]>> {
	const message = describeGitHubError(error);
	const status = (error as { status?: number } | null)?.status;
	// 4xx 是"这次请求被拒绝"，服务端没有接受，可以明确报失败（408/429 除外：可能是暂时性的）。
	if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
		return { status: "failed", error: message };
	}
	if (error instanceof VaultError) {
		if (error.type === "authentication") return { status: "failed", error: message };
		// network / remote_not_found / filesystem：是否已写入无法确定
		return { status: "uncertain", detail: message };
	}
	return { status: "uncertain", detail: message };
}

/**
 * 写入前的单条前置校验。
 *
 * 发布/写入可能耗时，必须逐条确认目标状态没有在这期间改变，
 * 不能复用一次执行开始的缓存就任意覆盖。
 *
 * @param expectation 期望的当前状态：字符串=该 SHA，null=必须不存在
 */
/**
 * 只要求"路径仍然存在"的期望值。
 *
 * 用于手工覆盖：内容将与计划值不同，但路径必须还在（用户没把它删掉）。
 */
export const ANY_PRESENT = Symbol("any-present");
export type PreconditionExpectation = string | null | typeof ANY_PRESENT;

export async function verifyPrecondition(
	ports: ExecutionPorts,
	side: "local" | "remote",
	path: string,
	expectation: PreconditionExpectation
): Promise<string | null> {
	// 优先用"即时读取单条路径"：不复用执行开始的缓存。
	if (ports.peekPath) {
		const peeked = await ports.peekPath(side, path);
		if ("error" in peeked) {
			return `无法确认${side === "local" ? "本地" : "远端"}路径当前状态（${path}）：${peeked.error}`;
		}
		const actual = peeked.present ? peeked.sha ?? "" : null;
		if (expectation === ANY_PRESENT) {
			return actual === null ? `目标路径已不存在（${path}）。` : null;
		}
		if (actual !== expectation) {
			return actual === null
				? `目标路径已不存在（${path}）。`
				: expectation === null
					? `目标路径已被创建（${path}）。`
					: `目标路径内容已变化（${path}）。`;
		}
		return null;
	}
	const current = await ports.currentPathState([path]);
	const table = side === "local" ? current.local : current.remote;
	if (!Object.prototype.hasOwnProperty.call(table, path)) {
		return `无法确认${side === "local" ? "本地" : "远端"}路径当前状态（${path}）。`;
	}
	const actual = table[path];
	if (expectation === ANY_PRESENT) {
		return actual === null ? `目标路径已不存在（${path}）。` : null;
	}
	if (actual !== expectation) {
		return actual === null
			? `目标路径已不存在（${path}）。`
			: expectation === null
				? `目标路径已被创建（${path}）。`
				: `目标路径内容已变化（${path}）。`;
	}
	return null;
}

export type ExecuteOptions = {
	/** 用户勾选的操作 id；未列出的操作一律不执行、不推进状态 */
	selected: Set<string>;
	/** 镜像规则：用于最终判断是否真的完整镜像 */
	rule: SyncPlan["rule"];
	/** 用户中止：逐步检查，已完成的保持不变 */
	signal?: AbortSignal;
};

export async function executePlan(
	plan: SyncPlan,
	options: ExecuteOptions,
	ports: ExecutionPorts
): Promise<ExecutionReport> {
	// 不再做"执行前整份复核"：每条写/删在动作前都有逐项前置校验，
	// 远端由条件提交的 expectedHeadOid 兜底，重复一遍只会多一次远端请求
	// 和一轮本地读取。
	const selectedOps = plan.operations.filter(op => options.selected.has(op.id));
	const skipped = plan.operations.filter(op => !options.selected.has(op.id)).map(op => op.path);
	if (selectedOps.length === 0) {
		// 全不选：不写任何文件，也不推进任何状态。
		return { items: [], succeeded: [], failed: [], uncertain: [], skipped, mirrorComplete: false };
	}

	const items: ExecutedItem[] = [];
	const push = (op: PlanOperation, outcome: ItemOutcome, digest?: ContentDigest) => {
		items.push({ operationId: op.id, path: op.path, kind: op.kind, outcome, ...(digest ? { digest } : {}) });
	};

	// ---- 远端动作：尽量形成一个提交，绑定审阅时的头 ----
	const remoteOps = selectedOps.filter(op => op.kind === "write-remote" || op.kind === "delete-remote");
	const isAborted = () => options.signal?.aborted === true;
	if (remoteOps.length > 0 && isAborted()) {
		for (const op of remoteOps) push(op, { status: "failed", error: "已中止：未执行远端改动。" });
	} else if (remoteOps.length > 0) {
		ports.onProgress?.("发布远端", 0, remoteOps.length);
		// 手工决策的显式内容随操作一起传下去：适配层不需要再回读源端。
		// 空字符串也是合法内容，因此用 "typeof === string" 而非真值判断。
		const additions = remoteOps
			.filter(op => op.kind === "write-remote")
			.map(op => ({
				path: op.path,
				...(typeof op.manualText === "string"
					? { content: FileContent.fromPlainText(op.manualText) }
					: {})
			}));
		// 摘要由发布适配层在读取待发送内容时顺带算出（不多读一次远端）。
		let sentDigests: Record<string, ContentDigest> = {};
		const deletions = remoteOps.filter(op => op.kind === "delete-remote").map(op => op.path);
		// 发布可能"已经发生但结果不明"：必须把异常通道也映射成结构化结果，
		// 不能让已写入的提交变成一次直接抛出的失败（那会让用户一无所知地重试）。
		type PublishResult = Awaited<ReturnType<ExecutionPorts["publishRemote"]>>;
		let result: PublishResult;
		try {
			result = await ports.publishRemote({ additions, deletions });
		} catch (error) {
			result = classifyPublishError(error);
		}
		if (result.status === "committed") {
			sentDigests = result.digests ?? {};
			const committed = new Set(result.committedPaths);
			for (const op of remoteOps) {
				if (!committed.has(op.path)) {
					push(op, { status: "uncertain", detail: "提交已建立，但该路径未出现在提交结果中，需核对远端实际内容。" });
					continue;
				}
				// 生产适配层会带回发布内容的摘要；自定义端口没给时才回读一次（兜底）。
				const digest = op.kind === "write-remote"
					? sentDigests[op.path] ?? await safeDigest(ports, "remote", op.path)
					: undefined;
				push(op, { status: "succeeded" }, digest);
			}
		} else if (result.status === "head-changed") {
			// 计划过期：一个字都没写，全部记为失败且原因明确。
			for (const op of remoteOps) {
				push(op, { status: "failed", error: "发布前远端分支头已变化（严格条件提交被拒绝），本次未写入任何远端内容；请重新检查。" });
			}
		} else if (result.status === "uncertain") {
			for (const op of remoteOps) push(op, { status: "uncertain", detail: result.detail });
		} else {
			for (const op of remoteOps) push(op, { status: "failed", error: result.error });
		}
	}

	// ---- 本地动作：逐条执行，部分成功如实记录 ----
	const localOps = selectedOps.filter(op => op.kind === "write-local" || op.kind === "delete-local");
	let completed = items.length;
	const total = selectedOps.length;
	for (const op of localOps) {
		if (isAborted()) {
			push(op, { status: "failed", error: "已中止：未执行。" });
			completed++;
			continue;
		}
		try {
			const plannedSha = plan.localState[op.path];
			if (op.kind === "write-local") {
				// 发布可能耗时：逐条确认目标没有在这期间被删除或改动。
				// 前置校验比较的是"预览时的目标"与"此刻的目标"，与即将写入的内容无关。
				// 手工结果同样必须校验：否则用户在预览后对同一文件的改动会被静默覆盖。
				// - 预览时目标存在（update）：要求此刻 SHA 仍是那个值；
				// - 预览时目标不存在（add / 手工恢复）：要求此刻仍然不存在，
				//   这样"用户预览后新建同名文件"会被拦下，而"原本就缺失"的合法恢复可以写入。
				const expectation = plannedSha ?? null;
				const mismatch = await verifyPrecondition(ports, "local", op.path, expectation);
				if (mismatch) {
					push(op, { status: "failed", error: `写入前校验失败：${mismatch}` });
					completed++;
					continue;
				}
				await ports.writeLocal(
					op.path,
					typeof op.manualText === "string" ? FileContent.fromPlainText(op.manualText) : undefined
				);
				const digest = await safeDigest(ports, "local", op.path);
				push(op, { status: "succeeded" }, digest);
			} else {
				const mismatch = await verifyPrecondition(ports, "local", op.path, plannedSha ?? null);
				if (mismatch) {
					push(op, { status: "failed", error: `删除前校验失败：${mismatch}` });
					completed++;
					continue;
				}
				await ports.deleteLocal(op.path);
				push(op, { status: "succeeded" });
			}
		} catch (error) {
			push(op, { status: "failed", error: error instanceof Error ? error.message : String(error) });
		}
		completed++;
		ports.onProgress?.("写入本地", completed, total);
	}

	const succeeded = items.filter(item => item.outcome.status === "succeeded");
	const failed = items.filter(item => item.outcome.status === "failed");
	const uncertain = items.filter(item => item.outcome.status === "uncertain");

	// 镜像只有在"全部操作都被选中且全部成功"时才算完整。
	const mirrorComplete = options.rule === "mirror"
		&& skipped.length === 0
		&& succeeded.length === selectedOps.length
		&& selectedOps.length === plan.operations.length;

	return {
		items,
		succeeded,
		failed,
		uncertain,
		skipped,
		mirrorComplete
	};
}

async function safeDigest(ports: ExecutionPorts, side: "local" | "remote", path: string): Promise<ContentDigest | undefined> {
	try {
		return await ports.digestOf(side, path);
	} catch (error) {
		// 摘要取不到不影响"文件已写入"这个事实，但不能用来推进共同状态。
		fitLogger.log(`[Execution] 无法读取 ${side}/${path} 的摘要，暂不推进共同状态`, error);
		return undefined;
	}
}

/**
 * 只推进实际成功项的共同状态。
 *
 * - succeeded 且拿到摘要 → 记录 same
 * - 删除成功 → 该路径只有在两端都确认不存在时才记 absent（由调用方传入核对结果）
 * - 失败/待确认/未选 → 保持原状，绝不标记为已同步
 */
export function applyOutcomesToCommonState(
	commonState: CommonState,
	report: ExecutionReport,
	bothAbsent: string[] = [],
	confirmedSame: Iterable<string> = []
): { advanced: string[]; withheld: string[] } {
	const advanced: string[] = [];
	const withheld: string[] = [];
	const bothAbsentSet = new Set(bothAbsent);
	const confirmedSet = new Set(confirmedSame);

	for (const item of report.items) {
		if (item.outcome.status !== "succeeded") {
			withheld.push(item.path);
			continue;
		}
		if (item.kind === "write-remote" || item.kind === "write-local") {
			// 写成功只说明"这一端写好了"。必须另有证据表明两端内容一致，
			// 才能记为共同状态；否则下次会把一侧的改动当成双方已知基线。
			if (!item.digest || !confirmedSet.has(item.path)) {
				withheld.push(item.path);
				continue;
			}
			// 远端写入成功后远端头已变，提交结果里没有现成的 blob OID；
			// 不伪造绑定，只记摘要结论（下次检查用 digest/逐文件或 OID 快速路径重验）。
			commonState.recordSame([{ path: item.path, digest: item.digest }]);
			advanced.push(item.path);
			continue;
		}
		// 删除：只有两端都确认不存在才算共同删除
		if (bothAbsentSet.has(item.path)) {
			commonState.recordAbsent([item.path]);
			advanced.push(item.path);
		} else {
			withheld.push(item.path);
		}
	}

	for (const path of report.skipped) {
		if (!advanced.includes(path)) withheld.push(path);
	}
	return { advanced: Array.from(new Set(advanced)), withheld: Array.from(new Set(withheld)) };
}

/**
 * 采纳一次扫描中**确实取得确定结论**的路径。
 *
 * 纪律（需求 §8「无共同状态不得把无法判定的差异当成已知删除」「未选/未决不得标成已同步」）：
 * - 只有"双方同名且内容一致"才记 same；只有"双方都确认不存在"才记 absent。
 * - 冲突未决、读取失败、执行失败、结果待确认、未选中的路径一律记 **unknown**，
 *   绝不让它们落进下一次扫描"无记录即此前不存在 → 视为 absent"的推断。
 * - 只有在本轮所有路径都有结论（或已被显式记为 unknown）后才 markEstablished()。
 *   否则一次部分执行就会整体 established，把未决路径解释成"新增"补到另一端——
 *   那会静默覆盖另一端真实的删除。
 */
export function adoptInitialCommonState(
	commonState: CommonState,
	plan: SyncPlan,
	uncertainPaths: Iterable<string> = [],
	reason = "本次未取得确定结论",
	/** 用户本次**未选**的路径：它们没有新结论，但不该抹掉已有的有效历史 */
	skippedPaths: Iterable<string> = [],
	/**
	 * 是否把扫描期"两端一致"的结论写入共同状态。
	 * 执行阶段传 false：那是预览时的快照，执行期间可能已变化；
	 * 但这些路径仍参与"不要被误记为 unknown"的路径集合。
	 */
	recordAdoptable = true
): { adopted: string[]; unknown: string[]; preserved: string[] } {
	const skipped = new Set(skippedPaths);
	const unknown = new Set<string>();
	const adoptablePaths = new Set(plan.adoptable.map(entry => entry.path));
	const absentPaths = new Set(plan.confirmedAbsent);
	const preserved: string[] = [];

	// 未选项分两种，语义必须严格区分：
	// - 已有合法历史的：保留旧 base（否则下次"已知单侧改动"会变成假冲突，抹掉有效结论）；
	// - 初始未知的：必须持久 unknown（否则下次会被"无记录即此前不存在"推断成新增，
	//   静默覆盖另一端真实的删除——这正是 R1 要防的安全反例）。
	for (const path of skipped) {
		if (adoptablePaths.has(path) || absentPaths.has(path)) continue;
		const existing = commonState.lookup(path);
		if (existing.known && existing.entry.presence !== "unknown") {
			preserved.push(path);
			continue;
		}
		unknown.add(path);
	}

	for (const path of uncertainPaths) {
		if (skipped.has(path)) continue; // 已在上面按"保留/未知"处理
		unknown.add(path);
	}
	// 未选项可能同时出现在 uncertainPaths 中（上游把它当"没有新结论"）；
	// 这里统一按 skipped 语义兜底：有合法历史就保留，初始未知才记 unknown。
	for (const path of skipped) {
		if (unknown.has(path)) {
			const existing = commonState.lookup(path);
			if (existing.known && existing.entry.presence !== "unknown") {
				unknown.delete(path);
				if (!preserved.includes(path)) preserved.push(path);
			}
		}
	}

	// 计划里所有涉及到的路径都必须有结论；没有结论的显式记为 unknown。
	for (const path of planIntroducedPaths(plan)) {
		if (adoptablePaths.has(path) || absentPaths.has(path)) continue;
		if (skipped.has(path)) continue;
		unknown.add(path);
	}
	for (const conflict of plan.conflicts) {
		// 未决冲突一律 unknown（即便未被选中，也不该让"冲突未裁决"被当成已知状态）
		unknown.add(conflict.path);
	}

	if (recordAdoptable && plan.adoptable.length > 0) {
		// 只采纳本轮扫描仍然成立的 same；执行后已变化的路径不再直接沿用旧扫描结果。
		// 附带绑定证据（远端 blob OID + 本地扫描 SHA），供下次检查做零请求快速判定。
		commonState.recordSame(plan.adoptable.map(entry => ({
			path: entry.path,
			digest: entry.digest,
			blobSha: entry.remote,
			localSha: entry.local
		})));
	}
	if (plan.confirmedAbsent.length > 0) {
		commonState.recordAbsent(plan.confirmedAbsent);
	}
	if (unknown.size > 0) {
		commonState.recordUnknown(Array.from(unknown), reason);
	}
	commonState.markEstablished();
	return {
		adopted: plan.adoptable.map(entry => entry.path),
		unknown: Array.from(unknown),
		preserved: Array.from(new Set(preserved))
	};
}

/** 计划中出现过的全部路径（操作、冲突、排除都不算"有结论"）。 */
function planIntroducedPaths(plan: SyncPlan): string[] {
	return Array.from(new Set([
		...plan.operations.map(op => op.path),
		...plan.conflicts.map(c => c.path)
	]));
}

export { ScopeContext };
