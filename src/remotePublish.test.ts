/**
 * 条件发布与惰性限流测试。
 *
 * 头条件：必须走 createCommitOnBranch + expectedHeadOid；不适用时不得静默降级。
 * 限流：任务必须在轮到它时才发起，而不是先全部启动再排队等待。
 */

import { describe, it, expect, vi } from 'vitest';
import { createCommitOnBranch, ConditionalCommitRequest, toBase64Payload } from './remotePublish';
import { createLazyQueue } from './util/rateLimiter';
import { FileContent } from './util/contentEncoding';
import { VaultError } from './vault';
import { CommitSha } from './util/hashing';
import { GraphQLCaller } from './remotePublish';

/** 把 vi.fn 收窄成 GraphQLCaller，便于断言变量。 */
function callerOf(mock: ReturnType<typeof vi.fn>): GraphQLCaller & { mock: { calls: unknown[][] } } {
	return { graphql: mock as unknown as GraphQLCaller['graphql'], mock: mock.mock as unknown as { calls: unknown[][] } };
}

function request(overrides: Partial<ConditionalCommitRequest> = {}): ConditionalCommitRequest {
	return {
		owner: 'o',
		repo: 'r',
		branch: 'main',
		expectedHeadOid: 'head-1',
		additions: [{ path: 'a.md', content: FileContent.fromPlainText('hello') }],
		deletions: [],
		message: { headline: 'commit from device' },
		...overrides
	};
}

describe('createCommitOnBranch', () => {
	it('使用官方变更并带上 expectedHeadOid 与 base64 载荷', async () => {
		const graphql = vi.fn(async () => ({ createCommitOnBranch: { commit: { oid: 'new-commit' } } }));
		const outcome = await createCommitOnBranch(callerOf(graphql), request());

		expect(outcome).toEqual({ status: 'committed', commitSha: 'new-commit' });
		const [query, variables] = graphql.mock.calls[0] as unknown as [string, { input: Record<string, unknown> }];
		expect(query).toContain('createCommitOnBranch');
		const input = variables.input as {
			expectedHeadOid: string;
			branch: { repositoryNameWithOwner: string; branchName: string };
			fileChanges: { additions: Array<{ path: string; contents: string }> };
		};
		expect(input.expectedHeadOid).toBe('head-1');
		expect(input.branch).toEqual({ repositoryNameWithOwner: 'o/r', branchName: 'main' });
		expect(input.fileChanges.additions[0].path).toBe('a.md');
		// base64 内容按字节往返
		expect(atob(input.fileChanges.additions[0].contents)).toBe('hello');
	});

	it('中文与二进制内容按字节完整传递，不经 Node Buffer', async () => {
		const binary = FileContent.fromBase64('AAECAwQ=');
		const graphql = vi.fn(async () => ({ createCommitOnBranch: { commit: { oid: 'c' } } }));
		await createCommitOnBranch(callerOf(graphql), request({
			additions: [
				{ path: 'note.md', content: FileContent.fromPlainText('中文内容') },
				{ path: 'img.bin', content: binary }
			]
		}));
		const input = (graphql.mock.calls[0] as unknown as [string, { input: { fileChanges: { additions: Array<{ contents: string }> } } }])[1].input;
		const decodedNote = new TextDecoder('utf-8', { fatal: true }).decode(
			Uint8Array.from(atob(input.fileChanges.additions[0].contents), c => c.charCodeAt(0))
		);
		expect(decodedNote).toBe('中文内容');
		expect(input.fileChanges.additions[1].contents).toBe('AAECAwQ=');
	});

	it('加密启用时仍以 base64 提交（由上层先加密成字节）', async () => {
		// 加密后的内容在插件里就是 base64 字节串，这里验证不变形、不加换行
		const encrypted = FileContent.fromBase64('ZW5jcnlwdGVkLWJ5dGVz');
		expect(toBase64Payload(encrypted)).toBe('ZW5jcnlwdGVkLWJ5dGVz');
		const graphql = vi.fn(async () => ({ createCommitOnBranch: { commit: { oid: 'c' } } }));
		await createCommitOnBranch(callerOf(graphql), request({ additions: [{ path: 'x.md', content: encrypted }] }));
		const input = (graphql.mock.calls[0] as unknown as [string, { input: { fileChanges: { additions: Array<{ contents: string }> } } }])[1].input;
		expect(input.fileChanges.additions[0].contents).toBe('ZW5jcnlwdGVkLWJ5dGVz');
	});

	it('删除通过 deletions 表达', async () => {
		const graphql = vi.fn(async () => ({ createCommitOnBranch: { commit: { oid: 'c' } } }));
		await createCommitOnBranch(callerOf(graphql), request({ additions: [], deletions: ['gone.md'] }));
		const input = (graphql.mock.calls[0] as unknown as [string, { input: { fileChanges: { deletions: Array<{ path: string }> } } }])[1].input;
		expect(input.fileChanges.deletions).toEqual([{ path: 'gone.md' }]);
	});

	it('头已变化时返回 head-changed，不重放旧计划', async () => {
		const graphql = vi.fn(async () => {
			throw new Error('The branch was updated since the expectedHeadOid was provided');
		});
		const outcome = await createCommitOnBranch(callerOf(graphql), request());
		expect(outcome.status).toBe('head-changed');
	});

	it('空仓库/分支不存在时不静默降级，返回不适用', async () => {
		const error: unknown = Object.assign(new Error('Not Found'), { status: 404 });
		const graphql = vi.fn(async () => { throw error; });
		const outcome = await createCommitOnBranch(callerOf(graphql), request());
		expect(outcome.status).toBe('unavailable');
		if (outcome.status === 'unavailable') expect(outcome.reason).toContain('空仓库');
	});

	it('缺少期望头时拒绝发布', async () => {
		const graphql = vi.fn();
		const outcome = await createCommitOnBranch(callerOf(graphql), request({ expectedHeadOid: '' }));
		expect(outcome.status).toBe('unavailable');
		expect(graphql).not.toHaveBeenCalled();
	});

	it('自动签名/权限失败按认证错误抛出，不当作成功', async () => {
		const error: unknown = Object.assign(new Error('Bad credentials'), { status: 401 });
		const graphql = vi.fn(async () => { throw error; });
		await expect(createCommitOnBranch(callerOf(graphql), request())).rejects.toBeInstanceOf(VaultError);
	});

	it('返回空提交标识时视为结果待确认，不谎报成功', async () => {
		const graphql = vi.fn(async () => ({ createCommitOnBranch: { commit: null } }));
		await expect(createCommitOnBranch(callerOf(graphql), request())).rejects.toBeInstanceOf(VaultError);
	});
});

describe('惰性限流队列', () => {
	it('任务在轮到它时才发起，不在构造阶段全部启动', async () => {
		const started: number[] = [];
		const queue = createLazyQueue(0, 1);
		const tasks = [0, 1, 2].map(i => () => {
			started.push(i);
			return Promise.resolve(i);
		});
		// 构造阶段没有任何请求发出
		expect(started).toEqual([]);
		const results = await Promise.all(tasks.map(task => queue.run(task)));
		expect(results).toEqual([0, 1, 2]);
		expect(started).toEqual([0, 1, 2]);
	});

	it('在途数量不超过上限', async () => {
		let active = 0;
		let peak = 0;
		const queue = createLazyQueue(0, 2);
		const later = () => new Promise<void>(resolve => setTimeout(resolve, 5));
		await Promise.all(Array.from({ length: 6 }, () => queue.run(async () => {
			active++;
			peak = Math.max(peak, active);
			await later();
			active--;
		})));
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('真实发起速率受限：相邻发起间隔不小于设定值', async () => {
		const starts: number[] = [];
		const queue = createLazyQueue(20, 4);
		await Promise.all(Array.from({ length: 4 }, () => queue.run(async () => {
			starts.push(Date.now());
		})));
		const gaps = starts.slice(1).map((value, index) => value - starts[index]);
		for (const gap of gaps) {
			// 允许 5ms 时钟/调度误差，但必须体现节奏而不是瞬时并发
			expect(gap).toBeGreaterThanOrEqual(15);
		}
	});

	it('单个任务失败不影响后续任务排队', async () => {
		const queue = createLazyQueue(0, 1);
		await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		await expect(queue.run(async () => 'ok')).resolves.toBe('ok');
	});
});

describe('R6: publishConditional 必须复用既有加密语义', () => {
	/**
	 * 用真实 RemoteGitHubVault + mock Octokit + spy Encryption，
	 * 验证新管线与原有 createBlob/createTree 的加密行为一致。
	 */
	it('加密开启时内容被 encryptContent 处理、路径被 encryptPath 处理（含删除项）', async () => {
		const { RemoteGitHubVault } = await import('./remoteGitHubVault');
		const { __setMockOctokitInstance } = await import('./__mocks__/@octokit/core');
		const Encryption = await import('./encryption');

		// 伪造一个只接受 graphql 的 octokit
		let captured: { input: { fileChanges: { additions: Array<{ path: string; contents: string }>; deletions: Array<{ path: string }> } } } | null = null;
		const fakeOctokit = {
			request: async () => { throw new Error('不应走 REST 路径'); },
			graphql: async (_query: string, variables: Record<string, unknown>) => {
				captured = variables as never;
				return { createCommitOnBranch: { commit: { oid: 'new-commit' } } };
			}
		};
		__setMockOctokitInstance(fakeOctokit);

		vi.spyOn(Encryption, 'isEnabled').mockReturnValue(true);
		const encryptContent = vi.spyOn(Encryption, 'encryptContent').mockImplementation(async base64 => `ENC:${base64}`);
		const encryptPath = vi.spyOn(Encryption, 'encryptPath').mockImplementation(async path => `P:${path}`);

		const vault = new RemoteGitHubVault('fake-pat', 'testowner', 'testrepo', 'main', 'dev');
		const outcome = await vault.publishConditional(
			[
				{ path: 'note.md', content: FileContent.fromPlainText('中文') },
				{ path: 'img.bin', content: FileContent.fromBase64('AAECAwQ=') }
			],
			['gone.md'],
			'head-1' as CommitSha,
			{ headline: 'msg' }
		);

		expect(outcome).toEqual({ status: 'committed', commitSha: 'new-commit' });
		expect(encryptContent).toHaveBeenCalledTimes(2);
		expect(encryptPath).toHaveBeenCalledTimes(3); // 2 写 + 1 删

		const additions = captured!.input.fileChanges.additions;
		const deletions = captured!.input.fileChanges.deletions;
		// 路径被加密
		expect(additions.map(a => a.path).sort()).toEqual(['P:img.bin', 'P:note.md']);
		expect(deletions).toEqual([{ path: 'P:gone.md' }]);
		// 载荷是"对 base64 明文做 encryptContent"的结果，而非明文
		const noteAddition = additions.find(a => a.path === 'P:note.md')!;
		const plainBase64 = FileContent.fromPlainText('中文').toBase64();
		expect(noteAddition.contents).toBe(`ENC:${plainBase64}`);
		expect(noteAddition.contents).not.toContain('中文');
		// 二进制同样走加密，不是裸 base64
		const imgAddition = additions.find(a => a.path === 'P:img.bin')!;
		expect(imgAddition.contents).toBe('ENC:AAECAwQ=');

		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
	});

	it('加密关闭时保持明文 base64 载荷与明文路径（不误加密）', async () => {
		const { RemoteGitHubVault } = await import('./remoteGitHubVault');
		const { __setMockOctokitInstance } = await import('./__mocks__/@octokit/core');
		const Encryption = await import('./encryption');

		let captured: { input: { fileChanges: { additions: Array<{ path: string; contents: string }>; deletions: Array<{ path: string }> } } } | null = null;
		__setMockOctokitInstance({
			request: async () => { throw new Error('不应走 REST 路径'); },
			graphql: async (_q: string, variables: Record<string, unknown>) => {
				captured = variables as never;
				return { createCommitOnBranch: { commit: { oid: 'c2' } } };
			}
		});
		vi.spyOn(Encryption, 'isEnabled').mockReturnValue(false);
		const encryptContent = vi.spyOn(Encryption, 'encryptContent');

		const vault = new RemoteGitHubVault('fake-pat', 'testowner', 'testrepo', 'main', 'dev');
		await vault.publishConditional(
			[{ path: 'note.md', content: FileContent.fromPlainText('hi') }],
			['gone.md'],
			'head-1' as CommitSha,
			{ headline: 'm' }
		);

		expect(encryptContent).not.toHaveBeenCalled();
		const additions = captured!.input.fileChanges.additions;
		expect(additions[0].path).toBe('note.md');
		expect(atob(additions[0].contents)).toBe('hi');
		expect(captured!.input.fileChanges.deletions).toEqual([{ path: 'gone.md' }]);

		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
	});
});
