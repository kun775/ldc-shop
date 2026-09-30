export class FetchTimeoutError extends Error {
    /**
     * 显式声明字段并在构造函数里赋值，而不是用 TypeScript 的「参数属性」
     * （`constructor(public readonly timeoutMs: number)`）。
     *
     * 原因是构造参数属性属于**非可擦除语法**，Node 的类型剥离（strip-only）
     * 会直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，导致任何直接 import 本模块的
     * `node --test` 单测无法加载 —— 而卡密服务适配器正需要在这里断超时错误。
     */
    readonly timeoutMs: number

    constructor(timeoutMs: number) {
        super(`Request timed out after ${timeoutMs}ms`)
        this.name = "FetchTimeoutError"
        this.timeoutMs = timeoutMs
    }
}

export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs = 10_000,
    /**
     * 可注入的 fetch 实现，仅用于单测桩。
     *
     * 默认值刻意写成 `globalThis.fetch(...)` 的包装函数而不是直接写 `fetch`：
     * 后者在**存进变量再调用**时 `this` 会变成 `undefined`，在 Cloudflare Workers
     * 上会抛 "Illegal invocation"（Workers 要求 fetch 以正确接收者调用）。
     */
    fetchImpl: typeof fetch = (fetchInput, fetchInit) => globalThis.fetch(fetchInput, fetchInit),
) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("timeoutMs must be a positive number")
    }

    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(new FetchTimeoutError(timeoutMs)), timeoutMs)
    const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutController.signal])
        : timeoutController.signal

    try {
        return await fetchImpl(input, { ...init, signal })
    } catch (error) {
        if (timeoutController.signal.aborted && !init.signal?.aborted) {
            throw new FetchTimeoutError(timeoutMs)
        }
        throw error
    } finally {
        clearTimeout(timeoutId)
    }
}
