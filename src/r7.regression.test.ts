/**
 * R7 回归：远端快照必须是不可变的一份，截断树必须拒绝。
 *
 * 缺陷 1（混合快照）：若路径集合与状态/提交分两次独立读取，期间远端推进会让
 * "旧路径集合"配"新状态/新提交"，头检查仍通过，但新出现的远端路径缺席——
 * 镜像会把它们当成目标独有而删除。
 *
 * 缺陷 2（截断树）：GitHub 递归树超过上限时返回 truncated:true，
 * 此时 tree 只是部分内容；当成完整存在性集合会误删未返回的路径。
 */

import { describe, it, expect, vi } from 'vitest';
import { scanAndPlan, SideScanner } from './syncScanner';
import { ScopeContext } from './scopeContext';
import { CommonState, StateIdentity } from './commonState';
import { FileContent } from './util/contentEncoding';
import { BlobSha, CommitSha } from './util/hashing';
import { RemoteGitHubVault } from './remoteGitHubVault';
import { __setMockOctokitInstance } from './__mocks__/@octokit/core';
import { init as initEncryption } from './encryption';
import { fitLogger } from './logger';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

function shas(files: Record<string, string>): Record<string, BlobSha> {
	return Object.fromEntries(Object.keys(files).map(p => [p, `sha-${p}` as BlobSha]));
}

function scanner(files: Record<string, string>): SideScanner {
	return {
		snapshot: async () => ({ paths: Object.keys(files), state: shas(files) }),
		isReadable: () => true,
		read: async path => FileContent.fromPlainText(files[path])
	};
}

async function emptyScope() {
	return ScopeContext.create({ stat: vi.fn(), read: vi.fn() } as never, { sharedIgnoreContent: '' });
}

function established(): CommonState {
	const s = CommonState.create(IDENTITY);
	s.markEstablished();
	return s;
}

describe('R7: 远端快照不可变', () => {
	it('路径集合与状态来自同一次快照：期间新增的远端路径不会被漏掉', async () => {
		// 远端在两次读取之间推进：新快照多了一个文件。
		// 若实现分别读路径与状态，就会用旧路径集合 + 新状态。
		let call = 0;
		const remote: SideScanner = {
			snapshot: async () => {
				call++;
				// 每一次 snapshot 都自洽：路径与状态同源
				const files: Record<string, string> = call === 1 ? { 'keep.md': 'K' } : { 'keep.md': 'K', 'new-on-remote.md': 'N' };
				return { paths: Object.keys(files), state: shas(files) };
			},
			isReadable: () => true,
			read: async path => FileContent.fromPlainText('K')
		};

		const { plan } = await scanAndPlan({
			rule: 'mirror', direction: 'pull', identity: IDENTITY,
			local: scanner({ 'keep.md': 'K' }),
			remote,
			scope: await emptyScope(),
			commonState: established(),
			// remoteHead 与 snapshot 描述同一份状态（自洽）
			remoteHead: async () => ({ commitSha: 'head-1' as CommitSha, state: shas({ 'keep.md': 'K' }) })
		});
		// 不应把远端路径当成"已删除"而产生本地删除
		expect(plan.operations.filter(op => op.kind === 'delete-local')).toEqual([]);
	});

	it('路径集合与状态不一致时报错，不生成混合计划', async () => {
		const remote: SideScanner = {
			snapshot: async () => ({ paths: ['a.md'], state: shas({ 'a.md': 'x', 'b.md': 'y' }) }),
			isReadable: () => true,
			read: async () => FileContent.fromPlainText('x')
		};
		await expect(scanAndPlan({
			rule: 'mirror', direction: 'pull', identity: IDENTITY,
			local: scanner({ 'a.md': 'x' }),
			remote,
			scope: await emptyScope(),
			commonState: established(),
			// 提交对应的状态与快照不同 → 期间推进
			remoteHead: async () => ({ commitSha: 'head-2' as CommitSha, state: shas({ 'a.md': 'x' }) })
		})).rejects.toThrow(/远端在扫描期间发生变化/);
	});
});

describe('R7: 截断树必须拒绝', () => {
	it('truncated:true 时报错，不按不完整树规划', async () => {
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as never);
		__setMockOctokitInstance({
			request: async (route: string) => {
				if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') {
					return { data: { sha: 'c1', commit: { tree: { sha: 't1' } } } };
				}
				if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
					// GitHub 在超大仓上返回部分树
					return { data: { tree: [{ path: 'only.md', type: 'blob', mode: '100644', sha: 'b1' }], truncated: true } };
				}
				throw new Error(`unexpected ${route}`);
			},
			graphql: async () => { throw new Error('n/a'); }
		} as never);

		const vault = new RemoteGitHubVault('pat', 'o', 'r', 'main', 'dev');
		await expect(vault.readFromSource(true)).rejects.toThrow(/截断|truncated/);

		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
	});

	it('未截断时正常返回（不误报）', async () => {
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as never);
		__setMockOctokitInstance({
			request: async (route: string) => {
				if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') {
					return { data: { sha: 'c1', commit: { tree: { sha: 't1' } } } };
				}
				if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
					return { data: { tree: [{ path: 'ok.md', type: 'blob', mode: '100644', sha: 'b1' }], truncated: false } };
				}
				throw new Error(`unexpected ${route}`);
			},
			graphql: async () => { throw new Error('n/a'); }
		} as never);

		const vault = new RemoteGitHubVault('pat', 'o', 'r', 'main', 'dev');
		const read = await vault.readFromSource(true);
		expect(read.state).toEqual({ 'ok.md': 'b1' });

		__setMockOctokitInstance(null);
		vi.restoreAllMocks();
	});
});
