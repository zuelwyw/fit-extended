/**
 * 同步范围与忽略上下文测试。
 *
 * 重点：
 * - Git 跟踪 / 本地可读 / 参与同步 三者分开，不能互相冒充。
 * - 规则来源单一（只编辑共享 .gitignore），本机与全局只读展示。
 * - 已跟踪后新增忽略规则不得假装停止跟踪。
 * - 镜像不得把被忽略对象当成应删除的目标独有文件。
 */

import { describe, it, expect, vi } from 'vitest';
import { ScopeContext, SHARED_IGNORE_FILE, isPathInsideVault } from './scopeContext';

function adapterWith(files: Record<string, string>) {
	return {
		stat: vi.fn(async (path: string) => (path in files ? { type: 'file', size: files[path].length } : null)),
		read: vi.fn(async (path: string) => {
			if (path in files) return files[path];
			throw new Error('ENOENT');
		})
	};
}

describe('ScopeContext.decide', () => {
	const readable = true;
	const hidden = false;

	it('排除插件保留区与 Git 元数据', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		expect(scope.decide('_fit/conflict.md', readable).kind).toBe('excluded');
		expect(scope.decide('.git/config', readable).kind).toBe('excluded');
		expect(scope.decide('.git', readable).kind).toBe('excluded');
	});

	it('排除 Obsidian 设置目录，但作为规则来源的 .gitignore 单独归类为控制元数据', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		const settings = scope.decide('.obsidian/plugins/x/main.js', readable);
		expect(settings.kind).toBe('excluded');
		if (settings.kind === 'excluded') expect(settings.excluded.reason).toBe('obsidian-settings');

		const rules = scope.decide(SHARED_IGNORE_FILE, hidden);
		expect(rules.kind).toBe('excluded');
		// .gitignore 本身是隐藏文件（本地不可读），但必须被识别为控制元数据而非"本地不可读"
		if (rules.kind === 'excluded') expect(rules.excluded.reason).toBe('control-metadata');
	});

	it('被 .gitignore 匹配的路径标注原因与规则来源', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\ndrafts/\n'
		});
		const decision = scope.decide('debug.log', readable);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') {
			expect(decision.excluded.reason).toBe('ignored');
			expect(decision.excluded.source).toBe('shared');
		}
		expect(scope.decide('drafts/x.md', readable).kind).toBe('excluded');
		expect(scope.decide('notes/ok.md', readable).kind).toBe('in-scope');
	});

	it('重新纳入例外生效：共享规则先用 ! 反选', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n!keep.log\n'
		});
		expect(scope.decide('keep.log', readable).kind).toBe('in-scope');
		expect(scope.decide('other.log', readable).kind).toBe('excluded');
	});


	it('本地隐藏路径不可读时排除，而不是当成被忽略', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		const decision = scope.decide('.hidden-note.md', hidden);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('local-unreadable-hidden');
	});

	it('越界路径被拦截', async () => {
		expect(isPathInsideVault('../escape.md')).toBe(false);
		expect(isPathInsideVault('/etc/passwd')).toBe(false);
		expect(isPathInsideVault('C:/Windows')).toBe(false);
		expect(isPathInsideVault('notes/../ok.md')).toBe(false);
		expect(isPathInsideVault('notes/ok.md')).toBe(true);
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		const decision = scope.decide('../escape.md', readable);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('outside-vault');
	});
});

describe('ScopeContext 规则来源', () => {
	it('从磁盘读取共享 .gitignore，全局未配置时标为 absent', async () => {
		const scope = await ScopeContext.create(adapterWith({ '.gitignore': '*.log\n' }) as never);
		const sources = scope.describeSources();
		const shared = sources.find(s => s.kind === 'shared')!;
		expect(shared.availability).toBe('available');
		expect(shared.editable).toBe(true);
		expect(shared.content).toBe('*.log\n');
		// 本机排除已不再读取：来源列表里不应出现 local
		expect(sources.some(s => s.kind === 'local')).toBe(false);
		expect(sources.find(s => s.kind === 'global')!.availability).toBe('absent');
		// 全局规则只读
		expect(sources.find(s => s.kind === 'global')!.editable).toBe(false);
	});


	it('只编辑共享 .gitignore：不产生任何写本机/全局规则的入口', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '*.log\n' });
		const editable = scope.describeSources().filter(s => s.editable).map(s => s.path);
		expect(editable).toEqual(['.gitignore']);
	});
});

describe('规则指纹', () => {

	it('内容相同则指纹稳定', async () => {
		const a = await (await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '*.log\n' })).fingerprint();
		const b = await (await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '*.log\n' })).fingerprint();
		expect(a).toBe(b);
	});
});

// ===== P1.2 / P1.5：原生已跟踪例外、嵌套规则、共享控制元数据 =====

describe('已跟踪例外（Git 原生语义）', () => {
	it('已跟踪用户文件命中忽略规则时仍参与同步，不被误排除', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n'
		});
		// 未注入 tracked：按被忽略处理
		expect(scope.decide('old.log', true).kind).toBe('excluded');
	});


	it('跟踪未知时不放行被忽略路径，也不伪装成已跟踪', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n'
		});
		const decision = scope.decide('a.log', true);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('ignored');
	});

});

describe('嵌套 .gitignore（Git 原生语义）', () => {
	it('子目录规则按相对目录匹配，且比根规则优先', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n',
			nestedIgnoreContents: { sub: '!a.log\n' }
		});
		// 深层规则优先：sub/.gitignore 的 !a.log 把 sub/a.log 重新纳入
		expect(scope.decide('sub/a.log', true).kind).toBe('in-scope');
		// 子目录以外的仍受根规则约束
		expect(scope.decide('b.log', true).kind).toBe('excluded');
	});

	it('父目录被整体忽略时，子目录 ! 规则不能复活其中文件', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: 'drops/\n',
			nestedIgnoreContents: { drops: '!x.md\n' }
		});
		const decision = scope.decide('drops/x.md', true);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('ignored');
	});

	it('父目录被重新纳入（!dir/）后，子目录规则才生效', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: 'drops/*\n!drops/deep/\n',
			nestedIgnoreContents: { 'drops/deep': '!x.md\n' }
		});
		expect(scope.decide('drops/deep/x.md', true).kind).toBe('in-scope');
	});

	it('子目录规则只作用于其目录之内', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			nestedIgnoreContents: { sub: '*.log\n' }
		});
		expect(scope.decide('sub/a.log', true).kind).toBe('excluded');
		expect(scope.decide('a.log', true).kind).toBe('in-scope');
	});

	it('按候选路径有界读取子目录规则，不进入 .git 与 .obsidian', async () => {
		const files: Record<string, string> = {
			'sub/.gitignore': '*.log\n',
			'.git/.gitignore': 'should-not-read\n',
			'.obsidian/.gitignore': 'should-not-read\n'
		};
		const adapter = adapterWith(files);
		const scope = await ScopeContext.create(adapter as never, {
			sharedIgnoreContent: '',
			candidatePaths: ['sub/a.log', '.git/x', '.obsidian/y']
		});
		expect(scope.nestedIgnoreDirs()).toEqual(['sub']);
		expect(scope.decide('sub/a.log', true).kind).toBe('excluded');
		const readPaths = (adapter.read as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0]);
		expect(readPaths).not.toContain('.git/.gitignore');
		expect(readPaths).not.toContain('.obsidian/.gitignore');
	});

	it('子目录规则读取失败时如实标为不可访问', async () => {
		const adapter = {
			stat: vi.fn(async (p: string) => {
				if (p === 'broken/.gitignore') return { type: 'file', size: 1 };
				return null;
			}),
			read: vi.fn(async () => { throw new Error('EACCES'); })
		};
		const scope = await ScopeContext.create(adapter as never, {
			sharedIgnoreContent: '',
			candidatePaths: ['broken/a.md']
		});
		const source = scope.describeSources().find(s => s.path === 'broken/.gitignore');
		expect(source?.availability).toBe('unavailable');
		expect(source?.reason).toContain('EACCES');
	});
});

describe('共享控制元数据（P1.5）', () => {
	it('默认仍把 .gitignore 归入 control-metadata（保持既有行为）', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		const decision = scope.decide(SHARED_IGNORE_FILE, false);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('control-metadata');
	});

	it('显式开启后共享规则文件参与同步，子目录 .gitignore 同样适用', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: true
		});
		expect(scope.decide(SHARED_IGNORE_FILE, true).kind).toBe('in-scope');
		expect(scope.decide('.gitattributes', true).kind).toBe('in-scope');
		expect(scope.decide('sub/.gitignore', true).kind).toBe('in-scope');
	});

	it('开启后仍不同步 Obsidian 设置、插件目录与 Git 内部文件', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: true
		});
		expect(scope.decide('.obsidian/app.json', true).kind).toBe('excluded');
		expect(scope.decide('.git/config', true).kind).toBe('excluded');
		expect(scope.decide('.gitignore.bak', true).kind).toBe('in-scope'); // 非控制文件，按普通内容
	});

	it('本机 exclude 永不可编辑也不因开关变成同步对象', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: true
		});
		expect(scope.decide('.git/info/exclude', true).kind).toBe('excluded');
		const editable = scope.describeSources().filter(s => s.editable).map(s => s.path);
		expect(editable).toEqual(['.gitignore']);
	});
});

describe('规则指纹覆盖范围语义', () => {
	it('子目录规则变化会改变指纹', async () => {
		const a = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '', nestedIgnoreContents: { sub: '*.log\n' }
		})).fingerprint();
		const b = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '', nestedIgnoreContents: { sub: '*.tmp\n' }
		})).fingerprint();
		expect(a).not.toBe(b);
	});



	it('指纹不含时间戳：同一输入连续两次一致', async () => {
		const build = async () => (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n', nestedIgnoreContents: { sub: '!a.log\n' }
		})).fingerprint();
		expect(await build()).toBe(await build());
	});
});

describe('指纹覆盖磁盘收集到的子目录规则（非仅显式注入）', () => {
	it('磁盘上的子目录规则变化会改变指纹', async () => {
		const make = async (content: string) => {
			const adapter = adapterWith({ 'sub/.gitignore': content });
			const scope = await ScopeContext.create(adapter as never, {
				sharedIgnoreContent: '',
				candidatePaths: ['sub/a.md']
			});
			return scope.fingerprint();
		};
		expect(await make('*.log\n')).not.toBe(await make('*.tmp\n'));
	});
});

describe('共享控制元数据在生产路径上可达（不只有 helper 测通）', () => {
	it('开启后 .gitignore 不因隐藏文件/不可读而被再次排除', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: true
		});
		// 即使调用方报告 locallyReadable=false（隐藏文件），也不能落到
		// local-unreadable-hidden：控制元数据由插件用自己的 adapter 读写。
		const decision = scope.decide(SHARED_IGNORE_FILE, false);
		expect(decision.kind).toBe('in-scope');
	});

	it('开启后 .obsidian 下的 .gitignore 仍被 Obsidian 设置策略拦截', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: true
		});
		const decision = scope.decide('.obsidian/.gitignore', false);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('obsidian-settings');
	});

	it('关闭时（默认）.gitignore 仍按 control-metadata 排除，行为不回退', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '' });
		const decision = scope.decide(SHARED_IGNORE_FILE, false);
		expect(decision.kind).toBe('excluded');
		if (decision.kind === 'excluded') expect(decision.excluded.reason).toBe('control-metadata');
	});
});

// ===== 验收补修：目录数不截断 / 不可读来源阻断计划 =====

describe('嵌套规则采集不设静默上限', () => {
	/** 造 70 个独立目录，每个目录的 .gitignore 都忽略同目录的 *.log。 */
	function manyDirFiles(count: number): Record<string, string> {
		const files: Record<string, string> = {};
		for (let i = 0; i < count; i++) files[`d${String(i).padStart(3, '0')}/.gitignore`] = '*.log\n';
		return files;
	}

	it('第 65 个及之后的目录规则仍然生效（回归：不得静默丢弃）', async () => {
		const total = 70;
		const files = manyDirFiles(total);
		const candidates = Array.from({ length: total }, (_, i) => `d${String(i).padStart(3, '0')}/x.log`);
		const scope = await ScopeContext.create(adapterWith(files) as never, {
			sharedIgnoreContent: '',
			candidatePaths: candidates
		});
		// 全部 70 个目录都必须被读到
		expect(scope.nestedIgnoreDirs()).toHaveLength(total);
		// 第 65 个（下标 64）与最后一个都必须真正生效
		expect(scope.decide('d064/x.log', true).kind).toBe('excluded');
		expect(scope.decide('d069/x.log', true).kind).toBe('excluded');
		// 完整性必须为真，否则调用方无权继续
		expect(scope.completeness().complete).toBe(true);
	});

	it('超过 64 个目录时仍逐目录读取（证明没有截断点）', async () => {
		const total = 100;
		const files = manyDirFiles(total);
		const adapter = adapterWith(files);
		const candidates = Array.from({ length: total }, (_, i) => `d${String(i).padStart(3, '0')}/x.log`);
		await ScopeContext.create(adapter as never, { sharedIgnoreContent: '', candidatePaths: candidates });
		const readPaths = (adapter.read as unknown as { mock: { calls: string[][] } }).mock.calls.map(c => c[0]);
		const ignoreReads = readPaths.filter(p => p.endsWith('/.gitignore'));
		expect(ignoreReads).toHaveLength(total);
		expect(ignoreReads).toContain('d064/.gitignore');
		expect(ignoreReads).toContain('d099/.gitignore');
	});

	it('采集并发受限：同一时刻在途读取不超过 8', async () => {
		const total = 40;
		let inFlight = 0;
		let peak = 0;
		const adapter = {
			stat: vi.fn(async (p: string) => (p.endsWith('/.gitignore') ? { type: 'file', size: 8 } : null)),
			read: vi.fn(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise(resolve => setTimeout(resolve, 1));
				inFlight--;
				return '*.log\n';
			})
		};
		const candidates = Array.from({ length: total }, (_, i) => `d${String(i).padStart(3, '0')}/x.log`);
		await ScopeContext.create(adapter as never, { sharedIgnoreContent: '', candidatePaths: candidates });
		expect(peak).toBeLessThanOrEqual(8);
		expect(peak).toBeGreaterThan(0);
	});
});

describe('规则不可读时不得按"无规则"放行', () => {

	it('子目录规则读取失败 → 完整性为假，且不把它当成空规则', async () => {
		const adapter = {
			stat: vi.fn(async (p: string) => (p === 'bad/.gitignore' ? { type: 'file', size: 4 } : null)),
			read: vi.fn(async () => { throw new Error('EIO: i/o error'); })
		};
		const scope = await ScopeContext.create(adapter as never, {
			sharedIgnoreContent: '',
			candidatePaths: ['bad/a.md']
		});
		expect(scope.completeness().complete).toBe(false);
		expect(scope.completeness().unreadableSources).toContain('bad/.gitignore');
		expect(() => scope.assertComplete()).toThrow(/bad\/\.gitignore|读取失败/);
	});


	it('完整性正常时不抛错', async () => {
		const scope = await ScopeContext.create(adapterWith({}) as never, { sharedIgnoreContent: '*.log\n' });
		expect(scope.completeness().complete).toBe(true);
		expect(() => scope.assertComplete()).not.toThrow();
	});
});

// ===== φ2：生效的共享控制元数据策略必须进入指纹 =====

describe('共享控制元数据策略进入指纹', () => {
	it('同一批规则、策略开/关的指纹不同', async () => {
		const off = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n'
		})).fingerprint();
		const on = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n',
			includeSharedControlMetadata: true
		})).fingerprint();
		expect(off).not.toBe(on);
	});

	it('未传与显式 false 视为同一策略（归一化，不制造无意义失效）', async () => {
		const omitted = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n'
		})).fingerprint();
		const explicitFalse = await (await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n',
			includeSharedControlMetadata: false
		})).fingerprint();
		expect(omitted).toBe(explicitFalse);
	});

	it('策略位变化确实改变判定结果（指纹差异不是空转）', async () => {
		const make = async (include: boolean) => ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '',
			includeSharedControlMetadata: include
		});
		const off = await make(false);
		const on = await make(true);
		expect(off.decide(SHARED_IGNORE_FILE, false).kind).toBe('excluded');
		expect(on.decide(SHARED_IGNORE_FILE, false).kind).toBe('in-scope');
	});

	it('策略位不影响其他规则语义：忽略判定本身与当前一致', async () => {
		const base = await ScopeContext.create(adapterWith({}) as never, {
			sharedIgnoreContent: '*.log\n',
			includeSharedControlMetadata: true
		});
		expect(base.decide('a.log', true).kind).toBe('excluded');
		expect(base.decide('a.md', true).kind).toBe('in-scope');
	});
});
