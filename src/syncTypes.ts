/**
 * 六类同步规则共用的类型定义。
 *
 * 设计原则（对应开发计划 P1/P2）：
 * - 一个计划由纯函数生成：输入两端快照 + 共同状态 + 规则，输出操作清单，零副作用。
 * - "存在性"与"内容"分开表达：补缺/覆盖/镜像只看存在性；更新与双向规则才需要共同状态。
 * - 内容一致性用同口径摘要判断，绝不用本地 SHA 与 Git blob SHA 互相比较。
 */

import { BlobSha, CommitSha } from "./util/hashing";
import { ContentDigest } from "./util/contentDigest";

/** 六类文件处理规则。人工审阅是第七项能力，不在这里。 */
export type RuleKind =
	/** 仅补充缺失文件：来源有、目标没有就补，目标已有同名文件绝不覆盖 */
	| "add-missing"
	/** 单向更新：按共同状态区分单方修改；目标主动删除且来源未改则保持删除 */
	| "update-one-way"
	/** 单向覆盖：来源存在的文件以来源内容为准，保留目标独有文件 */
	| "overwrite"
	/** 单向镜像：目标与来源在同步范围内一致，包括删除目标独有文件 */
	| "mirror"
	/** 双向合并、不传播删除：交换新增与修改，一端缺失则补回 */
	| "merge-no-delete"
	/** 双向同步、传播删除：基于共同状态交换新增、修改与删除 */
	| "two-way-delete";

export type OneWayRule = Extract<RuleKind, "add-missing" | "update-one-way" | "overwrite" | "mirror">;

/** 单向规则的操作方向：upload 表示本地→远端，pull 表示远端→本地。 */
export type SyncDirection = "upload" | "pull";

export function isOneWayRule(rule: RuleKind): rule is OneWayRule {
	return rule === "add-missing" || rule === "update-one-way" || rule === "overwrite" || rule === "mirror";
}

/**
 * 路径被排除在同步范围外的原因。
 *
 * 保留原因而不是简单布尔：镜像必须能区分"来源没有"与"规则排除"，
 * 否则会把被忽略的文件当成目标独有文件删除。
 */
export type ExcludeReason =
	/** 插件保留区：_fit/ 冲突副本、插件运行状态 */
	| "reserved"
	/** Git 仓库内部元数据：.git/ */
	| "git-metadata"
	/** Obsidian 设置、主题与插件目录：.obsidian/ 等 */
	| "obsidian-settings"
	/** 共享规则文件等控制元数据：可读可写可比较，但不作为内容同步/删除对象 */
	| "control-metadata"
	/** 被 Git 忽略规则匹配（规则来源已在 rule 字段标明） */
	| "ignored"
	/** 本地 Vault API 读不到的隐藏路径，无法参与内容同步 */
	| "local-unreadable-hidden"
	/** 越出知识库边界的路径 */
	| "outside-vault";

export type ExcludedPath = {
	path: string;
	reason: ExcludeReason;
	/** 命中的规则文本或规则来源说明（例如 .gitignore 中的具体一行） */
	rule?: string;
	/** 规则来源：共享 .gitignore / 本机排除 / 个人全局忽略 */
	source?: IgnoreSourceKind;
};

export type IgnoreSourceKind = "shared" | "local" | "global" | "plugin-policy";

/** 一端在某路径上的状态。present=false 表示该端不存在此路径。 */
export type SidePresence =
	| { present: true; sha: BlobSha }
	| { present: false };

/** 内容比较所需的同口径信息，仅在实际需要比较内容时采集。 */
export type SideContent = {
	digest: ContentDigest;
	binary: boolean;
	size: number;
};

/** 计划中每条路径的判据快照。 */
export type PathFacts = {
	path: string;
	local: SidePresence;
	remote: SidePresence;
	/** 两端都存在时，是否已确认内容相同（同口径摘要相等或共同状态证明） */
	contentEqual?: boolean;
	/** 读取失败信息：内容未知时不排任何写删操作 */
	unreadable?: { side: "local" | "remote"; error: string };
	/** 冲突决策需要的双方内容信息（仅文本可比较时提供摘要，不内联正文） */
	localContent?: SideContent;
	remoteContent?: SideContent;
	/** 文件/目录同路径碰撞的说明 */
	collision?: string;
};

/** 冲突种类：只有依赖共同状态仍无法判定时才产生。 */
export type ConflictKind =
	/** 双方都修改且内容不同 */
	| "both-modified"
	/** 一端修改、另一端删除 */
	| "modify-delete"
	/** 无共同状态且同名内容不同，不得自动覆盖 */
	| "no-baseline-differs"
	/** 文件与目录同路径，无法直接执行 */
	| "path-collision";

export type Conflict = {
	path: string;
	kind: ConflictKind;
	/** 双方内容事实，供审阅弹窗展示差异与"本地/远端/手工"决策 */
	local?: SideContent & { present: boolean };
	remote?: SideContent & { present: boolean };
	/** 二进制不得冒充文本合并 */
	binary: boolean;
	detail: string;
};

/** 计划中的单条操作。id 在计划内稳定，用于逐项选择与结果回填。 */
export type PlanOperation =
	| { id: string; kind: "write-remote"; path: string; reason: "add" | "update"; manualText?: string }
	| { id: string; kind: "write-local"; path: string; reason: "add" | "update"; manualText?: string }
	| { id: string; kind: "delete-remote"; path: string }
	| { id: string; kind: "delete-local"; path: string };

/** 依赖组：同组操作必须一起选择或一起放弃（例如同一路径的写与删）。 */
export type DependencyGroup = {
	id: string;
	members: string[];
	reason: string;
};

export type PlanCounts = {
	writeRemote: number;
	writeLocal: number;
	deleteRemote: number;
	deleteLocal: number;
	conflicts: number;
	excluded: number;
	unreadable: number;
};

/** 计划绑定的仓库身份，用于执行前复核。 */
export type SyncIdentity = {
	owner: string;
	repo: string;
	branch: string;
};

export type SyncPlan = {
	rule: RuleKind;
	/** 单向规则才有方向；双向规则为 null */
	direction: SyncDirection | null;
	identity: SyncIdentity;
	/** 生成计划时看到的分支头，发布必须绑定它 */
	remoteCommitSha: CommitSha;
	/** 生成计划时的忽略规则指纹（共享 .gitignore + 本机排除的内容摘要） */
	rulesFingerprint: string;
	operations: PlanOperation[];
	conflicts: Conflict[];
	excluded: ExcludedPath[];
	unreadable: Array<{ path: string; side: "local" | "remote"; error: string }>;
	dependencyGroups: DependencyGroup[];
	/** 扫描时的两端状态，执行前复核用（本地 SHA / 远端 blob SHA 各自同算法） */
	localState: Record<string, BlobSha>;
	remoteState: Record<string, BlobSha>;
	/** 首次扫描时同名且内容一致、可确认建立共同状态的路径（含同口径摘要） */
	adoptable: Array<{ path: string; local: BlobSha; remote: BlobSha; digest: ContentDigest }>;
	/** 双方都已不存在、可确认共同删除的路径 */
	confirmedAbsent: string[];
	/** 镜像是否因部分选择而不完整（由执行器在成功后判定，计划阶段为 false） */
	mirrorComplete: boolean;
	counts: PlanCounts;
};

export function countPlan(operations: PlanOperation[], conflicts: Conflict[], excluded: number, unreadable: number): PlanCounts {
	const counts: PlanCounts = { writeRemote: 0, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts: conflicts.length, excluded, unreadable };
	for (const op of operations) {
		if (op.kind === "write-remote") counts.writeRemote++;
		else if (op.kind === "write-local") counts.writeLocal++;
		else if (op.kind === "delete-remote") counts.deleteRemote++;
		else counts.deleteLocal++;
	}
	return counts;
}

export function operationId(kind: PlanOperation["kind"], path: string): string {
	return `${kind}:${path}`;
}
