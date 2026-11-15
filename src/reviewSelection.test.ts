/**
 * 审阅选择逻辑测试（不涉及 DOM）。
 */

import { describe, it, expect } from 'vitest';
import {
	initialSelection, selectNone, selectAllSafe, toggleOperation, setDecision,
	unresolvedConflicts, readiness, isDecisionUsable, finalizeSelection, applyDependencyGroups
} from './reviewSelection';
import { SyncPlan, PlanOperation, Conflict } from './syncTypes';
import { CommitSha } from './util/hashing';

function op(kind: PlanOperation['kind'], path: string): PlanOperation {
	return { id: `${kind}:${path}`, kind, path } as PlanOperation;
}

function plan(operations: PlanOperation[], conflicts: Conflict[] = [], groups: SyncPlan['dependencyGroups'] = []): SyncPlan {
	return {
		rule: 'merge-no-delete',
		direction: null,
		identity: { owner: 'o', repo: 'r', branch: 'main' },
		remoteCommitSha: 'head' as CommitSha,
		rulesFingerprint: 'rules',
		operations,
		conflicts,
		excluded: [],
		unreadable: [],
		dependencyGroups: groups,
		localState: {},
		remoteState: {},
		adoptable: [],
		confirmedAbsent: [],
		mirrorComplete: false,
		counts: {
			writeRemote: operations.filter(o => o.kind === 'write-remote').length,
			writeLocal: operations.filter(o => o.kind === 'write-local').length,
			deleteRemote: operations.filter(o => o.kind === 'delete-remote').length,
			deleteLocal: operations.filter(o => o.kind === 'delete-local').length,
			conflicts: conflicts.length,
			excluded: 0,
			unreadable: 0
		}
	};
}

const conflictAt = (path: string): Conflict => ({
	path, kind: 'both-modified', binary: false, detail: 'x'
});

describe('审阅选择', () => {
	const operations = [op('write-remote', 'a.md'), op('write-local', 'b.md')];

	it('默认只选中不涉及冲突的操作', () => {
		const selection = initialSelection(plan(operations, [conflictAt('a.md')]));
		expect([...selection.selected]).toEqual(['write-local:b.md']);
	});

	it('全选不会替未决冲突选边', () => {
		const selection = selectAllSafe(plan(operations, [conflictAt('a.md')]), selectNone());
		expect([...selection.selected]).toEqual(['write-local:b.md']);
	});

	it('全不选后没有可执行项', () => {
		const selection = selectNone();
		expect(selection.selected.size).toBe(0);
		expect(readiness(plan(operations), selection)).toEqual({ ready: false, reason: 'nothing-selected' });
	});

	it('只选一部分时另一项不进选择集', () => {
		const selection = toggleOperation(initialSelection(plan(operations)), plan(operations), 'write-remote:a.md', false);
		expect([...selection.selected]).toEqual(['write-local:b.md']);
	});

	it('依赖组联动：同组不能只执行一半', () => {
		const grouped = plan(
			[op('write-remote', 'a.md'), op('delete-remote', 'a.md')],
			[],
			[{ id: 'path:a.md', members: ['write-remote:a.md', 'delete-remote:a.md'], reason: '同一路径' }]
		);
		const selection = toggleOperation(selectNone(), grouped, 'write-remote:a.md', true);
		expect([...selection.selected].sort()).toEqual(['delete-remote:a.md', 'write-remote:a.md']);
	});

	it('未决冲突使计划不可执行', () => {
		const withConflict = plan(operations, [conflictAt('a.md')]);
		const selection = selectAllSafe(withConflict, initialSelection(withConflict));
		expect(readiness(withConflict, selection)).toMatchObject({ ready: false, reason: 'unresolved-conflicts' });
	});

	it('冲突全部决策后可执行', () => {
		const withConflict = plan(operations, [conflictAt('a.md')]);
		let selection = selectAllSafe(withConflict, initialSelection(withConflict));
		selection = setDecision(selection, 'a.md', { action: 'local' });
		expect(unresolvedConflicts(withConflict, selection)).toEqual([]);
		expect(readiness(withConflict, selection)).toEqual({ ready: true });
	});

	it('手工决策的有效性取决于"是否选择了手工"，而不是内容是否非空', () => {
		// 空文件与纯空白都是合法的真实内容，不能被当成未决策丢弃
		expect(isDecisionUsable({ action: 'manual', manualText: '' })).toBe(true);
		expect(isDecisionUsable({ action: 'manual', manualText: '   ' })).toBe(true);
		expect(isDecisionUsable({ action: 'manual', manualText: '合并后的内容' })).toBe(true);
		expect(isDecisionUsable({ action: 'remote' })).toBe(true);
		// 未选择任何决策才是未决
		expect(isDecisionUsable(undefined)).toBe(false);
	});

	it('明确选择空内容后该冲突视为已决策（不会被丢弃）', () => {
		const withConflict = plan(operations, [conflictAt('a.md')]);
		let selection = setDecision(selectNone(), 'a.md', { action: 'manual', manualText: '' });
		selection = finalizeSelection(withConflict, selection);
		expect(selection.decisions['a.md']).toEqual({ action: 'manual', manualText: '' });
		expect(unresolvedConflicts(withConflict, selection)).toEqual([]);
	});

	it('普通操作全部取消但冲突已决时仍可执行（决策本身产生动作）', () => {
		const withConflict = plan(operations, [conflictAt('a.md')]);
		let selection = selectNone();
		selection = setDecision(selection, 'a.md', { action: 'remote' });
		expect(readiness(withConflict, selection)).toEqual({ ready: true });
	});

	it('applyDependencyGroups 对完整选择不做改动', () => {
		const grouped = plan(
			[op('write-remote', 'a.md'), op('delete-remote', 'a.md')],
			[],
			[{ id: 'path:a.md', members: ['write-remote:a.md', 'delete-remote:a.md'], reason: '同一路径' }]
		);
		const all = { selected: new Set(['write-remote:a.md', 'delete-remote:a.md']), decisions: {} };
		expect([...applyDependencyGroups(grouped, all).selected].sort()).toEqual(['delete-remote:a.md', 'write-remote:a.md']);
	});
});
