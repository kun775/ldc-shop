import test from 'node:test'
import assert from 'node:assert/strict'

import {
    clampExpiredCleanupLimit,
    chunkCleanupIds,
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

test('收尾保持幂等：已取消订单补返积分和释放，重复执行不重复入账', async () => {
    const points = new Map<string, number>()
    const cards = new Map<string, string | null>([['stuck', 'stuck'], ['fresh', 'fresh']])
    const store: ExpiredCleanupStore = {
        async listPending() { return [] },
        async listReservedCancelled() { return [] },
        async cancelIfPending(orderId) {
            return orderId === 'fresh'
        },
        async returnPoints(candidate) {
            const key = `refund_return:${candidate.orderId}`
            if (points.has(key)) return
            points.set(key, candidate.pointsUsed ?? 0)
        },
        async releaseCoupons() { return 1 },
        async releaseCards(orderIds) {
            for (const orderId of orderIds) cards.set(orderId, null)
        },
    }
    const first = await settleExpiredCleanupBatch(store, [
        order('fresh', 'pending', 8),
        order('stuck', 'cancelled', 8),
        order('paid-won', 'pending', 8),
    ])
    const second = await settleExpiredCleanupBatch(store, [order('stuck', 'cancelled', 8)])
    assert.deepEqual(first, ['fresh', 'stuck'])
    assert.deepEqual(second, ['stuck'])
    assert.equal(points.size, 2)
    assert.equal(cards.get('fresh'), null)
    assert.equal(cards.get('stuck'), null)
})

test('返积分失败时不释放该订单的卡，调用方可以在下一轮重试', async () => {
    const released: string[] = []
    await assert.rejects(() => settleExpiredCleanupBatch({
        async listPending() { return [] },
        async listReservedCancelled() { return [] },
        async cancelIfPending() { return true },
        async returnPoints() { throw new Error('ledger unavailable') },
        async releaseCoupons() { return 0 },
        async releaseCards(orderIds) { released.push(...orderIds) },
    }, [order('fresh', 'pending', 5)]))
    assert.deepEqual(released, [])
})
