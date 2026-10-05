/**
 * 阶段 D 源码级单测：交付前远端 Sell。
 *
 * 用真实 SQLite 跑 `delivery.ts` 的 SQL 原文（含 D1 批次的原子语义），
 * 中心侧用假客户端控制每一次响应，因此「部分成功」「409 已售」「超窗」
 * 这些分支都能确定性复现，而不是靠读代码推断。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildSellDeferStatements,
    buildSellFailStatements,
    buildDeliverOrderStatements,
    executeOrderRemoteSales,
    listOrderRemoteCardRows,
    listPendingSellOperations,
    loadOrderRemoteSalePlan,
    type OrderRemoteSalePlan,
    type OrderSaleDeps,
} from './delivery.ts'
import { LicenseServiceError } from './errors.ts'
import { createFakeLicenseServiceClient, createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

const PRODUCT_ID = 'prod_001'
const ORDER_ID = 'ORDER-0001'
const CLAIM_ID = 'claim-1'
const ALLOC_A = 'all_A'
const ALLOC_B = 'all_B'
const REF_A = 'ldc-shop:restock:task-a'
const REF_B = 'ldc-shop:restock:task-b'

function seedOrder(
    ctx: SqliteTestContext,
    overrides: { orderId?: string; status?: string; claimId?: string | null; cardIds?: string; quantity?: number } = {},
) {
    ctx.exec(`INSERT INTO products (id) VALUES ('${PRODUCT_ID}')`)
    ctx.exec(`INSERT INTO orders (order_id, product_id, product_name, amount, status, quantity, card_ids, fulfillment_claim_id)
        VALUES (
            '${overrides.orderId ?? ORDER_ID}',
            '${PRODUCT_ID}',
            'Test Product',
            '0.00',
            '${overrides.status ?? 'processing'}',
            ${overrides.quantity ?? 1},
            ${overrides.cardIds ? `'${overrides.cardIds}'` : 'NULL'},
            ${overrides.claimId === null ? 'NULL' : `'${overrides.claimId ?? CLAIM_ID}'`}
        )`)
}

function seedCard(
    ctx: SqliteTestContext,
    id: number,
    options: { isUsed?: boolean; reservedOrderId?: string | null } = {},
) {
    ctx.exec(`INSERT INTO cards (id, product_id, card_key, is_used, reserved_order_id)
        VALUES (${id}, '${PRODUCT_ID}', 'KEY-${id}', ${options.isUsed ? 1 : 0},
                ${options.reservedOrderId === null ? 'NULL' : `'${options.reservedOrderId ?? ORDER_ID}'`})`)
}

function seedAllocation(
    ctx: SqliteTestContext,
    options: {
        allocationId?: string
        externalRef?: string
        state?: string
        quantity?: number
    } = {},
) {
    const allocationId = options.allocationId ?? ALLOC_A
    ctx.exec(`INSERT INTO card_service_allocations
        (allocation_id, product_id, program_key, external_ref, quantity, state, request_key, ack_key, expires_at, created_at, updated_at)
        VALUES ('${allocationId}', '${PRODUCT_ID}', 'program', '${options.externalRef ?? REF_A}',
                ${options.quantity ?? 1}, '${options.state ?? 'acknowledged'}', 'req', 'ack', 0, 0, 0)`)
}

function seedMapping(
    ctx: SqliteTestContext,
    options: {
        localCardId: number
        remoteCardId: string
        allocationId?: string
        state?: string
        orderId?: string | null
    },
) {
    ctx.exec(`INSERT INTO card_service_cards
        (local_card_id, remote_card_id, allocation_id, product_id, order_id, state, created_at, updated_at)
        VALUES (${options.localCardId}, '${options.remoteCardId}', '${options.allocationId ?? ALLOC_A}', '${PRODUCT_ID}',
                ${options.orderId ? `'${options.orderId}'` : 'NULL'}, '${options.state ?? 'acknowledged'}', 0, 0)`)
}

function planOf(plan: OrderRemoteSalePlan): Extract<OrderRemoteSalePlan, { kind: 'remote' }> {
    assert.equal(plan.kind, 'remote', `expected remote plan, got ${plan.kind}`)
    return plan as Extract<OrderRemoteSalePlan, { kind: 'remote' }>
}

// ---------------------------------------------------------------------------
// 计划阶段
// ---------------------------------------------------------------------------

test('no mapping rows → 纯本地订单，不触碰 card_service_* 表', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.deepEqual(plan, { kind: 'none' })
})

test('card_service_cards 不存在（升级项未执行）时按纯本地订单处理', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    ctx.exec('DROP TABLE card_service_cards')
    ctx.exec('DROP TABLE card_service_allocations')

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.deepEqual(plan, { kind: 'none' })
    const rows = await listOrderRemoteCardRows(ctx.database, [1])
    assert.deepEqual(rows, [])
})

test('单卡单批次：计划带原 external_ref 与全量远端卡', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.equal(plan.groups.length, 1)
    assert.deepEqual(plan.groups[0], {
        allocationId: ALLOC_A,
        externalRef: REF_A,
        remoteCardIds: ['card_a1'],
        localCardIds: [7],
        alreadySold: false,
    })
})

test('远端卡 ID 按升序排列（Sell 请求体必须可复现）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx, { quantity: 3 })
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedCard(ctx, 3)
    seedAllocation(ctx, { quantity: 3 })
    // 故意乱序写入
    seedMapping(ctx, { localCardId: 3, remoteCardId: 'card_c' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_b' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1, 2, 3] }))
    assert.deepEqual(plan.groups[0].remoteCardIds, ['card_a', 'card_b', 'card_c'])
    assert.deepEqual(plan.groups[0].localCardIds, [1, 2, 3])
})

test('已售给本单（幂等重放后的状态）标记 alreadySold', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    assert.equal(plan.groups[0].alreadySold, true)
})

test('混入普通本地卡 → mixed_inventory，拒绝交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx, { quantity: 2 })
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1, 2] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'mixed_inventory')
})

test('批次只被本单占了一半 → allocation_incomplete（Sell 是整批语义）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx, { quantity: 2 })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_b' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'allocation_incomplete')
})

test('台账缺失 → ledger_missing（拿不到原 external_ref）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'ledger_missing')
})

test('Ack 未确认（allocated）→ 必须回到补货/对账路径，不能直接 Sell', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx, { state: 'allocated' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'allocation_not_acknowledged')
})

test('台账已作废（expired）→ allocation_unusable', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx, { state: 'expired' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'allocation_unusable')
})

test('已售给别的订单 → sold_to_another_order', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', state: 'sold', orderId: 'ORDER-OTHER' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'sold_to_another_order')
})

test('映射已作废（revoked）→ mapping_unusable', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', state: 'revoked' })

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'mapping_unusable')
})

// ---------------------------------------------------------------------------
// 执行阶段
// ---------------------------------------------------------------------------

function depsOf(
    ctx: SqliteTestContext,
    behavior: Parameters<typeof createFakeLicenseServiceClient>[0],
    options: { policy?: OrderSaleDeps['policy'] } = {},
): { deps: OrderSaleDeps; client: ReturnType<typeof createFakeLicenseServiceClient> } {
    const client = createFakeLicenseServiceClient(behavior)
    return {
        client,
        deps: {
            client,
            database: ctx.database,
            now: () => 1_000,
            policy: { maxAttempts: 1, ...options.policy },
        },
    }
}

const SOLD_OK = { allocationId: ALLOC_A, status: 'sold', cardIds: ['card_a'], soldAtMs: 1 }

test('全部 Sell 成功 → confirmed，请求体与幂等键稳定', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, { sell: async () => SOLD_OK, getAllocation: async () => { throw new Error('must not probe') } })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.deepEqual(outcome, { status: 'confirmed' })

    assert.deepEqual(client.callsOf('sell'), [{
        allocationId: ALLOC_A,
        cardIds: ['card_a'],
        externalRef: REF_A,
        idempotencyKey: `sell:${ALLOC_A}:${ORDER_ID}`,
    }])
    // 意图先行落账，交付批次再把它标记 done。
    const operation = ctx.get('SELECT * FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_A}:${ORDER_ID}`])
    assert.equal(operation?.state, 'pending')
    assert.equal(operation?.operation, 'sell')
    assert.equal(operation?.order_id, ORDER_ID)
})

test('商品下架不阻断已有订单 Sell，冲突后仍查询分配确认售出', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    ctx.exec(`UPDATE products SET is_active = 0 WHERE id = '${PRODUCT_ID}'`)

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 }) },
        getAllocation: async () => ({ status: 'sold' } as never),
    })
    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })

    assert.deepEqual(outcome, { status: 'confirmed' })
    assert.equal(client.callCount('sell'), 1)
    assert.equal(client.callCount('getAllocation'), 1)
})

test('429 → deferred：保留待办与下次重试时间，不交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps } = depsOf(ctx, {
        sell: async () => {
            throw new LicenseServiceError({ code: 'rate_limited', httpStatus: 429, retryable: true, retryAfterMs: 2_000 })
        },
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'deferred')

    const operation = ctx.get('SELECT * FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_A}:${ORDER_ID}`])
    assert.equal(operation?.state, 'pending')
    assert.equal(operation?.attempts, 1)
    assert.equal(operation?.next_retry_at, 61_000)
    assert.equal(operation?.last_error_code, 'rate_limited')
})

test('409 + 查询显示已 sold → 视为本单已售，继续交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 }) },
        getAllocation: async () => ({ status: 'sold' } as never),
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.deepEqual(outcome, { status: 'confirmed' })
    assert.equal(client.callCount('sell'), 1)
    assert.equal(client.callCount('getAllocation'), 1)
})

test('409 + 查询显示仍 allocated → blocked，必须回到阶段 C', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 }) },
        getAllocation: async () => ({ status: 'allocated' } as never),
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'blocked')
    assert.equal((outcome as { reason: string }).reason, 'allocation_not_acknowledged')
    // 409 绝不重试：一次 Sell、一次单查。
    assert.equal(client.callCount('sell'), 1)
    assert.equal(client.callCount('getAllocation'), 1)
    assert.equal(ctx.get('SELECT state FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_A}:${ORDER_ID}`])?.state, 'failed')
})

test('409 + 查询显示已 expired → blocked allocation_unusable', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 }) },
        getAllocation: async () => ({ status: 'expired' } as never),
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'blocked')
    assert.equal((outcome as { reason: string }).reason, 'allocation_unusable')
})

test('409 + 单查不可用 → deferred（不能凭 409 就判定作废）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 }) },
        getAllocation: async () => { throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503, retryable: true }) },
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'deferred')
    assert.equal(ctx.get('SELECT state FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_A}:${ORDER_ID}`])?.state, 'pending')
})

test('鉴权失败 → blocked auth_error，不重试也不交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, {
        sell: async () => { throw new LicenseServiceError({ code: 'program_not_allowed', httpStatus: 403 }) },
    }, { policy: { maxAttempts: 3 } })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'blocked')
    assert.equal((outcome as { reason: string }).reason, 'auth_error')
    assert.equal(client.callCount('sell'), 1)
})

test('alreadySold 的批次被跳过：不调用 Sell、不写意图', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx)
    seedCard(ctx, 1)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, {})

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.deepEqual(outcome, { status: 'confirmed' })
    assert.equal(client.callCount('sell'), 0)
    assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 0)
})

test('多批次：先成功的批次不会因后一批 deferred 而被记为失败', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx, { quantity: 2 })
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx, { allocationId: ALLOC_A, quantity: 1 })
    seedAllocation(ctx, { allocationId: ALLOC_B, externalRef: REF_B, quantity: 1 })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', allocationId: ALLOC_A })
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_b', allocationId: ALLOC_B })

    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1, 2] }))
    const { deps, client } = depsOf(ctx, {
        sell: async (input) => {
            const allocationId = (input as { allocationId: string }).allocationId
            if (allocationId === ALLOC_B) {
                throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503, retryable: true })
            }
            return SOLD_OK
        },
    })

    const outcome = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
    assert.equal(outcome.status, 'deferred')
    assert.equal(client.callCount('sell'), 2)
    // 两个批次都留了待办：A 仍是 pending（等交付批次标 done），B 记了错误码。
    const rows = await listPendingSellOperations(ctx.database)
    assert.equal(rows.length, 2)
    assert.equal(ctx.get('SELECT last_error_code FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_B}:${ORDER_ID}`])?.last_error_code, 'temporarily_unavailable')
})

// ---------------------------------------------------------------------------
// 交付批次
// ---------------------------------------------------------------------------

function seedProcessingOrder(ctx: SqliteTestContext, options: { quantity?: number } = {}) {
    const quantity = options.quantity ?? 1
    seedOrder(ctx, { quantity })
    const ids = Array.from({ length: quantity }, (_, index) => index + 1)
    for (const id of ids) seedCard(ctx, id)
    return ids
}

test('纯本地交付：批次不引用任何 card_service_* 表', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)

    const statements = buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
    })
    assert.equal(statements.length, 2)
    for (const statement of statements) {
        assert.equal(statement.sql.includes('card_service_'), false, statement.sql)
    }

    const results = await ctx.database.write(statements)
    assert.equal(results[0].changes, 1)
    assert.equal(results[1].changes, 1)

    const order = ctx.get('SELECT * FROM orders WHERE order_id = ?', [ORDER_ID])
    assert.equal(order?.status, 'delivered')
    assert.equal(order?.card_key, 'KEY-1')
    assert.equal(order?.card_ids, '1')
    assert.equal(order?.delivered_at, 5_000)
    assert.equal(order?.paid_at, 5_000)
    assert.equal(order?.fulfillment_claim_id, null)
    assert.equal(ctx.get('SELECT is_used, used_at, reserved_order_id FROM cards WHERE id = 1')?.is_used, 1)
})

test('多卡交付：card_ids 逗号连接，全部置已用', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx, { quantity: 2 })

    await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1\nKEY-2',
        localCardIds: ids,
        deliveryNote: 'note',
        nowMs: 5_000,
    }))

    assert.equal(ctx.get('SELECT card_ids FROM orders WHERE order_id = ?', [ORDER_ID])?.card_ids, '1,2')
    assert.equal(ctx.all('SELECT id FROM cards WHERE is_used = 1').length, 2)
})

test('远端交付：映射与台账一并标记 sold，Sell 待办置 done', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
        VALUES ('sell:${ALLOC_A}:${ORDER_ID}', 'sell', '${ALLOC_A}', '${ORDER_ID}', 'pending', 1, 0, 0)`)

    await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
        remoteGroups: [{ allocationId: ALLOC_A, localCardIds: ids }],
    }))

    const mapping = ctx.get('SELECT * FROM card_service_cards WHERE local_card_id = 1')
    assert.equal(mapping?.state, 'sold')
    assert.equal(mapping?.order_id, ORDER_ID)
    assert.equal(mapping?.sold_at, 5_000)

    const allocation = ctx.get('SELECT * FROM card_service_allocations WHERE allocation_id = ?', [ALLOC_A])
    assert.equal(allocation?.state, 'sold')
    assert.equal(allocation?.sold_at, 5_000)

    assert.equal(ctx.get('SELECT state FROM card_service_operations WHERE operation_key = ?', [`sell:${ALLOC_A}:${ORDER_ID}`])?.state, 'done')
    assert.equal(ctx.get('SELECT status FROM orders WHERE order_id = ?', [ORDER_ID])?.status, 'delivered')
})

test('claim 丢失 → 整批落空：订单未交付、卡未消耗、映射仍可售', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })

    const results = await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: 'someone-else',
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
        remoteGroups: [{ allocationId: ALLOC_A, localCardIds: ids }],
    }))

    assert.equal(results[0].changes, 0)
    assert.equal(results[1].changes, 0)
    assert.equal(ctx.get('SELECT status FROM orders WHERE order_id = ?', [ORDER_ID])?.status, 'processing')
    assert.equal(ctx.get('SELECT is_used FROM cards WHERE id = 1')?.is_used, 0)
    assert.equal(ctx.get('SELECT state FROM card_service_cards WHERE local_card_id = 1')?.state, 'acknowledged')
    assert.equal(ctx.get('SELECT state FROM card_service_allocations WHERE allocation_id = ?', [ALLOC_A])?.state, 'acknowledged')
})

test('预留被抢走 → 前置条件不满足，订单也不交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)
    ctx.exec(`UPDATE cards SET reserved_order_id = 'ORDER-OTHER' WHERE id = 1`)

    const results = await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
    }))

    assert.equal(results[0].changes, 0)
    assert.equal(ctx.get('SELECT status FROM orders WHERE order_id = ?', [ORDER_ID])?.status, 'processing')
})

test('映射已 sold 给本单时仍可完成本地交付（幂等重放）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a', state: 'sold', orderId: ORDER_ID })

    const results = await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
        remoteGroups: [{ allocationId: ALLOC_A, localCardIds: ids }],
    }))

    assert.equal(results[0].changes, 1)
    assert.equal(ctx.get('SELECT status FROM orders WHERE order_id = ?', [ORDER_ID])?.status, 'delivered')
})

test('可售行却带着别的订单号（账本被改过）→ 拒绝交付', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedProcessingOrder(ctx)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    ctx.exec(`UPDATE card_service_cards SET state = 'acknowledged', order_id = 'ORDER-OTHER' WHERE local_card_id = 1`)

    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: ids })
    assert.equal(plan.kind, 'blocked')
    assert.equal((plan as { reason: string }).reason, 'mapping_unusable')

    // 即便绕过计划阶段直接构造批次，前置条件也不成立：订单不会交付。
    const results = await ctx.database.write(buildDeliverOrderStatements({
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-1',
        cardKey: 'KEY-1',
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
        remoteGroups: [{ allocationId: ALLOC_A, localCardIds: ids }],
    }))
    assert.equal(results[0].changes, 0)
    assert.equal(ctx.get('SELECT status FROM orders WHERE order_id = ?', [ORDER_ID])?.status, 'processing')
})

for (const state of ['pending', 'failed', 'abandoned']) {
    test(`历史 ${state} 待办尝试 364 次：执行核心停止且不增加次数`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seedOrder(ctx); seedCard(ctx, 1); seedAllocation(ctx)
        seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
        ctx.exec(`INSERT INTO card_service_operations
            (operation_key, operation, resource_id, order_id, state, attempts, last_error_code, created_at, updated_at)
            VALUES ('sell:${ALLOC_A}:${ORDER_ID}', 'sell', '${ALLOC_A}', '${ORDER_ID}', '${state}', 364, 'timeout', 0, 0)`)
        const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
        const { deps, client } = depsOf(ctx, {})
        for (let i = 0; i < 3; i++) assert.equal((await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })).status, 'blocked')
        assert.equal(client.calls.length, 0)
        const op = ctx.get('SELECT * FROM card_service_operations')!
        assert.equal(op.state, 'abandoned'); assert.equal(op.attempts, 364)
        assert.equal((await listPendingSellOperations(ctx.database)).length, 0)
    })
}

test('not_found 首次失败即停止，多次点击不再请求且不能被晚到失败写回复活', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedOrder(ctx); seedCard(ctx, 1); seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
    const { deps, client } = depsOf(ctx, { sell: async () => { throw new LicenseServiceError({ code: 'not_found', httpStatus: 404 }) } })
    for (let i = 0; i < 5; i++) assert.equal((await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })).status, 'blocked')
    assert.equal(client.callCount('sell'), 1)
    const before = ctx.get('SELECT * FROM card_service_operations')
    assert.equal(before?.state, 'abandoned'); assert.equal(before?.attempts, 1)
    await ctx.database.write(buildSellDeferStatements({ orderId: ORDER_ID, allocationId: ALLOC_A, errorCode: 'timeout', requestId: null, nowMs: 9999, nextRetryAtMs: 10000 }))
    await ctx.database.write(buildSellFailStatements({ orderId: ORDER_ID, allocationId: ALLOC_A, errorCode: 'other', requestId: null, nowMs: 9999 }))
    assert.deepEqual(ctx.get('SELECT * FROM card_service_operations'), before)
})

// ---------------------------------------------------------------------------
// D1 每条 SQL 参数预算与集合交付回归
// ---------------------------------------------------------------------------

function assertSqlParameterBudget(ctx: SqliteTestContext) {
    assert.ok(ctx.sqlCalls.length > 0)
    for (const call of ctx.sqlCalls) {
        assert.ok((call.params?.length ?? 0) <= 100,
            `${call.kind}: ${call.params?.length ?? 0} 个绑定参数\n${call.sql}`)
    }
}

function deliverySnapshot(ctx: SqliteTestContext) {
    return {
        orders: ctx.all('SELECT * FROM orders ORDER BY order_id'),
        cards: ctx.all('SELECT * FROM cards ORDER BY id'),
        mappings: ctx.all('SELECT * FROM card_service_cards ORDER BY local_card_id'),
        allocations: ctx.all('SELECT * FROM card_service_allocations ORDER BY allocation_id'),
        operations: ctx.all('SELECT * FROM card_service_operations ORDER BY operation_key'),
    }
}

function seedGroupedDelivery(ctx: SqliteTestContext, quantity: number, allocationCount: number) {
    const ids = seedProcessingOrder(ctx, { quantity })
    assert.equal(quantity % (allocationCount || 1), 0)
    const groupSize = allocationCount ? quantity / allocationCount : 0
    for (let index = 0; index < allocationCount; index++) {
        const allocationId = `all_batch_${String(index).padStart(3, '0')}`
        seedAllocation(ctx, {
            allocationId,
            externalRef: `ldc-shop:restock:batch-${index}`,
            quantity: groupSize,
        })
        for (const id of ids.slice(index * groupSize, (index + 1) * groupSize)) {
            seedMapping(ctx, {
                localCardId: id,
                remoteCardId: `remote_${String(id).padStart(3, '0')}`,
                allocationId,
            })
        }
    }
    return ids
}

function deliveryInput(ids: readonly number[], remoteGroups: Parameters<typeof buildDeliverOrderStatements>[0]['remoteGroups'] = []) {
    return {
        orderId: ORDER_ID,
        claimId: CLAIM_ID,
        tradeNo: 'T-BATCH',
        cardKey: ids.map((id) => `KEY-${id}`).join('\n'),
        localCardIds: ids,
        deliveryNote: null,
        nowMs: 5_000,
        remoteGroups,
    }
}

function successfulSellDeps(ctx: SqliteTestContext) {
    return depsOf(ctx, {
        sell: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'sold' }),
    })
}

function assertDeliveredBatch(ctx: SqliteTestContext, ids: readonly number[], allocationCount: number) {
    const order = ctx.get('SELECT * FROM orders WHERE order_id = ?', [ORDER_ID])!
    assert.equal(order.status, 'delivered')
    assert.equal(order.quantity, ids.length)
    assert.equal(order.card_key, ids.map((id) => `KEY-${id}`).join('\n'))
    assert.equal(String(order.card_key).split('\n').length, ids.length)
    assert.equal(order.card_ids, ids.join(','))
    assert.equal(order.delivered_at, 5_000)
    assert.equal(order.fulfillment_claim_id, null)
    const cards = ctx.all('SELECT id, is_used, used_at, reserved_order_id, reserved_at FROM cards ORDER BY id')
    assert.deepEqual(cards.map((row) => ({ ...row })), ids.map((id) => ({
        id, is_used: 1, used_at: 5_000, reserved_order_id: null, reserved_at: null,
    })))
    const mappings = ctx.all('SELECT local_card_id, state, order_id, sold_at FROM card_service_cards ORDER BY local_card_id')
    assert.deepEqual(mappings.map((row) => ({ ...row })), allocationCount ? ids.map((id) => ({
        local_card_id: id, state: 'sold', order_id: ORDER_ID, sold_at: 5_000,
    })) : [])
    const allocations = ctx.all('SELECT state, sold_at FROM card_service_allocations')
    assert.equal(allocations.length, allocationCount)
    assert.ok(allocations.every((row) => row.state === 'sold' && row.sold_at === 5_000))
    const operations = ctx.all('SELECT operation_key, resource_id, order_id, state FROM card_service_operations')
    assert.equal(operations.length, allocationCount)
    for (const row of operations) {
        assert.equal(row.operation_key, `sell:${row.resource_id}:${ORDER_ID}`)
        assert.equal(row.order_id, ORDER_ID)
        assert.equal(row.state, 'done')
    }
    assertSqlParameterBudget(ctx)
}

for (const kind of ['query', 'write'] as const) {
    test(`D1 替身 ${kind} 接受100绑定、拒绝101绑定`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seedProcessingOrder(ctx)
        const sql = (count: number) => `SELECT id FROM cards WHERE id IN (${Array(count).fill('?').join(',')})`
        const params = (count: number) => Array(count).fill(1)
        if (kind === 'query') {
            assert.equal((await ctx.database.query(sql(100), params(100))).length, 1)
            await assert.rejects(ctx.database.query(sql(101), params(101)), /D1 SQL parameter limit exceeded: 101 > 100/)
        } else {
            const update = (count: number) => sql(count).replace('SELECT id FROM cards', 'UPDATE cards SET used_at = 42')
            assert.equal((await ctx.database.write([{ sql: update(100), params: params(100) }]))[0].changes, 1)
            await assert.rejects(ctx.database.write([{ sql: update(101), params: params(101) }]), /D1 SQL parameter limit exceeded: 101 > 100/)
            assert.equal(ctx.get('SELECT used_at FROM cards WHERE id = 1')?.used_at, 42)
        }
    })
}

for (const failure of ['参数超限', 'SQL执行异常']) {
    test(`D1 batch 中段${failure}回滚首条写入且不执行尾条`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seedProcessingOrder(ctx)
        const before = deliverySnapshot(ctx)
        await assert.rejects(ctx.database.write([
            { sql: 'UPDATE cards SET is_used = 1 WHERE id = 1' },
            failure === '参数超限'
                ? { sql: `UPDATE orders SET status = 'delivered' WHERE order_id IN (${Array(101).fill('?').join(',')})`, params: Array(101).fill(ORDER_ID) }
                : { sql: 'UPDATE missing_table SET value = 1' },
            { sql: "UPDATE cards SET reserved_order_id = 'TAIL' WHERE id = 1" },
        ]), failure === '参数超限' ? /101 > 100/ : /no such table/)
        assert.deepEqual(deliverySnapshot(ctx), before)
        assert.equal(ctx.sqlCalls.filter((call) => call.kind === 'write').length, 2)
        const result = await ctx.database.write([{ sql: 'UPDATE cards SET used_at = 77 WHERE id = 1' }])
        assert.equal(result[0].changes, 1)
        assert.equal(ctx.get('SELECT used_at FROM cards WHERE id = 1')?.used_at, 77)
    })
}

for (const { quantity, allocationCount, label } of [
    { quantity: 50, allocationCount: 0, label: '50张本地卡' },
    { quantity: 50, allocationCount: 1, label: '50张远端卡单allocation' },
    { quantity: 50, allocationCount: 50, label: '50张远端卡50allocation' },
    { quantity: 120, allocationCount: 0, label: '120张本地卡（读取集合超过100）' },
    { quantity: 120, allocationCount: 1, label: '120张远端卡单allocation（组内集合超过100）' },
    { quantity: 120, allocationCount: 120, label: '120张远端卡120allocation（映射、台账、整批读取集合超过100）' },
]) {
    test(`${label}：真实SQL完成全部交付且每条绑定不超过100`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        const ids = seedGroupedDelivery(ctx, quantity, allocationCount)
        const mappingRows = await listOrderRemoteCardRows(ctx.database, [...ids].reverse())
        assert.equal(mappingRows.length, allocationCount ? quantity : 0)
        assert.equal(new Set(mappingRows.map((row) => row.localCardId)).size, mappingRows.length)
        const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [...ids].reverse() })
        const { deps, client } = successfulSellDeps(ctx)
        const groups = allocationCount ? planOf(plan).groups : []
        if (!allocationCount) assert.deepEqual(plan, { kind: 'none' })
        assert.equal(groups.length, allocationCount)
        assert.deepEqual(groups.flatMap((group) => group.localCardIds).sort((a, b) => a - b), allocationCount ? ids : [])
        if (allocationCount) {
            assert.deepEqual(await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups }), { status: 'confirmed' })
        }
        assert.equal(client.callCount('sell'), allocationCount)
        const statements = buildDeliverOrderStatements(deliveryInput(ids, groups))
        for (const statement of statements) {
            assert.ok((statement.params?.length ?? 0) <= 100, `${label}: ${statement.params?.length}\n${statement.sql}`)
            if (!allocationCount) assert.equal(statement.sql.includes('card_service_'), false)
        }
        const results = await ctx.database.write(statements)
        assert.equal(results[0].changes, 1)
        assertDeliveredBatch(ctx, ids, allocationCount)
    })
}

for (const conflict of ['末卡预留被抢', '末映射sold另一单', '末映射ack携带另一单']) {
    test(`50张交付${conflict}：全部SQL受影响0行，五张表保持原样`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        const allocationCount = conflict === '末卡预留被抢' ? 0 : 50
        const ids = seedGroupedDelivery(ctx, 50, allocationCount)
        const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: ids })
        const groups = allocationCount ? planOf(plan).groups : []
        if (allocationCount) {
            const { deps } = successfulSellDeps(ctx)
            assert.deepEqual(await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups }), { status: 'confirmed' })
        }
        if (!allocationCount) {
            ctx.exec("UPDATE cards SET reserved_order_id = 'ORDER-OTHER' WHERE id = 50")
        } else {
            ctx.exec(`UPDATE card_service_cards SET state = '${conflict === '末映射sold另一单' ? 'sold' : 'acknowledged'}',
                order_id = 'ORDER-OTHER' WHERE local_card_id = 50`)
            const blocked = await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: ids })
            assert.equal(blocked.kind, 'blocked')
            assert.equal((blocked as { reason: string }).reason, conflict === '末映射sold另一单' ? 'sold_to_another_order' : 'mapping_unusable')
        }
        const before = deliverySnapshot(ctx)
        const results = await ctx.database.write(buildDeliverOrderStatements(deliveryInput(ids, groups)))
        assert.ok(results.length > 0)
        assert.ok(results.every((row) => row.changes === 0), JSON.stringify(results))
        assert.deepEqual(deliverySnapshot(ctx), before)
        assert.equal(ctx.get('SELECT card_key FROM orders WHERE order_id = ?', [ORDER_ID])?.card_key, null)
        assert.equal(ctx.all('SELECT id FROM cards WHERE is_used = 1').length, 0)
        assertSqlParameterBudget(ctx)
    })
}

test('50张远端卡Sell成功后本地批次中段失败：未交付，按原计划原幂等键重试成功', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const ids = seedGroupedDelivery(ctx, 50, 1)
    const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: ids }))
    const { deps, client } = successfulSellDeps(ctx)
    assert.deepEqual(await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups }), { status: 'confirmed' })
    const before = deliverySnapshot(ctx)
    ctx.exec(`CREATE TRIGGER fail_last_mapping BEFORE UPDATE ON card_service_cards
        WHEN NEW.local_card_id = 50 AND NEW.state = 'sold'
        BEGIN SELECT RAISE(ABORT, '本地交付写入失败'); END`)
    await assert.rejects(ctx.database.write(buildDeliverOrderStatements(deliveryInput(ids, plan.groups))), /本地交付写入失败/)
    assert.deepEqual(deliverySnapshot(ctx), before)
    const order = ctx.get('SELECT status, card_key, card_ids, delivered_at, fulfillment_claim_id FROM orders')
    assert.deepEqual({ ...order }, { status: 'processing', card_key: null, card_ids: null, delivered_at: null, fulfillment_claim_id: CLAIM_ID })
    assert.equal(ctx.all('SELECT id FROM cards WHERE is_used = 1').length, 0)
    assert.equal(ctx.all('SELECT id FROM cards WHERE reserved_order_id = ?', [ORDER_ID]).length, 50)
    assert.equal(ctx.get('SELECT state FROM card_service_operations')?.state, 'pending')
    ctx.exec('DROP TRIGGER fail_last_mapping')
    assert.deepEqual(await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups }), { status: 'confirmed' })
    const sellCalls = client.callsOf('sell')
    assert.equal(sellCalls.length, 2)
    assert.deepEqual(sellCalls[1], sellCalls[0])
    assert.deepEqual(sellCalls[0], {
        allocationId: plan.groups[0].allocationId,
        cardIds: plan.groups[0].remoteCardIds,
        externalRef: plan.groups[0].externalRef,
        idempotencyKey: `sell:${plan.groups[0].allocationId}:${ORDER_ID}`,
    })
    await ctx.database.write(buildDeliverOrderStatements(deliveryInput(ids, plan.groups)))
    assertDeliveredBatch(ctx, ids, 1)
})

for (const transient of [false, true]) {
    test(`${transient ? '临时' : '拒绝'}错误遵守退避且最多请求 12 次`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seedOrder(ctx); seedCard(ctx, 1); seedAllocation(ctx)
        seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a' })
        const plan = planOf(await loadOrderRemoteSalePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }))
        const { deps, client } = depsOf(ctx, { sell: async () => { throw new LicenseServiceError({ code: transient ? 'temporarily_unavailable' : 'contract_error', httpStatus: transient ? 503 : 400, retryable: transient }) } }, { policy: { maxAttempts: 3 } })
        let clock = 1000; deps.now = () => clock
        for (let i = 0; i < 12; i++) {
            await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
            assert.equal(client.callCount('sell'), i + 1)
            const op = ctx.get('SELECT * FROM card_service_operations')!
            if (i < 11) {
                const result = await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
                assert.equal(result.status, 'deferred'); assert.equal(client.callCount('sell'), i + 1)
                assert.ok(Number(op.next_retry_at) >= clock + 60000)
                clock = Number(op.next_retry_at)
            }
        }
        assert.equal(ctx.get('SELECT state FROM card_service_operations')?.state, 'abandoned')
        await executeOrderRemoteSales(deps, { orderId: ORDER_ID, groups: plan.groups })
        assert.equal(client.callCount('sell'), 12)
    })
}
