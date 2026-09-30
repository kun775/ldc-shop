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
    productHasUnsettledCardServiceLedger,
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

// ---------------------------------------------------------------------------
// productHasUnsettledCardServiceLedger
// ---------------------------------------------------------------------------

/**
 * 说明：商品删除守卫的两路判定与订单守卫同构，但**归属维度不同** ——
 * 映射按 `product_id` 直查，待办表没有 `product_id` 列，只能按资源归属反查
 * （`sell` / `ack` 待办的 `resource_id` 是 allocation id，`revoke` 待办的是
 * 远端 card id）。下面把三种命中路径与两条放行路径都验一遍。
 */

const OTHER_PRODUCT_ID = 'prod_002'

function seedProduct(ctx: SqliteTestContext, id: string) {
    ctx.exec(`INSERT OR IGNORE INTO products (id) VALUES ('${id}')`)
}

function seedMappingFor(
    ctx: SqliteTestContext,
    options: { localCardId: number; remoteCardId: string; productId?: string; state?: string; allocationId?: string },
) {
    seedProduct(ctx, options.productId ?? PRODUCT_ID)
    ctx.exec(`INSERT INTO card_service_cards
        (local_card_id, remote_card_id, allocation_id, product_id, order_id, state, created_at, updated_at)
        VALUES (${options.localCardId}, '${options.remoteCardId}', '${options.allocationId ?? 'alloc_a'}',
                '${options.productId ?? PRODUCT_ID}', NULL, '${options.state ?? 'acknowledged'}', 0, 0)`)
}

function seedAllocation(ctx: SqliteTestContext, options: { allocationId: string; productId: string }) {
    ctx.exec(`INSERT INTO card_service_allocations
        (allocation_id, product_id, program_key, external_ref, quantity, state, request_key, ack_key,
         expires_at, created_at, updated_at)
        VALUES ('${options.allocationId}', '${options.productId}', 'prog', 'ref_${options.allocationId}', 1,
                'acknowledged', 'q_${options.allocationId}', 'a_${options.allocationId}', 0, 0, 0)`)
}

function seedScopedOperation(
    ctx: SqliteTestContext,
    options: { operationKey: string; operation: string; resourceId: string; state: string },
) {
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
        VALUES ('${options.operationKey}', '${options.operation}', '${options.resourceId}', NULL, '${options.state}', 0, 0, 0)`)
}

test('商品仍有 acknowledged 映射时不许删除：删掉映射中心那几张卡再也无法作废', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedMappingFor(ctx, { localCardId: 1, remoteCardId: 'card_a1' })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), true)
    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, OTHER_PRODUCT_ID), false)
})

test('商品仍有 sold 映射时同样不许删除：卡已在用户手里，删了就查不到来源', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedMappingFor(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'sold' })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), true)
})

test('只有 revoked 映射的商品可以删除：远端卡已是死卡', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedMappingFor(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'revoked' })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), false)
})

test('按 allocation 归属反查出未了结待办时不许删除商品', async () => {
    // Sell 意图已落账、映射行却还是 acknowledged 的窗口：映射查得到，但真正
    // 说明「中心可能已经卖掉了」的是这条 sell 待办。
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { allocationId: 'alloc_x', productId: PRODUCT_ID })
    seedScopedOperation(ctx, {
        operationKey: 'sell:alloc_x', operation: 'sell', resourceId: 'alloc_x', state: 'pending',
    })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), true)
})

test('按远端卡归属反查出未了结待办（revoke）时不许删除商品', async () => {
    // 退款后 `cards` 与映射可能已被清理，只剩 revoke 待办是「中心还留着一张已售出
    // 的卡」的唯一痕迹。此时映射状态是 revoked（不拦），但待办必须拦住。
    const ctx = createSqliteCardServiceDatabase()
    seedMappingFor(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'revoked' })
    seedScopedOperation(ctx, {
        operationKey: 'revoke:card_a1', operation: 'revoke', resourceId: 'card_a1', state: 'failed',
    })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), true)
})

test('终态待办（done / abandoned）不拦删除，否则历史商品永远删不掉', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { allocationId: 'alloc_done', productId: PRODUCT_ID })
    seedScopedOperation(ctx, {
        operationKey: 'sell:alloc_done', operation: 'sell', resourceId: 'alloc_done', state: 'done',
    })
    seedScopedOperation(ctx, {
        operationKey: 'sell:alloc_gone', operation: 'sell', resourceId: 'alloc_gone', state: 'abandoned',
    })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), false)
})

test('别的商品的未了结待办不会误伤本商品', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, OTHER_PRODUCT_ID)
    seedAllocation(ctx, { allocationId: 'alloc_other', productId: OTHER_PRODUCT_ID })
    seedScopedOperation(ctx, {
        operationKey: 'sell:alloc_other', operation: 'sell', resourceId: 'alloc_other', state: 'pending',
    })

    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, PRODUCT_ID), false)
    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, OTHER_PRODUCT_ID), true)
})

test('空商品号、缺表与缺列一律放行，不抛出', async () => {
    const ctx = createSqliteCardServiceDatabase()
    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, ''), false)
    assert.equal(await productHasUnsettledCardServiceLedger(ctx.database, '   '), false)
    assert.equal(await productHasUnsettledCardServiceLedger(missingTableDatabase, PRODUCT_ID), false)
})

test('0038 已建表但缺 product_id 列时不误伤（按缺列放行），不抛出', async () => {
    // 升级项半执行/旧表的真实形态：表在，列没有。此时删除商品必须放行 ——
    // 守卫是「多拦一层」，不该因为结构缺失把管理端整个卡死。
    const missingColumnDatabase = {
        async query(): Promise<never[]> {
            throw new Error('D1_ERROR: no such column: product_id')
        },
        async write(): Promise<never[]> {
            throw new Error('unreachable')
        },
    }

    assert.equal(await productHasUnsettledCardServiceLedger(missingColumnDatabase, PRODUCT_ID), false)
})
