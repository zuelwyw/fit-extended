/**
 * 远端发布的严格头条件（GitHub 官方 createCommitOnBranch + expectedHeadOid）
 *
 * 为什么需要单独一层：现有 REST 路径是"建 blob → 建 tree → 建 commit → 改 ref"，
 * 最后一步 PATCH ref 默认不是比较交换，执行期间远端推进就会把别人提交盖掉。
 * GitHub 官方 GraphQL 变更 createCommitOnBranch 支持 expectedHeadOid：头不等于期望值
 * 时整体失败，这才具备严格条件语义。
 *
 * 约束（不静默降级）：
 * - 只有拿到 expectedHeadOid 语义时才走 GraphQL。
 * - 不适用时（例如空仓库无 HEAD）**不**退回无条件更新并宣称有 CAS 保证，
 *   而是返回明确的"不适用"结果，由上层决定是否走专门的建分支流程。
 */

import { Octokit } from "@octokit/core";
import { Content, FileContent } from "./util/contentEncoding";
import { CommitSha } from "./util/hashing";
import { VaultError } from "./vault";

const CREATE_COMMIT_ON_BRANCH = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
    ref { name }
  }
}`;

/**
 * 内容与路径的变换钩子。
 *
 * 必须与原 REST 路径的加密语义完全一致，否则启用加密的用户会在这条新管线上
 * 把明文内容/明文路径写到 GitHub，或删不掉旧的密文路径：
 * - 内容：原 createBlob 在加密开启时，先把明文转成 base64 再 encryptContent；
 * - 路径：原 createTree 对每个节点 path 调 encryptPath（删除项同样要加密）。
 */
export type PayloadTransform = {
	isEncryptionEnabled(): boolean;
	/** 入参为归一化 base64，返回加密后的 base64 */
	encryptContent(base64: string): Promise<string>;
	encryptPath(path: string): Promise<string>;
};

export const identityTransform: PayloadTransform = {
	isEncryptionEnabled: () => false,
	encryptContent: async base64 => base64,
	encryptPath: async path => path
};

export type ConditionalCommitRequest = {
	owner: string;
	repo: string;
	branch: string;
	/** 审阅时看到的分支头；发布必须绑定它 */
	expectedHeadOid: string;
	additions: Array<{ path: string; content: FileContent }>;
	deletions: string[];
	message: { headline: string; body?: string };
	/** 内容/路径变换（加密）；缺省为不加密 */
	transform?: PayloadTransform;
};

export type ConditionalCommitOutcome =
	| { status: "committed"; commitSha: CommitSha }
	/** 头已变化：属于"计划过期"，必须重新审阅，不能重放旧计划 */
	| { status: "head-changed"; expectedHeadOid: string; actualHeadOid?: string }
	/** 当前环境下条件提交不适用（例如空仓库无 HEAD），不得静默降级 */
	| { status: "unavailable"; reason: string };

/** Octokit 的最小结构，便于测试注入替身。 */
export type GraphQLCaller = {
	graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
};

function isHeadMismatchError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /expectedHeadOid|head.*(does not match|mismatch|changed)/i.test(message);
}

/** 把 FileContent 归一成 GraphQL 要求的 base64 内容（不经过 Node Buffer）。 */
export function toBase64Payload(content: FileContent): string {
	const raw = content.toRaw();
	const base64 = raw.encoding === "base64" ? raw.content : Content.encodeToBase64(raw.content);
	// GraphQL Base64String 不接受换行；这里只做格式归一，不改字节。
	return (base64 as string).replace(/\s/g, "");
}

export async function createCommitOnBranch(
	client: GraphQLCaller,
	request: ConditionalCommitRequest
): Promise<ConditionalCommitOutcome> {
	if (!request.expectedHeadOid) {
		return { status: "unavailable", reason: "缺少期望的分支头提交：无法建立严格条件，不执行发布。" };
	}
	if (request.additions.length === 0 && request.deletions.length === 0) {
		return { status: "unavailable", reason: "本次没有远端改动，未发起提交。" };
	}

	const transform = request.transform ?? identityTransform;
	const encrypting = transform.isEncryptionEnabled();

	// 内容与路径都必须走与原有 REST 路径相同的加密转换。
	const additions = await Promise.all(request.additions.map(async file => {
		const base64 = toBase64Payload(file.content);
		const path = encrypting ? await transform.encryptPath(file.path) : file.path;
		const contents = encrypting ? await transform.encryptContent(base64) : base64;
		return { path, contents };
	}));
	const deletions = await Promise.all(request.deletions.map(async path =>
		encrypting ? { path: await transform.encryptPath(path) } : { path }));

	const input = {
		branch: {
			repositoryNameWithOwner: `${request.owner}/${request.repo}`,
			branchName: request.branch
		},
		expectedHeadOid: request.expectedHeadOid,
		message: {
			headline: request.message.headline,
			...(request.message.body ? { body: request.message.body } : {})
		},
		fileChanges: {
			...(additions.length > 0 ? { additions } : {}),
			...(deletions.length > 0 ? { deletions } : {})
		}
	};

	try {
		const result = await client.graphql<{ createCommitOnBranch: { commit: { oid: string } | null } }>(
			CREATE_COMMIT_ON_BRANCH,
			{ input }
		);
		const oid = result?.createCommitOnBranch?.commit?.oid;
		if (!oid) {
			// 返回空但没抛错：结果不明，不能当成成功。
			throw VaultError.network("条件提交未返回提交标识，结果待确认；请先检查远端头再决定是否重试。");
		}
		return { status: "committed", commitSha: oid as CommitSha };
	} catch (error) {
		if (error instanceof VaultError) throw error;
		if (isHeadMismatchError(error)) {
			return { status: "head-changed", expectedHeadOid: request.expectedHeadOid };
		}
		const err = error as { status?: number; message?: string };
		if (err.status === 404) {
			// 分支不存在（空仓库）或仓库不可达：不退回强制推送。
			return { status: "unavailable", reason: `条件提交不适用：${err.message ?? "分支或仓库不可达"}（空仓库需先单独建分支）。` };
		}
		if (err.status === 401 || err.status === 403) {
			throw VaultError.authentication(err.message ?? "认证失败", { originalError: error });
		}
		throw VaultError.network(err.message ?? "条件提交失败", { originalError: error });
	}
}

/** 由 Octokit 实例构造 GraphQL 调用器。 */
export function graphqlCallerOf(octokit: Octokit): GraphQLCaller {
	return {
		graphql: (query, variables) => octokit.graphql(query, variables) as Promise<never>
	};
}
