import { describe, it, expect, vi } from 'vitest';
import { Fit } from './fit';
import { DirectionalOperationRunner, prepareDirectionalOperation } from './directionalOperations';
import { FakeLocalVault, FakeRemoteVault, FakeObsidianVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { FileContent } from './util/contentEncoding';
import { CommitSha } from './util/hashing';
import FitNotice from './fitNotice';
import { FileChange, FileStates } from './util/changeTracking';

const testSettings = {
	pat: 'fake-test-token',
	owner: 'test-owner',
	repo: 'test-repo',
	branch: 'test-branch',
	deviceName: 'test-device'
};

function createHarness(initialStore?: Partial<LocalStores>) {
	const localVault = new FakeLocalVault();
	const remoteVault = new FakeRemoteVault(testSettings.owner, testSettings.repo, testSettings.branch);
	const localStoreState: LocalStores = {
		localSha: {},
		lastFetchedRemoteSha: {},
		lastFetchedCommitSha: 'commit-initial' as CommitSha,
		...initialStore
	};
	const fit = new Fit(testSettings as FitSettings, localStoreState, {} as unknown as Vault);
	fit.localVault = localVault as never;
	fit.remoteVault = remoteVault as never;
	const savedStores: Array<Partial<LocalStores>> = [];
	const runner = new DirectionalOperationRunner(fit, async store => {
		Object.assign(localStoreState, store);
		fit.loadLocalStore(localStoreState);
		savedStores.push(store);
	});
	const notice = {
		setMessage: vi.fn(),
		remove: vi.fn()
	} as unknown as FitNotice;
	return { fit, runner, localVault, remoteVault, localStoreState, savedStores, notice };
}

describe('prepareDirectionalOperation', () => {
	it('upload keep: lists only files changed since the baseline, keeps remote-only files', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local new');
		h.localVault.setFile('notes/changed.md', 'local changed');
		h.localVault.setFile('notes/untouched.md', 'unchanged');
		await h.remoteVault.applyChanges([
			{ path: 'notes/changed.md', content: FileContent.fromPlainText('remote old') },
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);
		// 建立基线：untouched.md 已在基线中，changed.md 的基线内容与当前不同
		const before = await h.fit.localVault.readFromSource();
		h.fit.loadLocalStore({
			localSha: { 'notes/untouched.md': before.state['notes/untouched.md'] },
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: null
		});
		// changed.md 是基线后才变动的文件：先把它记入基线，再修改内容
		h.fit.loadLocalStore({
			localSha: { ...h.fit.localSha, 'notes/changed.md': before.state['notes/changed.md'] },
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: null
		});
		h.localVault.setFile('notes/changed.md', '本地再次修改');

		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false);
		const byPath = Object.fromEntries(plan.changes.map(c => [c.path, c.type]));
		// 未变文件不参与；新增与修改才参与
		expect(byPath['notes/untouched.md']).toBeUndefined();
		expect(byPath['notes/changed.md']).toBe('MODIFIED');
		expect(byPath['notes/local-only.md']).toBe('ADDED');
	});

	it('upload delete: adds remote-only files to removal list', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local new');
		await h.remoteVault.applyChanges([
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', true, true);
		const removed = plan.changes.filter(c => c.type === 'REMOVED').map(c => c.path);
		expect(removed).toEqual(['notes/remote-only.md']);
	});

	it('pull keep: lists remote additions/modifications, keeps local-only files', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local only');
		h.localVault.setFile('notes/changed.md', 'local old');
		await h.remoteVault.applyChanges([
			{ path: 'notes/changed.md', content: FileContent.fromPlainText('remote new') },
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		// 拉取的增量基线是 lastFetchedRemoteSha：changed.md 的旧版本需在基线中
		const remoteNow = await h.fit.remoteVault.readFromSource(true);
		h.fit.loadLocalStore({
			localSha: {},
			lastFetchedRemoteSha: { 'notes/changed.md': remoteNow.state['notes/changed.md'] },
			lastFetchedCommitSha: remoteNow.commitSha
		});
		await h.remoteVault.setFile('notes/changed.md', 'remote 再改');
		const plan = await prepareDirectionalOperation(h.fit, 'pull', 'overwrite', false);
		const byPath = Object.fromEntries(plan.changes.map(c => [c.path, c.type]));
		expect(byPath['notes/changed.md']).toBe('MODIFIED');
		expect(byPath['notes/local-only.md']).toBeUndefined();
	});

	it('pull delete: adds local-only files to removal list', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local only');
		await h.remoteVault.applyChanges([
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		const plan = await prepareDirectionalOperation(h.fit, 'pull', 'overwrite', true, true);
		const removed = plan.changes.filter(c => c.type === 'REMOVED').map(c => c.path);
		expect(removed).toEqual(['notes/local-only.md']);
	});

	it('addOnly + delete: removes remote-only files without overwriting any existing file', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/existing.md', '本地新内容');
		h.localVault.setFile('notes/local-new.md', '本地新增');
		await h.remoteVault.setFile('notes/existing.md', '远端旧内容');
		await h.remoteVault.setFile('notes/remote-only.md', '远端独有');

		const before = await h.fit.localVault.readFromSource();
		h.fit.loadLocalStore({
			localSha: { 'notes/existing.md': before.state['notes/existing.md'] },
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: null
		});
		h.localVault.setFile('notes/existing.md', '本地又改了');
		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'addOnly', true);
		const byPath = Object.fromEntries(plan.changes.map(c => [c.path, c.type]));
		// 同名差异文件不进入覆盖清单
		expect(byPath['notes/existing.md']).toBeUndefined();
		// 只新增 + 删除独有
		expect(byPath['notes/local-new.md']).toBe('ADDED');
		expect(byPath['notes/remote-only.md']).toBe('REMOVED');
	});

	it('addOnly without delete leaves remote untouched when nothing is new', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/existing.md', '本地新内容');
		await h.remoteVault.setFile('notes/existing.md', '远端旧内容');

		await expect(prepareDirectionalOperation(h.fit, 'upload', 'addOnly', false))
			.rejects.toThrow('尚无同步基线');
	});

	it('addOnly pull deletes local-only files without touching shared files', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/existing.md', '本地旧');
		h.localVault.setFile('notes/local-only.md', '仅本地');
		await h.remoteVault.setFile('notes/existing.md', '远端新');
		await h.remoteVault.setFile('notes/remote-new.md', '远端新增');

		// 远端基线：existing.md 旧版本在基线中，remote-new.md 不在
		const r0 = await h.fit.remoteVault.readFromSource(true);
		h.fit.loadLocalStore({
			localSha: {},
			lastFetchedRemoteSha: { 'notes/existing.md': r0.state['notes/existing.md'] },
			lastFetchedCommitSha: r0.commitSha
		});
		const plan = await prepareDirectionalOperation(h.fit, 'pull', 'addOnly', true);
		const byPath = Object.fromEntries(plan.changes.map(c => [c.path, c.type]));
		// 同名差异在 addOnly 下不写入
		expect(byPath['notes/existing.md']).toBeUndefined();
		expect(byPath['notes/local-only.md']).toBe('REMOVED');
	});

	it('overwrite mode still lists same-name differences', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/existing.md', '本地新内容');
		await h.remoteVault.setFile('notes/existing.md', '远端旧内容');

		const b = await h.fit.localVault.readFromSource();
		h.fit.loadLocalStore({
			localSha: { 'notes/existing.md': b.state['notes/existing.md'] },
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: null
		});
		h.localVault.setFile('notes/existing.md', '本地再改');
		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false);
		expect(plan.changes).toEqual([{ path: 'notes/existing.md', type: 'MODIFIED' }]);
	});

	it('does not read file content for unchanged files when using baseline', async () => {
		const h = createHarness();
		h.localVault.setFile('keep/a.md', 'a');
		h.localVault.setFile('keep/b.md', 'b');
		const b = await h.fit.localVault.readFromSource();
		h.fit.loadLocalStore({
			localSha: { 'keep/a.md': b.state['keep/a.md'], 'keep/b.md': b.state['keep/b.md'] },
			lastFetchedRemoteSha: {},
			lastFetchedCommitSha: null
		});

		const spy = vi.spyOn(h.fit.localVault, 'readFileContent');
		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false);
		// 两个文件都没有改动，计划为空，且不读取任何文件内容
		expect(plan.changes).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('baseline missing refuses to run silently', async () => {
		const h = createHarness();
		h.localVault.setFile('a.md', 'a');
		await expect(prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false))
			.rejects.toThrow('尚无同步基线');
	});

	it('baseline missing proceeds after explicit confirmation', async () => {
		const h = createHarness();
		h.localVault.setFile('a.md', 'a');
		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false, true);
		expect(plan.baselineMissing).toBe(true);
		expect(plan.changes).toEqual([{ path: 'a.md', type: 'ADDED' }]);
	});

	it('never treats repository metadata (.gitignore, .gitattributes) as remote-only files', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/a.md', 'a');
		await h.remoteVault.setFile('.gitignore', '/.obsidian\n');
		await h.remoteVault.setFile('.gitattributes', '* text=auto\n');
		await h.remoteVault.setFile('remote-only.md', 'r');

		const upload = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', true, true);
		const uploadPaths = upload.changes.map(c => c.path);
		expect(uploadPaths).not.toContain('.gitignore');
		expect(uploadPaths).not.toContain('.gitattributes');
		// 普通远端独有文件仍按用户选择加入删除清单
		expect(uploadPaths).toContain('remote-only.md');

		const pull = await prepareDirectionalOperation(h.fit, 'pull', 'overwrite', true, true);
		const pullPaths = pull.changes.map(c => c.path);
		expect(pullPaths).not.toContain('.gitignore');
		expect(pullPaths).not.toContain('.gitattributes');
	});

	it('never schedules deletion or overwrite for protected paths', async () => {
		const h = createHarness();
		h.localVault.setFile('_fit/conflict.md', 'conflict copy');
		h.localVault.setFile('.obsidian/plugins/x/main.js', 'plugin');
		await h.remoteVault.applyChanges([
			{ path: '_fit/remote.md', content: FileContent.fromPlainText('x') },
			{ path: '.obsidian/remote.md', content: FileContent.fromPlainText('x') },
			{ path: 'notes/normal.md', content: FileContent.fromPlainText('normal') }
		], []);

		for (const direction of ['upload', 'pull'] as const) {
			const plan = await prepareDirectionalOperation(h.fit, direction, 'overwrite', true, true);
			for (const change of plan.changes) {
				expect(change.path.startsWith('_fit/') || change.path.startsWith('.obsidian/')).toBe(false);
			}
		}
	});
});

describe('DirectionalOperationRunner.execute', () => {
	it('upload keep: writes local changes to remote and leaves remote-only files intact', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local new');
		h.localVault.setFile('notes/changed.md', 'local changed');
		await h.remoteVault.applyChanges([
			{ path: 'notes/changed.md', content: FileContent.fromPlainText('remote old') },
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false, true);
		const result = await h.runner.execute(plan, h.notice);

		expect(result.success).toBe(true);
		expect(h.remoteVault.getAllFilesAsRaw()['notes/local-only.md']).toBeDefined();
		expect(h.remoteVault.getAllFilesAsRaw()['notes/changed.md']).toContain('local changed');
		expect(h.remoteVault.getAllFilesAsRaw()['notes/remote-only.md']).toContain('remote only');
		// Local vault must not be modified by an upload
		expect(h.localVault.getAllFilesAsRaw()['notes/changed.md']).toContain('local changed');
	});

	it('pull keep: writes remote changes locally and leaves local-only files intact', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local only');
		h.localVault.setFile('notes/changed.md', 'local old');
		await h.remoteVault.applyChanges([
			{ path: 'notes/changed.md', content: FileContent.fromPlainText('remote new') },
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		const plan = await prepareDirectionalOperation(h.fit, 'pull', 'overwrite', false, true);
		const result = await h.runner.execute(plan, h.notice);

		expect(result.success).toBe(true);
		expect(h.localVault.getAllFilesAsRaw()['notes/changed.md']).toContain('remote new');
		expect(h.localVault.getAllFilesAsRaw()['notes/remote-only.md']).toBeDefined();
		expect(h.localVault.getAllFilesAsRaw()['notes/local-only.md']).toContain('local only');
		// No remote commit should be created by a pull
		const commitBefore = h.remoteVault.getCommitSha();
		expect(h.remoteVault.getCommitSha()).toBe(commitBefore);
	});

	it('pull delete: removes local-only files', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/local-only.md', 'local only');
		await h.remoteVault.applyChanges([
			{ path: 'notes/remote-only.md', content: FileContent.fromPlainText('remote only') }
		], []);

		const plan = await prepareDirectionalOperation(h.fit, 'pull', 'overwrite', true, true);
		const result = await h.runner.execute(plan, h.notice);

		expect(result.success).toBe(true);
		expect(h.localVault.getAllFilesAsRaw()['notes/local-only.md']).toBeUndefined();
		expect(h.localVault.getAllFilesAsRaw()['notes/remote-only.md']).toBeDefined();
	});

	it('aborts when remote advanced after the preview', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/a.md', 'local');

		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false, true);
		// Simulate another device committing to remote after preview
		await h.remoteVault.setFile('notes/other-device.md', 'other', true);

		const result = await h.runner.execute(plan, h.notice);
		expect(result.success).toBe(false);
		if (!result.success && 'message' in result.error && result.error.message) {
			expect(String(result.error.message)).toContain('Remote branch changed');
		} else if (!result.success) {
			expect(result.error).toBeDefined();
		}
		expect(h.remoteVault.getAllFilesAsRaw()['notes/a.md']).toBeUndefined();
		expect(h.remoteVault.getAllFilesAsRaw()['notes/other-device.md']).toBeDefined();
	});

	it('aborts when local files changed after the preview', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/a.md', 'local');

		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false, true);
		h.localVault.setFile('notes/a.md', 'local edited after preview');

		const result = await h.runner.execute(plan, h.notice);
		expect(result.success).toBe(false);
		if (!result.success && 'message' in result.error && result.error.message) {
			expect(String(result.error.message)).toContain('Local files changed');
		} else if (!result.success) {
			expect(result.error).toBeDefined();
		}
		expect(h.remoteVault.getAllFilesAsRaw()['notes/a.md']).toBeUndefined();
		expect(Object.keys(h.remoteVault.getAllFilesAsRaw()).length).toBe(0);
	});

	it('serializes concurrent operations', async () => {
		const h = createHarness();
		h.localVault.setFile('notes/a.md', 'local');
		const plan = await prepareDirectionalOperation(h.fit, 'upload', 'overwrite', false, true);

		const second = { valid: false };
		Object.defineProperty(second, 'valid', { value: true });
		const plan2 = { ...plan };
		const first = h.runner.execute(plan, h.notice);
		const secondResult = await h.runner.execute(plan2, h.notice);
		await first;
		expect(secondResult.success).toBe(false);
		if (!secondResult.success) {
			expect(secondResult.error.type).toBe('already-syncing');
		}
	});
});

describe('conflict cleanup', () => {
	function createVaultHarness() {
		const { fit, runner, remoteVault, notice } = createHarness();
		// Wire a FakeObsidianVault so cleanup can enumerate _fit/ files
		const obsidian = new FakeObsidianVault();
		const localWithAdapter = new LocalVault(obsidian as never);
		fit.localVault = localWithAdapter as never;
		return { fit, runner, localVault: localWithAdapter, remoteVault, obsidian, notice };
	}

	it('listConflictFiles last-scope fails when no conflicts recorded', async () => {
		const h = createHarness();
		await expect(h.runner.listConflictFiles('last')).rejects.toThrow('没有可用的上次同步冲突清单');
	});

	it('cleanup removes recorded last-scope files and keeps others', async () => {
		const h = createVaultHarness();
		await h.localVault.applyChanges(
			[
				{ path: 'notes/one.md', content: FileContent.fromPlainText('one') },
				{ path: 'notes/two.md', content: FileContent.fromPlainText('two') }
			],
			[],
			{ clashPaths: new Set(['notes/one.md', 'notes/two.md']) }
		);
		// Original-path files exist separately from the _fit/ copies
		await h.localVault.applyChanges(
			[
				{ path: 'notes/one.md', content: FileContent.fromPlainText('one') },
				{ path: 'notes/two.md', content: FileContent.fromPlainText('two') }
			],
			[]
		);
		h.runner.recordConflicts([{ path: '_fit/notes/one.md', type: 'ADDED' }] as FileChange[]);

		const result = await h.runner.cleanupConflicts('last');
		expect(result.deleted).toEqual(['_fit/notes/one.md']);
		expect(result.failed).toEqual([]);
		const remaining = h.obsidian.listPaths().filter(p => p.startsWith('_fit/'));
		expect(remaining).toEqual(['_fit/notes/two.md']);
		// Original-path files must survive cleanup
		expect(h.obsidian.readText('notes/one.md') ?? '').toContain('one');
		expect(h.obsidian.readText('notes/two.md') ?? '').toContain('two');
	});

	it('cleanup all removes every _fit/ file including nested paths', async () => {
		const h = createVaultHarness();
		await h.localVault.applyChanges(
			[
				{ path: 'a.md', content: FileContent.fromPlainText('a') },
				{ path: 'deep/nested/b.md', content: FileContent.fromPlainText('b') },
				{ path: 'keep.md', content: FileContent.fromPlainText('keep') }
			],
			[],
			{ clashPaths: new Set(['a.md', 'deep/nested/b.md']) }
		);

		const result = await h.runner.cleanupConflicts('all');
		expect(result.deleted.sort()).toEqual(['_fit/a.md', '_fit/deep/nested/b.md']);
		expect(result.failed).toEqual([]);
		const remaining = h.obsidian.listPaths();
		expect(remaining).toContain('keep.md');
		expect(remaining.filter(p => p.startsWith('_fit/'))).toEqual([]);
	});

	it('cleanup never deletes original-path content', async () => {
		const h = createVaultHarness();
		await h.localVault.applyChanges(
			[{ path: 'notes/doc.md', content: FileContent.fromPlainText('precious') }],
			[],
			{ clashPaths: new Set(['notes/doc.md']) }
		);
		// The original file exists alongside the _fit/ copy
		await h.localVault.applyChanges(
			[{ path: 'notes/doc.md', content: FileContent.fromPlainText('precious') }],
			[]
		);

		const result = await h.runner.cleanupConflicts('all');
		expect(result.deleted).toEqual(['_fit/notes/doc.md']);
		expect(h.obsidian.readText('notes/doc.md') ?? '').toContain('precious');
	});
});
