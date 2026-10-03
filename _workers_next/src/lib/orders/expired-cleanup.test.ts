import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
    EXPIRED_CLEANUP_CARDS_ONLY_RECOVERY_CONDITION_SQL,
    EXPIRED_CLEANUP_POINT_RECOVERY_WINDOW_MS,
    buildExpiredCleanupRecoveryConditionSql,
    clampExpiredCleanupLimit,
    chunkCleanupIds,
    refundablePointsParams,
    selectExpiredCleanupCandidates,
    settleExpiredCleanupBatch,
    type ExpiredCleanupStore,
    type ExpiredOrderCandidate,
} from './expired-cleanup.ts'

function order(id: string, status: string, points = 0): ExpiredOrderCandidate {
    return {
        orderId: id,
        productId: 'product',
        userId: 'user',
        username: null,
        email: null,
        pointsUsed: points,
        status,
    }
}

test('超时清理上限：缺失与非法值用 20，合法值夹在 1 到 100', () => {
    assert.equal(clampExpiredCleanupLimit(undefined), 20)
    assert.equal(clampExpiredCleanupLimit(Number.NaN), 20)
    assert.equal(clampExpiredCleanupLimit(0), 1)
    assert.equal(clampExpiredCleanupLimit(7), 7)
    assert.equal(clampExpiredCleanupLimit(500), 100)
})

test('卡释放按 90 个订单分块，避免单条语句超过 100 个参数', () => {
    const chunks = chunkCleanupIds(Array.from({ length: 91 }, (_, index) => `order-${index}`))
    assert.deepEqual(chunks.map((chunk) => chunk.length), [90, 1])
})

test('候选名额先给待取消订单，剩余才用来恢复已取消但仍押卡的订单', async () => {
    const store = {
        async listPending() {
            return [order('pending-1', 'pending'), order('pending-2', 'pending')]
        },
        async listReservedCancelled(input: { limit: number }) {
            assert.equal(input.limit, 1)
            return [order('stuck', 'cancelled')]
        },
    }
    const selected = await selectExpiredCleanupCandidates(store, { deadlineMs: 1, limit: 3 })
    assert.deepEqual(selected.map((row) => row.orderId), ['pending-1', 'pending-2', 'stuck'])
})

test('待取消订单占满名额时，本轮不查询恢复项', async () => {
    let recoveryReads = 0
    const selected = await selectExpiredCleanupCandidates({
        async listPending() { return [order('pending-1', 'pending')] },
        async listReservedCancelled() { recoveryReads += 1; return [] },
    }, { deadlineMs: 1, limit: 1 })
    assert.deepEqual(selected.map((row) => row.orderId), ['pending-1'])
    assert.equal(recoveryReads, 0)
})

function memoryStore(overrides: Partial<ExpiredCleanupStore> = {}) {
    const points = new Map<string, number>()
    const cards = new Map<string, string | null>()
    const store: ExpiredCleanupStore = {
        async listPending() { return [] },
        async listReservedCancelled() { return [] },
        async cancelIfPending(orderId) { return !orderId.startsWith('paid') },
        async shouldReturnPoints(candidate) { return !points.has(`refund_return:${candidate.orderId}`) },
        async returnPoints(candidate) {
            const key = `refund_return:${candidate.orderId}`
            if (points.has(key)) return
            points.set(key, candidate.pointsUsed ?? 0)
        },
        async releaseCoupons() { return 1 },
        async releaseCards(orderIds) {
            for (const orderId of orderIds) cards.set(orderId, null)
        },
        ...overrides,
    }
    return { store, points, cards }
}

test('收尾保持幂等：已取消订单补返积分和释放，重复执行不重复入账', async () => {
    const { store, points, cards } = memoryStore()
    const first = await settleExpiredCleanupBatch(store, [
        order('fresh', 'pending', 8),
        order('stuck', 'cancelled', 8),
        order('paid-won', 'pending', 8),
    ])
    const second = await settleExpiredCleanupBatch(store, [order('stuck', 'cancelled', 8)])
    assert.deepEqual(first.settled.map((row) => row.orderId), ['fresh', 'stuck'])
    assert.deepEqual(first.failed, [])
    assert.equal(first.releasedCouponUsages, 2)
    assert.deepEqual(second.settled.map((row) => row.orderId), ['stuck'])
    assert.equal(points.size, 2)
    assert.equal(cards.get('fresh'), null)
    assert.equal(cards.get('stuck'), null)
    assert.equal(cards.has('paid-won'), false)
})

test('返积分失败只影响该订单：它的卡不释放，同批其他订单照常收尾', async () => {
    const { store, cards } = memoryStore({
        async returnPoints(candidate) {
            if (candidate.orderId === 'broken') throw new Error('ledger unavailable')
        },
    })
    const result = await settleExpiredCleanupBatch(store, [
        order('before', 'pending', 5),
        order('broken', 'pending', 5),
        order('after', 'cancelled', 5),
    ])
    assert.deepEqual(result.settled.map((row) => row.orderId), ['before', 'after'])
    assert.deepEqual(result.failed.map((row) => [row.orderId, row.step]), [['broken', 'points']])
    assert.equal(cards.get('before'), null)
    assert.equal(cards.get('after'), null)
    assert.equal(cards.has('broken'), false)
})

test('券释放失败同样逐单隔离，不再被吞掉后照常放卡', async () => {
    const { store, cards } = memoryStore({
        async releaseCoupons(orderId) {
            if (orderId === 'coupon-broken') throw new Error('D1 busy')
            return 0
        },
    })
    const result = await settleExpiredCleanupBatch(store, [order('coupon-broken', 'pending'), order('ok', 'pending')])
    assert.deepEqual(result.failed.map((row) => [row.orderId, row.step]), [['coupon-broken', 'coupons']])
    assert.equal(cards.has('coupon-broken'), false)
    assert.equal(cards.get('ok'), null)
})

test('取消失败（例如 D1 写入异常）也不中断整批', async () => {
    const { store } = memoryStore({
        async cancelIfPending(orderId) {
            if (orderId === 'x') throw new Error('write failed')
            return true
        },
    })
    const result = await settleExpiredCleanupBatch(store, [order('x', 'pending'), order('y', 'pending')])
    assert.deepEqual(result.settled.map((row) => row.orderId), ['y'])
    assert.deepEqual(result.failed.map((row) => [row.orderId, row.step]), [['x', 'cancel']])
})

test('释放押卡失败不丢已完成的状态、积分与券；订单记为 cards 失败等下一轮', async () => {
    const { store, points } = memoryStore({
        async releaseCards() { throw new Error('D1 timeout') },
    })
    const result = await settleExpiredCleanupBatch(store, [order('a', 'pending', 3)])
    assert.deepEqual(result.settled.map((row) => row.orderId), ['a'])
    assert.deepEqual(result.failed.map((row) => [row.orderId, row.step]), [['a', 'cards']])
    assert.equal(points.get('refund_return:a'), 3)
})

test('账本判定不需要返还时不调用 returnPoints（历史回填订单不重复返还）', async () => {
    let returned = 0
    const { store } = memoryStore({
        async shouldReturnPoints() { return false },
        async returnPoints() { returned += 1 },
    })
    const result = await settleExpiredCleanupBatch(store, [order('legacy', 'cancelled', 9)])
    assert.equal(returned, 0)
    assert.deepEqual(result.settled.map((row) => row.orderId), ['legacy'])
})

// ---------------------------------------------------------------------------
// 恢复条件 SQL：用真实 SQLite 跑生产里那段原文
// ---------------------------------------------------------------------------

interface SqliteDb {
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] }
}
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb }

const NOW = 1_800_000_000_000

function recoveryDb(): SqliteDb {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE orders (order_id TEXT PRIMARY KEY, status TEXT, user_id TEXT, points_used INTEGER DEFAULT 0, created_at INTEGER);
        CREATE TABLE cards (id INTEGER PRIMARY KEY, reserved_order_id TEXT, is_used INTEGER DEFAULT 0);
        CREATE TABLE coupon_usages (id TEXT PRIMARY KEY, order_id TEXT, status TEXT);
        CREATE TABLE user_point_ledger (id INTEGER PRIMARY KEY, business_key TEXT UNIQUE, status TEXT, metadata TEXT);
    `)
    return database
}

function recovered(database: SqliteDb, nowMs = NOW): string[] {
    return database.prepare(
        `SELECT order_id FROM orders WHERE status = 'cancelled' AND ${buildExpiredCleanupRecoveryConditionSql(nowMs)} ORDER BY order_id`,
    ).all().map((row) => String(row.order_id))
}

test('恢复条件：押卡、券仍 reserved、积分未返三种残留都能被重新找到', () => {
    const database = recoveryDb()
    const recent = NOW - 60_000
    database.exec(`
        INSERT INTO orders VALUES
            ('card-held', 'cancelled', 'u', 0, ${recent}),
            ('card-used', 'cancelled', 'u', 0, ${recent}),
            ('coupon-held', 'cancelled', 'u', 0, ${recent}),
            ('coupon-done', 'cancelled', 'u', 0, ${recent}),
            ('points-owed', 'cancelled', 'u', 5, ${recent}),
            ('points-returned', 'cancelled', 'u', 5, ${recent}),
            ('points-legacy', 'cancelled', 'u', 5, ${recent}),
            ('points-pending', 'cancelled', 'u', 5, ${recent}),
            ('points-old', 'cancelled', 'u', 5, ${NOW - EXPIRED_CLEANUP_POINT_RECOVERY_WINDOW_MS - 1}),
            ('clean', 'cancelled', 'u', 0, ${recent}),
            ('still-pending', 'pending', 'u', 5, ${recent});
        INSERT INTO cards (reserved_order_id, is_used) VALUES ('card-held', 0), ('card-used', 1), ('still-pending', 0);
        INSERT INTO coupon_usages VALUES ('c1', 'coupon-held', 'reserved'), ('c2', 'coupon-done', 'released');
        INSERT INTO user_point_ledger (business_key, status, metadata) VALUES
            ('order_deduction:points-owed', 'completed', '{"productId":"p"}'),
            ('order_deduction:points-returned', 'completed', '{"productId":"p"}'),
            ('refund_return:points-returned', 'completed', NULL),
            ('order_deduction:points-legacy', 'completed', NULL),
            ('order_deduction:points-pending', 'pending', '{"productId":"p"}'),
            ('order_deduction:points-old', 'completed', '{"productId":"p"}');
    `)
    assert.deepEqual(recovered(database), ['card-held', 'coupon-held', 'points-owed'])
})

test('恢复条件：退化版只看未使用的押卡', () => {
    const database = recoveryDb()
    database.exec(`
        INSERT INTO orders VALUES ('a', 'cancelled', 'u', 0, 1), ('b', 'cancelled', 'u', 0, 1);
        INSERT INTO cards (reserved_order_id, is_used) VALUES ('a', NULL), ('b', 1);
    `)
    const rows = database.prepare(
        `SELECT order_id FROM orders WHERE status = 'cancelled' AND ${EXPIRED_CLEANUP_CARDS_ONLY_RECOVERY_CONDITION_SQL}`,
    ).all().map((row) => String(row.order_id))
    assert.deepEqual(rows, ['a'])
})

test('返积分判定键与 checkout / 各取消流程共用的 businessKey 一致', () => {
    assert.deepEqual(refundablePointsParams('ORD1'), ['order_deduction:ORD1', 'refund_return:ORD1'])
})

test('入口接线：生产 cancelExpiredOrders 走 settleExpiredCleanupBatch 与扩展后的恢复条件', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../db/queries.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export async function cancelExpiredOrders(')
    assert.ok(start >= 0, '找不到 cancelExpiredOrders')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    assert.match(body, /settleExpiredCleanupBatch\(/)
    assert.match(body, /buildExpiredCleanupRecoveryConditionSql\(/)
    assert.match(body, /shouldReturnPoints/)
    // 旧的「只按押卡恢复」与吞掉券释放异常的写法不得回来。
    assert.doesNotMatch(body, /EXISTS \(SELECT 1 FROM cards WHERE cards\.reserved_order_id/)
    assert.doesNotMatch(body, /Release on timeout cancel failed/)
    // 释放押卡必须带 is_used 条件。
    assert.match(body, /isNull\(cards\.isUsed\)/)
})
