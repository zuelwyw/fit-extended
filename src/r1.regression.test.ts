/**
 * R1 回归：部分执行后，未决/未选路径必须持久保持 unknown。
 *
 * 缺陷链路（旧实现在此处会失败）：
 * 1. 首次双向同步，X 无基线且双方内容不同 → 冲突，用户不决策 X、只执行别的项；
 * 2. 旧实现 adoptInitialCommonState 无条件 markEstablished()，而 X 没有任何记录；
 * 3. 重开插件后重新生成计划，"无记录且已 established"被解析成 absent；
 * 4. X 只剩一端存在 → 被判为"另一端删除后来源新增"，pushWrite 补到另一端，
 *    等于静默覆盖另一端真实的删除。
 *
 * 新增的 unknown 记录必须切断第 3 步：未决路径永远不被推断为 absent。
 */

import { describe, it, expect } from 'vitest';
import { adoptInitialCommonState } from './syncExecutor';
import { collectUncertainPaths } from './syncService';
import { generatePlan } from './syncPlanner';
import { CommonState, StateIdentity } from './commonState';
import { contentDigestOfText } from './util/contentDigest';
import { BlobSha, CommitSha } from './util/hashing';
import { SyncPlan } from './syncTypes';
import { ExecutionReport } from './syncExecutor';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

function emptyPlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
	return {
		rule: 'two-way-delete', direction: null, identity: IDENTITY,
		remoteCommitSha: 'head-1' as CommitSha, rulesFingerprint: 'rules-1',
		operations: [], conflicts: [], excluded: [], unreadable: [],
		dependencyGroups: [], localState: {}, remoteState: {},
		adoptable: [], confirmedAbsent: [], mirrorComplete: false,
		counts: { writeRemote: 0, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts: 0, excluded: 0, unreadable: 0 },
		...overrides
	};
}

function failedReport(paths: string[]): ExecutionReport {
	return {
		items: paths.map(path => ({
			operationId: `write-remote:${path}`, path, kind: 'write-remote' as const,
			outcome: { status: 'failed' as const, error: 'boom' }
		})),
		succeeded: [], failed: [], uncertain: [],
		skipped: paths, mirrorComplete: false
	};
}

/** 重开插件：从持久化快照重建共同状态。 */
function reload(state: CommonState): CommonState {
	return CommonState.create(IDENTITY, JSON.parse(JSON.stringify(state.toJSON())));
}

async function planSingleSided(common: CommonState, localHas: boolean) {
	return generatePlan({
		rule: 'two-way-delete',
		identity: IDENTITY,
		remoteCommitSha: 'head-2' as CommitSha,
		rulesFingerprint: 'rules-1',
		local: { state: localHas ? { 'X.md': 'sha-x' as BlobSha } : {}, excluded: [], unreadable: [] },
		remote: { state: localHas ? {} : { 'X.md': 'blob-x' as BlobSha }, excluded: [], unreadable: [] },
		commonState: common,
		reader: { read: async () => ({ digest: await contentDigestOfText('content'), binary: false, size: 7 }) }
	});
}

describe('R1: 未决冲突路径不得推断为 absent', () => {
	it('回归：首次部分执行 → 重开 → 单边存在仍为冲突，绝不静默补写', async () => {
		const state = CommonState.create(IDENTITY);
		const plan = emptyPlan({
			conflicts: [{ path: 'X.md', kind: 'no-baseline-differs', binary: false, detail: '双方内容不同' }],
			operations: [{ id: 'write-remote:Y.md', kind: 'write-remote', path: 'Y.md', reason: 'add' }]
		});
		// 用户不决策 X，只执行 Y（Y 成功、X 未产生任何结论）
		const report: ExecutionReport = {
			items: [{ operationId: 'write-remote:Y.md', path: 'Y.md', kind: 'write-remote', outcome: { status: 'succeeded' }, digest: await contentDigestOfText('y') }],
			succeeded: [], failed: [], uncertain: [], skipped: [], mirrorComplete: false
		};
		const uncertain = collectUncertainPaths(plan, report, {});
		expect(uncertain).toContain('X.md');

		adoptInitialCommonState(state, plan, uncertain, '本次未取得确定结论');
		const reopened = reload(state);

		// X 必须有显式 unknown 记录，而不是"没有记录"
		expect(reopened.lookup('X.md')).toMatchObject({ known: true, entry: { presence: 'unknown' } });
		expect(reopened.isDefinite('X.md')).toBe(false);

		for (const localHas of [true, false]) {
			const next = await planSingleSided(reopened, localHas);
			expect(next.operations).toEqual([]);
			expect(next.conflicts.map(c => c.path)).toContain('X.md');
		}
	});

	it('失败/未选/待确认的路径同样记为 unknown 并持久化', async () => {
		const state = CommonState.create(IDENTITY);
		const plan = emptyPlan({
			operations: [
				{ id: 'write-remote:F.md', kind: 'write-remote', path: 'F.md', reason: 'add' },
				{ id: 'write-remote:S.md', kind: 'write-remote', path: 'S.md', reason: 'add' },
				{ id: 'write-local:U.md', kind: 'write-local', path: 'U.md', reason: 'add' }
			]
		});
		const report = failedReport(['F.md', 'S.md']);
		report.skipped = ['U.md'];
		const uncertain = collectUncertainPaths(plan, report, {});
		expect(uncertain.sort()).toEqual(['F.md', 'S.md', 'U.md']);

		adoptInitialCommonState(state, plan, uncertain, '未确认');
		const reopened = reload(state);
		for (const path of ['F.md', 'S.md', 'U.md']) {
			expect(reopened.isDefinite(path)).toBe(false);
			expect(reopened.lookup(path)).toMatchObject({ known: true, entry: { presence: 'unknown' } });
		}
	});

	it('正常新增不因 unknown 机制反复假冲突：曾确认 absent 的单边出现仍判为新增', async () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		state.recordAbsent(['new.md']);
		const plan = await generatePlan({
			rule: 'two-way-delete',
			identity: IDENTITY,
			remoteCommitSha: 'head-2' as CommitSha,
			rulesFingerprint: 'rules-1',
			local: { state: { 'new.md': 'sha-n' as BlobSha }, excluded: [], unreadable: [] },
			remote: { state: {}, excluded: [], unreadable: [] },
			commonState: state,
			reader: { read: async () => ({ digest: await contentDigestOfText('n'), binary: false, size: 1 }) }
		});
		expect(plan.conflicts).toEqual([]);
		expect(plan.operations.map(o => `${o.kind}:${o.path}`)).toEqual(['write-remote:new.md']);
	});

	it('确定结论的路径不受 unknown 牵连', async () => {
		const state = CommonState.create(IDENTITY);
		const plan = emptyPlan({
			conflicts: [{ path: 'X.md', kind: 'no-baseline-differs', binary: false, detail: 'x' }],
			adoptable: [{ path: 'S.md', local: 'sha-s' as BlobSha, remote: 'blob-s' as BlobSha, digest: await contentDigestOfText('s') }]
		});
		const { adopted, unknown } = adoptInitialCommonState(state, plan, ['X.md'], '未确认');
		expect(adopted).toContain('S.md');
		expect(unknown).toContain('X.md');
		expect(state.isDefinite('S.md')).toBe(true);
		expect(state.isDefinite('X.md')).toBe(false);
	});

	it('未决策冲突即使没有操作项也会被记为 unknown', () => {
		const state = CommonState.create(IDENTITY);
		const plan = emptyPlan({
			conflicts: [{ path: 'C.md', kind: 'both-modified', binary: false, detail: 'x' }]
		});
		// 传入空的 uncertain，adopt 自身也必须兜住计划里的冲突路径
		adoptInitialCommonState(state, plan, [], '未确认');
		expect(state.lookup('C.md')).toMatchObject({ known: true, entry: { presence: 'unknown' } });
	});
});
