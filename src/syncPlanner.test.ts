/**
 * 六类规则的计划生成测试：表驱动覆盖 模式 × 方向 × 文件状态 矩阵。
 *
 * 每个用例只断言"计划内容"，不触碰真实文件系统或网络：生成计划必须是纯的。
 */

import { describe, it, expect, vi } from 'vitest';
import { generatePlan, ContentFact } from './syncPlanner';
import { CommonState, StateIdentity } from './commonState';
import { ContentDigest, digestBytes } from './util/contentDigest';
import { BlobSha, CommitSha } from './util/hashing';
import { RuleKind, SyncDirection } from './syncTypes';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

async function digestOf(text: string): Promise<ContentDigest> {
	const bytes = new TextEncoder().encode(text);
	return digestBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** 内存版内容读取器：localFiles / remoteFiles 为 path → 文本。 */
function makeReader(localFiles: Record<string, string>, remoteFiles: Record<string, string>) {
	return {
		read: vi.fn(async (side: 'local' | 'remote', path: string): Promise<ContentFact> => {
			const table = side === 'local' ? localFiles : remoteFiles;
			const content = table[path];
			if (content === undefined) throw new Error(`File not found: ${side}/${path}`);
			const binary = content.startsWith('\u0000BIN\u0000');
			return { digest: await digestOf(content), binary, size: content.length };
		})
	};
}

function shas(files: Record<string, string>): Record<string, BlobSha> {
	return Object.fromEntries(Object.keys(files).map(path => [path, `sha-${path}` as BlobSha]));
}

type Case = {
	name: string;
	rule: RuleKind;
	direction?: SyncDirection;
	local: Record<string, string>;
	remote: Record<string, string>;
	/** 共同状态：path → 内容文本；null 表示"双方已删除" */
	common?: Record<string, string | null>;
	expect: {
		writeRemote?: string[];
		writeLocal?: string[];
		deleteRemote?: string[];
		deleteLocal?: string[];
		conflicts?: Array<{ path: string; kind: string }>;
		adoptable?: string[];
	};
};

async function runCase(testCase: Case) {
	const identity = IDENTITY;
	const snapshot = { version: 2, identity, entries: {} as Record<string, never> };
	const state = CommonState.create(identity);
	if (testCase.common !== undefined) {
		state.markEstablished();
		for (const [path, content] of Object.entries(testCase.common)) {
			if (content === null) state.recordAbsent([path]);
			else state.recordSame([{ path, digest: await digestOf(content) }]);
		}
	}
	Object.assign(snapshot, state.toJSON());
	const plan = await generatePlan({
		rule: testCase.rule,
		direction: testCase.direction,
		identity,
		remoteCommitSha: 'commit-1' as CommitSha,
		rulesFingerprint: 'rules-1',
		local: { state: shas(testCase.local), excluded: [], unreadable: [] },
		remote: { state: shas(testCase.remote), excluded: [], unreadable: [] },
		commonState: state,
		reader: makeReader(testCase.local, testCase.remote)
	});
	const collect = (kind: string) => plan.operations.filter(op => op.kind === kind).map(op => op.path).sort();
	return {
		plan,
		writeRemote: collect('write-remote'),
		writeLocal: collect('write-local'),
		deleteRemote: collect('delete-remote'),
		deleteLocal: collect('delete-local'),
		conflicts: plan.conflicts.map(c => ({ path: c.path, kind: c.kind }))
	};
}

const cases: Case[] = [
	// ===== 1. 仅补充缺失文件 =====
	{
		name: '补缺/上传：目标缺失就补，来源未变也要补',
		rule: 'add-missing', direction: 'upload',
		local: { 'a.md': 'A' }, remote: {},
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '补缺/上传：目标已有同名不同内容绝不覆盖',
		rule: 'add-missing', direction: 'upload',
		local: { 'a.md': '本地' }, remote: { 'a.md': '远端' },
		expect: {}
	},
	{
		name: '补缺/上传：目标独有文件保留',
		rule: 'add-missing', direction: 'upload',
		local: {}, remote: { 'r.md': 'R' },
		expect: {}
	},
	{
		name: '补缺/拉取：目标缺失就补（不传播来源删除）',
		rule: 'add-missing', direction: 'pull',
		local: { 'l.md': 'L' }, remote: { 'r.md': 'R' },
		expect: { writeLocal: ['r.md'] }
	},
	{
		name: '补缺/上传：目标曾主动删除的文件可补回',
		rule: 'add-missing', direction: 'upload',
		local: { 'a.md': 'A' }, remote: {},
		common: { 'a.md': 'A' },
		expect: { writeRemote: ['a.md'] }
	},

	// ===== 2. 单向更新 =====
	{
		name: '更新/上传：仅来源修改则更新目标',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '新' }, remote: { 'a.md': '旧' },
		common: { 'a.md': '旧' },
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '更新/上传：仅目标修改则保留',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '旧' }, remote: { 'a.md': '远端新' },
		common: { 'a.md': '旧' },
		expect: {}
	},
	{
		name: '更新/上传：双方修改且内容相同则无需操作',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '同' }, remote: { 'a.md': '同' },
		common: { 'a.md': '旧' },
		expect: {}
	},
	{
		name: '更新/上传：双方修改且不同则冲突',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '本地改' }, remote: { 'a.md': '远端改' },
		common: { 'a.md': '旧' },
		expect: { conflicts: [{ path: 'a.md', kind: 'both-modified' }] }
	},
	{
		name: '更新/上传：无共同状态且同名内容不同，不自动覆盖',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '本地' }, remote: { 'a.md': '远端' },
		expect: { conflicts: [{ path: 'a.md', kind: 'no-baseline-differs' }] }
	},
	{
		name: '更新/上传：目标主动删除而来源未改，保持删除',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '原' }, remote: {},
		common: { 'a.md': '原' },
		expect: {}
	},
	{
		name: '更新/上传：目标删除且来源也修改，报删改冲突',
		rule: 'update-one-way', direction: 'upload',
		local: { 'a.md': '本地新' }, remote: {},
		common: { 'a.md': '原' },
		expect: { conflicts: [{ path: 'a.md', kind: 'modify-delete' }] }
	},
	{
		name: '更新/上传：补充来源新增，不传播来源删除，保留目标独有',
		rule: 'update-one-way', direction: 'upload',
		local: { 'new.md': 'N' }, remote: { 'r-only.md': 'R' },
		common: {},
		expect: { writeRemote: ['new.md'] }
	},
	{
		name: '更新/拉取：仅远端修改则更新本地',
		rule: 'update-one-way', direction: 'pull',
		local: { 'a.md': '旧' }, remote: { 'a.md': '新' },
		common: { 'a.md': '旧' },
		expect: { writeLocal: ['a.md'] }
	},
	{
		name: '更新/拉取：仅本地修改则保留',
		rule: 'update-one-way', direction: 'pull',
		local: { 'a.md': '本地新' }, remote: { 'a.md': '旧' },
		common: { 'a.md': '旧' },
		expect: {}
	},

	// ===== 3. 单向覆盖 =====
	{
		name: '覆盖/上传：来源未变但目标变了，仍按来源覆盖',
		rule: 'overwrite', direction: 'upload',
		local: { 'a.md': '来源' }, remote: { 'a.md': '目标改过' },
		common: { 'a.md': '来源' },
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '覆盖/上传：来源缺失不删目标独有',
		rule: 'overwrite', direction: 'upload',
		local: {}, remote: { 'r.md': 'R' },
		expect: {}
	},
	{
		name: '覆盖/上传：目标缺失则补',
		rule: 'overwrite', direction: 'upload',
		local: { 'a.md': 'A' }, remote: {},
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '覆盖/拉取：以远端为准写入本地，不删本地独有',
		rule: 'overwrite', direction: 'pull',
		local: { 'a.md': '本地', 'l.md': 'L' }, remote: { 'a.md': '远端' },
		expect: { writeLocal: ['a.md'] }
	},
	{
		name: '覆盖/上传：无共同状态同名不同也按来源列入预览，不升格冲突',
		rule: 'overwrite', direction: 'upload',
		local: { 'a.md': '来源' }, remote: { 'a.md': '其它' },
		expect: { writeRemote: ['a.md'] }
	},

	// ===== 4. 单向镜像 =====
	{
		name: '镜像/上传：删除目标独有文件',
		rule: 'mirror', direction: 'upload',
		local: { 'a.md': 'A' }, remote: { 'a.md': 'A', 'r.md': 'R' },
		common: { 'a.md': 'A' },
		expect: { deleteRemote: ['r.md'] }
	},
	{
		name: '镜像/上传：目标独有但被排除的对象不在快照内，不删',
		rule: 'mirror', direction: 'upload',
		local: { 'a.md': 'A' }, remote: { 'a.md': 'A' },
		common: { 'a.md': 'A' },
		expect: {}
	},
	{
		name: '镜像/拉取：删除本地独有文件并写入远端内容',
		rule: 'mirror', direction: 'pull',
		local: { 'l.md': 'L' }, remote: { 'r.md': 'R' },
		expect: { writeLocal: ['r.md'], deleteLocal: ['l.md'] }
	},
	{
		name: '镜像/上传：内容相同不产生写操作',
		rule: 'mirror', direction: 'upload',
		local: { 'a.md': 'A' }, remote: { 'a.md': 'A' },
		expect: {}
	},

	// ===== 5. 双向合并、不传播删除 =====
	{
		name: '合并：一端缺失另一端仍有则补回（允许复活）',
		rule: 'merge-no-delete',
		local: { 'a.md': 'A' }, remote: {},
		common: { 'a.md': null },
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '合并：另一端缺失也补回到本地',
		rule: 'merge-no-delete',
		local: {}, remote: { 'r.md': 'R' },
		expect: { writeLocal: ['r.md'] }
	},
	{
		name: '合并：改名不做智能清理，新旧路径并存',
		rule: 'merge-no-delete',
		local: { 'new.md': 'N' }, remote: { 'old.md': 'N' },
		common: { 'old.md': 'N', 'new.md': 'N' },
		// 不传播删除：新路径写入另一端，旧路径补回本地，两者并存
		expect: { writeRemote: ['new.md'], writeLocal: ['old.md'] }
	},
	{
		name: '合并：双方都修改且不同交用户决策',
		rule: 'merge-no-delete',
		local: { 'a.md': '本地改' }, remote: { 'a.md': '远端改' },
		common: { 'a.md': '旧' },
		expect: { conflicts: [{ path: 'a.md', kind: 'both-modified' }] }
	},
	{
		name: '合并：仅本地修改则上传',
		rule: 'merge-no-delete',
		local: { 'a.md': '本地改' }, remote: { 'a.md': '旧' },
		common: { 'a.md': '旧' },
		expect: { writeRemote: ['a.md'] }
	},
	{
		name: '合并：仅远端修改则拉取',
		rule: 'merge-no-delete',
		local: { 'a.md': '旧' }, remote: { 'a.md': '远端改' },
		common: { 'a.md': '旧' },
		expect: { writeLocal: ['a.md'] }
	},
	{
		name: '合并：无共同状态同名相同可确认建立共同状态',
		rule: 'merge-no-delete',
		local: { 'a.md': '同' }, remote: { 'a.md': '同' },
		expect: { adoptable: ['a.md'] }
	},
	{
		name: '合并：无共同状态同名不同不自动选一方',
		rule: 'merge-no-delete',
		local: { 'a.md': '本地' }, remote: { 'a.md': '远端' },
		expect: { conflicts: [{ path: 'a.md', kind: 'no-baseline-differs' }] }
	},
	{
		name: '合并：双方都没有的文件不从历史恢复',
		rule: 'merge-no-delete',
		local: {}, remote: {},
		common: { 'gone.md': 'G' },
		expect: {}
	},

	// ===== 6. 双向同步、传播删除 =====
	{
		name: '传播删除：来源未改、另一端删除则传播删除',
		rule: 'two-way-delete',
		local: { 'a.md': 'A' }, remote: {},
		common: { 'a.md': 'A' },
		expect: { deleteLocal: ['a.md'] }
	},
	{
		name: '传播删除：另一端删除则传播到远端',
		rule: 'two-way-delete',
		local: {}, remote: { 'r.md': 'R' },
		common: { 'r.md': 'R' },
		expect: { deleteRemote: ['r.md'] }
	},
	{
		name: '传播删除：首次未知不误判删除，交用户决策',
		rule: 'two-way-delete',
		local: { 'a.md': 'A' }, remote: {},
		expect: { conflicts: [{ path: 'a.md', kind: 'no-baseline-differs' }] }
	},
	{
		name: '传播删除：删改冲突不自动选胜方',
		rule: 'two-way-delete',
		local: { 'a.md': '本地改' }, remote: {},
		common: { 'a.md': '原' },
		expect: { conflicts: [{ path: 'a.md', kind: 'modify-delete' }] }
	},
	{
		name: '传播删除：双方最终内容相同不产生假冲突',
		rule: 'two-way-delete',
		local: { 'a.md': '同' }, remote: { 'a.md': '同' },
		common: { 'a.md': '旧' },
		expect: {}
	},
	{
		name: '传播删除：一方新增文件同步到另一端',
		rule: 'two-way-delete',
		local: { 'new.md': 'N' }, remote: {},
		common: {},
		expect: { writeRemote: ['new.md'] }
	},
	{
		name: '传播删除：远端新增同步到本地',
		rule: 'two-way-delete',
		local: {}, remote: { 'r.md': 'R' },
		common: {},
		expect: { writeLocal: ['r.md'] }
	},
	{
		name: '传播删除：双方都删除时确认共同删除，不从历史恢复',
		rule: 'two-way-delete',
		local: {}, remote: {},
		common: { 'gone.md': 'G' },
		expect: {}
	}
];

describe('六类规则的计划生成', () => {
	it.each(cases.map(c => [c.name, c] as const))('%s', async (_name, testCase) => {
		const result = await runCase(testCase);
		const expected = testCase.expect;
		expect(result.writeRemote).toEqual(expected.writeRemote ?? []);
		expect(result.writeLocal).toEqual(expected.writeLocal ?? []);
		expect(result.deleteRemote).toEqual(expected.deleteRemote ?? []);
		expect(result.deleteLocal).toEqual(expected.deleteLocal ?? []);
		expect(result.conflicts).toEqual(expected.conflicts ?? []);
		if (expected.adoptable) {
			expect(result.plan.adoptable.map(a => a.path).sort()).toEqual(expected.adoptable);
		}
	});

	it('生成计划不写文件、不发布远端：读取器只被调用，不产生任何写操作', async () => {
		const local = { 'a.md': 'A' };
		const remote = { 'a.md': 'B' };
		const reader = makeReader(local, remote);
		const plan = await generatePlan({
			rule: 'update-one-way',
			direction: 'upload',
			identity: IDENTITY,
			remoteCommitSha: 'commit-1' as CommitSha,
			rulesFingerprint: 'rules-1',
			local: { state: shas(local), excluded: [], unreadable: [] },
			remote: { state: shas(remote), excluded: [], unreadable: [] },
			commonState: CommonState.create(IDENTITY),
			reader
		});
		expect(reader.read.mock.calls.length).toBeGreaterThan(0);
		expect(plan.conflicts).toHaveLength(1);
		// 双方内容都存在于内存对象中，且未被修改
		expect(local).toEqual({ 'a.md': 'A' });
		expect(remote).toEqual({ 'a.md': 'B' });
	});

	it('路径碰撞形成显式冲突并阻止乱序执行', async () => {
		const local = { 'notes': 'file-at-dir-path' };
		const remote = { 'notes/a.md': 'inside' };
		const plan = await generatePlan({
			rule: 'merge-no-delete',
			identity: IDENTITY,
			remoteCommitSha: 'commit-1' as CommitSha,
			rulesFingerprint: 'rules-1',
			local: { state: shas(local), excluded: [], unreadable: [] },
			remote: { state: shas(remote), excluded: [], unreadable: [] },
			commonState: CommonState.create(IDENTITY),
			reader: makeReader(local, remote)
		});
		expect(plan.conflicts.some(c => c.kind === 'path-collision')).toBe(true);
		// 被碰撞阻塞的路径不得留在操作清单里
		for (const op of plan.operations) {
			expect(op.path === 'notes' || op.path.startsWith('notes/')).toBe(false);
		}
	});

	it('读取失败不排写删，列入未确认项', async () => {
		const local = { 'a.md': 'A' };
		const remote = { 'a.md': 'B' };
		const localTable: Record<string, string> = local;
		const reader = {
			read: vi.fn(async (side: 'local' | 'remote', path: string) => {
				if (side === 'remote') throw new Error('network down');
				return { digest: await digestOf(localTable[path]), binary: false, size: localTable[path].length };
			})
		};
		const plan = await generatePlan({
			rule: 'two-way-delete',
			identity: IDENTITY,
			remoteCommitSha: 'commit-1' as CommitSha,
			rulesFingerprint: 'rules-1',
			local: { state: shas(local), excluded: [], unreadable: [] },
			remote: { state: shas(remote), excluded: [], unreadable: [] },
			commonState: CommonState.create(IDENTITY),
			reader
		});
		expect(plan.operations).toHaveLength(0);
		expect(plan.unreadable.length).toBeGreaterThan(0);
	});

	it('二进制内容不同也形成冲突，不当作文本合并', async () => {
		const local = { 'img.png': '\u0000BIN\u0000local' };
		const remote = { 'img.png': '\u0000BIN\u0000remote' };
		const plan = await generatePlan({
			rule: 'two-way-delete',
			identity: IDENTITY,
			remoteCommitSha: 'commit-1' as CommitSha,
			rulesFingerprint: 'rules-1',
			local: { state: shas(local), excluded: [], unreadable: [] },
			remote: { state: shas(remote), excluded: [], unreadable: [] },
			commonState: CommonState.create(IDENTITY),
			reader: makeReader(local, remote)
		});
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0].binary).toBe(true);
	});
});
