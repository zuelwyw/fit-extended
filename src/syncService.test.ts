/**
 * 服务层端到端（内存两端，不含真实网络与真实知识库）。
 *
 * 目的：验证"扫描 → 计划 → 审阅选择 → 发布/写入 → 共同状态"这条真实链路
 * 的接线正确，而不是各模块各自通过、拼起来却对不上。
 */

import { describe, it, expect } from 'vitest';
import { executePlan, applyOutcomesToCommonState, ExecutionPorts } from './syncExecutor';
import { CommonState, StateIdentity } from './commonState';
import { buildDecisionOperations } from './syncService';
import { digestBytes, ContentDigest } from './util/contentDigest';
import { CommitSha } from './util/hashing';
import { SyncPlan } from './syncTypes';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

async function digestOf(text: string): Promise<ContentDigest> {
	const bytes = new TextEncoder().encode(text);
	return digestBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

function planOf(overrides: Partial<SyncPlan>): SyncPlan {
	return {
		rule: 'two-way-delete',
		direction: null,
		identity: IDENTITY,
		remoteCommitSha: 'head-1' as CommitSha,
		rulesFingerprint: 'rules-1',
		operations: [],
		conflicts: [],
		excluded: [],
		unreadable: [],
		dependencyGroups: [],
		localState: {},
		remoteState: {},
		adoptable: [],
		confirmedAbsent: [],
		mirrorComplete: false,
		counts: { writeRemote: 0, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts: 0, excluded: 0, unreadable: 0 },
		...overrides
	};
}

describe('冲突决策 → 动作', () => {
	const conflict = (path: string, localPresent: boolean, remotePresent: boolean) => ({
		path,
		kind: 'both-modified' as const,
		binary: false,
		detail: 'x',
		local: { present: localPresent, digest: 'sha1:a' as ContentDigest, binary: false, size: 1 },
		remote: { present: remotePresent, digest: 'sha1:b' as ContentDigest, binary: false, size: 2 }
	});

	it('采用本地 → 写远端；本地不存在则删远端', () => {
		const plan = planOf({ conflicts: [conflict('a.md', true, true), conflict('b.md', false, true)] });
		const ops = buildDecisionOperations(plan, { 'a.md': { action: 'local' }, 'b.md': { action: 'local' } });
		expect(ops.map(op => op.kind + ':' + op.path)).toEqual(['write-remote:a.md', 'delete-remote:b.md']);
	});

	it('采用远端 → 写本地；远端不存在则删本地', () => {
		const plan = planOf({ conflicts: [conflict('a.md', true, true), conflict('c.md', true, false)] });
		const ops = buildDecisionOperations(plan, { 'a.md': { action: 'remote' }, 'c.md': { action: 'remote' } });
		expect(ops.map(op => op.kind + ':' + op.path)).toEqual(['write-local:a.md', 'delete-local:c.md']);
	});

	it('手工结果真正写入：双向规则两端都写，携带用户确认的最终内容', () => {
		const plan = planOf({ conflicts: [conflict('a.md', true, true)], rule: 'two-way-delete' });
		const ops = buildDecisionOperations(plan, { 'a.md': { action: 'manual', manualText: '合并结果' } });
		expect(ops.map(op => `${op.kind}:${op.path}`).sort()).toEqual(['write-local:a.md', 'write-remote:a.md']);
		for (const op of ops) expect((op as { manualText?: string }).manualText).toBe("合并结果");
	});

	it('手工结果在单向规则下只写目标端，不反向改写来源端', () => {
		const upload = planOf({ conflicts: [conflict('a.md', true, true)], rule: 'overwrite', direction: 'upload' });
		expect(buildDecisionOperations(upload, { 'a.md': { action: 'manual', manualText: 'x' } })
			.map(op => op.kind)).toEqual(['write-remote']);
		const pull = planOf({ conflicts: [conflict('a.md', true, true)], rule: 'overwrite', direction: 'pull' });
		expect(buildDecisionOperations(pull, { 'a.md': { action: 'manual', manualText: 'x' } })
			.map(op => op.kind)).toEqual(['write-local']);
	});

	it('手工结果为空字符串时也生成写入操作（空文件是合法内容）', () => {
		const plan = planOf({ conflicts: [conflict('a.md', true, true)] });
		const ops = buildDecisionOperations(plan, { 'a.md': { action: 'manual', manualText: '' } });
		expect(ops).toHaveLength(2);
		for (const op of ops) expect((op as { manualText?: string }).manualText).toBe('');
	});

	it('未决策的冲突不产生动作', () => {
		const plan = planOf({ conflicts: [conflict('a.md', true, true)] });
		expect(buildDecisionOperations(plan, {})).toEqual([]);
	});
});

describe('端到端：决策转成的动作会真正被执行', () => {
	it('采用本地会把冲突项写进远端提交，并推进共同状态', async () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		const plan = planOf({
			conflicts: [{
				path: 'a.md', kind: 'both-modified', binary: false, detail: 'x',
				local: { present: true, digest: 'sha1:a' as ContentDigest, binary: false, size: 3 },
				remote: { present: true, digest: 'sha1:b' as ContentDigest, binary: false, size: 4 }
			}],
			localState: { 'a.md': 'sha-a' as never }
		});
		const decisionOps = buildDecisionOperations(plan, { 'a.md': { action: 'local' } });
		const effectivePlan = { ...plan, operations: decisionOps };
		const published: string[][] = [];
		const ports: ExecutionPorts = {
			currentIdentity: async () => IDENTITY,
			currentRemoteHead: async () => 'head-1',
			currentRulesFingerprint: async () => 'rules-1',
			currentPathState: async () => ({ local: { 'a.md': 'sha-a' }, remote: {} }),
			writeLocal: async () => {},
			deleteLocal: async () => {},
			publishRemote: async (actions) => {
				published.push(actions.additions.map(a => a.path));
				return { status: 'committed', commitSha: 'head-2', committedPaths: actions.additions.map(a => a.path) };
			},
			digestOf: async () => digestOf('merged')
		};
		const report = await executePlan(effectivePlan, { selected: new Set(decisionOps.map(op => op.id)), rule: 'two-way-delete' }, ports);
		expect(published).toEqual([['a.md']]);
		expect(report.succeeded.map(i => i.path)).toEqual(['a.md']);

		const advanced = applyOutcomesToCommonState(state, report, [], ['a.md']);
		expect(advanced.advanced).toEqual(['a.md']);
	});
});
