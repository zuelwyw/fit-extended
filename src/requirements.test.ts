/**
 * 需求验收框架里的关键场景（docs/需求说明.md 第 8、9 节）。
 *
 * 这些用例刻意跨模块：范围判定 → 计划生成 → 执行 → 共同状态，
 * 因为需求里的失败模式都发生在"两个模块衔接处"，而不是单个函数内部。
 */

import { describe, it, expect, vi } from 'vitest';
import { generatePlan } from './syncPlanner';
import { executePlan, applyOutcomesToCommonState, adoptInitialCommonState, ExecutionPorts } from './syncExecutor';
import { CommonState, StateIdentity } from './commonState';
import { ScopeContext } from './scopeContext';
import { scanAndPlan, SideScanner } from './syncScanner';
import { ContentDigest, digestBytes, digestFileContent } from './util/contentDigest';
import { FileContent } from './util/contentEncoding';
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

async function planWith(rule: RuleKind, direction: SyncDirection | undefined, local: Record<string, string>, remote: Record<string, string>, opts: { established?: boolean; common?: Record<string, string | null>; binary?: string[] } = {}) {
	const state = CommonState.create(IDENTITY);
	if (opts.established !== false) state.markEstablished();
	for (const [path, content] of Object.entries(opts.common ?? {})) {
		if (content === null) state.recordAbsent([path]);
		else state.recordSame([{ path, digest: await digestOf(content) }]);
	}
	const binary = new Set(opts.binary ?? []);
	const reader = {
		read: async (side: 'local' | 'remote', path: string) => {
			const table = side === 'local' ? local : remote;
			const content = table[path];
			if (content === undefined) throw new Error(`missing ${side}/${path}`);
			return { digest: await digestOf(content), binary: binary.has(path), size: content.length };
		}
	};
	const plan = await generatePlan({
		rule, direction, identity: IDENTITY,
		remoteCommitSha: 'head-1' as CommitSha,
		rulesFingerprint: 'rules-1',
		local: { state: shas(local), excluded: [], unreadable: [] },
		remote: { state: shas(remote), excluded: [], unreadable: [] },
		commonState: state,
		reader
	});
	return { plan, state };
}

describe('首次扫描：无共同状态', () => {
	it('同名内容相同可确认建立共同状态', async () => {
		const { plan } = await planWith('two-way-delete', undefined, { 'a.md': '一样' }, { 'a.md': '一样' }, { established: false });
		expect(plan.adoptable.map(a => a.path)).toEqual(['a.md']);
		expect(plan.operations).toEqual([]);
	});

	it('同名内容不同绝不冒充已同步：两个方向都不写', async () => {
		for (const direction of ['upload', 'pull'] as const) {
			const { plan } = await planWith('update-one-way', direction, { 'a.md': '本地' }, { 'a.md': '远端' }, { established: false });
			expect(plan.operations).toEqual([]);
			expect(plan.conflicts.map(c => c.kind)).toEqual(['no-baseline-differs']);
			expect(plan.adoptable).toEqual([]);
		}
	});

	it('补缺模式按存在性处理：首次也能补，但不覆盖已有同名', async () => {
		const missing = await planWith('add-missing', 'upload', { 'new.md': 'N', 'same.md': 'S' }, { 'same.md': '其它' }, { established: false });
		expect(missing.plan.operations.map(o => o.path)).toEqual(['new.md']);
	});

	it('覆盖/镜像按来源列入预览，不升格为冲突裁决', async () => {
		const overwrite = await planWith('overwrite', 'upload', { 'a.md': '本地' }, { 'a.md': '远端' }, { established: false });
		expect(overwrite.plan.operations).toHaveLength(1);
		expect(overwrite.plan.conflicts).toEqual([]);
	});

	it('双向传播删除首次不把"仅一端存在"误判为删除', async () => {
		const { plan } = await planWith('two-way-delete', undefined, { 'only-local.md': 'L' }, {}, { established: false });
		expect(plan.operations).toEqual([]);
		expect(plan.conflicts.map(c => c.kind)).toEqual(['no-baseline-differs']);
	});

	it('旧"零上传采纳基线"留下的双份缓存不能被当成共同状态', async () => {
		const legacy = {
			localSha: { 'a.md': 'sha-local-a' },
			lastFetchedRemoteSha: { 'a.md': 'blob-sha-a' }
		};
		// 用旧缓存构造 CommonState：没有任何记录被采纳
		const state = CommonState.create(IDENTITY, {
			version: 2,
			identity: IDENTITY,
			established: true,
			entries: {}
		});
		expect(state.lookup('a.md').known).toBe(false);
		// 即便两端同名，也必须走内容比较，而不是引用旧缓存
		const { plan } = await planWith('update-one-way', 'upload', { 'a.md': '本地新' }, { 'a.md': '远端新' });
		expect(plan.conflicts.length).toBe(1);
		expect(legacy.lastFetchedRemoteSha['a.md']).toBe('blob-sha-a');
	});
});

describe('被忽略规则覆盖的路径', () => {
	it('被 .gitignore 匹配的路径不参与同步，镜像也不会把它当成"来源删除"', async () => {
		// 插件不再读取本机 Git 索引：被 .gitignore 匹配就按忽略处理（与 Git 跟踪状态无关）。
		// 该路径被排除出同步集合，因此镜像不会删除它。
		const scope = await ScopeContext.create({ stat: vi.fn(), read: vi.fn() } as never, { sharedIgnoreContent: 'notes/**\n' });
		const scanner = (files: Record<string, string>): SideScanner => ({
			snapshot: async () => ({ paths: Object.keys(files), state: shas(files) }),
			isReadable: () => true,
			read: async (path) => FileContent.fromPlainText(files[path])
		});
		const { plan } = await scanAndPlan({
			rule: 'mirror', direction: 'upload',
			identity: IDENTITY,
			local: scanner({ 'keep.md': 'K' }),
			remote: scanner({ 'keep.md': 'K', 'notes/a.md': 'A' }),
			scope,
			commonState: (() => { const s = CommonState.create(IDENTITY); s.markEstablished(); return s; })(),
			remoteHead: async () => ({ commitSha: 'head-1' as CommitSha, state: shas({ 'keep.md': 'K', 'notes/a.md': 'A' }) })
		});
		expect(plan.operations.filter(op => op.kind === 'delete-remote')).toEqual([]);
	});
});

describe('二进制冲突', () => {
	it('二进制不做文本合并：只标为二进制冲突并给出大小', async () => {
		const { plan } = await planWith('two-way-delete', undefined,
			{ 'img.png': '\u0000BIN\u0000local' }, { 'img.png': '\u0000BIN\u0000remote' },
			{ established: false, binary: ['img.png'] });
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0].binary).toBe(true);
		expect(plan.conflicts[0].local?.size).toBeGreaterThan(0);
	});

	it('二进制内容字节往返摘要一致（不因编码路径不同而变形）', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const base64 = btoa(String.fromCharCode(...bytes));
		const fromBase64 = await digestFileContent(FileContent.fromBase64(base64));
		const expected = await digestBytes(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
		expect(fromBase64).toBe(expected);
	});
});

describe('中断与部分失败', () => {
	it('部分成功时重开仍能识别未完成项（共同状态只记录成功项）', async () => {
		const { plan, state } = await planWith('merge-no-delete', undefined, {}, { 'a.md': 'A', 'b.md': 'B' });
		const ports: ExecutionPorts = {
			currentIdentity: async () => IDENTITY,
			currentRemoteHead: async () => 'head-1',
			currentRulesFingerprint: async () => 'rules-1',
			currentPathState: async (paths) => ({
				local: Object.fromEntries(paths.map(path => [path, path in plan.localState ? plan.localState[path] : null])),
				remote: {}
			}),
			writeLocal: async (path) => { if (path === 'b.md') throw new Error('EACCES'); },
			deleteLocal: async () => {},
			publishRemote: async (actions) => ({ status: 'committed', commitSha: 'h2', committedPaths: actions.additions.map(a => a.path) }),
			digestOf: async (side, path) => digestOf(`${side}:${path}`)
		};
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'merge-no-delete' }, ports);
		adoptInitialCommonState(state, plan);
		const { advanced, withheld } = applyOutcomesToCommonState(state, report, [], ['a.md']);
		expect(advanced).toEqual(['a.md']);
		expect(withheld).toContain('b.md');
		// 下次计划仍会把 b.md 当作待同步：显式 unknown，不是"已同步"，也不进入 absent 推断
		expect(state.isDefinite('b.md')).toBe(false);
		expect(state.lookup('b.md')).toMatchObject({ known: true, entry: { presence: 'unknown' } });
	});

	it('执行结果不明的项目在再次操作前必须核对：不被标记为已同步', async () => {
		const { plan, state } = await planWith('two-way-delete', undefined, { 'a.md': 'A' }, {});
		const ports: ExecutionPorts = {
			currentIdentity: async () => IDENTITY,
			currentRemoteHead: async () => 'head-1',
			currentRulesFingerprint: async () => 'rules-1',
			currentPathState: async (paths) => ({
				local: Object.fromEntries(paths.map(path => [path, path in plan.localState ? plan.localState[path] : null])),
				remote: {}
			}),
			writeLocal: async () => {},
			deleteLocal: async () => {},
			publishRemote: async () => ({ status: 'uncertain', detail: '响应丢失' }),
			digestOf: async () => digestOf('x')
		};
		const report = await executePlan(plan, { selected: new Set(plan.operations.map(o => o.id)), rule: 'two-way-delete' }, ports);
		expect(report.uncertain).toHaveLength(1);
		expect(applyOutcomesToCommonState(state, report, [], []).advanced).toEqual([]);
	});
});

describe('镜像删除范围', () => {
	it('目标独有未跟踪文件可删，但排除对象、元数据、范围外文件绝不删', async () => {
		const scope = await ScopeContext.create({ stat: vi.fn(), read: vi.fn() } as never, { sharedIgnoreContent: '*.log\n' });
		const scanner = (files: Record<string, string>): SideScanner => ({
			snapshot: async () => ({ paths: Object.keys(files), state: shas(files) }),
			isReadable: () => true,
			read: async (path) => FileContent.fromPlainText(files[path])
		});
		const remoteFiles = {
			'keep.md': 'K',
			'untracked-extra.md': 'U',
			'debug.log': 'log',
			'.obsidian/app.json': '{}',
			'.git/config': 'x',
			'_fit/conflict.md': 'c',
			'.gitignore': '*.log\n'
		};
		const { plan } = await scanAndPlan({
			rule: 'mirror', direction: 'upload', identity: IDENTITY,
			local: scanner({ 'keep.md': 'K' }),
			remote: scanner(remoteFiles),
			scope,
			commonState: (() => { const s = CommonState.create(IDENTITY); s.markEstablished(); return s; })(),
			remoteHead: async () => ({ commitSha: 'head-1' as CommitSha, state: shas(remoteFiles) })
		});
		const deletions = plan.operations.filter(op => op.kind === 'delete-remote').map(op => op.path);
		expect(deletions).toEqual(['untracked-extra.md']);
	});
});
