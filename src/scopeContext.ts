/**
 * 同步范围与忽略上下文
 *
 * 三个概念必须分开，不能互相冒充（开发计划 P1.1）：
 * 1. **Git 已跟踪**：本机 Git index 的内容。插件不伪造：拿不到就报"未知"。
 * 2. **本地可读**：Obsidian Vault API 能否读到该路径（隐藏路径读不到）。
 * 3. **参与 FE 同步**：本模块判定的结果——排除保留区、元数据、被忽略对象等。
 *
 * GitHub 远端树或插件缓存**不是**本机 index，不得用来推断跟踪状态。
 *
 * 忽略语义按 Git 原生规则：
 * - 单个规则文件内，后出现的规则优先；
 * - 子目录 `.gitignore` 相对其所在目录匹配，且**比父目录规则优先**；
 * - 父目录整体被排除时，子目录规则**不能**把其中的文件重新纳入
 *   （Git 不会进入被忽略的目录，`!` 无法复活）；
 * - 跨来源时，高优先级来源只要对该路径有命中（含重新纳入 `!`）即决定结果。
 *   优先级（高→低）：共享规则（根 + 子目录） > 本机 .git/info/exclude > 个人全局忽略。
 *
 * **已跟踪例外**：真实 Git 中，已跟踪文件不会因新增忽略规则而停止跟踪。
 * 因此当跟踪状态已知时，已跟踪路径即使命中忽略规则也判为参与同步，并另行提示。
 * 跟踪状态未知时不做任何推断——既不当成已跟踪，也不伪装成原生语义已实现。
 */

import { DataAdapter } from "obsidian";
import ignore, { Ignore } from "ignore";
import { digestBytes } from "./util/contentDigest";
import { ExcludedPath, IgnoreSourceKind } from "./syncTypes";

/** 共享规则文件名：唯一允许编辑的规则来源。 */
export const SHARED_IGNORE_FILE = ".gitignore";
/** 允许随 Git 提交共享的控制元数据文件名（不含任何设置/插件内容）。 */
const SHARED_CONTROL_FILES = new Set([SHARED_IGNORE_FILE]);
/** 读取子目录规则时的保护目录：不进入 Git 内部或 Obsidian 配置树。 */
const NESTED_SCAN_BLOCKLIST = [".git", ".obsidian", ".trash", ".smart-env", "_fit", "_fit-runtime"];
/**
 * 子目录规则读取的并发度。
 *
 * 这里**不设目录数上限**：静默丢弃第 N 个之后的规则会让"被忽略"的文件
 * 被当成参与同步（镜像时甚至会被删除）。候选目录只来自本次扫描实际涉及的
 * 祖先目录，本就是有界的；读取按并发度节流，不做全库遍历。
 */
const NESTED_READ_CONCURRENCY = 8;

/** 规则来源的能力状态：可用 / 未配置 / 不可访问，必须分别表达。 */
export type SourceAvailability = "available" | "absent" | "unavailable";

export type IgnoreSource = {
	kind: IgnoreSourceKind;
	label: string;
	path?: string;
	availability: SourceAvailability;
	content?: string;
	editable: boolean;
	reason?: string;
};

function isObsidianSettings(path: string): boolean {
	return /^\.obsidian(\/|$)/.test(path) || /^\.trash(\/|$)/.test(path) || /^\.smart-env(\/|$)/.test(path);
}

function isGitMetadata(path: string): boolean {
	return /^\.git(\/|$)/.test(path);
}

function isReserved(path: string): boolean {
	return path === "_fit" || path.startsWith("_fit/") || path.startsWith("_fit-runtime/");
}

/** 任意层级的共享规则文件（根与子目录的 .gitignore）。 */
function isSharedControlMetadata(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return SHARED_CONTROL_FILES.has(name);
}

function isBlockedForNestedScan(dir: string): boolean {
	return NESTED_SCAN_BLOCKLIST.some(blocked => dir === blocked || dir.startsWith(`${blocked}/`));
}

/**
 * 判断错误是"文件不存在"还是"存在但读不到"。
 *
 * 二者必须分开：不存在 = 该来源未配置（`absent`，可安全当作没有规则）；
 * 存在但读不到 = 规则未知，不能按"没有规则"放行。
 * 调用方把 stat/read 的任何异常都塞进 error 字段，这里按消息区分。
 */
function isAbsenceError(message: string): boolean {
	return /ENOENT|no such file|not exist|不存在|is not a file|不是文件/i.test(message);
}

/** 路径越界检查：拒绝绝对路径与 .. 段。 */
export function isPathInsideVault(path: string): boolean {
	if (!path) return false;
	if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
	const segments = path.split("/");
	return segments.every(segment => segment !== ".." && segment !== ".");
}

/** 路径的祖先目录，由浅到深（不含路径自身所在目录之外的部分）。 */
function ancestorsOf(path: string): string[] {
	const parts = path.split("/");
	parts.pop();
	const dirs: string[] = [];
	for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
	return dirs;
}

/** 在指定目录下的相对路径；不在该目录下时返回 null。 */
function relativeTo(dir: string, path: string): string | null {
	if (dir === "") return path;
	if (!path.startsWith(`${dir}/`)) return null;
	return path.slice(dir.length + 1);
}

export type ScopeContextInput = {
	/** 各来源原文；undefined 表示该来源未配置 */
	sharedIgnoreContent?: string;
	sharedIgnoreError?: string;
	globalIgnoreContent?: string;
	globalIgnoreError?: string;
	/**
	 * 子目录 `.gitignore`：键为相对目录（根为 ""，子目录为 "sub" 等），值为原文。
	 * 未提供时，若同时给了 `candidatePaths`，会在有界范围内按需读取。
	 */
	nestedIgnoreContents?: Record<string, string>;
	/** 读取子目录规则失败的目录 → 原因。 */
	nestedIgnoreErrors?: Record<string, string>;
	/** 与 `nestedIgnoreContents` 配套：调用方明确声明未覆盖的目录（应恒为空）。 */
	nestedIgnoredOmitted?: readonly string[];
	/**
	 * 候选路径（来自一次扫描）。提供后，`create` 会按这些路径的祖先目录
	 * 有界地读取子目录 `.gitignore`，不需要遍历整个知识库。
	 * 不进入 `.git/`、`.obsidian/` 等受保护目录。
	 */
	candidatePaths?: readonly string[];
	/**
	 * 是否把共享规则文件（`.gitignore`）视为参与同步。
	 *
	 * 默认 `false`：按现状归入 `control-metadata` 排除，由界面另行提示。
	 * 置 `true` 时这些文件**不再是排除对象**，可在用户审阅后随 Git 提交共享；
	 * 不表示同步 Obsidian 设置、插件目录或任何私有 exclude。
	 */
	includeSharedControlMetadata?: boolean;
};

export type ScopeDecision =
	| { kind: "in-scope" }
	| { kind: "excluded"; excluded: ExcludedPath };

/** 一层规则：kind 决定跨来源优先级，dir 决定相对匹配的基准目录。 */
type RuleLayer = { kind: IgnoreSourceKind; dir: string; filter: Ignore; path: string; content: string };

export class ScopeContext {
	private readonly layers: RuleLayer[];
	private readonly sourceErrors: Map<IgnoreSourceKind, string>;
	private readonly nestedErrors: Map<string, string>;
	/** 未被覆盖的规则目录；非空即表示忽略语义不完整，计划必须整体失败。 */
	private readonly omittedDirs: readonly string[];
	/**
	 * 生效的共享控制元数据策略（归一化为布尔）。
	 *
	 * `undefined` 与 `false` 行为完全一致（默认排除），因此必须归一化，
	 * 否则"未传"与"显式关"会被算成两个不同指纹，产生无意义的计划失效。
	 */
	private readonly includeSharedControlMetadata: boolean;

	private constructor(
		private readonly input: ScopeContextInput,
		layers: RuleLayer[],
		sourceErrors: Map<IgnoreSourceKind, string>,
		nestedErrors: Map<string, string>,
		omittedDirs: readonly string[]
	) {
		this.layers = layers;
		this.sourceErrors = sourceErrors;
		this.nestedErrors = nestedErrors;
		this.omittedDirs = omittedDirs;
		this.includeSharedControlMetadata = Boolean(input.includeSharedControlMetadata);
	}

	static async create(adapter: DataAdapter, input: ScopeContextInput = {}): Promise<ScopeContext> {
		const sourceErrors = new Map<IgnoreSourceKind, string>();
		let shared = input.sharedIgnoreContent;
		if (shared === undefined) {
			if (input.sharedIgnoreError !== undefined) {
				sourceErrors.set("shared", input.sharedIgnoreError);
				shared = "";
			} else {
				try {
					const stat = await adapter.stat(SHARED_IGNORE_FILE);
					shared = stat && stat.type === "file" ? await adapter.read(SHARED_IGNORE_FILE) : "";
				} catch (error) {
					sourceErrors.set("shared", error instanceof Error ? error.message : String(error));
					shared = "";
				}
			}
		} else if (input.sharedIgnoreError !== undefined) {
			sourceErrors.set("shared", input.sharedIgnoreError);
		}
		if (input.globalIgnoreError !== undefined) sourceErrors.set("global", input.globalIgnoreError);

		const nestedErrors = new Map<string, string>(Object.entries(input.nestedIgnoreErrors ?? {}));
		// 完整性：显式注入的规则视为已覆盖调用方想覆盖的目录；
		// 从磁盘采集时以采集结果为准，绝不静默省略。
		let nestedContents: Record<string, string>;
		let omittedDirs: string[];
		if (input.nestedIgnoreContents !== undefined) {
			nestedContents = { ...input.nestedIgnoreContents };
			omittedDirs = [...(input.nestedIgnoredOmitted ?? [])];
		} else {
			const collected = await collectNestedIgnoreFiles(adapter, input.candidatePaths ?? [], nestedErrors);
			nestedContents = collected.contents;
			omittedDirs = collected.omitted;
		}
		const nested = nestedContents;

		// 高优先级来源放前面；空规则不建层（否则会把"未配置"误报成"有规则"）。
		// 子目录规则放在其父目录之后，因此同来源内"越深越优先"由顺序天然表达。
		const layers: RuleLayer[] = [];
		const addLayer = (kind: IgnoreSourceKind, dir: string, content: string | undefined, path: string) => {
			if (!content || content.trim().length === 0) return;
			layers.push({ kind, dir, filter: ignore().add(content), path, content });
		};

		addLayer("shared", "", shared, SHARED_IGNORE_FILE);
		for (const dir of Object.keys(nested).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
			if (dir === "") continue;
			addLayer("shared", dir, nested[dir], `${dir}/${SHARED_IGNORE_FILE}`);
		}
		addLayer("global", "", input.globalIgnoreContent, "(个人全局 core.excludesFile)");

		// 在 create 时一次性解析跟踪状态：decide() 保持同步签名，调用方无需改动。

		return new ScopeContext(
			{ ...input, sharedIgnoreContent: shared },
			layers,
			sourceErrors,
			nestedErrors,
			omittedDirs
		);
	}

	/**
	 * 忽略语义是否完整覆盖了本次扫描涉及的目录。
	 *
	 * 不完整时**不得**继续生成计划：未覆盖目录里的规则可能把文件判成
	 * "参与同步"，镜像还会据此删除。调用方应整体拒绝本次计划并提示用户。
	 */
	completeness(): {
		complete: boolean;
		omittedCount: number;
		omittedDirs: readonly string[];
		/** 参与匹配但读不到的规则来源；非空同样表示不能按"无规则"继续 */
		unreadableSources: readonly string[];
	} {
		return {
			complete: this.omittedDirs.length === 0 && this.unreadableSources().length === 0,
			omittedCount: this.omittedDirs.length,
			omittedDirs: this.omittedDirs,
			unreadableSources: this.unreadableSources()
		};
	}

	/**
	 * 参与忽略匹配、但内容读取失败的规则来源。
	 *
	 * 读不到**不等于**没有规则：把读失败当成"空规则"会让本应被忽略的文件
	 * 被当成参与同步（镜像时甚至会被删除）。因此这些来源必须阻断计划。
	 */
	private unreadableSources(): string[] {
		const blocking: string[] = [];
		const blocks = (kind: IgnoreSourceKind): boolean => {
			const reason = this.sourceErrors.get(kind);
			// 未配置（文件不存在）不阻断；读出错误才阻断。
			return reason !== undefined && !isAbsenceError(reason);
		};
		// 根共享规则：唯一可编辑来源，读不到就没有可信的共享规则。
		if (blocks("shared")) blocking.push(SHARED_IGNORE_FILE);
		// 本机排除：Git 原生会应用它，读不到就无法判断实际范围。
		// 个人全局忽略：同样参与匹配；能读到就必须用，读不到不能装作没有。
		if (blocks("global")) blocking.push("(个人全局 core.excludesFile)");
		// 子目录规则：逐个目录列出；同样区分"不存在"与"读不到"。
		for (const [dir, reason] of [...this.nestedErrors.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			if (isAbsenceError(reason)) continue;
			blocking.push(`${dir}/${SHARED_IGNORE_FILE}`);
		}
		return blocking;
	}

	/**
	 * 不完整时抛错，供调用方在生成计划前调用。
	 *
	 * 错误信息可直接展示给用户；抛出后不得写任何文件或发布远端提交。
	 */
	assertComplete(): void {
		const state = this.completeness();
		if (state.complete) return;
		const reasons: string[] = [];
		if (state.omittedDirs.length > 0) {
			reasons.push(
				`有 ${state.omittedDirs.length} 个目录的 .gitignore 未被覆盖`
				+ `（例如 ${state.omittedDirs.slice(0, 3).join("、")}）`
			);
		}
		if (state.unreadableSources.length > 0) {
			reasons.push(
				`有 ${state.unreadableSources.length} 个规则来源读取失败`
				+ `（例如 ${state.unreadableSources.slice(0, 3).join("、")}）`
			);
		}
		throw new Error(
			`忽略规则不完整：${reasons.join("；")}。`
			+ "读不到或未覆盖的规则可能使本应被忽略的文件被当成参与同步（镜像时可能误删），"
			+ "本次未生成计划、未改动任何文件。"
		);
	}

	/** 已加载的子目录规则目录（供界面与测试观察，不影响判定）。 */
	nestedIgnoreDirs(): string[] {
		return this.layers
			.filter(layer => layer.kind === "shared" && layer.dir !== "")
			.map(layer => layer.dir);
	}

	describeSources(): IgnoreSource[] {
		const build = (kind: IgnoreSourceKind, label: string, path: string, content: string | undefined, editable: boolean): IgnoreSource => {
			const reason = this.sourceErrors.get(kind);
			const availability: SourceAvailability = reason ? "unavailable" : content === undefined ? "absent" : "available";
			return {
				kind, label, path, availability, content: content ?? "", editable,
				...(reason ? { reason } : {})
			};
		};
		const sources = [
			build("shared", "共享 .gitignore", SHARED_IGNORE_FILE, this.input.sharedIgnoreContent, true),
			build("global", "个人全局忽略规则", "(个人全局 core.excludesFile)", this.input.globalIgnoreContent, false)
		];
		// 子目录规则单独列出：它们参与匹配但同样只由共享文件承载。
		for (const layer of this.layers) {
			if (layer.kind !== "shared" || layer.dir === "") continue;
			sources.push({
				kind: "shared",
				label: `子目录 .gitignore（${layer.dir}）`,
				path: layer.path,
				availability: "available",
				content: "",
				editable: false
			});
		}
		for (const [dir, reason] of this.nestedErrors) {
			sources.push({
				kind: "shared",
				label: `子目录 .gitignore（${dir}）`,
				path: `${dir}/${SHARED_IGNORE_FILE}`,
				availability: "unavailable",
				content: "",
				editable: false,
				reason
			});
		}
		return sources;
	}

	/**
	 * 规则指纹：任一条规则文件变化都让旧计划失效。
	 *
	 * 只覆盖**规则语义**：各来源原文、来源可用性、子目录规则原文，以及
	 * "已跟踪且当前被忽略"的路径集合（该集合直接改变 decide 结果）。
	 * 不含时间戳、提交号、文件内容或任何凭据。
	 */
	async fingerprint(): Promise<string> {
		const parts = [
			`shared:${this.input.sharedIgnoreContent ?? ""}`,
			`global:${this.input.globalIgnoreContent ?? ""}`
		];
		const availability = [...this.sourceErrors.keys()].sort().join(",");
		parts.push(`errors:${availability}`);
		// 直接用已加载层里的规则原文：无论来自显式注入还是磁盘收集，
		// 都按同一口径计入指纹，不序列化库内部对象。
		const nestedRaw = this.layers
			.filter(layer => layer.kind === "shared" && layer.dir !== "")
			.sort((a, b) => a.dir.localeCompare(b.dir))
			.map(layer => `${layer.dir}:${layer.content}`)
			.join("\u0001");
		parts.push(`nested:${nestedRaw}`);
		// 完整性必须进入指纹：否则两次"都不完整"的扫描指纹相同，
		// 旧计划会被误认为仍然有效。
		parts.push(`nested-complete:${this.completeness().complete ? "yes" : "no"}`);
		parts.push(`nested-omitted:${[...this.omittedDirs].sort().join("\u0002")}`);
		// 来源可读性同样影响判定结果：从"不可读"变成"可读"必须让旧计划失效。
		parts.push(`unreadable:${this.unreadableSources().join("\u0002")}`);
		// 生效策略位：同一批规则、不同控制元数据策略下 decide 结果不同
		// （.gitignore 是否参与同步），必须让旧计划失效。
		parts.push(`shared-control-metadata:${this.includeSharedControlMetadata ? "on" : "off"}`);
		const bytes = new TextEncoder().encode(parts.join("\u0000"));
		return digestBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	}

	/** 已跟踪且被忽略的路径集合；跟踪未知时为空并显式标注未知。 */

	private matchLayer(layer: RuleLayer, path: string): { ignored: boolean; rule?: string } | null {
		if (layer.dir !== "") {
			const relative = relativeTo(layer.dir, path);
			// 相对路径为空表示查询的是该目录自身（例如 "sub/"）；目录项不由
			// 子目录规则判定，避免空路径进入匹配库。
			if (relative === null || relative === "") return null;
			const result = layer.filter.test(relative);
			if (result.ignored || result.unignored) return { ignored: result.ignored, rule: result.rule?.pattern };
			return null;
		}
		const result = layer.filter.test(path);
		if (result.ignored || result.unignored) return { ignored: result.ignored, rule: result.rule?.pattern };
		return null;
	}

	/**
	 * 按来源优先级 + 目录深度解析忽略归属；未命中返回 null。
	 *
	 * 顺序：共享根 → 共享子目录（深→浅）→ 本机 → 全局。
	 * 第一个命中即决定结果，因此高层级的 `!` 不会被低层级再次覆盖。
	 */
	private matchIgnore(path: string): { source: IgnoreSourceKind; rule?: string; ignored: boolean } | null {
		const sharedRoot = this.layers.filter(layer => layer.kind === "shared" && layer.dir === "");
		const sharedNested = this.layers
			.filter(layer => layer.kind === "shared" && layer.dir !== "")
			.sort((a, b) => b.dir.split("/").length - a.dir.split("/").length);
		const rest = this.layers.filter(layer => layer.kind !== "shared");
		const ordered = [...sharedNested, ...sharedRoot, ...rest];
		for (const layer of ordered) {
			const hit = this.matchLayer(layer, path);
			if (hit) return { source: layer.kind, rule: hit.rule, ignored: hit.ignored };
		}
		return null;
	}

	/**
	 * 原始忽略判定（不考虑已跟踪例外）。
	 *
	 * 父目录被整体排除时，该路径同样被排除：Git 不会进入被忽略的目录，
	 * 子目录 `.gitignore` 里的 `!` 无法把它复活。
	 *
	 * 目录本身被 `!dir/` 重新纳入时无需特判：`matchIgnore(dir)` 已按
	 * "同文件内后规则优先" 返回 unignored，Git 也正是在这种情况下才会进入该目录。
	 */
	private rawIgnores(path: string): boolean {
		// 目录在 Git 规则里用尾斜杠表达；`ignore` 库同样只在带 `/` 时按目录匹配。
		for (const dir of ancestorsOf(path)) {
			if (this.matchIgnore(`${dir}/`)?.ignored) return true;
		}
		const self = this.matchIgnore(path);
		return self?.ignored ?? false;
	}

	/**
	 * 该路径是否被忽略（跨来源合并后的最终结果，不含已跟踪例外）。
	 *
	 * 高优先级来源只要对该路径有命中就决定结果——包括用 `!` 重新纳入。
	 */
	ignores(path: string): boolean {
		return this.rawIgnores(path);
	}

	/**
	 * 判定单条路径。
	 *
	 * @param locallyReadable 本地 Vault API 是否可读（隐藏路径为 false）
	 */
	decide(path: string, locallyReadable: boolean): ScopeDecision {
		const excluded = (reason: ExcludedPath["reason"], extra?: Partial<ExcludedPath>): ScopeDecision => ({
			kind: "excluded",
			excluded: { path, reason, ...extra }
		});
		if (!isPathInsideVault(path)) return excluded("outside-vault");
		if (isGitMetadata(path)) return excluded("git-metadata");
		if (isReserved(path)) return excluded("reserved");
		if (isObsidianSettings(path)) return excluded("obsidian-settings", { source: "plugin-policy" });
		// 共享控制元数据默认排除，只有显式开启才参与同步；无论如何不对外扩到设置/插件目录。
		const sharedControl = isSharedControlMetadata(path);
		if (sharedControl && !this.includeSharedControlMetadata) {
			return excluded("control-metadata", { source: "plugin-policy" });
		}
		if (this.rawIgnores(path)) {
			// 只按 .gitignore 判定；本机排除与跟踪状态交给 Git，插件不参与。
			const matched = this.matchIgnore(path);
			return excluded("ignored", { rule: matched?.rule, source: matched?.source });
		}
		// 共享控制元数据由插件用自己的 adapter 读写（Obsidian 的索引看不到隐藏文件），
		// 因此不受"本地索引不可读"限制；否则开关打开也无法真正同步规则文件。
		if (!locallyReadable && !sharedControl) return excluded("local-unreadable-hidden");
		return { kind: "in-scope" };
	}


}

/**
 * 子目录规则采集结果。
 *
 * `omitted` 恒为空数组：本实现不丢弃任何候选目录。保留该字段是为了让
 * 完整性状态可被显式表达并被指纹覆盖，避免将来再引入静默截断。
 */
export type NestedIgnoreCollection = {
	contents: Record<string, string>;
	/** 尚未覆盖的目录（本实现不会产生；一旦出现即为不完整，必须让计划失败） */
	omitted: string[];
};

/**
 * 按候选路径的祖先目录，逐目录读取子目录 `.gitignore`。
 *
 * 只读候选路径实际涉及的目录，不遍历整个知识库，不进入 `.git/`、
 * `.obsidian/` 等受保护目录；读不到时按目录记录原因，不静默当成"没有规则"。
 * 读取按 {@link NESTED_READ_CONCURRENCY} 并发，且目录集合在开始读取前就已确定，
 * 因此不存在"读到一半截断"的中间态。
 */
export async function collectNestedIgnoreFiles(
	adapter: DataAdapter,
	candidatePaths: readonly string[],
	errors: Map<string, string> = new Map()
): Promise<NestedIgnoreCollection> {
	const dirs = new Set<string>();
	for (const path of candidatePaths) {
		for (const dir of ancestorsOf(path)) {
			if (isBlockedForNestedScan(dir) || dir === "") continue;
			dirs.add(dir);
		}
	}
	const ordered = [...dirs].sort();
	const contents: Record<string, string> = {};

	// 受限并发的按需读取：不新增依赖，用简单的 worker 池推进下标。
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < ordered.length) {
			const dir = ordered[cursor++];
			const filePath = `${dir}/${SHARED_IGNORE_FILE}`;
			try {
				const stat = await adapter.stat(filePath);
				if (!stat || stat.type !== "file") continue;
				contents[dir] = await adapter.read(filePath);
			} catch (error) {
				errors.set(dir, error instanceof Error ? error.message : String(error));
			}
		}
	};
	const workers = Array.from(
		{ length: Math.min(NESTED_READ_CONCURRENCY, ordered.length) },
		() => worker()
	);
	await Promise.all(workers);

	return { contents, omitted: [] };
}
