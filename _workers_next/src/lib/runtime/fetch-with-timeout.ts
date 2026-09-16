export class FetchTimeoutError extends Error {
    constructor(public readonly timeoutMs: number) {
        super(`Request timed out after ${timeoutMs}ms`)
        this.name = "FetchTimeoutError"
    }
}

export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs = 10_000,
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
        return await fetch(input, { ...init, signal })
    } catch (error) {
        if (timeoutController.signal.aborted && !init.signal?.aborted) {
            throw new FetchTimeoutError(timeoutMs)
        }
        throw error
    } finally {
        clearTimeout(timeoutId)
    }
}
