/**
 * `ops.ts` 的单测。
 *
 * 用的是 `test-support.ts` 里的**真实 SQLite**（内存库），不是替身对象 ——
 * 这个模块的价值全在 SQL 本身（分组计数、join 口径、子查询关联），
 * 用假数据库等于把要验的东西验没了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    CARD_SERVICE_EXPIRING_SOON_DEFAULT_MS,
    emptyCardServiceDrift,
    loadCardServiceOverview,
    listCardServiceProductStatus,
    listCardServiceReviewQueue,
} from './ops.ts'
import { createSqliteCardServiceDatabase } from './test-support.ts'

const NOW = Date.parse('2026-09-30T10:00:00.000Z')
const MINUTE = 60_000

function makeContext() {
    return createSqliteCardServiceDatabase()
}

type Ctx = ReturnType<typeof makeContext>

async function insertAllocation(
    ctx: Ctx,
    overrides: {
        allocationId?: string
        productId?: string
        programKey?: string
        state?: string
        quantity?: number
        expiresAt?: number
        ackedAt?: number | null
    } = {},
) {
    await ctx.database.write([{
        sql: `INSERT INTO card_service_allocations
            (allocation_id, product_id, program_key, external_ref, quantity, state,
             request_key, ack_key, expires_at, acked_at, sold_at, last_error_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        params: [
            overrides.allocationId ?? 'alloc_1',
            overrides.productId ?? 'prod_1',
            overrides.programKey ?? 'bill-service',
            `ref:${overrides.allocationId ?? 'alloc_1'}`,
            overrides.quantity ?? 1,
            overrides.state ?? 'allocated',
            `req:${overrides.allocationId ?? 'alloc_1'}`,
            `ack:${overrides.allocationId ?? 'alloc_1'}`,
            overrides.expiresAt ?? NOW + 30 * MINUTE,
            overrides.ackedAt ?? null,
            NOW,
            NOW,
        ],
    }])
}

async function insertMapping(
    ctx: Ctx,
    overrides: {
        localCardId?: number
        remoteCardId?: string
        allocationId?: string
        productId?: string
        orderId?: string | null
        state?: string
    } = {},
    options: { orphan?: boolean } = {},
) {
    const localCardId = overrides.localCardId ?? 1
    const productId = overrides.productId ?? 'prod_1'
    // 默认让映射指向真实存在的本地卡 —— 否则每个用到映射的用例都会顺带
    // 命中 `orphanMappings`，把要验的口径淹掉。仅孤立映射用例显式跳过。
    if (!options.orphan) await insertLocalCard(ctx, { id: localCardId, productId })
    await ctx.database.write([{
        sql: `INSERT INTO card_service_cards
            (local_card_id, remote_card_id, allocation_id, product_id, order_id, state,
             sold_at, revoked_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        params: [
            localCardId,
            overrides.remoteCardId ?? `remote_${localCardId}`,
            overrides.allocationId ?? 'alloc_1',
            productId,
            overrides.orderId ?? null,
            overrides.state ?? 'acknowledged',
            NOW,
            NOW,
        ],
    }])
}

async function insertOperation(
    ctx: Ctx,
    overrides: {
        operationKey?: string
        operation?: string
        resourceId?: string
        orderId?: string | null
        state?: string
        attempts?: number
        nextRetryAt?: number | null
        lastErrorCode?: string | null
    } = {},
) {
    const key = overrides.operationKey ?? 'op_1'
    await ctx.database.write([{
        sql: `INSERT INTO card_service_operations
            (operation_key, operation, resource_id, order_id, state, attempts,
             next_retry_at, request_id, last_error_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        params: [
            key,
            overrides.operation ?? 'ack',
            overrides.resourceId ?? 'alloc_1',
            overrides.orderId ?? null,
            overrides.state ?? 'pending',
            overrides.attempts ?? 0,
            overrides.nextRetryAt ?? null,
            overrides.lastErrorCode ?? null,
            NOW,
            NOW,
        ],
    }])
}

async function insertLocalCard(
    ctx: Ctx,
    overrides: { id?: number; productId?: string; isUsed?: number; reservedOrderId?: string | null } = {},
) {
    const productId = overrides.productId ?? 'prod_1'
    await ctx.database.write([
        // `cards.product_id` 有外键指向 `products`，真实约束要一并满足。
        // OR IGNORE：`insertMapping` 会为同一张卡补默认行，重复插入不该报错。
        { sql: `INSERT OR IGNORE INTO products (id) VALUES (?)`, params: [productId] },
        {
            sql: `INSERT OR IGNORE INTO cards (id, product_id, card_key, is_used, reserved_order_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
            params: [
                overrides.id ?? 1,
                productId,
                `KEY-${overrides.id ?? 1}`,
                overrides.isUsed ?? 0,
                overrides.reservedOrderId ?? null,
                NOW,
            ],
        },
    ])
}

async function insertOrder(ctx: Ctx, overrides: { orderId?: string; status?: string; productId?: string } = {}) {
    await ctx.database.write([{
        sql: `INSERT INTO orders (order_id, product_id, product_name, amount, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
            overrides.orderId ?? 'order_1',
            overrides.productId ?? 'prod_1',
            'Bill Service',
            '9.90',
            overrides.status ?? 'delivered',
            NOW,
        ],
    }])
}

async function insertStagedCard(
    ctx: Ctx,
    overrides: { remoteCardId?: string; allocationId?: string; productId?: string } = {},
) {
    const remoteCardId = overrides.remoteCardId ?? 'remote_staged'
    await ctx.database.write([{
        sql: `INSERT INTO card_service_staged_cards
            (remote_card_id, allocation_id, product_id, card_key, masked_key, created_at)
            VALUES (?, ?, ?, ?, NULL, ?)`,
        params: [
            remoteCardId,
            overrides.allocationId ?? 'alloc_1',
            overrides.productId ?? 'prod_1',
            `RAW-${remoteCardId}`,
            NOW,
        ],
    }])
}

async function insertProductConfig(
    ctx: Ctx,
    overrides: {
        productId?: string
        supplyMode?: string
        programKey?: string | null
        targetStock?: number | null
    } = {},
) {
    const productId = overrides.productId ?? 'prod_1'
    await ctx.database.write([{
        sql: `INSERT INTO card_service_product_configs
            (product_id, supply_mode, program_key, target_stock, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
            productId,
            overrides.supplyMode ?? 'license_service',
            overrides.programKey === undefined ? 'bill-service' : overrides.programKey,
            overrides.targetStock === undefined ? 5 : overrides.targetStock,
            NOW,
            NOW,
        ],
    }])
}

// ---------------------------------------------------------------------------
// 未执行 0038 的窗口
// ---------------------------------------------------------------------------

test('overview reports enabled=false when the ledger tables are missing', async () => {
    const database = {
        async query(): Promise<never[]> {
            throw new Error('D1_ERROR: no such table: card_service_allocations')
        },
        async write(): Promise<never[]> {
            throw new Error('unreachable')
        },
    }

    const overview = await loadCardServiceOverview(database, { now: NOW })
    assert.equal(overview.enabled, false)
    assert.equal(overview.reviewCount, 0)
    assert.deepEqual(overview.drift, emptyCardServiceDrift())
    assert.equal(overview.checkedAtMs, NOW)

    const queue = await listCardServiceReviewQueue(database, { now: NOW })
    assert.equal(queue.enabled, false)
    assert.deepEqual(queue.failedOperations, [])

    assert.deepEqual(await listCardServiceProductStatus(database), [])
})

test('empty ledger yields an enabled all-zero overview', async () => {
    const ctx = makeContext()
    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })

    assert.equal(overview.enabled, true)
    assert.equal(overview.cards.total, 0)
    assert.equal(overview.stagedCards, 0)
    assert.equal(overview.operations.ack.total, 0)
    assert.equal(overview.allocations.allocated, 0)
    assert.equal(overview.reviewCount, 0)
    assert.deepEqual(overview.expiring, [])
})

// ---------------------------------------------------------------------------
// 计数
// ---------------------------------------------------------------------------

test('operation counters are grouped by operation and state', async () => {
    const ctx = makeContext()
    await insertOperation(ctx, { operationKey: 'a1', operation: 'ack', state: 'pending' })
    await insertOperation(ctx, { operationKey: 'a2', operation: 'ack', state: 'done' })
    await insertOperation(ctx, { operationKey: 'a3', operation: 'ack', state: 'failed' })
    await insertOperation(ctx, { operationKey: 's1', operation: 'sell', state: 'pending' })
    await insertOperation(ctx, { operationKey: 's2', operation: 'sell', state: 'abandoned' })
    await insertOperation(ctx, { operationKey: 'r1', operation: 'revoke', state: 'failed' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.deepEqual(overview.operations.ack, { pending: 1, failed: 1, abandoned: 0, done: 1, total: 3 })
    assert.deepEqual(overview.operations.sell, { pending: 1, failed: 0, abandoned: 1, done: 0, total: 2 })
    assert.deepEqual(overview.operations.revoke, { pending: 0, failed: 1, abandoned: 0, done: 0, total: 1 })
})

test('unknown operation names are ignored instead of inflating a known bucket', async () => {
    const ctx = makeContext()
    await insertOperation(ctx, { operationKey: 'x1', operation: 'mystery', state: 'pending' })
    await insertOperation(ctx, { operationKey: 'a1', operation: 'ack', state: 'pending' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.operations.ack.total, 1)
    assert.equal(overview.operations.sell.total, 0)
})

test('allocation and card counts are grouped, with unknown mapping states isolated', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'alloc_1', state: 'allocated' })
    await insertAllocation(ctx, { allocationId: 'alloc_2', state: 'allocated' })
    await insertAllocation(ctx, { allocationId: 'alloc_3', state: 'sold' })
    await insertAllocation(ctx, { allocationId: 'alloc_4', state: 'expired' })

    await insertMapping(ctx, { localCardId: 1, state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 2, state: 'sold' })
    await insertMapping(ctx, { localCardId: 3, state: 'revoked' })
    await insertMapping(ctx, { localCardId: 4, state: 'weird' })
    await insertStagedCard(ctx, { remoteCardId: 'r1' })
    await insertStagedCard(ctx, { remoteCardId: 'r2' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.allocations.allocated, 2)
    assert.equal(overview.allocations.sold, 1)
    assert.equal(overview.allocations.expired, 1)
    assert.equal(overview.allocations.cancelled, 0)
    assert.deepEqual(overview.cards, { acknowledged: 1, sold: 1, revoked: 1, other: 1, total: 4 })
    assert.equal(overview.stagedCards, 2)
})

// ---------------------------------------------------------------------------
// 临近超窗
// ---------------------------------------------------------------------------

test('expiring list only covers allocated rows within the threshold, sorted by deadline', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'soon_2', expiresAt: NOW + 2 * MINUTE })
    await insertAllocation(ctx, { allocationId: 'soon_1', expiresAt: NOW + MINUTE })
    await insertAllocation(ctx, { allocationId: 'overdue', expiresAt: NOW - MINUTE })
    await insertAllocation(ctx, { allocationId: 'later', expiresAt: NOW + 60 * MINUTE })
    // 已 Ack 的分配即使 expires_at 临近也不该出现在这个列表里。
    await insertAllocation(ctx, { allocationId: 'acked', state: 'acknowledged', expiresAt: NOW + MINUTE })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.deepEqual(
        overview.expiring.map((row) => row.allocationId),
        ['overdue', 'soon_1', 'soon_2'],
    )
    assert.equal(overview.expiring[0].remainingMs, -MINUTE)
    assert.deepEqual(overview.overdue.map((row) => row.allocationId), ['overdue'])
})

test('a wider expiring threshold surfaces allocations that are not yet urgent', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'todays', expiresAt: NOW + 20 * MINUTE })

    const narrow = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(narrow.expiring.length, 0)

    const wide = await loadCardServiceOverview(ctx.database, {
        now: NOW,
        expiringSoonMs: 30 * MINUTE,
    })
    assert.deepEqual(wide.expiring.map((row) => row.allocationId), ['todays'])
})

test('the default expiring threshold stays at five minutes', () => {
    assert.equal(CARD_SERVICE_EXPIRING_SOON_DEFAULT_MS, 5 * 60_000)
})

// ---------------------------------------------------------------------------
// 漂移口径
// ---------------------------------------------------------------------------

test('overview preserves all six metrics under a restrictive compound SELECT limit', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'expired', state: 'expired' })
    await insertOrder(ctx, { orderId: 'delivered', status: 'delivered' })
    await insertMapping(ctx, { localCardId: 1, allocationId: 'expired', orderId: 'delivered' })
    await insertMapping(ctx, { localCardId: 99, state: 'sold' }, { orphan: true })
    await insertStagedCard(ctx, { allocationId: 'missing' })

    // 本地 SQLite 的默认上限更高；模拟受限平台的复合 SELECT 上限，
    // 其余查询仍交给真实内存 SQLite 执行，验证六项统计没有被漏算。
    const database: typeof ctx.database = {
        ...ctx.database,
        async query<T>(sql: string, params?: readonly unknown[]) {
            const terms = 1 + (sql.match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0)
            if (terms > 5) throw new Error('too many terms in compound SELECT')
            return ctx.database.query<T>(sql, params)
        },
    }

    const overview = await loadCardServiceOverview(database, { now: NOW })
    assert.equal(overview.enabled, true)
    assert.deepEqual(overview.drift, {
        sellableRemoteCards: 1,
        soldWithoutDeliveredOrder: 1,
        deliveredWithoutRemoteSold: 1,
        expiredWithSellableCards: 1,
        orphanMappings: 1,
        stagedWithoutActiveAllocation: 1,
    })
    assert.equal(overview.reviewCount, 5)
})

test('sellableRemoteCards counts acknowledged mappings and is excluded from reviewCount', async () => {
    const ctx = makeContext()
    await insertMapping(ctx, { localCardId: 1, state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 2, state: 'acknowledged' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.sellableRemoteCards, 2)
    assert.equal(overview.reviewCount, 0)
})

test('soldWithoutDeliveredOrder catches a mapping sold before the order flipped', async () => {
    const ctx = makeContext()
    await insertOrder(ctx, { orderId: 'order_paid', status: 'paid' })
    await insertOrder(ctx, { orderId: 'order_ok', status: 'delivered' })
    await insertMapping(ctx, { localCardId: 1, orderId: 'order_paid', state: 'sold' })
    await insertMapping(ctx, { localCardId: 2, orderId: 'order_ok', state: 'sold' })
    // 没有对应订单行的 sold 映射同样计入。
    await insertMapping(ctx, { localCardId: 3, orderId: null, state: 'sold' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.soldWithoutDeliveredOrder, 2)
    assert.equal(overview.reviewCount, 2)
})

test('deliveredWithoutRemoteSold flags delivered orders whose mapping is not sold or revoked', async () => {
    const ctx = makeContext()
    await insertOrder(ctx, { orderId: 'order_bad', status: 'delivered' })
    await insertOrder(ctx, { orderId: 'order_sold', status: 'delivered' })
    await insertOrder(ctx, { orderId: 'order_refunded', status: 'delivered' })
    await insertMapping(ctx, { localCardId: 1, orderId: 'order_bad', state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 2, orderId: 'order_sold', state: 'sold' })
    // 退款作废后订单可能仍是 delivered，映射已经是 revoked —— 这不算漂移。
    await insertMapping(ctx, { localCardId: 3, orderId: 'order_refunded', state: 'revoked' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.deliveredWithoutRemoteSold, 1)
})

test('expiredWithSellableCards flags live stock left behind by a terminal allocation', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'alloc_expired', state: 'expired' })
    await insertAllocation(ctx, { allocationId: 'alloc_cancelled', state: 'cancelled' })
    await insertAllocation(ctx, { allocationId: 'alloc_ok', state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 1, allocationId: 'alloc_expired', state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 2, allocationId: 'alloc_cancelled', state: 'acknowledged' })
    await insertMapping(ctx, { localCardId: 3, allocationId: 'alloc_ok', state: 'acknowledged' })
    // 该 allocation 已作废，但映射已进入 sold：由作废路径负责，不计入可售残留口径。
    await insertMapping(ctx, { localCardId: 4, allocationId: 'alloc_expired', state: 'sold' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.expiredWithSellableCards, 2)
})

test('orphanMappings counts mappings without a local card row', async () => {
    const ctx = makeContext()
    await insertMapping(ctx, { localCardId: 1 })
    await insertMapping(ctx, { localCardId: 99, remoteCardId: 'remote_orphan' }, { orphan: true })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.orphanMappings, 1)
    assert.equal(overview.reviewCount, 1)
})

test('stagedWithoutActiveAllocation spots staged keys whose allocation moved on', async () => {
    const ctx = makeContext()
    await insertAllocation(ctx, { allocationId: 'alloc_live', state: 'allocated' })
    await insertAllocation(ctx, { allocationId: 'alloc_acked', state: 'acknowledged' })
    await insertStagedCard(ctx, { remoteCardId: 'r_live', allocationId: 'alloc_live' })
    await insertStagedCard(ctx, { remoteCardId: 'r_stale', allocationId: 'alloc_acked' })
    await insertStagedCard(ctx, { remoteCardId: 'r_ghost', allocationId: 'alloc_missing' })

    const overview = await loadCardServiceOverview(ctx.database, { now: NOW })
    assert.equal(overview.drift.stagedWithoutActiveAllocation, 2)
})

// ---------------------------------------------------------------------------
// 复核清单
// ---------------------------------------------------------------------------

test('review queue returns failed operations, stale allocations and orphan mappings', async () => {
    const ctx = makeContext()
    await insertOperation(ctx, {
        operationKey: 'revoke_1',
        operation: 'revoke',
        resourceId: 'remote_1',
        orderId: 'order_1',
        state: 'failed',
        attempts: 3,
        lastErrorCode: 'revoke_key_missing',
    })
    await insertOperation(ctx, { operationKey: 'ack_ok', operation: 'ack', state: 'pending' })
    await insertAllocation(ctx, { allocationId: 'alloc_stale', expiresAt: NOW - 10 * MINUTE })
    await insertMapping(ctx, { localCardId: 42, remoteCardId: 'remote_orphan' }, { orphan: true })

    const queue = await listCardServiceReviewQueue(ctx.database, { now: NOW })
    assert.equal(queue.enabled, true)
    assert.equal(queue.failedOperations.length, 1)
    assert.equal(queue.failedOperations[0].operation, 'revoke')
    assert.equal(queue.failedOperations[0].lastErrorCode, 'revoke_key_missing')
    assert.equal(queue.failedOperations[0].attempts, 3)
    assert.deepEqual(queue.staleAllocations.map((row) => row.allocationId), ['alloc_stale'])
    assert.deepEqual(queue.orphanMappings.map((row) => row.localCardId), [42])
    assert.equal(queue.truncated, false)
})

test('review queue marks itself truncated when a bucket hits the limit', async () => {
    const ctx = makeContext()
    for (let index = 0; index < 3; index += 1) {
        await insertOperation(ctx, {
            operationKey: `op_${index}`,
            operation: 'sell',
            state: 'failed',
        })
    }

    const queue = await listCardServiceReviewQueue(ctx.database, { now: NOW, limit: 2 })
    assert.equal(queue.failedOperations.length, 2)
    assert.equal(queue.truncated, true)
})

// ---------------------------------------------------------------------------
// 商品维度
// ---------------------------------------------------------------------------

test('product status only lists license_service products and aggregates their counters', async () => {
    const ctx = makeContext()
    await insertProductConfig(ctx, { productId: 'prod_remote', targetStock: 3 })
    await insertProductConfig(ctx, { productId: 'prod_local', supplyMode: 'local', programKey: null, targetStock: 9 })

    await insertLocalCard(ctx, { id: 1, productId: 'prod_remote' })
    await insertLocalCard(ctx, { id: 2, productId: 'prod_remote' })
    await insertLocalCard(ctx, { id: 3, productId: 'prod_remote', isUsed: 1 })
    await insertLocalCard(ctx, { id: 4, productId: 'prod_remote', reservedOrderId: 'order_x' })

    await insertAllocation(ctx, { allocationId: 'alloc_remote', productId: 'prod_remote', state: 'acknowledged' })
    await insertAllocation(ctx, { allocationId: 'alloc_flight', productId: 'prod_remote', state: 'allocated' })
    await insertMapping(ctx, {
        localCardId: 1,
        remoteCardId: 'remote_1',
        allocationId: 'alloc_remote',
        productId: 'prod_remote',
        state: 'acknowledged',
    })
    await insertOperation(ctx, {
        operationKey: 'ack_pending',
        operation: 'ack',
        resourceId: 'alloc_flight',
        state: 'pending',
    })
    await insertOperation(ctx, {
        operationKey: 'sell_pending',
        operation: 'sell',
        resourceId: 'alloc_remote',
        orderId: 'order_1',
        state: 'failed',
    })
    await insertOperation(ctx, {
        operationKey: 'revoke_pending',
        operation: 'revoke',
        resourceId: 'remote_1',
        orderId: 'order_1',
        state: 'pending',
    })

    const rows = await listCardServiceProductStatus(ctx.database)
    assert.equal(rows.length, 1)
    const status = rows[0]
    assert.equal(status.productId, 'prod_remote')
    assert.equal(status.supplyMode, 'license_service')
    assert.equal(status.programKey, 'bill-service')
    assert.equal(status.targetStock, 3)
    // 本地可售：id=1 与 id=2 均未用未预留；id=3 已用、id=4 已预留。
    assert.equal(status.localSellableCards, 2)
    assert.equal(status.remoteSellableCards, 1)
    assert.equal(status.inFlightAllocations, 1)
    assert.equal(status.pendingAck, 1)
    assert.equal(status.pendingSell, 1)
    assert.equal(status.pendingRevoke, 1)
    assert.equal(status.stockExhausted, false)
})

test('product status raises stockExhausted when no stock remains at all', async () => {
    const ctx = makeContext()
    await insertProductConfig(ctx, { productId: 'prod_remote', targetStock: 3 })

    const rows = await listCardServiceProductStatus(ctx.database)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].stockExhausted, true)
})

test('product status without a target stock never reports exhaustion', async () => {
    const ctx = makeContext()
    await insertProductConfig(ctx, { productId: 'prod_remote', targetStock: null })

    const rows = await listCardServiceProductStatus(ctx.database)
    assert.equal(rows[0].targetStock, null)
    assert.equal(rows[0].stockExhausted, false)
})
