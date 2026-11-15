/**
 * 带真实中止的请求超时（诊断修复 D4）。
 *
 * 为什么不是 Promise.race：race 的"超时"只是不再等待，请求仍在后台继续，
 * 扫描看起来失败但网络栈仍在跑——D4 明确禁止这种假超时。
 * 这里用 AbortController 真正中止底层请求：fetch 层收到 abort 后连接关闭，
 * 没有后台扫描残留。Octokit request 支持 signal 透传。
 *
 * 超时语义只用于**读取**（检查阶段）：超时抛出的错误由调用方归类为
 * "检查失败"，不得与"提交结果不明"（uncertain）混用——读取没有写任何东西。
 * 写请求（发布）不走这里：结果不明的发布仍走 classifyPublishError 的
 * uncertain 逻辑，绝不自动重发提交。
 */

/** 检查阶段单请求超时：30 秒。足够覆盖慢网络单请求，又保证用户不会面对无限静默。 */
export const CHECK_REQUEST_TIMEOUT_MS = 30_000;

export type TimeoutSignal = { signal: AbortSignal; cancel: () => void };

/** 创建一个 ms 后自动 abort 的信号；cancel() 取消定时器（请求正常完成时调用防泄漏）。 */
export function createTimeoutSignal(ms: number = CHECK_REQUEST_TIMEOUT_MS): TimeoutSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${Math.round(ms / 1000)} 秒未响应，已中止`)), ms);
	return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** 判断错误是否为本次超时中止（AbortError 或携带超时消息）。 */
export function isTimeoutAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || /超过.*秒未响应|aborted/i.test(error.message);
}
