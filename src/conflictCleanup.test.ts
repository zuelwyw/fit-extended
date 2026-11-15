/**
 * 冲突副本清理回归测试（从 directionalOperations.test.ts 搬迁并保留原断言）。
 *
 * 这些用例守的是历史兼容功能：只删 _fit/ 副本、永远不删原路径正文。
 * 搬迁后归属明确：清理逻辑现在位于 conflictCleanup.ts。
 */

import { describe, it, expect } from 'vitest';
import { ConflictCleanupRunner } from './conflictCleanup';
import { Fit } from './fit';
import { FakeLocalVault, FakeObsidianVault, FakeRemoteVault } from './testUtils';
import { LocalVault } from './localVault';
import { FitSettings, LocalStores } from '@main';
import { Vault } from 'obsidian';
import { FileContent } from './util/contentEncoding';
import { CommitSha } from './util/hashing';
import { FileChange } from './util/changeTracking';

const testSettings = {
	pat: 'fake-test-token',
	owner: 'test-owner',
	repo: 'test-repo',
	branch: 'test-branch',
	deviceName: 'test-device'
};

function createHarness() {
	const localVault = new FakeLocalVault();
	const remoteVault = new FakeRemoteVault(testSettings.owner, testSettings.repo, testSettings.branch);
	const localStoreState: LocalStores = {
		localSha: {},
		lastFetchedRemoteSha: {},
		lastFetchedCommitSha: 'commit-initial' as CommitSha
	};
	const fit = new Fit(testSettings as FitSettings, localStoreState, {} as unknown as Vault);
	fit.localVault = localVault as never;
	fit.remoteVault = remoteVault as never;
	const runner = new ConflictCleanupRunner(fit);
	return { fit, runner, localVault, remoteVault };
}

describe('conflict cleanup', () => {
	function createVaultHarness() {
		const { fit, runner, remoteVault } = createHarness();
		// Wire a FakeObsidianVault so cleanup can enumerate _fit/ files
		const obsidian = new FakeObsidianVault();
		const localWithAdapter = new LocalVault(obsidian as never);
		fit.localVault = localWithAdapter as never;
		return { fit, runner, localVault: localWithAdapter, remoteVault, obsidian };
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

	it('records only non-removed _fit/ paths as last conflict set', () => {
		const h = createHarness();
		h.runner.recordConflicts([
			{ path: '_fit/a.md', type: 'ADDED' },
			{ path: '_fit/b.md', type: 'REMOVED' },
			{ path: 'notes/c.md', type: 'ADDED' }
		] as FileChange[]);
		expect(h.runner.hasLastConflictSet).toBe(true);
	});
});
