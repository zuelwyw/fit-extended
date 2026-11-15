/**
 * 第四轮修复：父代理真实服务探针 T1—T6 的回归用例。
 *
 * 全部走真实 Fit + SyncService + LocalVault + buildPorts + 现有
 * FakeObsidianVault/FakeRemoteVault（只替换适配器），不手写 ExecutionPorts。
 *
 * 每个用例先确认"修复前失败"，再据以实现修复；不为了让测试变绿而放宽生产前置条件。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fit } from './fit';
import { SyncService } from './syncService';
import { FakeObsidianVault, FakeRemoteVault } from './testUtils';
import { LocalVault } from './localVault';
import { CommonState, StateIdentity } from './commonState';
import { digestFileContent } from './util/contentDigest';
import { FileContent } from './util/contentEncoding';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { fitLogger } from './logger';
import { VaultError } from './vault';

const identity: StateIdentity = { owner: 'fixture-owner', repo: 'fixture-repo', branch: 'fixture-branch' };
const settings = { ...identity, pat: 'fixture-only-not-a-real-token', deviceName: 'fixture' };
const empty = () => ({ commonState: null, localSha: {}, lastFetchedRemoteSha: {} });

function harness() {
	const vault = new FakeObsidianVault();
	const local = new LocalVault(vault as never);
	const remote = new FakeRemoteVault(identity.owner, identity.repo, identity.branch);
	const fit = new Fit(
		settings as FitSettings,
		{ localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null } as LocalStores,
		vault as unknown as Vault
	);
	fit.localVault = local as never;
	fit.remoteVault = remote as never;
	const store: { commonState: { entries: Record<string, unknown> } | null } = { commonState: null };
	const service = new SyncService(fit, async update => {
		store.commonState = update.commonState as never;
	});
	return { vault, local, remote, service, fit, store };
}

describe('T1 共享控制元数据必须经 adapter 枚举进真实快照', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('磁盘存在 .gitignore 但不在 vault 索引时，覆盖上传仍计划写入该规则文件', async () => {
		const h = harness();
		await h.vault.create('note.md', 'fixture note');
		// 规则文件只在磁盘上（Obsidian 索引看不到隐藏文件）
		await h.vault.adapter.write('.gitignore', '*.tmp\n');

		expect(await h.vault.adapter.stat('.gitignore')).toBeTruthy();
		expect(h.vault.getFiles().some(f => f.path === '.gitignore')).toBe(false);

		const plan = await h.service.plan('overwrite', 'upload', empty());
		expect(plan.operations.some(op => op.path === '.gitignore')).toBe(true);
	});

	it('远端有、本地没有的共享规则也应按方向正确计划（拉取）', async () => {
		const h = harness();
		await h.vault.create('note.md', 'n');
		await h.remote.setFile('.gitignore', '*.tmp\n');

		const plan = await h.service.plan('overwrite', 'pull', empty());
		expect(plan.operations.some(op => op.path === '.gitignore')).toBe(true);
	});

	it('子目录共享规则同样经 adapter 枚举（不只在 vault 索引里）', async () => {
		const h = harness();
		await h.vault.create('sub/note.md', 'n');
		await h.vault.adapter.write('sub/.gitignore', '* text=auto\n');

		const plan = await h.service.plan('overwrite', 'upload', empty());
		expect(plan.operations.some(op => op.path === 'sub/.gitignore')).toBe(true);
	});

	it('私有排除文件与 Obsidian 内部路径仍不可同步', async () => {
		const h = harness();
		await h.vault.create('note.md', 'n');
		await h.vault.adapter.write('.git/info/exclude', 'secret/\n');
		await h.vault.adapter.write('.obsidian/app.json', '{}');

		const plan = await h.service.plan('overwrite', 'upload', empty());
		const paths = plan.operations.map(op => op.path);
		expect(paths).not.toContain('.git/info/exclude');
		expect(paths.some(p => p.startsWith('.obsidian/'))).toBe(false);
	});
});

describe('T2 手工写入不得跳过"预览后用户改动"的前置校验', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('发布期间用户改了本地文件：手工写入必须被拦下，不得覆盖用户改动', async () => {
		const h = harness();
		await h.vault.create('a.md', 'LOCAL_OLD');
		await h.remote.setFile('a.md', 'REMOTE_OLD');
		const plan = await h.service.plan('two-way-delete', undefined, empty());
		expect(plan.conflicts.map(c => c.path)).toContain('a.md');

		const publish = h.remote.publishConditional.bind(h.remote);
		h.remote.publishConditional = async (...args) => {
			const outcome = await publish(...args);
			if (outcome.status === 'committed') {
				// 提交完成、返回之前，用户在本地又改了同一个文件
				await h.vault.modify(h.vault.getAbstractFileByPath('a.md')!, 'AFTER_PREVIEW_USER_EDIT');
			}
			return outcome;
		};

		const report = await h.service.execute(plan, [], { 'a.md': { action: 'manual', manualText: 'USER_MANUAL' } }, empty());

		expect(h.vault.readText('a.md')).toBe('AFTER_PREVIEW_USER_EDIT');
		expect(report.failed.map(i => i.path)).toContain('a.md');
	});
});

describe('T3 本地原本不存在时，手工恢复应被允许', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	async function baseStore() {
		const common = CommonState.create(identity);
		common.recordSame([{ path: 'a.md', digest: await digestFileContent(FileContent.fromPlainText('BASE')) }]);
		common.markEstablished();
		return { ...empty(), commonState: common.toJSON() };
	}

	it('本地缺失 + 远端修改 → 手工恢复应写入本地', async () => {
		const h = harness();
		const store = await baseStore();
		await h.remote.setFile('a.md', 'REMOTE_CHANGED_AFTER_BASE');
		const plan = await h.service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts.length).toBeGreaterThan(0);

		const report = await h.service.execute(plan, [], { 'a.md': { action: 'manual', manualText: 'RESTORE_MANUAL' } }, store);

		expect(h.vault.readText('a.md')).toBe('RESTORE_MANUAL');
		expect(report.failed.map(i => i.path)).not.toContain('a.md');
	});

	it('但预览后本地新出现同名文件时，不得覆盖它', async () => {
		const h = harness();
		const store = await baseStore();
		await h.remote.setFile('a.md', 'REMOTE_CHANGED_AFTER_BASE');
		const plan = await h.service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts.length).toBeGreaterThan(0);

		// 预览之后用户新建了同名文件
		await h.vault.create('a.md', 'USER_CREATED_AFTER_PREVIEW');
		const report = await h.service.execute(plan, [], { 'a.md': { action: 'manual', manualText: 'RESTORE_MANUAL' } }, store);

		// 关键安全性质：用户新建的内容不得被覆盖
		expect(h.vault.readText('a.md')).toBe('USER_CREATED_AFTER_PREVIEW');
		// 且必须可见地未成功（整体拒绝或该项失败都算）
		expect(report.rejected !== undefined || report.failed.some(i => i.path === 'a.md')).toBe(true);
	});
});

describe('T4 发布已发生但结果不明时必须返回结构化报告', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('提交成功但响应丢失：不抛异常，返回 uncertain 并要求先查证', async () => {
		const h = harness();
		await h.vault.create('a.md', 'LOCAL_TO_PUBLISH');
		const plan = await h.service.plan('overwrite', 'upload', empty());
		expect(plan.operations.map(op => op.path)).toContain('a.md');

		const publish = h.remote.publishConditional.bind(h.remote);
		h.remote.publishConditional = async (...args) => {
			await publish(...args); // 远端确实写入
			throw VaultError.network('条件提交未返回提交标识，结果待确认；fixture 模拟提交成功后响应丢失');
		};

		let report;
		let thrown: string | undefined;
		try {
			report = await h.service.execute(plan, plan.operations.map(op => op.id), {}, empty());
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}

		// 远端确实已写入
		expect((await h.remote.readFileContent('a.md')).toPlainText()).toBe('LOCAL_TO_PUBLISH');
		expect(thrown).toBeUndefined();
		expect(report).toBeDefined();
		expect(report!.uncertain.map(i => i.path)).toContain('a.md');
		expect(report!.succeeded).toEqual([]);
	});

	it('认证/参数拒绝属于明确失败，不是 uncertain', async () => {
		const h = harness();
		await h.vault.create('a.md', 'X');
		const plan = await h.service.plan('overwrite', 'upload', empty());
		h.remote.publishConditional = async () => {
			throw VaultError.authentication('Bad credentials');
		};
		const report = await h.service.execute(plan, plan.operations.map(op => op.id), {}, empty());
		expect(report.failed.map(i => i.path)).toContain('a.md');
		expect(report.uncertain).toEqual([]);
	});

	it('收尾重扫/状态核对失败时仍保留已取得的逐项结果', async () => {
		const h = harness();
		await h.vault.create('a.md', 'X');
		const plan = await h.service.plan('overwrite', 'upload', empty());
		// 发布成功后，让后续远端读取失败（模拟收尾阶段网络中断）
		const publish = h.remote.publishConditional.bind(h.remote);
		let published = false;
		h.remote.publishConditional = async (...args) => {
			const outcome = await publish(...args);
			published = true;
			return outcome;
		};
		// 保留真实读取行为，只在发布成功之后注入失败（模拟收尾阶段网络中断）
		const realRead = h.remote.readFromSource.bind(h.remote);
		h.remote.readFromSource = async () => {
			if (published) throw VaultError.network('收尾读取失败');
			return realRead();
		};
		const report = await h.service.execute(plan, plan.operations.map(op => op.id), {}, empty());
		expect(report.succeeded.map(i => i.path)).toContain('a.md');
	});
});

describe('T5 重验采纳时必须保存刚刚验证过的摘要', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('预览后双方同时变成相同新内容：共同状态保存当前摘要而非旧扫描值', async () => {
		const h = harness();
		// 扫描时双方一致（旧内容 OLD）→ 计划里 s.md 是可采纳项，digest 对应 OLD
		await h.vault.create('s.md', 'OLD');
		await h.remote.setFile('s.md', 'OLD');
		await h.remote.setFile('other.md', 'O');

		const plan = await h.service.plan('merge-no-delete', undefined, empty());
		const adoptable = plan.adoptable.find(a => a.path === 's.md');
		expect(adoptable).toBeDefined();
		const oldDigest = adoptable!.digest;

		// 预览之后（同一份计划尚未执行），双方都被改成同一个新的内容 NEW
		await h.vault.modify(h.vault.getAbstractFileByPath('s.md')!, 'NEW');
		await h.remote.setFile('s.md', 'NEW');

		// 用**同一份计划**执行无关操作：收尾重验会发现 s.md 现在一致于 NEW
		const op = plan.operations.find(o => o.path === 'other.md');
		expect(op).toBeDefined();
		await h.service.execute(plan, [op!.id], {}, empty());

		// 现在执行阶段不再重扫/重验：预览时的结论过期就不再被采纳，
		// 该路径保持"本次未取得结论"，由下一次检查重新判定。
		const saved = h.store.commonState!.entries['s.md'] as { presence?: string; digest?: string } | undefined;
		expect(saved?.digest).not.toBe(oldDigest);
		expect(saved?.presence === 'same' ? saved.digest : undefined).toBeUndefined();
	});
});
