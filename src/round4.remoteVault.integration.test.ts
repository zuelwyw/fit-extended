/**
 * T6：真实 RemoteGitHubVault 的缓存契约在服务链路中的影响。
 *
 * FakeRemoteVault 不会在发布后清空状态缓存，因此漏掉了真实适配器的行为：
 * publishConditional 成功后 latestKnownState = null，紧接着 readFileContent 会抛
 * "state not yet loaded"。若不处理，远端写成功也永远拿不到摘要，基线永不推进。
 *
 * 这里用 mock Octokit 驱动真实 RemoteGitHubVault，严格保留其缓存契约。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fit } from './fit';
import { SyncService } from './syncService';
import { RemoteGitHubVault } from './remoteGitHubVault';
import { FakeObsidianVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { __setMockOctokitInstance } from './__mocks__/@octokit/core';
import { init as initEncryption } from './encryption';
import { fitLogger } from './logger';
import { CommitSha } from './util/hashing';

const identity = { owner: 'o', repo: 'r', branch: 'main' };
const settings = { ...identity, pat: 'fixture-pat', deviceName: 'dev' };

/** 支持 tree/blob/graphql 的最小 mock，行为与真实适配器的缓存失效一致。 */
function makeMockOctokit() {
	const files = new Map<string, string>([['a.md', 'REMOTE_BEFORE']]);
	let commitSha = 'c1';
	let treeSha = 't1';
	const blobOf = (content: string) => `blob-${content}`;

	const octokit = {
		request: async (route: string, params?: unknown) => {
			if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') {
				return { data: { sha: commitSha, commit: { tree: { sha: treeSha } } } };
			}
			if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
				const tree = Array.from(files.keys()).map(path => ({
					path, type: 'blob', mode: '100644', sha: blobOf(files.get(path)!)
				}));
				return { data: { tree, truncated: false } };
			}
			if (route === 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}') {
				// 按 blob sha 反查内容：这里 blobOf(content) 是内容到 sha 的映射，
				// 需要反向查找。用参数取 sha，再找对应内容。
				const sha = (params as { file_sha?: string }).file_sha ?? '';
				const found = Array.from(files.values()).find(content => blobOf(content) === sha);
				if (found === undefined) throw new Error(`blob not found: ${sha}`);
				return { data: { content: Buffer.from(found, 'utf8').toString('base64') } };
			}
			throw new Error(`unexpected route ${route}`);
		},
		graphql: async (_q: string, vars: { input: { expectedHeadOid: string; fileChanges?: { additions?: Array<{ path: string; contents: string }>; deletions?: Array<{ path: string }> } } }) => {
			if (vars.input.expectedHeadOid !== commitSha) {
				throw new Error('The branch was updated since the expectedHeadOid was provided');
			}
			for (const add of vars.input.fileChanges?.additions ?? []) {
				const text = Buffer.from(add.contents, 'base64').toString('utf8');
				files.set(add.path, text);
			}
			for (const del of vars.input.fileChanges?.deletions ?? []) files.delete(del.path);
			commitSha = `c-${files.size}`;
			treeSha = `t-${files.size}`;
			return { createCommitOnBranch: { commit: { oid: commitSha } } };
		}
	};
	return { octokit, files, getCommit: () => commitSha };
}

describe('T6: 真实 RemoteGitHubVault 发布后摘要仍可取得', () => {
	beforeEach(() => {
		vi.spyOn(fitLogger, 'log').mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: '' } } as never);
	});
	afterEach(() => { __setMockOctokitInstance(null); vi.restoreAllMocks(); });

	it('发布成功后 readFileContent 因缓存被清空而抛错，服务链路仍能取得摘要并推进基线', async () => {
		const mock = makeMockOctokit();
		__setMockOctokitInstance(mock.octokit as never);

		const vault = new FakeObsidianVault();
		const local = new LocalVault(vault as never);
		await vault.create('b.md', 'LOCAL_B');

		const remoteVault = new RemoteGitHubVault('pat', identity.owner, identity.repo, identity.branch, 'dev');
		const fit = new Fit(
			settings as FitSettings,
			{ localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null } as LocalStores,
			vault as unknown as Vault
		);
		fit.localVault = local as never;
		fit.remoteVault = remoteVault as never;

		let saved: { commonState?: { entries: Record<string, { presence: string }> } } | null = null;
		const service = new SyncService(fit, async update => { saved = update as never; });

		const plan = await service.plan('merge-no-delete', undefined, {});
		const op = plan.operations.find(o => o.path === 'b.md');
		expect(op).toBeDefined();

		const report = await service.execute(plan, [op!.id], {}, {});

		// 远端写入成功
		expect(report.succeeded.map(i => i.path)).toContain('b.md');
		// 且成功项带有可用的摘要（否则基线永远不会推进）
		const item = report.succeeded.find(i => i.path === 'b.md');
		expect(item?.digest).toBeTruthy();
		// 共同状态确实推进
		expect(saved).not.toBeNull();
	});

	it('发布后立刻取远端摘要：buildPorts.digestOf 必须刷新一次而不是返回空', async () => {
		const mock = makeMockOctokit();
		__setMockOctokitInstance(mock.octokit as never);
		const vault = new FakeObsidianVault();
		const local = new LocalVault(vault as never);
		await vault.create('b.md', 'LOCAL_B');
		const remoteVault = new RemoteGitHubVault('pat', identity.owner, identity.repo, identity.branch, 'dev');
		const fit = new Fit(
			settings as FitSettings,
			{ localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null } as LocalStores,
			vault as unknown as Vault
		);
		fit.localVault = local as never;
		fit.remoteVault = remoteVault as never;

		const service = new SyncService(fit, async () => {});
		// 用生产 buildPorts 组装端口，只替换"读取远端内容"为真实适配器调用
		const { buildPorts } = await import('./syncScanner');
		const ports = buildPorts({
			identity: () => identity,
			localHead: async () => ({}),
			localPathState: async () => ({ present: true, sha: 'x' }),
			remoteHead: async () => (await remoteVault.readFromSource(true)).commitSha,
			remoteHeadState: async () => (await remoteVault.readFromSource(true)).state,
			rulesFingerprint: async () => 'f',
			readLocal: async path => local.readFileContent(path),
			readRemote: async path => remoteVault.readFileContent(path),
			writeLocal: async () => {},
			deleteLocal: async () => {},
			publish: async () => ({ status: 'committed', commitSha: 'c2', committedPaths: [] })
		});
		void service;

		// 先加载远端状态
		await remoteVault.readFromSource(true);
		// 发布：真实适配器会把 latestKnownState 置空
		const outcome = await remoteVault.publishConditional(
			[{ path: 'b.md', content: (await import('./util/contentEncoding')).FileContent.fromPlainText('NEW') }],
			[],
			mock.getCommit() as CommitSha,
			{ headline: 'h' }
		);
		expect(outcome.status).toBe('committed');

		// 发布后立刻取摘要：必须拿到值，而不是 undefined
		const digest = await ports.digestOf('remote', 'b.md');
		expect(digest).toBeTruthy();
	});
});
