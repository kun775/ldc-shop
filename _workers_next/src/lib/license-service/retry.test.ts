import test from 'node:test'
import assert from 'node:assert/strict'

import { LicenseServiceError } from './errors.ts'
import {
    computeRetryDelayMs,
    LICENSE_SERVICE_DEFAULT_RETRY_POLICY,
    runWithRetry,
} from './retry.ts'

function errorOf(code: string, init: { httpStatus?: number; retryAfterMs?: number | null } = {}) {
    return new LicenseServiceError({
        code,
        httpStatus: init.httpStatus ?? 0,
        retryAfterMs: init.retryAfterMs ?? null,
    })
}

test('退避按指数增长并在上限处封顶，抖动不超过基延迟的一半', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000 }
    assert.equal(computeRetryDelayMs(1, null, policy, () => 0), 100)
    assert.equal(computeRetryDelayMs(2, null, policy, () => 0), 200)
    assert.equal(computeRetryDelayMs(3, null, policy, () => 0), 400)
    // 2^4 * 100 = 1600 → 封顶 1000
    assert.equal(computeRetryDelayMs(5, null, policy, () => 0), 1_000)
    // 抖动上限 = baseDelayMs / 2
    assert.equal(computeRetryDelayMs(1, null, policy, () => 1), 150)
})

test('Retry-After 优先于本地退避：服务端要求等待时不拿更短的延迟去撞限流', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000 }
    assert.equal(computeRetryDelayMs(1, 5_000, policy, () => 0), 5_000)
    assert.equal(computeRetryDelayMs(1, 50, policy, () => 0), 100)
    // 0 / undefined / null 都不算有效提示。
    assert.equal(computeRetryDelayMs(1, 0, policy, () => 0), 100)
    assert.equal(computeRetryDelayMs(1, undefined, policy, () => 0), 100)
    assert.equal(computeRetryDelayMs(1, null, policy, () => 0), 100)
})

test('暂时性错误按同一次闭包重试，返回首次成功结果', async () => {
    const attempts: number[] = []
    let failures = 0
    const sleeps: number[] = []

    const result = await runWithRetry(async (attempt) => {
        attempts.push(attempt)
        if (failures < 2) {
            failures += 1
            throw errorOf('rate_limited', { httpStatus: 429 })
        }
        return 'ok'
    }, {
        operation: 'ack',
        policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
        sleep: async (delayMs) => { sleeps.push(delayMs) },
        random: () => 0,
        now: () => 0,
    })

    assert.equal(result, 'ok')
    assert.deepEqual(attempts, [1, 2, 3])
    assert.deepEqual(sleeps, [10, 20])
})

test('耗尽尝试次数后抛出最后一次错误', async () => {
    let calls = 0
    await assert.rejects(
        runWithRetry(async () => {
            calls += 1
            throw errorOf('temporarily_unavailable', { httpStatus: 503 })
        }, {
            operation: 'allocate',
            policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
            sleep: async () => {},
            random: () => 0,
            now: () => 0,
        }),
        (error: unknown) => error instanceof LicenseServiceError && error.code === 'temporarily_unavailable',
    )
    assert.equal(calls, 3)
})

test('409 一律不重试：超窗与幂等冲突重试只会重复同一个结果', async () => {
    for (const code of ['allocation_expired', 'idempotency_conflict', 'allocation_conflict']) {
        let calls = 0
        await assert.rejects(
            runWithRetry(async () => {
                calls += 1
                throw errorOf(code, { httpStatus: 409 })
            }, {
                operation: 'ack',
                policy: { maxAttempts: 5 },
                sleep: async () => {},
                random: () => 0,
                now: () => 0,
            }),
            (error: unknown) => error instanceof LicenseServiceError && error.code === code,
        )
        assert.equal(calls, 1, code)
    }
})

test('非 LicenseServiceError 的异常不重试：逸出的异常是自己代码的缺陷', async () => {
    let calls = 0
    await assert.rejects(
        runWithRetry(async () => {
            calls += 1
            throw new TypeError('undefined is not a function')
        }, {
            operation: 'ack',
            policy: { maxAttempts: 3 },
            sleep: async () => {},
            random: () => 0,
            now: () => 0,
        }),
        TypeError,
    )
    assert.equal(calls, 1)
})

test('总预算耗尽即放弃：不会把调用方一直挂在退避里', async () => {
    const sleeps: number[] = []
    let clock = 0
    const policy = { maxAttempts: 5, baseDelayMs: 6_000, maxDelayMs: 6_000, totalBudgetMs: 10_000 }

    let calls = 0
    await assert.rejects(
        runWithRetry(async () => {
            calls += 1
            throw errorOf('timeout')
        }, {
            operation: 'ack',
            policy,
            sleep: async (delayMs) => { sleeps.push(delayMs); clock += delayMs },
            random: () => 0,
            now: () => clock,
        }),
        (error: unknown) => error instanceof LicenseServiceError && error.code === 'timeout',
    )

    // 第一次退避 6s 仍在预算内；第二次 6s + 已用 6s = 12s 超预算，不再等待。
    assert.deepEqual(sleeps, [6_000])
    assert.equal(calls, 2)
})

test('onRetry 上报每次退避，便于观测重试风暴', async () => {
    const seen: Array<{ attempt: number; delayMs: number; code: string }> = []
    let calls = 0

    await assert.rejects(runWithRetry(async () => {
        calls += 1
        throw errorOf('internal_error', { httpStatus: 500 })
    }, {
        operation: 'allocate',
        policy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 5, totalBudgetMs: 10_000 },
        sleep: async () => {},
        random: () => 0,
        now: () => 0,
        onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs, code: info.error.code }),
    }), LicenseServiceError)

    assert.deepEqual(seen, [{ attempt: 1, delayMs: 5, code: 'internal_error' }])
    assert.equal(calls, 2)
})

test('默认策略保守：尝试次数与总预算都远小于 30 分钟的 Ack 窗口', () => {
    assert.equal(LICENSE_SERVICE_DEFAULT_RETRY_POLICY.maxAttempts, 3)
    assert.ok(LICENSE_SERVICE_DEFAULT_RETRY_POLICY.totalBudgetMs < 60_000)
    assert.ok(LICENSE_SERVICE_DEFAULT_RETRY_POLICY.maxDelayMs <= 2_000)
})
