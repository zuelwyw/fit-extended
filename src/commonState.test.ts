/**
 * 共同状态测试。
 *
 * 核心断言：旧双份缓存不能证明一致；身份/版本不符即未知；只有实际成功的操作推进状态。
 */

import { describe, it, expect } from 'vitest';
import { CommonState, COMMON_STATE_VERSION, StateIdentity, fromLegacyLocalStore } from './commonState';
import { ContentDigest, digestBytes } from './util/contentDigest';

const IDENTITY: StateIdentity = { owner: 'o', repo: 'r', branch: 'main' };

async function digest(text: string): Promise<ContentDigest> {
	const bytes = new TextEncoder().encode(text);
	return digestBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe('CommonState', () => {
	it('新装时没有任何共同状态，且不是"已建立"', () => {
		const state = CommonState.create(IDENTITY);
		expect(state.established).toBe(false);
		expect(state.lookup('a.md')).toEqual({ known: false, reason: 'no-entry' });
	});

	it('记录同内容后可按路径查回摘要', async () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		const d = await digest('hello');
		state.recordSame([{ path: 'a.md', digest: d }]);
		expect(state.lookup('a.md')).toEqual({ known: true, entry: { presence: 'same', digest: d } });
	});

	it('双方删除记录为 absent，与"没有记录"不同', () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		state.recordAbsent(['gone.md']);
		expect(state.lookup('gone.md')).toEqual({ known: true, entry: { presence: 'absent' } });
		expect(state.lookup('other.md')).toEqual({ known: false, reason: 'no-entry' });
	});

	it('空知识库已建立与从未建立必须区分', () => {
		const established = CommonState.create(IDENTITY);
		established.markEstablished();
		const roundTrip = CommonState.create(IDENTITY, established.toJSON());
		expect(roundTrip.established).toBe(true);
		expect(roundTrip.size).toBe(0);

		const fresh = CommonState.create(IDENTITY, CommonState.create(IDENTITY).toJSON());
		expect(fresh.established).toBe(false);
	});

	it('仓库/分支身份变化后旧共同状态不可复用', async () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		state.recordSame([{ path: 'a.md', digest: await digest('x') }]);
		const otherBranch = CommonState.create({ ...IDENTITY, branch: 'other' }, state.toJSON());
		expect(otherBranch.lookup('a.md').known).toBe(false);
		expect(otherBranch.established).toBe(false);
		const otherRepo = CommonState.create({ ...IDENTITY, repo: 'other' }, state.toJSON());
		expect(otherRepo.lookup('a.md').known).toBe(false);
	});

	it('版本不符的旧数据整体视为未知', () => {
		const legacy = { version: 1, identity: IDENTITY, established: true, entries: { 'a.md': { presence: 'same', digest: 'sha1:abc' } } };
		const state = CommonState.create(IDENTITY, legacy as never);
		expect(state.lookup('a.md').known).toBe(false);
		expect(state.established).toBe(false);
	});

	it('丢弃无效摘要而不是当成已知一致', () => {
		const broken = {
			version: COMMON_STATE_VERSION,
			identity: IDENTITY,
			established: true,
			entries: { 'a.md': { presence: 'same', digest: 'not-a-digest' } }
		};
		const state = CommonState.create(IDENTITY, broken as never);
		expect(state.lookup('a.md').known).toBe(false);
	});

	it('forget 清除单条记录（执行时发现无法确认一致性）', async () => {
		const state = CommonState.create(IDENTITY);
		state.markEstablished();
		state.recordSame([{ path: 'a.md', digest: await digest('x') }]);
		state.forget(['a.md']);
		expect(state.lookup('a.md').known).toBe(false);
	});
});

describe('fromLegacyLocalStore', () => {
	it('零上传采纳基线留下的双份缓存不得采纳为共同状态', () => {
		const legacy = {
			localSha: { 'a.md': 'local-sha-a', 'b.md': 'local-sha-b' },
			lastFetchedRemoteSha: { 'a.md': 'remote-sha-a', 'b.md': 'remote-sha-b' }
		};
		const { snapshot, droppedPaths } = fromLegacyLocalStore(legacy, IDENTITY);
		expect(Object.keys(snapshot.entries)).toEqual([]);
		expect(snapshot.established).toBe(false);
		expect(droppedPaths).toEqual(['a.md', 'b.md']);
	});

	it('本地 SHA 与远端 SHA 算法不同，不得互相拷贝', () => {
		// 即使两侧字符串完全一样，也不能证明内容一致：算法口径不同。
		const legacy = { localSha: { 'a.md': 'same-string' }, lastFetchedRemoteSha: { 'a.md': 'same-string' } };
		const { snapshot } = fromLegacyLocalStore(legacy, IDENTITY);
		expect(snapshot.entries['a.md']).toBeUndefined();
	});
});
