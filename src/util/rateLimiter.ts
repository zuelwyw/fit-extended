/**
 * 惰性请求队列：约束真实发起速率与在途数量。
 *
 * 为什么必须惰性：把 `tasks.map(task => task())` 的结果数组交给定时等待，
 * 只是把"已完成的结果"延后取出，请求在高频发起时早已全部发出——注释里写的
 * 速率上限并没有生效。任务必须**在轮到它时**才被调用。
 *
 * 限流语义：
 * - minIntervalMs：相邻两次**发起**之间的最小间隔（真实发起时刻，不是完成）。
 * - maxInFlight：同时在途上限。
 * - 时间片分配是串行的：并发调用不会读到同一个"上次发起时刻"而同时放行。
 */

export function createLazyQueue(minIntervalMs: number, maxInFlight: number) {
	const limit = Math.max(1, maxInFlight);
	const waiting: Array<() => void> = [];
	let active = 0;
	let lastStartedAt = 0;
	/**
	 * 串行锁：保证"读上次发起时刻 → 计算等待 → 更新上次发起时刻"不会被并发打断。
	 * 没有它，多个任务会读到相同的 lastStartedAt 并各自算出相同的等待时间，
	 * 醒来时仍然同时发起——限速形同虚设。
	 */
	let slotChain: Promise<void> = Promise.resolve();

	const acquireSlot = (): Promise<void> => {
		const next = slotChain.then(async () => {
			const wait = lastStartedAt + minIntervalMs - Date.now();
			if (wait > 0) await sleep(wait);
			lastStartedAt = Date.now();
		});
		slotChain = next;
		return next;
	};

	const acquireCapacity = async (): Promise<void> => {
		if (active >= limit) {
			await new Promise<void>(resolve => waiting.push(resolve));
		}
		active++;
	};

	const release = (): void => {
		active--;
		waiting.shift()?.();
	};

	return {
		/** 只有调用 run 时才真正开始请求。 */
		async run<T>(task: () => Promise<T>): Promise<T> {
			await acquireCapacity();
			try {
				await acquireSlot();
				return await task();
			} finally {
				release();
			}
		},
		/** 供测试观测：当前在途数量。 */
		get inFlight(): number {
			return active;
		}
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** GitHub 内容创建请求的保守节奏：≤80/分钟。 */
export const BLOB_CREATION_RATE = { minIntervalMs: 750, maxInFlight: 1 } as const;
