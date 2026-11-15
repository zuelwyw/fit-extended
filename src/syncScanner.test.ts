/**
 * 扫描器测试：范围判定接入计划生成、镜像不误删排除对象、二进制识别。
 */

import { describe, it, expect, vi } from 'vitest';
import { scanAndPlan, buildPorts, isBinaryContent, SideScanner, ExecutionDeps } from './syncScanner';
import { ScopeContext } from './scopeContext';
import { CommonState, StateIdentity } from './commonState';
import { FileContent } from './util/contentEncoding';
import { BlobSha, CommitSha } from './util/hashing';
import { ContentDigest, digestFileContent, digestBytes } from './util/contentDigest';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

function makeScanner(files: Record<string, string>, options: { hidden?: string[]; excludedFromState?: string[] } = {}): SideScanner {
	const hidden = new Set(options.hidden ?? []);
	const state: Record<string, BlobSha> = {};
	for (const path of Object.keys(files)) state[path] = `sha-${path}` as BlobSha;
	for (const path of hidden) state[path] = `sha-${path}` as BlobSha;
	return {
		snapshot: async () => ({ paths: [...Object.keys(files), ...hidden], state }),
		isReadable: (path: string) => !hidden.has(path),
		read: async (path: string) => {
			const content = files[path];
			if (content === undefined) throw new Error(`missing ${path}`);
			return FileContent.fromPlainText(content);
		}
	};
}

async function scan(localFiles: Record<string, string>, remoteFiles: Record<string, string>, rule: 'merge-no-delete' | 'mirror', direction?: 'upload' | 'pull', scopeInput: { sharedIgnoreContent?: string } = {}) {
	const scope = await ScopeContext.create({ stat: vi.fn(), read: vi.fn() } as never, { sharedIgnoreContent: scopeInput.sharedIgnoreContent ?? '' });
	const commonState = CommonState.create(IDENTITY);
	commonState.markEstablished();
	return scanAndPlan({
		rule,
		direction,
		identity: IDENTITY,
		local: makeScanner(localFiles, { hidden: ['.gitignore'] }),
		remote: makeScanner(remoteFiles),
		scope,
		commonState,
		remoteHead: async () => ({ commitSha: 'head-1' as CommitSha, state: Object.fromEntries(Object.keys(remoteFiles).map(p => [p, `sha-${p}` as BlobSha])) })
	});
}

describe('scanAndPlan', () => {
	it('范围外的路径不进入计划：镜像不得删除被忽略的对象', async () => {
		const { plan } = await scan(
			{ 'keep.md': 'K' },
			{ 'keep.md': 'K', 'debug.log': 'log', '.obsidian/app.json': '{}', '_fit/copy.md': 'c' },
			'mirror', 'upload',
			{ sharedIgnoreContent: '*.log\n' }
		);
		const deletions = plan.operations.filter(op => op.kind === 'delete-remote').map(op => op.path);
		expect(deletions).toEqual([]);
		// 排除项被如实记录，且带原因
		const reasons = plan.excluded.map(e => e.reason);
		expect(reasons).toContain('ignored');
		expect(reasons).toContain('obsidian-settings');
		expect(reasons).toContain('reserved');
	});

	it('镜像仍会删除同步范围内目标独有的普通文件', async () => {
		const { plan } = await scan(
			{ 'keep.md': 'K' },
			{ 'keep.md': 'K', 'remote-only.md': 'R' },
			'mirror', 'upload'
		);
		expect(plan.operations.filter(op => op.kind === 'delete-remote').map(op => op.path)).toEqual(['remote-only.md']);
	});

	it('.gitignore 作为控制元数据被排除，既不上传也不删除', async () => {
		const { plan } = await scan(
			{ 'a.md': 'A' },
			{ 'a.md': 'A' },
			'mirror', 'upload',
			{ sharedIgnoreContent: '*.log\n' }
		);
		const touched = plan.operations.map(op => op.path);
		expect(touched).not.toContain('.gitignore');
		expect(plan.excluded.some(e => e.path === '.gitignore' && e.reason === 'control-metadata')).toBe(true);
	});

	it('双方同名同内容在首次扫描时标记为可采纳', async () => {
		const { plan, adoptableCount } = await scan({ 'same.md': 'X' }, { 'same.md': 'X' }, 'merge-no-delete');
		expect(adoptableCount).toBe(1);
		expect(plan.adoptable[0].path).toBe('same.md');
	});

	it('双方同名不同内容不得标记为已同步', async () => {
		const { plan } = await scan({ 'diff.md': 'A' }, { 'diff.md': 'B' }, 'merge-no-delete');
		expect(plan.adoptable).toEqual([]);
		expect(plan.conflicts.map(c => c.path)).toContain('diff.md');
	});
});

describe('isBinaryContent', () => {
	it('空字节内容识别为二进制', async () => {
		const bytes = new Uint8Array([0x41, 0x00, 0x42]);
		const base64 = btoa(String.fromCharCode(...bytes));
		expect(isBinaryContent(FileContent.fromBase64(base64))).toBe(true);
	});

	it('非法 UTF-8 识别为二进制', () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
		const base64 = btoa(String.fromCharCode(...bytes));
		expect(isBinaryContent(FileContent.fromBase64(base64))).toBe(true);
	});

	it('普通中文文本不是二进制', () => {
		expect(isBinaryContent(FileContent.fromPlainText('中文内容'))).toBe(false);
	});
});

describe('buildPorts', () => {
	function deps(overrides: Partial<ExecutionDeps> = {}): ExecutionDeps {
		const writes: string[] = [];
		return {
			identity: () => IDENTITY,
			localHead: async () => ({ 'a.md': 'sha-a' as BlobSha }),
			localPathState: async (path: string) => path === 'a.md'
				? { present: true, sha: 'sha-a' }
				: { present: false },
			remoteHead: async () => 'head-1',
			remoteHeadState: async () => ({ 'a.md': 'blob-a' as BlobSha }),
			rulesFingerprint: async () => 'rules-1',
			readLocal: async () => FileContent.fromPlainText('local'),
			readRemote: async () => FileContent.fromPlainText('remote'),
			writeLocal: async (path) => { writes.push(path); },
			deleteLocal: async () => {},
			publish: async (actions) => ({
				status: 'committed',
				commitSha: 'head-2',
				committedPaths: [...actions.additions.map(a => a.path), ...actions.deletions]
			}),
			...overrides
		};
	}

	it('写本地时取远端内容（拉取方向）', async () => {
		const written: Array<{ path: string; text: string }> = [];
		const ports = buildPorts(deps({
			writeLocal: async (path, content) => { written.push({ path, text: content.toPlainText() }); }
		}));
		await ports.writeLocal('a.md');
		expect(written).toEqual([{ path: 'a.md', text: 'remote' }]);
	});

	it('发布远端时取本地内容（上传方向）', async () => {
		let published: { additions: Array<{ path: string; content: FileContent }>; deletions: string[] } | null = null;
		const ports = buildPorts(deps({
			publish: async (actions) => {
				published = actions;
				return { status: 'committed', commitSha: 'head-2', committedPaths: actions.additions.map(a => a.path) };
			}
		}));
		await ports.publishRemote({ additions: [{ path: 'a.md' }], deletions: ['b.md'] });
		expect(published!.additions[0].content.toPlainText()).toBe('local');
		expect(published!.deletions).toEqual(['b.md']);
	});

	it('复核只用计划相关路径', async () => {
		const ports = buildPorts(deps({
			localHead: async () => ({ 'a.md': 'sha-a' as BlobSha, 'unrelated.md': 'sha-u' as BlobSha })
		}));
		const state = await ports.currentPathState(['a.md']);
		expect(state.local).toEqual({ 'a.md': 'sha-a' });
	});

	it('摘要对同一内容稳定（跨端同口径）', async () => {
		const localBytes = new TextEncoder().encode('中文内容');
		const buffer = localBytes.buffer.slice(localBytes.byteOffset, localBytes.byteOffset + localBytes.byteLength) as ArrayBuffer;
		const expected: ContentDigest = await digestBytes(buffer);
		expect(await digestFileContent(FileContent.fromPlainText('中文内容'))).toBe(expected);
		// base64 往返后摘要不变（GitHub 路径）
		expect(await digestFileContent(FileContent.fromBase64(btoa(String.fromCharCode(...localBytes))))).toBe(expected);
	});
});
