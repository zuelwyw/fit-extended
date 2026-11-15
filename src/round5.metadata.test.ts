/**
 * 第五轮：共享控制元数据枚举的两个真实误删反例。
 *
 * M1 stat 失败被当成"不存在" → 镜像错误删除远端同名共享规则。
 * M2 枚举目录只取本地索引祖先 → 远端独有目录里的本地共享规则被当成"来源没有"。
 *
 * 两条都必须修复且不得回退第四轮的 T1—T6。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fit } from './fit';
import { SyncService } from './syncService';
import { FakeObsidianVault, FakeRemoteVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { fitLogger } from './logger';

const identity = { owner: 'fixture', repo: 'fixture', branch: 'main' };
const settings = { ...identity, pat: 'fixture-only-not-a-token', deviceName: 'fixture' };

function harness() {
	const vault = new FakeObsidianVault();
	const remote = new FakeRemoteVault(identity.owner, identity.repo, identity.branch);
	const fit = new Fit(
		settings as FitSettings,
		{ localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null } as LocalStores,
		vault as unknown as Vault
	);
	fit.localVault = new LocalVault(vault as never) as never;
	fit.remoteVault = remote as never;
	return { vault, remote, service: new SyncService(fit, async () => {}) };
}

describe('M1: 共享规则 stat 失败不得被当成"不存在"', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('本地 stat 抛 EACCES 时，镜像绝不删除远端同名 .gitignore', async () => {
		const h = harness();
		await h.vault.create('note.md', 'fixture');
		await h.vault.adapter.write('.gitignore', 'LOCAL ACTUAL FILE');
		await h.remote.setFile('.gitignore', 'REMOTE FILE');

		const realStat = h.vault.adapter.stat.bind(h.vault.adapter);
		h.vault.adapter.stat = async (path: string) => {
			if (path === '.gitignore') throw new Error('EACCES stat fixture');
			return realStat(path);
		};

		// 规则文件读不到 ⇒ 规则不完整 ⇒ 整次计划被拒绝（不会按残缺规则去镜像）
		await expect(h.service.plan('mirror', 'upload', {})).rejects.toThrow(/规则/);
	});

	it('ENOENT（确实不存在）不算不可读，仍按镜像正常处理', async () => {
		const h = harness();
		await h.vault.create('note.md', 'fixture');
		// 本地确实没有 .gitignore；远端有 → 镜像应删除远端那一份实例文件
		await h.remote.setFile('old.md', 'REMOTE ONLY');

		const plan = await h.service.plan('mirror', 'upload', {});
		expect(plan.operations.some(op => op.path === 'old.md' && op.kind === 'delete-remote')).toBe(true);
	});
});

describe('M2: 枚举目录必须覆盖两端，而不只是本地索引祖先', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('远端独有目录中的本地共享规则被识别，镜像不误删', async () => {
		const h = harness();
		// 本地索引只有根 note.md
		await h.vault.create('note.md', 'fixture');
		// 但 adapter 上存在 remote-dir/.gitignore
		await h.vault.adapter.write('remote-dir/.gitignore', 'LOCAL ACTUAL ATTRIBUTES');
		await h.remote.setFile('remote-dir/note.md', 'REMOTE NOTE');
		await h.remote.setFile('remote-dir/.gitignore', 'REMOTE ATTRIBUTES');

		const plan = await h.service.plan('mirror', 'upload', {});

		expect(plan.operations.some(op => op.path === 'remote-dir/.gitignore' && op.kind === 'delete-remote')).toBe(false);
		// 本地确实存在该规则文件 → 应按来源覆盖远端（内容不同）
		expect(plan.operations.some(op => op.path === 'remote-dir/.gitignore' && op.kind === 'write-remote')).toBe(true);
	});

	it('枚举只用本地索引祖先时会漏（反向对照）', async () => {
		const h = harness();
		await h.vault.create('note.md', 'fixture');
		await h.vault.adapter.write('only-in-adapter/.gitignore', 'A');
		// 远端没有任何 only-in-adapter 路径 → 该目录不会被两端候选覆盖到
		const plan = await h.service.plan('mirror', 'upload', {});
		// 没有远端同名文件时不应产生删除动作（防误删），也不应凭空写入
		expect(plan.operations.some(op => op.kind === 'delete-remote')).toBe(false);
	});
});

describe('枚举边界：只认白名单，不扫配置/插件/私有排除', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('不枚举 .git/info/exclude 与 .obsidian 下的规则文件', async () => {
		const h = harness();
		await h.vault.create('note.md', 'fixture');
		await h.vault.adapter.write('.git/info/exclude', 'secret/\n');
		await h.vault.adapter.write('.obsidian/.gitignore', 'x');

		const plan = await h.service.plan('overwrite', 'upload', {});
		const paths = plan.operations.map(op => op.path);
		expect(paths).not.toContain('.git/info/exclude');
		expect(paths.some(p => p.startsWith('.obsidian/'))).toBe(false);
	});
});
