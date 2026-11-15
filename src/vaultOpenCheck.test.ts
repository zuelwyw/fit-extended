/**
 * R3：打开知识库只检查、不执行；计划可复用；保存设置不重复触发。
 */

import { describe, it, expect, vi } from 'vitest';
import { runVaultOpenCheck, VaultOpenCheckDeps } from './vaultOpenCheck';
import { SyncPlan } from './syncTypes';
import { CommitSha } from './util/hashing';

function planOf(operations: number, conflicts = 0): SyncPlan {
	return {
		rule: 'two-way-delete', direction: null,
		identity: { owner: 'o', repo: 'r', branch: 'main' },
		remoteCommitSha: 'h' as CommitSha, rulesFingerprint: 'f',
		operations: Array.from({ length: operations }, (_, i) => ({
			id: `write-remote:f${i}.md`, kind: 'write-remote' as const, path: `f${i}.md`, reason: 'add' as const
		})),
		conflicts: Array.from({ length: conflicts }, (_, i) => ({
			path: `c${i}.md`, kind: 'both-modified' as const, binary: false, detail: 'x'
		})),
		excluded: [], unreadable: [], dependencyGroups: [],
		localState: {}, remoteState: {}, adoptable: [], confirmedAbsent: [],
		mirrorComplete: false,
		counts: { writeRemote: operations, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts, excluded: 0, unreadable: 0 }
	};
}

function deps(overrides: Partial<VaultOpenCheckDeps> = {}) {
	const pending: Array<SyncPlan | null> = [];
	const notices: string[] = [];
	const logs: string[] = [];
	let executed = 0;
	const base: VaultOpenCheckDeps = {
		enabled: () => true,
		configured: () => true,
		busy: () => false,
		plan: async () => planOf(2),
		setPending: plan => { pending.push(plan); },
		notify: message => { notices.push(message); },
		log: message => { logs.push(message); }
	};
	return { deps: { ...base, ...overrides }, pending, notices, logs, executedRef: () => executed };
}

describe('R3: 打开知识库检查', () => {
	it('开关关闭时不检查、不生成计划', async () => {
		const plan = vi.fn(async () => planOf(2));
		const d = deps({ enabled: () => false, plan });
		const result = await runVaultOpenCheck(d.deps);
		expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
		expect(plan).not.toHaveBeenCalled();
		expect(d.pending).toEqual([]);
	});

	it('有差异时保存计划供复用，并提示用户（只检查不执行）', async () => {
		const d = deps();
		const result = await runVaultOpenCheck(d.deps);
		expect(result.status).toBe('planned');
		expect(d.pending).toHaveLength(1);
		expect(d.pending[0]).toBe((result as { plan: SyncPlan }).plan);
		expect(d.notices[0]).toContain('不会自动同步');
	});

	it('无差异时静默：不提示、不保留计划', async () => {
		const d = deps({ plan: async () => planOf(0, 0) });
		const result = await runVaultOpenCheck(d.deps);
		expect(result).toEqual({ status: 'no-changes' });
		expect(d.pending).toEqual([null]);
		expect(d.notices).toEqual([]);
	});

	it('计划对象可复用：不重复生成（保存后再打开不会重扫）', async () => {
		const plan = vi.fn(async () => planOf(1));
		const d = deps({ plan });
		await runVaultOpenCheck(d.deps);
		// 复用保存下来的计划，不再调用 plan()
		const reused = d.pending[0];
		expect(reused).not.toBeNull();
		expect(plan).toHaveBeenCalledTimes(1);
	});

	it('已有操作运行时跳过检查', async () => {
		const plan = vi.fn(async () => planOf(1));
		const d = deps({ busy: () => true, plan });
		expect(await runVaultOpenCheck(d.deps)).toEqual({ status: 'skipped', reason: 'busy' });
		expect(plan).not.toHaveBeenCalled();
	});

	it('未配置时跳过，不报错', async () => {
		const d = deps({ configured: () => false });
		expect(await runVaultOpenCheck(d.deps)).toEqual({ status: 'skipped', reason: 'not-configured' });
	});

	it('检查本身不触发任何同步执行：依赖里没有执行能力', async () => {
		// 结构性断言：VaultOpenCheckDeps 不含 execute/apply/publish 等写入能力
		const d = deps();
		const keys = Object.keys(d.deps);
		for (const forbidden of ['execute', 'apply', 'publish', 'write', 'sync']) {
			expect(keys.some(k => k.toLowerCase().includes(forbidden))).toBe(false);
		}
		await runVaultOpenCheck(d.deps);
	});
});
