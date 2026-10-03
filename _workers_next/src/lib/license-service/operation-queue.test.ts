/**
 * 待办队列的**堵塞**回归测试（`operation-queue.ts`）。
 *
 * 要钉住的三件事，缺一条队列就会重新坏掉：
 *   1. 失败落账必须带退避（`next_retry_at` 不再是 NULL）；
 *   2. 连续失败到上限转 `abandoned`，离开重试队列、但仍留在复核清单里；
 *   3. 排序把 `failed`（死信）放在 `pending` 之后 —— 否则死信恒定占据队首，
 *      把 `LIMIT` 吃光，新进队的活儿永远轮不到。
 *
 * 用的是真实 SQLite：`buildOperationFailureClauses` 生成的 `CASE`/`MIN`/`<<`
 * 必须被真实引擎接受，用替身对象验不出来。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listPendingCardServiceOperations, buildInsertAckOperationStatement, buildFailAckStatements } from './restock.ts'
import { buildSellFailStatements, listPendingSellOperations } from './delivery.ts'
import { buildRevokeFailStatements, listPendingRevokeOperations } from './revoke.ts'
import { buildSellIdempotencyKey, buildRevokeIdempotencyKey } from './idempotency.ts'
import {
    CARD_SERVICE_MAX_OPERATION_ATTEMPTS,
    CARD_SERVICE_RETRY_BACKOFF_BASE_MS,
    buildOperationFailureClauses,
} from './operation-queue.ts'
import { listCardServiceReviewQueue } from './ops.ts'
import { createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

const NOW = 1_700_000_000_000
const ACK_KEY = 'restock:task-ack:ack'
const SELL_ALLOC = 'alloc_sell'
const ORDER_ID = 'ORDER-Q'

function seedOperation(
    ctx: SqliteTestContext,
    input: { key: string; operation: string; state: string; attempts: number; nextRetryAt?: number | null; createdAt?: number },
) {
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, next_retry_at, created_at, updated_at)
        VALUES ('${input.key}', '${input.operation}', 'res_${input.key}', '${ORDER_ID}', '${input.state}',
                ${input.attempts}, ${input.nextRetryAt ?? 'NULL'}, ${input.createdAt ?? 0}, ${input.createdAt ?? 0})`)
}

function operationRow(ctx: SqliteTestContext, key: string) {
    return ctx.get(`SELECT state, attempts, next_retry_at FROM card_service_operations WHERE operation_key = ?`, [key])
}

const SELL_KEY = buildSellIdempotencyKey(SELL_ALLOC, ORDER_ID)
const REVOKE_KEY = buildRevokeIdempotencyKey('card_r1', ORDER_ID)

// ---------------------------------------------------------------------------
// 退避与尝试上限
// ---------------------------------------------------------------------------

test('失败落账带退避：按已有尝试次数指数后退，而不是 NULL', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'pending', attempts: 0 })
    seedOperation(ctx, { key: REVOKE_KEY, operation: 'revoke', state: 'pending', attempts: 3 })
    seedOperation(ctx, { key: ACK_KEY, operation: 'ack', state: 'pending', attempts: 0 })

    await ctx.database.write(buildSellFailStatements({
        orderId: ORDER_ID, allocationId: SELL_ALLOC, errorCode: 'contract_error', requestId: null, nowMs: NOW,
    }))
    await ctx.database.write(buildRevokeFailStatements({
        orderId: ORDER_ID, remoteCardId: 'card_r1', errorCode: 'permission_denied', requestId: null, nowMs: NOW,
    }))
    await ctx.database.write(buildFailAckStatements({
        allocationId: 'alloc_ack', ackOperationKey: ACK_KEY, errorCode: 'contract_error', requestId: null, nowMs: NOW,
    }))

    // attempts = 0 → 退避 1 档；attempts = 3 → 退避 8 档。
    assert.equal(operationRow(ctx, SELL_KEY)?.next_retry_at, NOW + CARD_SERVICE_RETRY_BACKOFF_BASE_MS)
    assert.equal(operationRow(ctx, REVOKE_KEY)?.next_retry_at, NOW + CARD_SERVICE_RETRY_BACKOFF_BASE_MS * 8)
    assert.equal(operationRow(ctx, ACK_KEY)?.next_retry_at, NOW + CARD_SERVICE_RETRY_BACKOFF_BASE_MS)

    for (const key of [SELL_KEY, REVOKE_KEY, ACK_KEY]) {
        assert.equal(operationRow(ctx, key)?.state, 'failed')
        assert.equal(operationRow(ctx, key)?.attempts, 1 + (key === REVOKE_KEY ? 3 : 0))
    }
})

test('连续失败到上限转 abandoned：离开重试队列，但仍在复核清单里', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const attempts = CARD_SERVICE_MAX_OPERATION_ATTEMPTS - 1
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'failed', attempts })

    await ctx.database.write(buildSellFailStatements({
        orderId: ORDER_ID, allocationId: SELL_ALLOC, errorCode: 'contract_error', requestId: null, nowMs: NOW,
    }))

    const row = operationRow(ctx, SELL_KEY)
    assert.equal(row?.state, 'abandoned')
    assert.equal(row?.next_retry_at, null)

    // 不再出现在重放队列里（不会每轮被重新捡起来）。
    assert.deepEqual(await listPendingSellOperations(ctx.database, { limit: 10 }), [])

    // 但必须仍然可见：死信不能静默消失。
    const review = await listCardServiceReviewQueue(ctx.database, { now: NOW })
    assert.equal(review.enabled, true)
    assert.deepEqual(review.failedOperations.map((item) => item.operationKey), [SELL_KEY])
    assert.equal(review.failedOperations[0].state, 'abandoned')
})

test('未到上限时仍留在队列里等待重放（failed 不算终态）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'failed', attempts: 0 })

    await ctx.database.write(buildSellFailStatements({
        orderId: ORDER_ID, allocationId: SELL_ALLOC, errorCode: 'contract_error', requestId: null, nowMs: NOW,
    }))

    const rows = await listPendingSellOperations(ctx.database, { limit: 10 })
    assert.deepEqual(rows.map((item) => item.operationKey), [SELL_KEY])
})

test('退避表达式对异常 attempts 也有界（不溢出、不产生负时间）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const huge = 10_000
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'pending', attempts: huge })

    await ctx.database.write(buildSellFailStatements({
        orderId: ORDER_ID, allocationId: SELL_ALLOC, errorCode: 'contract_error', requestId: null, nowMs: NOW,
    }))

    const row = operationRow(ctx, SELL_KEY)
    // attempts 超过上限时**先**转 abandoned（上限判定在退避之前），所以这里没有时间值。
    assert.equal(row?.state, 'abandoned')
    assert.equal(row?.next_retry_at, null)

    // 直接验表达式本身：移位被夹住，不会算出天文数字。
    const clauses = buildOperationFailureClauses(NOW)
    assert.match(clauses.nextRetryAt, /MIN\(attempts, 6\)/)
})

// ---------------------------------------------------------------------------
// 排序：死信不堵塞队列
// ---------------------------------------------------------------------------

test('死信恒定排在 pending 之后：LIMIT 1 时拿到的是活着的待办', async () => {
    const ctx = createSqliteCardServiceDatabase()
    // 死信更早进队，且 next_retry_at 为 NULL（旧的失败落账方式）——按老的
    // ORDER BY COALESCE(next_retry_at,0) 它会永远排在队首。
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'failed', attempts: 1, nextRetryAt: null, createdAt: 0 })
    seedOperation(ctx, { key: ACK_KEY, operation: 'sell', state: 'pending', attempts: 0, nextRetryAt: NOW, createdAt: 10 })

    const rows = await listPendingSellOperations(ctx.database, { limit: 1 })
    assert.deepEqual(rows.map((item) => item.operationKey), [ACK_KEY])

    // 把 LIMIT 放宽后才轮到死信（它仍然可被人工重放）。
    const all = await listPendingSellOperations(ctx.database, { limit: 10 })
    assert.deepEqual(all.map((item) => item.operationKey), [ACK_KEY, SELL_KEY])
})

test('三条重放队列共用同一份排序：ack / revoke 同样不被死信堵住', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await ctx.database.write([
        buildInsertAckOperationStatement({ operationKey: ACK_KEY, allocationId: 'alloc_1', nowMs: NOW }),
    ])
    // 让 ack 变成死信：更早进队 + next_retry_at 为空。
    ctx.exec(`UPDATE card_service_operations
        SET state = 'failed', next_retry_at = NULL, created_at = 0, attempts = 1
        WHERE operation_key = '${ACK_KEY}'`)
    seedOperation(ctx, { key: 'restock:task-live:ack', operation: 'ack', state: 'pending', attempts: 0, nextRetryAt: NOW, createdAt: 10 })

    seedOperation(ctx, { key: REVOKE_KEY, operation: 'revoke', state: 'failed', attempts: 1, nextRetryAt: null, createdAt: 0 })
    seedOperation(ctx, { key: buildRevokeIdempotencyKey('card_live', ORDER_ID), operation: 'revoke', state: 'pending', attempts: 0, nextRetryAt: NOW, createdAt: 10 })

    const acks = await listPendingCardServiceOperations(ctx.database, { operation: 'ack', limit: 1 })
    assert.deepEqual(acks.map((item) => item.operationKey), ['restock:task-live:ack'])

    const revokes = await listPendingRevokeOperations(ctx.database, { limit: 1 })
    assert.deepEqual(revokes.map((item) => item.operationKey), [buildRevokeIdempotencyKey('card_live', ORDER_ID)])
})

// ---------------------------------------------------------------------------
// 退避是**定时重放**的闸门，不是人工重试的闸门
// ---------------------------------------------------------------------------

test('定时重放遵守退避：未到期的待办这一轮跳过，人工重试仍拿得到', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const future = NOW + 5 * 60_000
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'failed', attempts: 1, nextRetryAt: NOW, createdAt: 0 })
    seedOperation(ctx, { key: ACK_KEY, operation: 'sell', state: 'failed', attempts: 1, nextRetryAt: future, createdAt: 10 })

    // 自动重放（`respectBackoff: true`）：只拿已到期的。少了这道过滤，每分钟一次的
    // 调度会让刚失败的操作立刻重试，12 次上限约 12 分钟就被烧光。
    const scheduled = await listPendingSellOperations(ctx.database, { limit: 10, respectBackoff: true, nowMs: NOW })
    assert.deepEqual(scheduled.map((item) => item.operationKey), [SELL_KEY])

    // 人工重试（默认不遵守退避）：两条都拿得到 —— 凭据刚配好就该能立刻补上。
    const manual = await listPendingSellOperations(ctx.database, { limit: 10 })
    assert.deepEqual(manual.map((item) => item.operationKey).sort(), [ACK_KEY, SELL_KEY].sort())
})

test('三条队列共用退避口径：revoke / ack 同样按 next_retry_at 过滤', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const future = NOW + 5 * 60_000
    seedOperation(ctx, { key: REVOKE_KEY, operation: 'revoke', state: 'failed', attempts: 1, nextRetryAt: future, createdAt: 0 })
    seedOperation(ctx, { key: ACK_KEY, operation: 'ack', state: 'failed', attempts: 1, nextRetryAt: future, createdAt: 0 })

    assert.deepEqual(
        await listPendingRevokeOperations(ctx.database, { limit: 10, respectBackoff: true, nowMs: NOW }),
        [],
    )
    assert.deepEqual(
        await listPendingCardServiceOperations(ctx.database, { operation: 'ack', limit: 10, respectBackoff: true, nowMs: NOW }),
        [],
    )
})

test('首次入队的待办（next_retry_at 为空）不受退避过滤影响', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'pending', attempts: 0, nextRetryAt: null })

    const rows = await listPendingSellOperations(ctx.database, { limit: 10, respectBackoff: true, nowMs: NOW })
    assert.deepEqual(rows.map((item) => item.operationKey), [SELL_KEY])
})

test('回归：已退款/已取消订单的 Sell 待办不占用重放队列', async () => {
    const ctx = createSqliteCardServiceDatabase()
    // 线上实况：退款订单留下的 40 条 Sell 待办 attempts 恒为 0、created_at 最早，
    // 交付入口对终态订单直接返回、不会推进它们 —— 不过滤就会永久吃光 `LIMIT`。
    ctx.exec(`INSERT INTO orders (order_id, product_id, product_name, amount, status) VALUES
        ('${ORDER_ID}', 'p', 'p', '0', 'refunded'),
        ('ORDER-C', 'p', 'p', '0', 'cancelled'),
        ('ORDER-PAID', 'p', 'p', '1', 'paid')`)
    seedOperation(ctx, { key: SELL_KEY, operation: 'sell', state: 'pending', attempts: 0, createdAt: 0 })
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, next_retry_at, created_at, updated_at) VALUES
        ('sell:c', 'sell', 'alloc_c', 'ORDER-C', 'pending', 0, NULL, 1, 1),
        ('sell:paid', 'sell', 'alloc_paid', 'ORDER-PAID', 'pending', 0, NULL, 2, 2)`)

    const rows = await listPendingSellOperations(ctx.database, { limit: 1, respectBackoff: true, nowMs: NOW })
    assert.deepEqual(rows.map((item) => item.operationKey), ['sell:paid'])
})
