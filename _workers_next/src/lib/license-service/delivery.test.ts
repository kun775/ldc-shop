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
    assert.equal(operation?.next_retry_at, 3_000)
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
