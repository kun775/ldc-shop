/**
 * `guards.ts` 的单测。
 *
 * 这些判断决定「哪些行不许被物理删除」，一旦判错就是不可逆的：删掉映射后
 * 那张远端卡再也无法作废。所以每条路径都要在真实 SQLite 上验一遍，
 * 包括「0038 未执行 → 表不存在」这个必须放行的窗口。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    listProtectedLocalCardIds,
    orderHasPendingCardServiceOperations,
    orderHasRemoteMappings,
    orderHasUnsettledCardServiceLedger,
    partitionDeletableLocalCardIds,
} from './guards.ts'
import { createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

const PRODUCT_ID = 'prod_001'

function seedCard(ctx: SqliteTestContext, id: number) {
    ctx.exec(`INSERT OR IGNORE INTO products (id) VALUES ('${PRODUCT_ID}')`)
    ctx.exec(`INSERT OR IGNORE INTO cards (id, product_id, card_key, is_used)
        VALUES (${id}, '${PRODUCT_ID}', 'KEY-${id}', 0)`)
}

function seedMapping(
    ctx: SqliteTestContext,
    options: { localCardId: number; remoteCardId: string; state?: string; orderId?: string | null },
) {
    ctx.exec(`INSERT INTO card_service_cards
        (local_card_id, remote_card_id, allocation_id, product_id, order_id, state, created_at, updated_at)
        VALUES (${options.localCardId}, '${options.remoteCardId}', 'alloc_a', '${PRODUCT_ID}',
                ${options.orderId ? `'${options.orderId}'` : 'NULL'}, '${options.state ?? 'acknowledged'}', 0, 0)`)
}

const missingTableDatabase = {
    async query(): Promise<never[]> {
        throw new Error('D1_ERROR: no such table: card_service_cards')
    },
    async write(): Promise<never[]> {
        throw new Error('unreachable')
    },
}

// ---------------------------------------------------------------------------
// listProtectedLocalCardIds
// ---------------------------------------------------------------------------

test('没有远端映射的卡全部可删', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedCard(ctx, 2)

    assert.deepEqual(await listProtectedLocalCardIds(ctx.database, [1, 2]), [])
})

test('有远端映射的卡被保护，未映射的邻居不受影响', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1' })

    assert.deepEqual(await listProtectedLocalCardIds(ctx.database, [1, 2]), [1])
})

test('已作废的映射同样保护本地卡：删掉它等于抹掉「这张卡已不可售」的记录', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 5)
    seedMapping(ctx, { localCardId: 5, remoteCardId: 'card_a5', state: 'revoked' })

    assert.deepEqual(await listProtectedLocalCardIds(ctx.database, [5]), [5])
})

test('升级项 0038 未执行时一律放行，保持既有删除行为', async () => {
    assert.deepEqual(await listProtectedLocalCardIds(missingTableDatabase, [1, 2, 3]), [])
    assert.equal(await orderHasRemoteMappings(missingTableDatabase, 'ORDER-1'), false)
})

test('空输入与重复 ID 都不会触发出错', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 3)
    seedMapping(ctx, { localCardId: 3, remoteCardId: 'card_a3' })

    assert.deepEqual(await listProtectedLocalCardIds(ctx.database, []), [])
    assert.deepEqual(await listProtectedLocalCardIds(ctx.database, [3, 3, 3]), [3])
})

// ---------------------------------------------------------------------------
// partitionDeletableLocalCardIds
// ---------------------------------------------------------------------------

test('批次被拆成可删与受保护两部分，供管理端如实告知管理员', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedCard(ctx, 3)
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_a2' })

    const result = await partitionDeletableLocalCardIds(ctx.database, [1, 2, 3])
    assert.deepEqual(result.deletable, [1, 3])
    assert.deepEqual(result.protectedIds, [2])
})

test('一个都没映射时 partition 保持原顺序放行', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const result = await partitionDeletableLocalCardIds(ctx.database, [9, 4, 7])
    assert.deepEqual(result.deletable, [9, 4, 7])
    assert.deepEqual(result.protectedIds, [])
})

test('partition 对空批次返回两个空数组', async () => {
    const ctx = createSqliteCardServiceDatabase()
    assert.deepEqual(await partitionDeletableLocalCardIds(ctx.database, []), {
        deletable: [],
        protectedIds: [],
    })
})

// ---------------------------------------------------------------------------
// orderHasRemoteMappings
// ---------------------------------------------------------------------------

test('订单持有远端映射时不允许物理删除', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', orderId: 'ORDER-1' })

    assert.equal(await orderHasRemoteMappings(ctx.database, 'ORDER-1'), true)
    assert.equal(await orderHasRemoteMappings(ctx.database, 'ORDER-2'), false)
})

test('映射没有归属订单时不会被误判成某个订单持有', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', orderId: null })

    assert.equal(await orderHasRemoteMappings(ctx.database, 'ORDER-1'), false)
})

test('空订单号直接返回 false，不发出无意义查询', async () => {
    const ctx = createSqliteCardServiceDatabase()
    assert.equal(await orderHasRemoteMappings(ctx.database, ''), false)
    assert.equal(await orderHasRemoteMappings(ctx.database, '   '), false)
})

// ---------------------------------------------------------------------------
// orderHasPendingCardServiceOperations / orderHasUnsettledCardServiceLedger
// ---------------------------------------------------------------------------

function seedOperation(ctx: SqliteTestContext, orderId: string, state: string, operation = 'sell') {
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
        VALUES ('${operation}:card_${orderId}:${operation}', '${operation}', 'card_${orderId}', '${orderId}', '${state}', 0, 0, 0)`)
}

test('待重放的中心待办（sell / revoke 的 pending / failed）会拦住订单删除', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, 'ORDER-P', 'pending')
    seedOperation(ctx, 'ORDER-F', 'failed')
    seedOperation(ctx, 'ORDER-R', 'pending', 'revoke')

    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-P'), true)
    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-F'), true)
    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-R'), true)
})

test('终态待办（done / abandoned）不再拦删除，否则历史订单永远删不掉', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, 'ORDER-D', 'done')
    seedOperation(ctx, 'ORDER-A', 'abandoned')

    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-D'), false)
    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-A'), false)
})

test('空订单号与缺表都直接放行，不抛出', async () => {
    const ctx = createSqliteCardServiceDatabase()
    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, '  '), false)
    assert.equal(await orderHasPendingCardServiceOperations(missingTableDatabase, 'ORDER-1'), false)
    assert.equal(await orderHasUnsettledCardServiceLedger(missingTableDatabase, 'ORDER-1'), false)
})

test('总闸门两路取或：只有待办、没有映射，同样拦下', async () => {
    const ctx = createSqliteCardServiceDatabase()
    // Sell 意图已经落账，但映射行还在 acknowledged / 尚未写入 —— 这正是
    // 「中心可能已经卖掉、本地还没确认」的窗口，只查映射会漏掉。
    seedOperation(ctx, 'ORDER-SELL', 'pending')

    assert.equal(await orderHasRemoteMappings(ctx.database, 'ORDER-SELL'), false)
    assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'ORDER-SELL'), true)
})

test('总闸门两路取或：只有映射、没有待办，同样拦下', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', orderId: 'ORDER-MAP' })

    assert.equal(await orderHasPendingCardServiceOperations(ctx.database, 'ORDER-MAP'), false)
    assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'ORDER-MAP'), true)
})

test('两路都没有时订单可以正常删除', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOperation(ctx, 'ORDER-CLEAN', 'done')
    seedCard(ctx, 2)
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_a2', orderId: 'ORDER-OTHER' })

    assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'ORDER-CLEAN'), false)
})
