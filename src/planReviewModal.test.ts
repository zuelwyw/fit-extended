/**
 * 审阅弹窗的真实渲染回归。
 *
 * 为什么需要这组测试：此前计划审阅弹窗从未在任何测试里被实例化
 * （测试桩连 Modal 都没有），因此"渲染到一半抛错、界面只剩一个单选框"
 * 这种缺陷可以带着 474 项全绿通过。
 *
 * 这里直接断言 DOM：选项文字、冲突条目数、操作按钮、就绪门槛、手工框显隐。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanReviewModal } from './planReviewModal';
import { Conflict, SyncPlan } from './syncTypes';

function conflict(path: string, index: number): Conflict {
	return {
		path,
		kind: 'no-baseline-differs',
		local: { present: true, size: 100 + index, digest: `d-local-${index}` as never, binary: false },
		remote: { present: true, size: 200 + index, digest: `d-remote-${index}` as never, binary: false },
		binary: false,
		detail: '没有共同状态且双方内容不同'
	};
}

function planWith(conflicts: Conflict[]): SyncPlan {
	return {
		rule: 'two-way-delete',
		direction: null,
		identity: { owner: 'o', repo: 'r', branch: 'main' },
		remoteCommitSha: 'head' as never,
		rulesFingerprint: 'fp',
		operations: [],
		conflicts,
		excluded: [],
		unreadable: [],
		dependencyGroups: [],
		localState: {},
		remoteState: {},
		adoptable: [],
		confirmedAbsent: [],
		mirrorComplete: false,
		counts: {
			writeRemote: 0, writeLocal: 0, deleteRemote: 0, deleteLocal: 0,
			conflicts: conflicts.length, excluded: 0, unreadable: 0
		}
	} as unknown as SyncPlan;
}

function planWithOperations(): SyncPlan {
	return {
		...planWith([]),
		operations: [{ id: 'write-remote:a.md', kind: 'write-remote', path: 'a.md', reason: 'update' }],
		counts: { writeRemote: 1, writeLocal: 0, deleteRemote: 0, deleteLocal: 0, conflicts: 0, excluded: 0, unreadable: 0 }
	} as unknown as SyncPlan;
}

function openModal(plan: SyncPlan, loader?: (path: string) => Promise<{ local?: string; remote?: string }>) {
	const modal = new PlanReviewModal({} as never, plan, loader);
	(modal as unknown as { open(): void }).open();
	return modal;
}

describe('审阅弹窗渲染', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('每个冲突都渲染出三个带文字的决策选项（不是只有圆点）', () => {
		const modal = openModal(planWith([conflict('a.md', 1)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const labels = Array.from(content.querySelectorAll('.fit-operation-choice .fit-operation-choice-label'))
			.map(el => el.textContent?.trim());
		expect(labels).toEqual(['采用本地版本', '采用远端版本', '手工编辑结果']);
	});

	it('多个冲突全部渲染，不会被前一个的渲染异常吞掉', () => {
		const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
		const modal = openModal(planWith(paths.map(conflict)));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		expect(content.querySelectorAll('.fit-operation-conflict-item')).toHaveLength(5);
		// 每个冲突都要有自己的三行选项：5 × 3
		expect(content.querySelectorAll('.fit-operation-choice .fit-operation-choice-label')).toHaveLength(15);
		expect(content.querySelectorAll('textarea.fit-conflict-draft')).toHaveLength(5);
	});

	it('展示两侧大小，让用户有判断依据', () => {
		const modal = openModal(planWith([conflict('a.md', 1)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		const text = content.textContent ?? '';
		expect(text).toContain('本地：存在');
		expect(text).toContain('远端：存在');
		expect(text).toMatch(/\d+(\.\d+)?\s?(B|KB|MB)/);
	});

	it('底部操作按钮始终存在，且未决冲突时“执行所选”是禁用的', () => {
		const modal = openModal(planWith([conflict('a.md', 1)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const bar = content.querySelector('.fit-operation-actions');
		expect(bar).not.toBeNull();
		const buttons = Array.from(content.querySelectorAll('.fit-operation-actions button')).map(b => b.textContent);
		expect(buttons).toContain('执行所选');
		// 该用例只有冲突、没有文件操作：勾选类按钮不应出现
		expect(buttons).not.toContain('勾选全部文件操作');
		expect(buttons).toContain('冲突全部采用本地');
		expect(buttons).toContain('冲突全部采用远端');

		const confirm = Array.from(content.querySelectorAll('.fit-operation-actions button'))
			.find(b => b.textContent === '执行所选') as HTMLButtonElement;
		expect(confirm.disabled).toBe(true);
	});

	it('给每个冲突选定一版后变为可执行', () => {
		const modal = openModal(planWith([conflict('a.md', 1), conflict('b.md', 2)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const radios = Array.from(content.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
		const localRadios = radios.filter(r => r.value === 'local');
		expect(localRadios).toHaveLength(2);
		for (const radio of localRadios) {
			radio.checked = true;
			radio.dispatchEvent(new Event('change'));
		}

		const confirm = Array.from(content.querySelectorAll('.fit-operation-actions button'))
			.find(b => b.textContent === '执行所选') as HTMLButtonElement;
		expect(confirm.disabled).toBe(false);
	});

	it('“冲突全部采用本地”一次给所有冲突定边，并让执行按钮可用', () => {
		const modal = openModal(planWith([conflict('a.md', 1), conflict('b.md', 2)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		const byText = (t: string) => Array.from(content.querySelectorAll('.fit-operation-actions button'))
			.find(b => b.textContent === t) as HTMLButtonElement;

		expect(byText('执行所选').disabled).toBe(true);
		byText('冲突全部采用本地').dispatchEvent(new Event('click'));

		const checked = Array.from(content.querySelectorAll('input[type="radio"]:checked')) as HTMLInputElement[];
		expect(checked.map(r => r.value)).toEqual(['local', 'local']);
		expect(byText('执行所选').disabled).toBe(false);
	});

	it('手工输入框默认隐藏，选中“手工编辑结果”后出现', () => {
		const modal = openModal(planWith([conflict('a.md', 1)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const wrapper = content.querySelector('.fit-operation-manual') as HTMLElement;
		expect(wrapper.hidden).toBe(true);

		const manualRadio = Array.from(content.querySelectorAll('input[type="radio"]'))
			.find(r => (r as HTMLInputElement).value === 'manual') as HTMLInputElement;
		manualRadio.checked = true;
		manualRadio.dispatchEvent(new Event('change'));

		expect(wrapper.hidden).toBe(false);
	});

	it('按需预览两端内容，加载后显示文本', async () => {
		const loader = vi.fn(async () => ({ local: 'LOCAL BODY', remote: 'REMOTE BODY' }));
		const modal = openModal(planWith([conflict('a.md', 1)]), loader);
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const toggle = content.querySelector('.fit-conflict-preview-toggle') as HTMLButtonElement;
		expect(toggle.textContent).toBe('查看两端内容');
		toggle.dispatchEvent(new Event('click'));
		await Promise.resolve();
		await Promise.resolve();

		expect(loader).toHaveBeenCalledWith('a.md');
		const body = content.querySelector('.fit-conflict-preview-body') as HTMLElement;
		expect(body.classList.contains('is-collapsed')).toBe(false);
		expect(body.textContent).toContain('LOCAL BODY');
		expect(body.textContent).toContain('REMOTE BODY');

		// 展开后必须还能收回去（display:grid 会覆盖 [hidden]，所以用 class 折叠）
		toggle.dispatchEvent(new Event('click'));
		expect(body.classList.contains('is-collapsed')).toBe(true);
		expect(toggle.textContent).toBe('查看两端内容');

		// 再点一次重新展开，且不重复读取
		toggle.dispatchEvent(new Event('click'));
		expect(body.classList.contains('is-collapsed')).toBe(false);
		expect(toggle.textContent).toBe('隐藏内容');
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('选择集缺少 decisions 时仍完整渲染（真实环境出现过的崩溃路径）', () => {
		const modal = new PlanReviewModal({} as never, planWith([conflict('a.md', 1), conflict('b.md', 2)]));
		// 复现现场：selection 存在但 decisions 缺失
		(modal as unknown as { selection: unknown }).selection = { selected: new Set<string>() };
		(modal as unknown as { open(): void }).open();
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		expect(content.querySelectorAll('.fit-operation-choice .fit-operation-choice-label')).toHaveLength(6);
		const failures = Array.from(content.querySelectorAll('.fit-operation-warning'))
			.filter(el => (el.textContent ?? '').includes('渲染失败'));
		expect(failures).toHaveLength(0);

		// 选中一版后应能正常推进就绪状态，而不是在 finalizeSelection 里再炸一次
		const radio = Array.from(content.querySelectorAll('input[type="radio"]'))[0] as HTMLInputElement;
		radio.checked = true;
		radio.dispatchEvent(new Event('change'));
		const confirm = Array.from(content.querySelectorAll('.fit-operation-actions button'))
			.find(b => b.textContent === '执行所选') as HTMLButtonElement;
		expect(confirm.disabled).toBe(true); // 还有一条冲突未决
	});

	it.each([
		['空对象', {}],
		['缺 selected', { decisions: {} }],
		['缺 decisions', { selected: new Set<string>() }]
	])('选择集形状异常（%s）也不崩，仍渲染文件操作与冲突', (_label, bad) => {
		const modal = new PlanReviewModal({} as never, planWith([conflict('a.md', 1)]));
		(modal as unknown as { storedSelection: unknown }).storedSelection = bad;
		(modal as unknown as { open(): void }).open();
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const failures = Array.from(content.querySelectorAll('.fit-operation-warning'))
			.filter(el => (el.textContent ?? '').includes('渲染失败'));
		expect(failures).toHaveLength(0);
		expect(content.querySelectorAll('.fit-operation-choice .fit-operation-choice-label')).toHaveLength(3);
	});

	it('有文件操作时勾选框正常渲染（真实环境报过 reading has）', () => {
		const modal = openModal(planWithOperations());
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		expect(content.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		const failures = Array.from(content.querySelectorAll('.fit-operation-warning'))
			.filter(el => (el.textContent ?? '').includes('渲染失败'));
		expect(failures).toHaveLength(0);
	});

	it('不同中文路径的冲突各自独立分组，不会共用圆点', () => {
		const modal = openModal(planWith([conflict('中文论文/甲.md', 1), conflict('中文论文/乙.md', 2)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const radios = Array.from(content.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
		const names = new Set(radios.map(r => r.name));
		// 两条冲突 × 3 个选项，必须得到两个互不相同的分组名
		expect(names.size).toBe(2);

		// 选中第一条的“本地”不应影响第二条
		const firstLocal = radios.filter(r => r.value === 'local')[0];
		firstLocal.checked = true;
		firstLocal.dispatchEvent(new Event('change'));
		const checked = Array.from(content.querySelectorAll('input[type="radio"]:checked')) as HTMLInputElement[];
		expect(checked).toHaveLength(1);
	});

	it('没有文件操作时不显示勾选类按钮', () => {
		const modal = openModal(planWith([conflict('a.md', 1)]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		const texts = Array.from(content.querySelectorAll('.fit-operation-actions button')).map(b => b.textContent);
		expect(texts).not.toContain('取消全部勾选');
		expect(texts).not.toContain('勾选全部文件操作');
		expect(texts).toContain('冲突全部采用本地');
	});

	it('标出哪一侧更新、哪一侧更大', async () => {
		const meta = vi.fn(async () => ({
			local: Date.parse('2026-01-02T03:04:05Z'),
			remote: '2026-02-03T04:05:06Z'
		}));
		// a.md 本地更小(101)、远端更大(201)，远端时间更晚
		const modal = new PlanReviewModal({} as never, planWith([conflict('a.md', 1)]), undefined, meta);
		(modal as unknown as { open(): void }).open();
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		await Promise.resolve();
		await Promise.resolve();

		const newer = Array.from(content.querySelectorAll('.fit-conflict-badge.is-newer')).map(e => e.textContent);
		const larger = Array.from(content.querySelectorAll('.fit-conflict-badge.is-larger')).map(e => e.textContent);
		expect(newer).toEqual(['更新']);
		expect(larger).toEqual(['更大']);
		// 两个标签都应挂在"远端"那一行
		const remoteRow = Array.from(content.querySelectorAll('.fit-conflict-side'))
			.find(row => (row.textContent ?? '').startsWith('远端')) as HTMLElement;
		expect(remoteRow.querySelectorAll('.fit-conflict-badge')).toHaveLength(2);
	});

	it('不再出现“内容不同”“双方都修改”这类复述', () => {
		const modal = openModal(planWith([{ ...conflict('a.md', 1), kind: 'both-modified' }]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		const text = content.textContent ?? '';
		expect(text).not.toContain('内容不同');
		expect(text).not.toContain('双方都修改');
	});

	it('冲突项展示两侧最后修改时间', async () => {
		const meta = vi.fn(async () => ({ local: Date.parse('2026-01-02T03:04:05Z'), remote: '2026-02-03T04:05:06Z' }));
		const modal = new PlanReviewModal({} as never, planWith([conflict('a.md', 1)]), undefined, meta);
		(modal as unknown as { open(): void }).open();
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;
		await Promise.resolve();
		await Promise.resolve();
		const text = content.textContent ?? '';
		expect(meta).toHaveBeenCalledWith('a.md');
		expect(text).toContain('本地：存在');
		expect(text).toContain('远端：存在');
		expect(text).toContain('最后修改');
	});

	it('二进制冲突不提供手工文本编辑', () => {
		const binaryConflict = { ...conflict('x.png', 1), binary: true };
		const modal = openModal(planWith([binaryConflict]));
		const content = (modal as unknown as { contentEl: HTMLElement }).contentEl;

		const labels = Array.from(content.querySelectorAll('.fit-operation-choice .fit-operation-choice-label'))
			.map(el => el.textContent?.trim());
		expect(labels).toEqual(['采用本地版本', '采用远端版本', '手工编辑结果']);
		expect(content.querySelectorAll('textarea.fit-conflict-draft')).toHaveLength(0);
	});
});
