/**
 * 旧版缓存作为"变化基线"的回归。
 *
 * 背景：升级后共同状态被重建（旧双份缓存不采纳为"已同步"），于是所有路径都成了
 * "无基线"。若无基线时一律把两侧差异报成冲突，用户会看到一堆从未改动过的文件
 * 变成冲突。正确语义是：**只有两侧相对上次同步都改过才算冲突**。
 *
 * 这里只验证"哪一侧改过"的判定；缓存本身绝不作为两端一致的证据。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fit } from './fit';
import { SyncService } from './syncService';
import { LocalVault } from './localVault';
import { FakeObsidianVault, FakeRemoteVault } from './testUtils';
import { FileContent } from './util/contentEncoding';
import { fitLogger } from './logger';

const settings = { owner: 'o', repo: 'r', branch: 'main', pat: 'fixture-not-real', deviceName: 'd' };

async function setup(localText: string, remoteText: string) {
	const vault = new FakeObsidianVault();
	const remote = new FakeRemoteVault('o', 'r', 'main');
	const fit = new Fit(settings as never, { localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null }, vault as never);
	fit.localVault = new LocalVault(vault as never) as never;
	fit.remoteVault = remote as never;
	await vault.create('a.md', localText);
	await remote.setFile('a.md', remoteText);
	const service = new SyncService(fit, async () => {});
	return { vault, remote, service };
}

async function localShaOf(text: string) {
	return LocalVault.fileSha1('a.md', FileContent.fromPlainText(text));
}

describe('旧缓存作为变化基线', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('只有远端改过：按“远端有修改”更新本地，不是冲突', async () => {
		const { service } = await setup('LOCAL_UNCHANGED', 'REMOTE_CHANGED');
		const store = {
			localSha: { 'a.md': await localShaOf('LOCAL_UNCHANGED') },
			lastFetchedRemoteSha: { 'a.md': 'old-remote-blob-sha' }
		};
		const plan = await service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts).toHaveLength(0);
		expect(plan.operations.map(op => `${op.kind}:${op.path}`)).toEqual(['write-local:a.md']);
	});

	it('只有本地改过：按“本地有修改”更新远端，不是冲突', async () => {
		const { service, remote } = await setup('LOCAL_CHANGED', 'REMOTE_UNCHANGED');
		// 远端未变：缓存里的 blob OID 必须等于当前远端 OID
		const remoteSha = (await remote.readFromSource()).state['a.md'];
		const store = {
			localSha: { 'a.md': 'old-local-sha' },
			lastFetchedRemoteSha: { 'a.md': remoteSha as string }
		};
		const plan = await service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts).toHaveLength(0);
		expect(plan.operations.map(op => `${op.kind}:${op.path}`)).toEqual(['write-remote:a.md']);
	});

	it('两侧都改过：仍然是冲突', async () => {
		const { service } = await setup('LOCAL_CHANGED', 'REMOTE_CHANGED');
		const store = {
			localSha: { 'a.md': 'old-local-sha' },
			lastFetchedRemoteSha: { 'a.md': 'old-remote-blob-sha' }
		};
		const plan = await service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts.map(c => c.kind)).toEqual(['both-modified']);
		expect(plan.operations).toHaveLength(0);
	});

	it('部分执行不会把未执行路径的基线推成“已同步”', async () => {
		const vault = new FakeObsidianVault();
		const remote = new FakeRemoteVault('o', 'r', 'main');
		const fit = new Fit(settings as never, { localSha: {}, lastFetchedRemoteSha: {}, lastFetchedCommitSha: null }, vault as never);
		fit.localVault = new LocalVault(vault as never) as never;
		fit.remoteVault = remote as never;

		// a.md：只有本地改过 → 应更新远端
		await vault.create('a.md', 'A_LOCAL_NEW');
		await remote.setFile('a.md', 'A_REMOTE');
		// b.md：只有远端改过 → 应更新本地
		await vault.create('b.md', 'B_LOCAL');
		await remote.setFile('b.md', 'B_REMOTE_NEW');

		const remoteState = (await remote.readFromSource()).state;
		const store = {
			localSha: {
				'a.md': await LocalVault.fileSha1('a.md', FileContent.fromPlainText('A_LOCAL_OLD')),
				'b.md': await LocalVault.fileSha1('b.md', FileContent.fromPlainText('B_LOCAL'))
			},
			lastFetchedRemoteSha: {
				// a.md 远端没变：基线必须等于当前远端 OID
				'a.md': remoteState['a.md'] as string,
				// b.md 远端改过：基线是旧 OID
				'b.md': 'b-remote-old-blob'
			}
		};

		let persisted: { localSha: Record<string, string>; lastFetchedRemoteSha: Record<string, string> } | null = null;
		const service = new SyncService(fit, async update => { persisted = update as never; });
		const plan = await service.plan('two-way-delete', undefined, store);
		expect(plan.conflicts).toHaveLength(0);
		expect(plan.operations.map(op => `${op.kind}:${op.path}`).sort())
			.toEqual(['write-local:b.md', 'write-remote:a.md']);

		// 只执行 b.md
		const onlyB = plan.operations.filter(op => op.path === 'b.md').map(op => op.id);
		await service.execute(plan, onlyB, {}, store);

		expect(persisted).not.toBeNull();
		// a.md 没执行：基线必须保持旧值，否则下次会退化成冲突
		expect(persisted!.localSha['a.md']).toBe(store.localSha['a.md']);
		// b.md 已同步：该路径的旧缓存被移除，下次以共同状态为准
		expect(persisted!.localSha['b.md']).toBeUndefined();
		expect(persisted!.lastFetchedRemoteSha['b.md']).toBeUndefined();
	});

	it('完全没有缓存：仍交用户决策（不猜）', async () => {
		const { service } = await setup('LOCAL', 'REMOTE');
		const plan = await service.plan('two-way-delete', undefined, {});
		expect(plan.conflicts.map(c => c.kind)).toEqual(['no-baseline-differs']);
	});
});
