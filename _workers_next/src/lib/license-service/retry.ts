/**
 * 通用卡密服务调用的重试策略。
 *
 * 与客户端分离的原因：重试预算依赖业务语境。补货可以容忍几秒的退避
 * （最坏情况是任务留待下一轮对账），而订单交付的重试必须更保守，否则会
 * 把用户挡在付款回调里等。
 *
 * 硬约束（`docs/API.md` §9）：
 *   - 只有 `unavailable` 类别重试（429 / 503 / 网络超时 / 5xx），
 *     `409` 一律不重试 —— 包括 `allocation_expired` 与幂等冲突；
 *   - 重试必须复用**同一个** `Idempotency-Key`，所以本模块不认识键，
 *     键由调用方在闭包外冻结；
 *   - `429` 必须尊重 `Retry-After`，即使它比本地指数退避更长。
 *
 * 另一个刻意的选择：**非 `LicenseServiceError` 的异常不重试**。客户端已把所有
 * fetch 失败折算成 `LicenseServiceError`，因此逸出的其它异常只能是自己代码的
 * 缺陷，重试只会让 bug 更难发现。
 */

import {
    isLicenseServiceError,
    isRetryableCategory,
    LicenseServiceError,
} from './errors.ts'

export interface RetryPolicy {
    /** 含首次尝试的总次数。 */
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
    /** 全部尝试与退避合计的时间预算，超出即放弃并交回调用方。 */
    totalBudgetMs: number
}

/**
 * 默认策略刻意保守：补货任务允许失败后由对账重放，不值得在一次调用里
 * 耗掉几十秒。总预算远小于 30 分钟的 Ack 窗口，留足处置时间。
 */
export const LICENSE_SERVICE_DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    totalBudgetMs: 10_000,
}

/**
 * 计算第 `attempt` 次失败后的退避时长（毫秒）。
 *
 * `Retry-After` 优先于本地退避：服务端明确要求等待时，用更短的本地延迟
 * 去撞限流只会延长处罚。是否真的等得起由 `totalBudgetMs` 判定。
 */
export function computeRetryDelayMs(
    attempt: number,
    retryAfterMs: number | null | undefined,
    policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
    random: () => number = Math.random,
): number {
    const serverHint = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : 0
    const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
    const jitter = Math.trunc((random() * policy.baseDelayMs) / 2)
    const local = Math.min(policy.maxDelayMs, exponential + jitter)
    return Math.max(serverHint, local)
}

export interface RunWithRetryOptions {
    /** 用于错误归属与日志。 */
    operation: string
    policy?: Partial<RetryPolicy>
    sleep?: (delayMs: number) => Promise<void>
    random?: () => number
    now?: () => number
    onRetry?: (info: { attempt: number; delayMs: number; error: LicenseServiceError }) => void
}

function defaultSleep(delayMs: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

/**
 * 按同幂等键重试 `fn`。
 *
 * `fn` 收到当前尝试序号（从 1 开始），但**不应**据此改变请求体：契约把
 * 幂等键绑死在请求体 hash 上，改体就是自找 `409 idempotency_conflict`。
 */
export async function runWithRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RunWithRetryOptions,
): Promise<T> {
    const policy: RetryPolicy = { ...LICENSE_SERVICE_DEFAULT_RETRY_POLICY, ...options.policy }
    const maxAttempts = Math.max(1, Math.trunc(policy.maxAttempts))
    const sleep = options.sleep ?? defaultSleep
    const random = options.random ?? Math.random
    const now = options.now ?? (() => Date.now())
    const startedAt = now()

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await fn(attempt)
        } catch (error) {
            if (!isLicenseServiceError(error)) throw error
            if (!isRetryableCategory(error.category)) throw error
            if (attempt >= maxAttempts) throw error

            const delayMs = computeRetryDelayMs(attempt, error.retryAfterMs, policy, random)
            if (now() - startedAt + delayMs > policy.totalBudgetMs) throw error

            options.onRetry?.({ attempt, delayMs, error })
            await sleep(delayMs)
        }
    }
}
