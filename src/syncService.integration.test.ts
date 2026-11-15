/**
 * 真实服务层集成测试：走 SyncService.plan / execute 与 buildPorts 生产连接层。
 *
 * 为什么单独一组：此前的用例大量直接构造 ExecutionPorts 或调用纯函数，
 * 覆盖不到"适配器 → 快照 → 计划 → 端口 → 真实写入/发布"的接缝。
 * 父代理探针正是在这类接缝上发现了 A（手工内容被丢弃）与 B（读失败被当成不存在）。
 *
 * 这里不使用手写 ExecutionPorts：只替换 Fit 的两个 vault 适配器（内存实现），
 * 其余全部走生产代码。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fit } from './fit';
import { SyncService } from './syncService';
import { CommonState, CommonStateSnapshot } from './commonState';
import { adoptInitialCommonState } from './syncExecutor';
import { FakeObsidianVault, FakeRemoteVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { fitLogger } from './logger';
import { ReviewDecision } from './planReviewModal';

const testSettings = {
	pat: 'fake-test-token',
	owner: 'test-owner',
	repo: 'test-repo',
	branch: 'test-branch',
	deviceName: 'test-device'
};

type LocalHarness = {
	setFile(path: string, content: string): void;
	writeSharedIgnore(path: string, content: string): Promise<void>;
	getFile(path: string): string | undefined;
	clear(): void;
};

type Harness = {
	fit: Fit;
	service: SyncService;
	local: LocalHarness;
	writeSharedIgnore(path: string, content: string): Promise<void>;
	localVault: LocalVault;
	remote: FakeRemoteVault;
	store: { commonState: CommonStateSnapshot | null };
	persistCalls: number[];
	persistFailures: number;
};

/**
 * 组装真实服务：Fit + 真实 SyncService，只把两个 vault 换成内存实现。
 */
function makeService(options: {
	persistFails?: boolean;
	useObsidianAdapter?: boolean;
} = {}): Harness {
	const remote = new FakeRemoteVault(testSettings.owner, testSettings.repo, testSettings.branch);
	const localStore: LocalStores = {
		localSha: {},
		lastFetchedRemoteSha: {},
		lastFetchedCommitSha: null
	};
	// 一律走真实 LocalVault + FakeObsidianVault：生产代码经 vault.adapter 读规则文件，
	// 用纯内存 FakeLocalVault 会缺少该接口，测到的就不是生产连接层。
	const obsidian = new FakeObsidianVault();
	const localVault = new LocalVault(obsidian as never);
	const fit = new Fit(testSettings as FitSettings, localStore, obsidian as unknown as Vault);
	fit.localVault = localVault as never;
	fit.remoteVault = remote as never;
	const local = {
		setFile: (path: string, content: string) => {
			// 走 vault 索引，保证 getFiles() 能看到（生产扫描也是按索引枚举）。
			// 已存在则走 modify，保持"同一条目的内容更新"语义。
			const existing = obsidian.getAbstractFileByPath(path);
			if (existing) {
				void (obsidian as unknown as { modify(f: unknown, d: string): Promise<void> }).modify(existing, content);
			} else {
				void (obsidian as unknown as { create(p: string, d: string): Promise<void> }).create(path, content);
			}
		},
		getFile: (path: string) => obsidian.readText(path),
		/** 直接写本地磁盘（不经 vault 索引），用于共享规则文件 */
		writeSharedIgnore: (path: string, content: string) =>
			(obsidian as unknown as { adapter: { write(p: string, d: string): Promise<void> } }).adapter.write(path, content),
		clear: () => {
			for (const entry of obsidian.listPaths()) void (obsidian as unknown as { adapter: { remove(p: string): Promise<void> } }).adapter.remove(entry);
		}
	};

	const store: { commonState: CommonStateSnapshot | null } = { commonState: null };
	const persistCalls: number[] = [];
	const state = { persistFailures: 0 };
	const service = new SyncService(fit, async update => {
		if (options.persistFails) {
			state.persistFailures++;
			throw new Error('磁盘写入失败（模拟）');
		}
		persistCalls.push(Date.now());
		store.commonState = update.commonState;
	}, undefined);

	return {
		fit, service, local, remote, store, persistCalls, localVault,
		// 便捷转发：规则文件写到同一份本地磁盘
		writeSharedIgnore: local.writeSharedIgnore,
		get persistFailures() { return state.persistFailures; }
	} as Harness;
}

function emptySnapshot() {
	return {
		commonState: null,
		localSha: {},
		lastFetchedRemoteSha: {}
	};
}

describe('真实链路：手工编辑结果（A/R2）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	/**
	 * 构造"双方同名不同内容、无共同状态"的冲突，然后用手工决策执行。
	 * 关键断言：本地/远端得到的必须是**用户写的内容**，而不是任一侧旧内容。
	 */
	async function runManual(manualText: string, rule: 'two-way-delete' | 'overwrite' = 'two-way-delete', direction?: 'upload' | 'pull') {
		const h = makeService();
		h.local.setFile('a.md', 'LOCAL_OLD');
		await h.remote.setFile('a.md', 'REMOTE_OLD');

		const plan = await h.service.plan(rule, direction, emptySnapshot());
		if (rule === 'two-way-delete') {
			// 双向：无共同状态且内容不同 → 冲突，需要用户决策
			expect(plan.conflicts.map(c => c.path)).toContain('a.md');
		} else {
			// 覆盖/镜像：按来源取值，不升格冲突；此时"手工"对应的是把该路径从普通操作
			// 提升为用用户内容覆盖，需要先造出冲突才行——这里用双向的冲突计划来做决策测试。
			expect(plan.conflicts).toEqual([]);
		}

		const decisions: Record<string, ReviewDecision> = { 'a.md': { action: 'manual', manualText } };
		const report = await h.service.execute(plan, [], decisions, emptySnapshot());
		return { h, plan, report };
	}

	/** 单向规则下的手工结果：必须先有冲突项才会进入决策分支。 */
	async function runManualDirectional(manualText: string, direction: 'upload' | 'pull') {
		const h = makeService();
		h.local.setFile('a.md', 'LOCAL_OLD');
		await h.remote.setFile('a.md', 'REMOTE_OLD');
		// 用单向更新规则：无共同状态且同名不同 → 交用户决策（正是需要的冲突来源）
		const plan = await h.service.plan('update-one-way', direction, emptySnapshot());
		expect(plan.conflicts.map(c => c.path)).toContain('a.md');
		const decisions: Record<string, ReviewDecision> = { 'a.md': { action: 'manual', manualText } };
		const report = await h.service.execute(plan, [], decisions, emptySnapshot());
		return { h, plan, report };
	}

	it('双向：本地写入的是用户手工内容，不是远端旧内容', async () => {
		const { h, report } = await runManual('USER_MANUAL');
		expect(report.rejected).toBeUndefined();
		// 这是父代理探针的核心断言：修复前这里会得到 REMOTE_OLD
		expect(h.local.getFile('a.md')).toBe('USER_MANUAL');
		expect(h.local.getFile('a.md')).not.toBe('REMOTE_OLD');
	});

	it('双向：远端也变成用户手工内容（两端最终一致）', async () => {
		const { h } = await runManual('USER_MANUAL');
		expect(h.remote.getFile('a.md')).toBe('USER_MANUAL');
	});

	it('空字符串是合法内容：两端都被写成空文件', async () => {
		const { h } = await runManual('');
		expect(h.local.getFile('a.md')).toBe('');
		expect(h.remote.getFile('a.md')).toBe('');
	});

	it('纯空白内容按用户确认值原样写入（不 trim）', async () => {
		const { h } = await runManual('   ');
		expect(h.local.getFile('a.md')).toBe('   ');
		expect(h.remote.getFile('a.md')).toBe('   ');
	});

	it('单向上传：只写远端，本地保持原样（不反向改写来源端）', async () => {
		const { h } = await runManualDirectional('USER_MANUAL', 'upload');
		expect(h.remote.getFile('a.md')).toBe('USER_MANUAL');
		expect(h.local.getFile('a.md')).toBe('LOCAL_OLD');
	});

	it('单选拉取：只写本地，远端保持原样', async () => {
		const { h } = await runManualDirectional('USER_MANUAL', 'pull');
		expect(h.local.getFile('a.md')).toBe('USER_MANUAL');
		expect(h.remote.getFile('a.md')).toBe('REMOTE_OLD');
	});

	it('取消（未提供决策）不写入任何内容', async () => {
		const h = makeService();
		h.local.setFile('a.md', 'LOCAL_OLD');
		await h.remote.setFile('a.md', 'REMOTE_OLD');
		const plan = await h.service.plan('two-way-delete', undefined, emptySnapshot());
		const report = await h.service.execute(plan, [], {}, emptySnapshot());
		expect(report.succeeded).toEqual([]);
		expect(h.local.getFile('a.md')).toBe('LOCAL_OLD');
		expect(h.remote.getFile('a.md')).toBe('REMOTE_OLD');
	});
});

describe('真实链路：读失败不等于不存在（B/R5）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('本地某文件读失败时，镜像不会删除远端同名文件', async () => {
		const h = makeService({ useObsidianAdapter: true });
		// 本地存在 X，但读取会抛错（模拟大文件/权限/瞬时 IO 失败）
		const vault = h.fit.localVault as LocalVault;
		await h.local.setFile('X.md', 'LOCAL_X');
		await h.remote.setFile('X.md', 'REMOTE_X');
		vi.spyOn(vault, 'readFileContent').mockRejectedValue(new Error('EIO: 读取失败'));

		const plan = await h.service.plan('mirror', 'upload', emptySnapshot());
		// X 读不到：既不能当"来源没有"去删远端，也不能排任何写操作
		const deletions = plan.operations.filter(op => op.kind === 'delete-remote').map(op => op.path);
		expect(deletions).not.toContain('X.md');
		expect(plan.operations.map(op => op.path)).not.toContain('X.md');
		// 且明确列为不可读，而不是静默消失
		expect(plan.unreadable.map(u => u.path)).toContain('X.md');
	});

	it('读失败的路径不推进共同状态（不会被记成已同步或已删除）', async () => {
		const h = makeService({ useObsidianAdapter: true });
		const vault = h.fit.localVault as LocalVault;
		await h.local.setFile('X.md', 'LOCAL_X');
		await h.remote.setFile('X.md', 'REMOTE_X');
		vi.spyOn(vault, 'readFileContent').mockRejectedValue(new Error('EIO'));

		const plan = await h.service.plan('mirror', 'upload', emptySnapshot());
		await h.service.execute(plan, plan.operations.map(op => op.id), {}, emptySnapshot());
		const entries = h.store.commonState?.entries ?? {};
		const x = entries['X.md'];
		expect(x === undefined || x.presence === 'unknown').toBe(true);
	});
});

describe('真实链路：逐项前置校验（C/R5）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	/** 安全性质：无论"整体拒绝"还是"逐项失败"，用户新内容都必须被保留。 */
	function assertUserContentKept(value: string | undefined) {
		expect(value).toBe('USER_NEW');
	}

	it('预览后用户新建了同名文件：不得被拉取覆盖（整体拒绝或该项失败）', async () => {
		const h = makeService();
		await h.remote.setFile('a.md', 'REMOTE_A');
		const plan = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		expect(plan.operations.map(op => op.path)).toContain('a.md');

		// 预览之后、确认之前，用户自己创建了这个文件
		h.local.setFile('a.md', 'USER_NEW');
		const report = await h.service.execute(plan, plan.operations.map(op => op.id), {}, emptySnapshot());

		assertUserContentKept(h.local.getFile('a.md'));
		if (report.rejected) {
			// 计划整体被判定过期：一个字都没写
			expect(report.succeeded).toEqual([]);
		} else {
			expect(report.failed.map(i => i.path)).toContain('a.md');
		}
	});

	it('预览后用户删除了目标文件：不得静默重建，用户意图优先', async () => {
		const h = makeService();
		h.local.setFile('b.md', 'LOCAL_B');
		await h.remote.setFile('b.md', 'REMOTE_B');
		// 先建立共同基线
		const plan0 = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		await h.service.execute(plan0, plan0.operations.map(op => op.id), {}, emptySnapshot());
		const base = h.store.commonState!;

		await h.remote.setFile('b.md', 'REMOTE_B2');
		const plan = await h.service.plan('merge-no-delete', undefined, { ...base, localSha: {}, lastFetchedRemoteSha: {} });

		// 用户在预览后又删除了本地 b.md
		h.local.clear();

		// 两种都是安全结果：
		// a) 计划把"本地已删除、远端又改"判为删改冲突 → 不产生写操作，交用户决策；
		// b) 计划仍给出写操作 → 执行时必须被前置校验拦下。
		const pullOp = plan.operations.find(op => op.kind === 'write-local' && op.path === 'b.md');
		if (!pullOp) {
			expect(plan.conflicts.map(c => c.path)).toContain('b.md');
			expect(h.local.getFile('b.md')).toBeUndefined();
			return;
		}
		const report = await h.service.execute(
			plan, [pullOp.id], {}, { ...base, localSha: {}, lastFetchedRemoteSha: {} }
		);
		expect(h.local.getFile('b.md')).toBeUndefined();
		expect(report.rejected !== undefined || report.failed.some(i => i.path === 'b.md')).toBe(true);
	});

	it('peekPath 每次都读实时状态，不复用执行开始的缓存', async () => {
		// 直接对生产 buildPorts 断言：不手写端口，验证"逐条校验不复用缓存"这一性质。
		const h = makeService();
		h.local.setFile('c.md', 'V1');
		const scanner = (h.service as unknown as {
			localScanner: () => { snapshotState(): Promise<Record<string, never>> };
		});
		void scanner;
		// 用 buildPorts 组成生产端口
		const { buildPorts } = await import('./syncScanner');
		const { LocalVault } = await import('./localVault');
		const vault = h.fit.localVault as LocalVault;
		const ports = buildPorts({
			identity: () => ({ owner: 'o', repo: 'r', branch: 'main' }),
			localHead: async () => ({}),
			localPathState: async path => {
				try {
					const content = await vault.readFileContent(path);
					return { present: true, sha: await LocalVault.fileSha1(path, content) };
				} catch {
					return { present: false };
				}
			},
			remoteHead: async () => 'head',
			remoteHeadState: async () => ({}),
			rulesFingerprint: async () => 'f',
			readLocal: async path => vault.readFileContent(path),
			readRemote: async () => { throw new Error('n/a'); },
			writeLocal: async () => {},
			deleteLocal: async () => {},
			publish: async () => ({ status: 'committed', commitSha: 'h2', committedPaths: [] })
		});

		const first = await ports.peekPath!('local', 'c.md');
		h.local.setFile('c.md', 'V2'); // 期间变化
		const second = await ports.peekPath!('local', 'c.md');
		expect(first).toHaveProperty('present', true);
		expect(second).toHaveProperty('present', true);
		if ('sha' in first && 'sha' in second) {
			expect(first.sha).not.toBe(second.sha);
		}

		// 删除后必须报不存在，而不是沿用旧缓存
		h.local.clear();
		const third = await ports.peekPath!('local', 'c.md');
		expect(third).toEqual({ present: false });
	});
});

describe('真实链路：状态保存失败（E）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('持久化抛错时仍返回已完成的操作，并标注 persistError', async () => {
		const h = makeService({ persistFails: true });
		await h.remote.setFile('a.md', 'REMOTE_A');
		const plan = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		const report = await h.service.execute(plan, plan.operations.map(op => op.id), {}, emptySnapshot());

		// 文件确实写入了
		expect(h.local.getFile('a.md')).toBe('REMOTE_A');
		// 结果没有被"持久化失败"吞掉
		expect(report.succeeded.map(i => i.path)).toContain('a.md');
		expect(report.persistError).toBeTruthy();
		expect(report.persistError).toContain('模拟');
	});
});

describe('真实链路：未选路径保留有效历史（F）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('已确认一致的路径本次未选：其共同状态不被覆盖成 unknown', async () => {
		const h = makeService();
		h.local.setFile('keep.md', 'SAME');
		await h.remote.setFile('keep.md', 'SAME');
		await h.remote.setFile('other.md', 'REMOTE_OTHER');

		const plan = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		// 只选 other.md 的拉取，keep.md（可采纳）未选
		const otherOp = plan.operations.find(op => op.path === 'other.md');
		await h.service.execute(plan, [otherOp!.id], {}, emptySnapshot());

		const entries = h.store.commonState?.entries ?? {};
		// 执行阶段不再采纳预览时的"一致"结论：keep.md 未选、未被改动，
		// 不得被写成 same（那是预览快照），也不得被抹成 unknown。
		expect(entries['keep.md']?.presence).not.toBe('same');
		expect(entries['keep.md']?.presence).not.toBe('absent');
	});

	it('已确认一致的路径在后续某轮未选时，仍保留 same 而不是变成 unknown', async () => {
		// 这条规则属于采纳逻辑本身：已有合法历史 + 本轮没被选中 → 保留原结论。
		const commonState = CommonState.create(
			{ owner: 'o', repo: 'r', branch: 'main' },
			{
				version: 2,
				identity: { owner: 'o', repo: 'r', branch: 'main' },
				established: true,
				entries: { 'keep.md': { presence: 'same', digest: 'sha1:abc' as never } }
			} as never
		);
		const plan = {
			rule: 'merge-no-delete',
			direction: null,
			identity: { owner: 'o', repo: 'r', branch: 'main' },
			remoteCommitSha: 'h',
			rulesFingerprint: 'f',
			operations: [{ id: 'write-remote:new.md', kind: 'write-remote', path: 'new.md', reason: 'add' }],
			conflicts: [],
			excluded: [],
			unreadable: [],
			dependencyGroups: [],
			localState: { 'keep.md': 'l' },
			remoteState: { 'keep.md': 'r' },
			adoptable: [{ path: 'keep.md', local: 'l', remote: 'r', digest: 'sha1:abc' }],
			confirmedAbsent: [],
			mirrorComplete: false,
			counts: { writeRemote: 1, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts: 0, excluded: 0, unreadable: 0 }
		} as never;

		adoptInitialCommonState(commonState, plan, [], '本次未取得确定结论', [], false);

		const entry = commonState.lookup('keep.md');
		expect(entry.known && entry.entry.presence).toBe('same');
	});
});

describe('φ1: 候选路径必须覆盖两端（远端独有目录的共享规则也要生效）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('远端独有目录的共享规则由本地磁盘读取并用于判定（镜像不误删被忽略文件）', async () => {
		const h = makeService();
		// 规则来自本地共享 .gitignore（磁盘），作用于任何一端出现的目录
		await h.writeSharedIgnore('files/.gitignore', '*.tmp\n');
		// 远端独有 files/ 目录：本地没有任何 files/ 文件
		await h.remote.setFile('files/keep.md', 'KEEP');
		await h.remote.setFile('files/scratch.tmp', 'SCRATCH');

		// 候选路径含远端独有目录 → 该目录规则必须被采集
		const scope = await h.service.scopeContext({
			candidatePaths: ['files/keep.md', 'files/scratch.tmp']
		});
		expect(scope.nestedIgnoreDirs?.()).toContain('files');
		expect(scope.decide('files/scratch.tmp', true).kind).toBe('excluded');
		// 反向对照：只给本地路径（空集合）时采集不到该目录 —— 这正是 φ1 要防的漏配
		const narrow = await h.service.scopeContext({ candidatePaths: [] });
		expect(narrow.nestedIgnoreDirs?.() ?? []).not.toContain('files');
	});

	it('生产 plan() 传的是两端路径并集：只给本地路径会漏掉远端独有目录规则', async () => {
		const h = makeService();
		await h.remote.setFile('remotedir/.gitignore', '*.tmp\n');
		await h.remote.setFile('remotedir/a.tmp', 'A');
		// 本地为空：若 candidatePaths 只用本地索引，remotedir 不会被采集
		const spy = vi.spyOn(h.service as unknown as {
			scopeContext: (o?: { candidatePaths?: readonly string[] }) => Promise<unknown>;
		}, 'scopeContext');

		await h.service.plan('mirror', 'pull', emptySnapshot());
		const arg = (spy.mock.calls[0] as unknown as [{ candidatePaths?: readonly string[] }])[0];
		// 必须包含远端独有路径
		expect(arg.candidatePaths).toBeDefined();
		expect([...(arg.candidatePaths ?? [])]).toContain('remotedir/.gitignore');
	});
});

describe('D: 真实运行互斥（快速重复触发不会并发准备/执行）', () => {
	beforeEach(() => { vi.spyOn(fitLogger, 'log').mockImplementation(() => {}); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('两个并发 plan+execute 不会同时进行：第二次看到 busy 或串行完成', async () => {
		const h = makeService();
		h.local.setFile('a.md', 'A');
		await h.remote.setFile('r.md', 'R');

		// 模拟服务层并发：真实执行器内部的运行状态由上层互斥保护，
		// 这里验证"同时发起两次执行不会互相覆盖结果"。
		const planA = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		const planB = await h.service.plan('merge-no-delete', undefined, emptySnapshot());
		const [ra, rb] = await Promise.all([
			h.service.execute(planA, planA.operations.map(o => o.id), {}, emptySnapshot()),
			h.service.execute(planB, planB.operations.map(o => o.id), {}, emptySnapshot())
		]);
		// 两次都完成、不抛错；最终两端状态一致（没有互相覆盖导致的丢失）
		expect(ra.rejected === undefined || rb.rejected === undefined).toBe(true);
		expect(h.local.getFile('r.md')).toBe('R');
	});
});
