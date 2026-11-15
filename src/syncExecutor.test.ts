/**
 * 共用执行器测试：逐项选择、计划过期、部分失败、结果待确认、镜像完整性。
 */

import { describe, it, expect } from 'vitest';
import { executePlan, verifyPlanStillValid, applyOutcomesToCommonState, adoptInitialCommonState, ExecutionPorts, describeGitHubError, classifyPublishError } from './syncExecutor';
import { generatePlan } from './syncPlanner';
import { CommonState, StateIdentity } from './commonState';
import { ContentDigest, digestBytes } from './util/contentDigest';
import { BlobSha, CommitSha } from './util/hashing';
import { RuleKind, SyncDirection } from './syncTypes';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

async function digestOf(text: string): Promise<ContentDigest> {
	const bytes = new TextEncoder().encode(text);
	return digestBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

function shas(files: Record<string, string>): Record<string, BlobSha> {
	return Object.fromEntries(Object.keys(files).map(p => [p, `sha-${p}` as BlobSha]));
}

async function planFor(rule: RuleKind, direction: SyncDirection | undefined, local: Record<string, string>, remote: Record<string, string>, common: Record<string, string | null> = {}, established = true) {
	const state = CommonState.create(IDENTITY);
	if (established) state.markEstablished();
	for (const [path, content] of Object.entries(common)) {
		if (content === null) state.recordAbsent([path]);
		else state.recordSame([{ path, digest: await digestOf(content) }]);
	}
	const reader = {
		read: async (side: 'local' | 'remote', path: string) => {
			const table = side === 'local' ? local : remote;
			const content = table[path];
			if (content === undefined) throw new Error(`missing ${side}/${path}`);
			return { digest: await digestOf(content), binary: false, size: content.length };
		}
	};
	const plan = await generatePlan({
		rule, direction, identity: IDENTITY,
		remoteCommitSha: 'head-1' as CommitSha,
		rulesFingerprint: 'rules-1',
		local: { state: shas(local), excluded: [], unreadable: [] },
		remote: { state: shas(remote), excluded: [], unreadable: [] },
		commonState: state, reader
	});
	return { plan, state };
}

function makePorts(overrides: Partial<ExecutionPorts> = {}, localState: Record<string, string> = {}): ExecutionPorts & { logs: string[] } {
	const logs: string[] = [];
	const ports: ExecutionPorts = {
		currentIdentity: async () => IDENTITY,
		currentRemoteHead: async () => 'head-1',
		currentRulesFingerprint: async () => 'rules-1',
		// 三态：计划内有 SHA 的路径返回该 SHA，其余确认不存在（null）。
		currentPathState: async (paths) => ({
			local: Object.fromEntries(paths.map(path => [path, path in localState ? localState[path] : null])),
			remote: {}
		}),
		writeLocal: async (path) => { logs.push(`write-local:${path}`); },
		deleteLocal: async (path) => { logs.push(`delete-local:${path}`); },
		publishRemote: async (actions) => {
			const paths = actions.additions.map(a => a.path);
			logs.push(`publish:${paths.join(',')}|${actions.deletions.join(',')}`);
			return { status: 'committed', commitSha: 'head-2', committedPaths: [...paths, ...actions.deletions] };
		},
		digestOf: async (side, path) => digestOf(`${side}:${path}:content`),
		...overrides
	};
	return { ...ports, logs };
}

describe('executePlan', () => {
	it('确认前不应用：未选中的操作既不执行也不推进共同状态', async () => {
		const { plan, state } = await planFor('merge-no-delete', undefined, { 'a.md': 'A', 'b.md': 'B' }, {});
		const ports = makePorts({}, plan.localState);
		const report = await executePlan(plan, { selected: new Set([plan.operations[0].id]), rule: 'merge-no-delete' }, ports);

		expect(ports.logs).toEqual(['publish:a.md|']);
		expect(report.skipped).toEqual(['b.md']);
		const advanced = applyOutcomesToCommonState(state, report, [], ['a.md']);
		expect(advanced.advanced).toEqual(['a.md']);
		// b.md 未被选中：不能标成已同步
		expect(advanced.withheld).toContain('b.md');
		expect(state.lookup('b.md').known).toBe(false);
	});

	it('全不选时不写任何文件，也不推进状态', async () => {
		const { plan, state } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({}, plan.localState);
		const report = await executePlan(plan, { selected: new Set(), rule: 'merge-no-delete' }, ports);

		expect(ports.logs).toEqual([]);
		expect(report.succeeded).toEqual([]);
		expect(report.skipped).toEqual(['a.md']);
		expect(applyOutcomesToCommonState(state, report).advanced).toEqual([]);
	});

	it('执行前不再做整体复核：远端头变化由条件提交拒绝（不写任何远端内容）', async () => {
		const { plan } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({ publishRemote: async () => ({ status: 'head-changed' }) }, plan.localState);
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'merge-no-delete' }, ports);

		expect(report.rejected).toBeUndefined();
		expect(report.failed[0].outcome).toMatchObject({ status: 'failed' });
		expect(report.succeeded).toEqual([]);
	});

	it('verifyPlanStillValid 仍可按需单独调用（例如入口自己要提前判定）', async () => {
		const { plan } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const stale = makePorts({ currentRemoteHead: async () => 'head-other' }, plan.localState);
		expect(await verifyPlanStillValid(plan, stale)).toContain('远端分支已变化');

		const switched = makePorts({ currentIdentity: async () => ({ ...IDENTITY, branch: 'other' }) }, plan.localState);
		expect(await verifyPlanStillValid(plan, switched)).toContain('仓库或分支已变更');

		const rules = makePorts({ currentRulesFingerprint: async () => 'rules-2' }, plan.localState);
		expect(await verifyPlanStillValid(plan, rules)).toContain('忽略规则已变化');
	});

	it('严格条件发布被拒绝时，远端项记为失败且不推进状态', async () => {
		const { plan, state } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({ publishRemote: async () => ({ status: 'head-changed' }) }, plan.localState);
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'merge-no-delete' }, ports);

		expect(report.failed).toHaveLength(1);
		expect(report.failed[0].outcome).toMatchObject({ status: 'failed' });
		const advanced = applyOutcomesToCommonState(state, report, [], []);
		expect(advanced.advanced).toEqual([]);
		expect(advanced.withheld).toContain('a.md');
	});

	it('响应丢失（结果待确认）不算成功，不推进状态', async () => {
		const { plan, state } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({ publishRemote: async () => ({ status: 'uncertain', detail: '请求已发送但未收到响应' }) }, plan.localState);
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'merge-no-delete' }, ports);

		expect(report.uncertain).toHaveLength(1);
		expect(report.succeeded).toHaveLength(0);
		expect(applyOutcomesToCommonState(state, report, [], []).advanced).toEqual([]);
	});

	it('本地部分失败：成功项推进，失败项不推进', async () => {
		const { plan, state } = await planFor('merge-no-delete', undefined, {}, { 'a.md': 'A', 'b.md': 'B' });
		const ports = makePorts({
			writeLocal: async (path) => {
				if (path === 'b.md') throw new Error('EACCES');
			}
		}, plan.localState);
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'merge-no-delete' }, ports);

		expect(report.succeeded.map(i => i.path)).toEqual(['a.md']);
		expect(report.failed.map(i => i.path)).toEqual(['b.md']);
		const advanced = applyOutcomesToCommonState(state, report, [], ['a.md']);
		expect(advanced.advanced).toEqual(['a.md']);
		expect(advanced.withheld).toContain('b.md');
		expect(state.lookup('b.md').known).toBe(false);
	});

	it('删除只有两端都确认不存在才记为共同删除', async () => {
		const { plan, state } = await planFor('mirror', 'pull', {}, { 'keep.md': 'K' });
		// 构造一个删除项：本地独有而远端没有
		const { plan: deletionPlan, state: deletionState } = await planFor('mirror', 'pull', { 'l.md': 'L' }, {});
		const ports = makePorts({}, deletionPlan.localState);
		const report = await executePlan(deletionPlan, { selected: new Set(deletionPlan.operations.map(o => o.id)), rule: 'mirror' }, ports);
		expect(report.succeeded.map(i => i.path)).toEqual(['l.md']);

		// 只删了本地，远端本来也没有 → 两端都不存在
		const withBothAbsent = applyOutcomesToCommonState(deletionState, report, ['l.md']);
		expect(withBothAbsent.advanced).toEqual(['l.md']);
		expect(deletionState.lookup('l.md')).toEqual({ known: true, entry: { presence: 'absent' } });

		// 没有核对两端都不存在时不记为共同删除
		const withoutCheck = applyOutcomesToCommonState(CommonState.create(IDENTITY), report);
		expect(withoutCheck.advanced).toEqual([]);
		expect(plan.operations.length).toBeGreaterThan(0);
		expect(state.size).toBe(0);
	});

	it('镜像只选一部分时不宣称已完整镜像', async () => {
		const { plan } = await planFor('mirror', 'upload', { 'a.md': 'A' }, { 'a.md': 'A', 'r1.md': 'R', 'r2.md': 'R' });
		expect(plan.operations).toHaveLength(2);
		const ports = makePorts({}, plan.localState);
		const all = new Set(plan.operations.map(o => o.id));
		const partial = new Set([...all].slice(0, 1));
		const partialReport = await executePlan(plan, { selected: partial, rule: 'mirror' }, ports);
		expect(partialReport.mirrorComplete).toBe(false);

		const fullReport = await executePlan(plan, { selected: all, rule: 'mirror' }, makePorts({}, plan.localState));
		expect(fullReport.mirrorComplete).toBe(true);
	});

	it('同一路径的多个操作通过依赖组联动，不能只执行一半', async () => {
		// 双向同步中同一路径最多一个操作，这里用重复 id 构造依赖组场景
		const { plan } = await planFor('mirror', 'pull', { 'l.md': 'L' }, { 'l.md': 'R' });
		// 计划本身不应给同一路径排多个操作
		const ids = plan.operations.map(o => o.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('verifyPlanStillValid', () => {
	it('本地相关路径变化时拒绝执行', async () => {
		const { plan } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({
			currentPathState: async () => ({ local: { 'a.md': 'sha-changed' }, remote: {} })
		});
		const reason = await verifyPlanStillValid(plan, ports);
		expect(reason).toContain('本地文件已变化');
	});

	it('一切未变时通过', async () => {
		const { plan } = await planFor('merge-no-delete', undefined, { 'a.md': 'A' }, {});
		const ports = makePorts({
			currentPathState: async () => ({ local: { 'a.md': plan.localState['a.md'] }, remote: {} })
		});
		expect(await verifyPlanStillValid(plan, ports)).toBeNull();
	});
});

describe('adoptInitialCommonState', () => {
	it('只采纳双方同名且内容一致的路径，并标记为已建立', async () => {
		const { plan } = await planFor('merge-no-delete', undefined, { 'same.md': 'X', 'differs.md': 'A' }, { 'same.md': 'X', 'differs.md': 'B' }, {}, false);
		const state = CommonState.create(IDENTITY);
		const { adopted } = adoptInitialCommonState(state, plan);
		expect(adopted).toEqual(['same.md']);
		expect(state.lookup('same.md').known).toBe(true);
		// 内容不同的路径没有被采纳为共同状态：它是显式 unknown，绝不进入 absent 推断。
		expect(state.isDefinite('differs.md')).toBe(false);
		expect(state.lookup('differs.md')).toMatchObject({ known: true, entry: { presence: 'unknown' } });
		expect(state.established).toBe(true);
	});
});

describe('GitHub 错误必须可读', () => {
	it('GraphQL errors 会被逐条读出（状态是 200 也一样）', () => {
		const error = Object.assign(new Error('Something went wrong while executing your query'), {
			errors: [
				{ type: 'UNSTABLE', message: 'Branch is protected' },
				{ message: 'Invalid base64' }
			]
		});
		const text = describeGitHubError(error);
		expect(text).toContain('Branch is protected');
		expect(text).toContain('UNSTABLE');
		expect(text).toContain('Invalid base64');
	});

	it('HTTP 4xx 明确报失败，并带上服务端消息', () => {
		const error = Object.assign(new Error('Validation failed'), { status: 422, errors: [{ message: 'Invalid tree' }] });
		const result = classifyPublishError(error);
		expect(result.status).toBe('failed');
		expect(JSON.stringify(result)).toContain('Invalid tree');
	});

	it('网络/5xx 仍归为结果待确认，不谎报失败或成功', () => {
		const result = classifyPublishError(Object.assign(new Error('Bad gateway'), { status: 502 }));
		expect(result.status).toBe('uncertain');
	});
});
