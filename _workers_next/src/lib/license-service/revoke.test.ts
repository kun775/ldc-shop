/**
 * 阶段 E 源码级单测：退款后的远端作废。
 *
 * 重点覆盖两类截然不同的分支，因为它们的代价相反：
 *   - 已 `sold` 的卡必须作废（用户已拿到明文，作废不回库存）；
 *   - 仅 `acknowledged` 的卡**不能**直接作废（那是本店库存），必须先查中心
 *     真实状态，只有中心确实已售/已作废才动手。
 *
 * ⚠️ 判「中心是否已售出」只能看**分配状态**（`allocation_status` /
 * `GET /allocations/{id}`）。卡状态接口的 `status` 是运行态
 * （`active`/`revoked`/`disabled`/`expired`/`exhausted`），**永不返回 `sold`** ——
 * 拿它比 `'sold'` 是恒假条件，会把该作废的卡留成库存。
 *
 * 另外验证「中心超时不得说成已完成」：429/503 后待办必须仍是 `pending`
 * 且带 `next_retry_at`，能被重放入口原键再走一遍。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LicenseServiceError } from './errors.ts'
import {
    buildRefundRevokeStatements,
    buildRevokeIntentStatements,
    buildRevokeRetainStatements,
    classifyAcknowledgedProbe,
    executeOrderRevokes,
    failRevokesWithoutClient,
    listPendingRevokeOperations,
    loadOrderRevokePlan,
    loadRevokePlanForRemoteCards,
    revokePendingCardServiceOperations,
    type OrderRevokePlan,
    type RevokeDeps,
} from './revoke.ts'
import {
    createFakeLicenseServiceClient,
    createSqliteCardServiceDatabase,
    makeAllocationDetail,
    type SqliteTestContext,
} from './test-support.ts'

const PRODUCT_ID = 'prod_001'
const ORDER_ID = 'ORDER-0001'
const OTHER_ORDER = 'ORDER-0002'
const ALLOC_A = 'all_A'

function seedCard(ctx: SqliteTestContext, id: number, options: { isUsed?: boolean; reservedOrderId?: string | null } = {}) {
    ctx.exec(`INSERT INTO products (id) VALUES ('${PRODUCT_ID}') ON CONFLICT DO NOTHING`)
    ctx.exec(`INSERT INTO cards (id, product_id, card_key, is_used, reserved_order_id)
        VALUES (${id}, '${PRODUCT_ID}', 'KEY-${id}', ${options.isUsed ? 1 : 0},
                ${options.reservedOrderId === null ? 'NULL' : `'${options.reservedOrderId ?? ORDER_ID}'`})`)
}

function seedAllocation(ctx: SqliteTestContext, options: { allocationId?: string; state?: string } = {}) {
    ctx.exec(`INSERT INTO card_service_allocations
        (allocation_id, product_id, program_key, external_ref, quantity, state, request_key, ack_key, expires_at, created_at, updated_at)
        VALUES ('${options.allocationId ?? ALLOC_A}', '${PRODUCT_ID}', 'program', 'ref', 1,
                '${options.state ?? 'acknowledged'}', 'req', 'ack', 0, 0, 0)`)
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

/**
 * 卡状态响应。
 *
 * ⚠️ `status` 是**卡运行态**（`active`/`revoked`/`disabled`/`expired`/`exhausted`），
 * **永远不是 `sold`**；「是否已售出」只能看 `allocation_status`。
 */
function makeCardStatus(cardId: string, status: string, allocationStatus: string | null = null) {
    return {
        cardId,
        programId: 'prog_1',
        maskedKey: 'CS-****',
        status,
        allocationStatus,
        usageLimit: null,
        usageHeld: null,
        usageCommitted: null,
        remaining: null,
        createdAtMs: null,
    }
}

function mapped(ctx: SqliteTestContext, remoteCardId: string) {
    return ctx.get('SELECT state, order_id, revoked_at FROM card_service_cards WHERE remote_card_id = ?', [remoteCardId])
}

function card(ctx: SqliteTestContext, id: number) {
    return ctx.get('SELECT is_used, used_at, reserved_order_id, reserved_at FROM cards WHERE id = ?', [id])
}

function operation(ctx: SqliteTestContext, remoteCardId: string) {
    return ctx.get(
        'SELECT state, attempts, next_retry_at, last_error_code FROM card_service_operations WHERE operation_key = ?',
        [`revoke:${remoteCardId}:${ORDER_ID}`],
    )
}

function planOf(plan: OrderRevokePlan): Extract<OrderRevokePlan, { kind: 'revoke' }> {
    assert.equal(plan.kind, 'revoke', `expected revoke plan, got ${plan.kind}`)
    return plan as Extract<OrderRevokePlan, { kind: 'revoke' }>
}

function blockedOf(plan: OrderRevokePlan): Extract<OrderRevokePlan, { kind: 'blocked' }> {
    assert.equal(plan.kind, 'blocked', `expected blocked plan, got ${plan.kind}`)
    return plan as Extract<OrderRevokePlan, { kind: 'blocked' }>
}

// ---------------------------------------------------------------------------
// 计划阶段
// ---------------------------------------------------------------------------

test('没有远端映射 → 纯本地订单，退款不改动远端', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)

    const plan = await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] })
    assert.deepEqual(plan, { kind: 'none' })
    assert.deepEqual(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [] }), { kind: 'none' })
})

test('card_service_cards 不存在（升级项未执行）时按纯本地订单处理', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    ctx.exec('DROP TABLE card_service_cards')

    assert.deepEqual(
        await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1] }),
        { kind: 'none' },
    )
    assert.deepEqual(await listPendingRevokeOperations(ctx.database), [])
})

test('已 sold 的映射进入作废计划（用户已拿到明文）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.deepEqual(plan.cards, [{
        localCardId: 7,
        remoteCardId: 'card_a1',
        allocationId: ALLOC_A,
        state: 'sold',
        alreadyRevoked: false,
    }])
})

test('仅 acknowledged 的映射也进入计划，具体动不动手由执行阶段按中心状态决定', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.equal(plan.cards[0].state, 'acknowledged')
})

test('全部已作废 → 没有可做的事（幂等重放）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'revoked', orderId: ORDER_ID })

    assert.deepEqual(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }), { kind: 'none' })
})

test('部分本地卡查不到映射 → blocked partial_mapping（混合库存不得整单作废）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1' })

    const blocked = blockedOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1, 2] }))
    assert.equal(blocked.reason, 'partial_mapping')
    // 已识别的远端卡必须一并带出：退款方要拿它做本地隔离，否则这张卡会停留在
    // 可售池里 —— 而订单 `card_ids` 一清就再没有追溯线索。
    assert.deepEqual(blocked.cards.map((card) => card.remoteCardId), ['card_a1'])
})

test('阻断发生在遍历前段时，后面的远端卡仍然必须被收集', async () => {
    const ctx = createSqliteCardServiceDatabase()
    // 订单 `card_ids` 里是一张**没有映射**的本地卡（混合库存），而台账里另有一张
    // 挂在本单、仍有映射的远端卡 —— 它被排在阻断点之后。
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const blocked = blockedOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [2] }))
    assert.equal(blocked.reason, 'partial_mapping')
    // 修复前这里返回 `cards: []`：那张远端卡既不进作废待办、也不会被本地隔离。
    assert.deepEqual(blocked.cards.map((card) => card.remoteCardId), ['card_a1'])
})

test('映射挂在别的订单上 → blocked external_mismatch', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: OTHER_ORDER })

    const blocked = blockedOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.equal(blocked.reason, 'external_mismatch')
})

test('映射状态未知 → blocked mapping_unusable', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'quarantined' })

    const blocked = blockedOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.equal(blocked.reason, 'mapping_unusable')
})

test('台账已 expired → blocked allocation_unusable（卡密可能已回池）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'expired' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const blocked = blockedOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.equal(blocked.reason, 'allocation_unusable')
})

test('重放路径按远端 card_id 重建计划；查不到映射 → blocked 而不是猜', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadRevokePlanForRemoteCards(ctx.database, { orderId: ORDER_ID, remoteCardIds: ['card_a1'] }))
    assert.equal(plan.cards.length, 1)

    const blocked = blockedOf(
        await loadRevokePlanForRemoteCards(ctx.database, { orderId: ORDER_ID, remoteCardIds: ['card_a1', 'card_gone'] }),
    )
    assert.equal(blocked.reason, 'partial_mapping')
})

test('订单 card_ids 已空但台账按 order_id 记着映射 → 仍纳入作废（不能漏）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [] }))
    assert.deepEqual(plan.cards.map((card) => card.remoteCardId), ['card_a1'])
})

test('订单 card_ids 漏记了一张 → 与台账取并集，远端卡不会留在流通里', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedCard(ctx, 7)
    seedCard(ctx, 8)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })
    seedMapping(ctx, { localCardId: 8, remoteCardId: 'card_a2', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    assert.deepEqual(plan.cards.map((card) => card.remoteCardId).sort(), ['card_a1', 'card_a2'])
})

test('台账里本单的映射已全部作废 → 无可作废项', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'revoked', orderId: ORDER_ID })

    const plan = await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [] })
    assert.equal(plan.kind, 'none')
})

test('按订单号反查不会把挂在别的订单上的映射拉进来', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: OTHER_ORDER })

    const plan = await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [] })
    assert.equal(plan.kind, 'none')
})

// ---------------------------------------------------------------------------
// 执行阶段
// ---------------------------------------------------------------------------

test('已出售的卡：调用 revoke 后映射转 revoked、台账转 done', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async (cardId) => ({ cardId, status: 'revoked' }),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 1, retained: 0, deferred: 0, failed: 0 })
    assert.deepEqual(client.callsOf('revoke'), [{
        cardId: 'card_a1',
        input: { reason: 'ldc-shop:refund', idempotencyKey: `revoke:card_a1:${ORDER_ID}` },
    }])
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
    assert.equal(mapped(ctx, 'card_a1')?.revoked_at, 1_000)
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('未交付且分配仍在我们手上 → 不作废，保留为本店库存', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', 'acknowledged'),
        getAllocation: async () => { throw new Error('allocation must not be probed when allocation_status is present') },
        revoke: async () => { throw new Error('revoke must not be called') },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 0, retained: 1, deferred: 0, failed: 0 })
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(client.callCount('getAllocation'), 0)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'acknowledged')
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('回归：卡状态取值域里没有 sold —— 卡状态是 sold 也不得据此作废', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    // 故意造一个取值域外的卡状态 'sold'：旧实现拿卡状态比 'sold' 会把这张卡误作废。
    // 现在分配状态是 acknowledged（未售出），所以**绝不能**吊销；
    // 但 'sold' 也不是「明确可用」，因此也不能放回库存 —— 只能交人工核查。
    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'sold', 'acknowledged'),
        revoke: async () => { throw new Error('revoke must not be called') },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(client.callCount('revoke'), 0)
    assert.deepEqual(outcome, { requested: 1, revoked: 0, retained: 0, deferred: 0, failed: 1 })
    assert.equal(mapped(ctx, 'card_a1')?.state, 'acknowledged')
    assert.equal(operation(ctx, 'card_a1')?.state, 'failed')
    // 不能恢复成「可售」：卡状态读不准时放回库存就是「买得下、发不出」。
    assert.equal(card(ctx, 7)?.is_used, 1)
})

test('卡状态响应不带 allocation_status → 回退单查分配', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', null),
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'sold' }),
        revoke: async (cardId) => ({ cardId, status: 'revoked' }),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(client.callCount('getAllocation'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('回退单查分配也拿不到（429）→ deferred，绝不当成「未售出」放行', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', null),
        getAllocation: async () => {
            throw new LicenseServiceError({ code: 'rate_limited', httpStatus: 429, retryable: true })
        },
        revoke: async () => { throw new Error('revoke must not be called') },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 0, retained: 0, deferred: 1, failed: 0 })
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'acknowledged')
    assert.equal(operation(ctx, 'card_a1')?.state, 'pending')
})

test('未交付但分配其实已售出（交付响应丢失）→ 必须作废', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', 'sold'),
        revoke: async (cardId) => ({ cardId, status: 'revoked' }),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('未交付但卡已作废 → 幂等补记本地终态，不再调 revoke', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'revoked', 'sold'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('429 → deferred，待办保持 pending 并带下次重试时间（不得说成已完成）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'rate_limited', httpStatus: 429, retryable: true, retryAfterMs: 2_000 })
        },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.deferred, 1)
    assert.equal(outcome.revoked, 0)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'sold')
    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'pending')
    assert.equal(op?.next_retry_at, 3_000)
    assert.equal(op?.last_error_code, 'rate_limited')
})

test('403 → failed，映射保持原状等待人工核查，且不重试', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 })
        },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.failed, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'sold')
    assert.equal(operation(ctx, 'card_a1')?.state, 'failed')
})

test('409 + 单查卡已 revoked → 判为已作废；409 只调一次 revoke、一次单查', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 })
        },
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'revoked', 'sold'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(client.callCount('getCardStatus'), 1)
    // 409 分支只关心「卡是否已 revoked」，不该再打一次分配查询。
    assert.equal(client.callCount('getAllocation'), 0)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('409 + 单查卡并未 revoked → failed 交人工，不重试', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 })
        },
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', 'sold'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.failed, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(operation(ctx, 'card_a1')?.state, 'failed')
})

test('多卡：一张成功、一张 429，各自落账（一张失败不影响其余）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1, { isUsed: true })
    seedCard(ctx, 2, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_a2', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async (cardId) => {
            if (cardId === 'card_a2') {
                throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503, retryable: true })
            }
            return { cardId, status: 'revoked' }
        },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [1, 2] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 2, revoked: 1, retained: 0, deferred: 1, failed: 0 })
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
    assert.equal(mapped(ctx, 'card_a2')?.state, 'sold')
    assert.equal(operation(ctx, 'card_a2')?.state, 'pending')
})

test('已作废的卡直接跳过：不写意图、不调中心', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'revoked', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient()
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const outcome = await executeOrderRevokes(deps, {
        orderId: ORDER_ID,
        cards: [{ localCardId: 7, remoteCardId: 'card_a1', allocationId: ALLOC_A, state: 'revoked', alreadyRevoked: true }],
        reason: 'ldc-shop:refund',
    })

    assert.deepEqual(outcome, { requested: 0, revoked: 0, retained: 0, deferred: 0, failed: 0 })
    assert.equal(client.calls.length, 0)
    assert.equal(ctx.all('SELECT operation_key FROM card_service_operations').length, 0)
})

test('作废意图先于中心调用落账：调用失败也不会丢掉「谁需要作废」', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    let intentSeenDuringCall = -1
    const client = createFakeLicenseServiceClient({
        revoke: async (cardId) => {
            intentSeenDuringCall = ctx.all('SELECT operation_key FROM card_service_operations').length
            return { cardId, status: 'revoked' }
        },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(intentSeenDuringCall, 1)
})

test('buildRevokeIntentStatements 用 OR IGNORE，不把已有状态改回 pending', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
        VALUES ('revoke:card_a1:${ORDER_ID}', 'revoke', 'card_a1', '${ORDER_ID}', 'failed', 3, 0, 0)`)

    await ctx.database.write(buildRevokeIntentStatements({
        orderId: ORDER_ID,
        cards: [{ remoteCardId: 'card_a1' }],
        nowMs: 5_000,
    }))

    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'failed')
    assert.equal(op?.attempts, 3)
})

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

test('重放待办：按原键作废，成功后台账转 done', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, next_retry_at, created_at, updated_at)
        VALUES ('revoke:card_a1:${ORDER_ID}', 'revoke', 'card_a1', '${ORDER_ID}', 'pending', 1, 0, 0, 0)`)

    const client = createFakeLicenseServiceClient({ revoke: async (cardId) => ({ cardId, status: 'revoked' }) })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    assert.deepEqual(await listPendingRevokeOperations(ctx.database), [{
        operationKey: `revoke:card_a1:${ORDER_ID}`,
        remoteCardId: 'card_a1',
        orderId: ORDER_ID,
        state: 'pending',
        attempts: 1,
    }])

    const outcome = await revokePendingCardServiceOperations(deps, { limit: 5 })
    assert.equal(outcome.attempted, 1)
    assert.equal(outcome.revoked, 1)
    assert.equal(outcome.review, 0)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('重放时映射缺失 → 计入 review，绝不猜着作废', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
        VALUES ('revoke:card_ghost:${ORDER_ID}', 'revoke', 'card_ghost', '${ORDER_ID}', 'failed', 2, 0, 0)`)

    const client = createFakeLicenseServiceClient()
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const outcome = await revokePendingCardServiceOperations(deps, { limit: 5 })
    assert.equal(outcome.attempted, 1)
    assert.equal(outcome.review, 1)
    assert.equal(outcome.revoked, 0)
    assert.equal(client.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 中心凭据缺失时的降级
// ---------------------------------------------------------------------------

test('中心凭据缺失 → 意图照样落账、逐卡记 failed，绝不算作已完成', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedCard(ctx, 7, { isUsed: true })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await failRevokesWithoutClient(ctx.database, {
        orderId: ORDER_ID,
        cards: plan.cards,
        errorCode: 'config_error',
        nowMs: 1_000,
    })

    assert.equal(outcome.requested, 1)
    assert.equal(outcome.failed, 1)
    assert.equal(outcome.revoked, 0)
    assert.equal(outcome.deferred, 0)

    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'failed')
    assert.equal(op?.last_error_code, 'config_error')
    // 映射保持可作废状态：Key 配好后重放仍要凭它找到远端身份。
    assert.equal(mapped(ctx, 'card_a1')?.state, 'sold')
})

test('空作废范围不写任何台账（已作废的卡不会被重新拉进待办）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedAllocation(ctx, { state: 'sold' })
    seedCard(ctx, 7, { isUsed: true })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'revoked', orderId: ORDER_ID })

    const plan = await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] })
    assert.equal(plan.kind, 'none')

    const outcome = await failRevokesWithoutClient(ctx.database, {
        orderId: ORDER_ID,
        cards: [],
        errorCode: 'config_error',
        nowMs: 1_000,
    })
    assert.equal(outcome.requested, 0)
    assert.equal(ctx.get('SELECT COUNT(*) AS total FROM card_service_operations')?.total, 0)
})

// ---------------------------------------------------------------------------
// 本地卡隔离：作废未确认期间不得留在可售池
// ---------------------------------------------------------------------------

test('作废意图落账即隔离本地卡：is_used 置 1，且不改写已交付卡的 used_at', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedCard(ctx, 8, { isUsed: true })
    ctx.exec('UPDATE cards SET used_at = 500 WHERE id = 8')
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })
    seedMapping(ctx, { localCardId: 8, remoteCardId: 'card_a2', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({ revoke: async (cardId) => ({ cardId, status: 'revoked' }) })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7, 8] }))
    await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.equal(card(ctx, 7)?.used_at, 1_000)
    // 已交付的卡保留它真实的交付时间，隔离不改写历史。
    assert.equal(card(ctx, 8)?.used_at, 500)
})

test('作废未确认（中心 429）时本地卡也必须已经隔离 —— 否则会被再卖一次', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'rate_limited', httpStatus: 429, retryable: true })
        },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.deferred, 1)
    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.equal(card(ctx, 7)?.reserved_order_id, null)
    assert.equal(operation(ctx, 'card_a1')?.state, 'pending')
})

test('中心确认仍可用 → 本地卡放回可售池', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', 'acknowledged'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.retained, 1)
    assert.equal(card(ctx, 7)?.is_used, 0)
    assert.equal(card(ctx, 7)?.used_at, null)
    assert.equal(card(ctx, 7)?.reserved_order_id, null)
})

test('放回库存只针对「从未交付」的卡：台账已是 sold 时绝不放行', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    await ctx.database.write(buildRevokeIntentStatements({
        orderId: ORDER_ID,
        cards: [{ remoteCardId: 'card_a1', localCardId: 7 }],
        nowMs: 900,
    }))
    await ctx.database.write(buildRevokeRetainStatements({
        orderId: ORDER_ID,
        remoteCardId: 'card_a1',
        localCardId: 7,
        nowMs: 1_000,
    }))

    // 台账说这张卡已交付 → 不放回；台账仍要记成 done（放回动作已做过判断）。
    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('退款批次语句：未作废的写意图 + 隔离，已作废的只隔离', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 1)
    seedCard(ctx, 2)
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 1, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })
    seedMapping(ctx, { localCardId: 2, remoteCardId: 'card_a2', state: 'revoked', orderId: ORDER_ID })

    await ctx.database.write(buildRefundRevokeStatements({
        orderId: ORDER_ID,
        cards: [
            { localCardId: 1, remoteCardId: 'card_a1', allocationId: ALLOC_A, state: 'sold', alreadyRevoked: false },
            { localCardId: 2, remoteCardId: 'card_a2', allocationId: ALLOC_A, state: 'revoked', alreadyRevoked: true },
        ],
        nowMs: 1_000,
    }))

    // 两张卡都被隔离：远端已死的卡同样不该还能卖。
    assert.equal(card(ctx, 1)?.is_used, 1)
    assert.equal(card(ctx, 2)?.is_used, 1)
    // 只有未作废的那张需要待办。
    assert.equal(ctx.all('SELECT operation_key FROM card_service_operations').length, 1)
    assert.equal(operation(ctx, 'card_a1')?.state, 'pending')
})

test('退款动作把作废语句拼进同一个原子批次（先本地结算、后远端作废）', () => {
    const source = readFileSync(new URL('../../actions/refund.ts', import.meta.url), 'utf8')

    const pushAt = source.indexOf('planOrderRevokeBatchStatements(')
    const batchAt = source.indexOf('runAtomicD1Batch(refundStatements)')
    const executeAt = source.indexOf('executeOrderRevokePlan(')

    assert.ok(pushAt > 0, '退款动作必须把作废语句拼进 refundStatements')
    assert.ok(batchAt > pushAt, '作废语句必须在 runAtomicD1Batch(refundStatements) 之前拼好，否则又留下丢失窗口')
    assert.ok(executeAt > batchAt, '远端作废必须排在本地结算之后，顺序不能反')
})

// ---------------------------------------------------------------------------
// 源码级守卫：别再把卡状态当分配状态用
// ---------------------------------------------------------------------------

test('revoke.ts 不得用卡状态判「已售出」（它永不返回 sold）', () => {
    const source = readFileSync(new URL('./revoke.ts', import.meta.url), 'utf8')

    // 旧实现写的是 `probe.status !== 'sold'`（恒真）——这类比较一旦回归，
    // 「中心已售出但本地未落账」的卡就会被当成库存留下，永久留在流通里。
    assert.doesNotMatch(source, /cardStatus\s*[!=]==?\s*'sold'/)
    assert.doesNotMatch(source, /probe\.(cardStatus|status)\s*[!=]==?\s*'sold'/)

    // 判定必须走分配状态，且分配状态必须真的被读出来。
    assert.match(source, /allocationStatus\s*[!=]==?\s*'sold'/)
    assert.match(source, /getAllocation/)
})

// ---------------------------------------------------------------------------
// 远端状态未知 ≠ 未售出
// ---------------------------------------------------------------------------

test('远端状态未知（403 / 无效响应）→ 不得放回库存，保留隔离与待办', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    // 卡状态与分配查询都拿不到明确结论 → probe 返回 allocationStatus = 'unknown'。
    const forbidden = () => { throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 }) }
    const client = createFakeLicenseServiceClient({
        getCardStatus: async () => forbidden(),
        getAllocation: async () => forbidden(),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    // 未知**不是**「仍可售」的证据：中心完全可能已经 sold，放回就是「一张卡卖给两个人」。
    assert.equal(outcome.retained, 0)
    assert.equal(outcome.deferred, 1)
    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.equal(operation(ctx, 'card_a1')?.state, 'pending')
})

test('回归：远端状态未知的延后走指数退避，不再「立即可重试」', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })
    const unavailableAnswer = () => { throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 }) }
    const client = createFakeLicenseServiceClient({
        getCardStatus: async () => unavailableAnswer(),
        getAllocation: async () => unavailableAnswer(),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'pending')
    assert.equal(op?.last_error_code, 'remote_status_unknown')
    // 首次失败：attempts 0 → 1，退避 = now + 60s * 2^0。
    assert.equal(op?.attempts, 1)
    assert.equal(op?.next_retry_at, 1_000 + 60_000)
    // 定时重放遵守退避：退避未到期时不会被选中。
    assert.deepEqual(await listPendingRevokeOperations(ctx.database, { respectBackoff: true, nowMs: 2_000 }), [])
})

test('回归：远端状态持续未知累计到上限 → abandoned 进复核清单，不再无限重放', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })
    const unavailableAnswer = () => { throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 }) }
    const client = createFakeLicenseServiceClient({
        getCardStatus: async () => unavailableAnswer(),
        getAllocation: async () => unavailableAnswer(),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }
    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))

    // 模拟线上已累计 35 次的旧待办：下一次失败就必须转终态。
    ctx.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, attempts, next_retry_at, created_at, updated_at)
        VALUES ('revoke:card_a1:${ORDER_ID}', 'revoke', 'card_a1', '${ORDER_ID}', 'pending', 35, 0, 0, 0)`)
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.deferred, 1)
    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'abandoned')
    assert.equal(op?.attempts, 36)
    assert.equal(op?.next_retry_at, null)
    // 卡保持隔离：终态 ≠ 放回库存。
    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.deepEqual(await listPendingRevokeOperations(ctx.database), [])
})

test('卡与分配都 404（旧凭据名下的分配）→ 转复核 not_found，可本地丢弃，绝不放回库存', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })
    const notFound = () => { throw new LicenseServiceError({ code: 'not_found', httpStatus: 404 }) }
    const client = createFakeLicenseServiceClient({
        getCardStatus: async () => notFound(),
        getAllocation: async () => notFound(),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 0, retained: 0, deferred: 0, failed: 1 })
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(card(ctx, 7)?.is_used, 1)
    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'failed')
    assert.equal(op?.last_error_code, 'not_found')
})

test('只有一边 404（卡查不到但分配 403）→ 仍按未知延后，不下 not_found 结论', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })
    const client = createFakeLicenseServiceClient({
        getCardStatus: async () => { throw new LicenseServiceError({ code: 'not_found', httpStatus: 404 }) },
        getAllocation: async () => { throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 }) },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    const op = operation(ctx, 'card_a1')
    assert.equal(op?.state, 'pending')
    assert.equal(op?.last_error_code, 'remote_status_unknown')
})

test('明确确认仍可用（acknowledged）才放回 —— 与 unknown 区别对待', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', 'acknowledged'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.retained, 1)
    assert.equal(card(ctx, 7)?.is_used, 0)
})

// ---------------------------------------------------------------------------
// 放回库存不得越权动别的订单的预留
// ---------------------------------------------------------------------------

test('放回库存只认领本单的预留：并发重放不会清掉新订单刚做的预留', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    // 1) 退款批次先隔离这张卡（预留被清空）。
    await ctx.database.write(buildRevokeIntentStatements({
        orderId: ORDER_ID,
        cards: [{ remoteCardId: 'card_a1', localCardId: 7 }],
        nowMs: 900,
    }))
    // 2) 卡回到可售池后，另一笔订单把它预留了。
    ctx.exec(`UPDATE cards SET is_used = 1, reserved_order_id = '${OTHER_ORDER}', reserved_at = 500 WHERE id = 7`)
    // 3) 一笔**并发重放**的旧执行尝试把卡「放回」。
    await ctx.database.write(buildRevokeRetainStatements({
        orderId: ORDER_ID,
        remoteCardId: 'card_a1',
        localCardId: 7,
        nowMs: 1_000,
    }))

    // 既不能放回（is_used 仍为 1），更不能清掉那条不属于本单的预留。
    assert.equal(card(ctx, 7)?.is_used, 1)
    assert.equal(card(ctx, 7)?.reserved_order_id, OTHER_ORDER)
})

// ---------------------------------------------------------------------------
// 「不是 sold」≠「仍可售」：处置口径必须穷举取值域
// ---------------------------------------------------------------------------

test('处置口径逐格穷举：只有「卡 active 且分配仍归本店」才放回库存', () => {
    const cases: Array<[string, string, string]> = [
        // 卡状态, 分配状态, 期望 kind
        ['active', 'acknowledged', 'retain'],
        ['active', 'allocated', 'retain'],
        ['revoked', 'acknowledged', 'reclaim'],
        ['revoked', 'sold', 'reclaim'],
        ['active', 'sold', 'revoke'],
        ['active', '', 'defer'],
        ['active', 'unknown', 'defer'],
        ['', 'unknown', 'defer'],
        // ⚠️ 本轮 P1：分配「不是 sold」但已不可用 —— 曾一律被放回库存。
        ['active', 'expired', 'review'],
        ['active', 'cancelled', 'review'],
        ['active', 'unallocated', 'review'],
        // 分配还在手上，但卡本身已经卖不出去 —— 曾一律被放回库存，制造发不出的订单。
        ['disabled', 'acknowledged', 'revoke'],
        ['expired', 'acknowledged', 'revoke'],
        ['exhausted', 'acknowledged', 'revoke'],
        // 卡状态读不到 / 不认识：不是「可售」的证据。
        ['unknown', 'acknowledged', 'review'],
        ['', 'acknowledged', 'review'],
        ['sold', 'acknowledged', 'review'],
    ]

    for (const [cardStatus, allocationStatus, expected] of cases) {
        const disposition = classifyAcknowledgedProbe({ cardStatus, allocationStatus })
        assert.equal(
            disposition.kind,
            expected,
            `cardStatus=${cardStatus || '(空)'} allocationStatus=${allocationStatus || '(空)'} 期望 ${expected}，实际 ${disposition.kind}`,
        )
    }
})

test('复核分支给出可区分的错误码，便于运维定位', () => {
    assert.deepEqual(
        classifyAcknowledgedProbe({ cardStatus: 'active', allocationStatus: 'expired' }),
        { kind: 'review', errorCode: 'allocation_unusable' },
    )
    assert.deepEqual(
        classifyAcknowledgedProbe({ cardStatus: 'active', allocationStatus: 'unallocated' }),
        { kind: 'review', errorCode: 'allocation_not_held' },
    )
    assert.deepEqual(
        classifyAcknowledgedProbe({ cardStatus: 'unknown', allocationStatus: 'acknowledged' }),
        { kind: 'review', errorCode: 'card_status_unusable' },
    )
    assert.deepEqual(
        classifyAcknowledgedProbe({ cardStatus: 'active', allocationStatus: '' }),
        { kind: 'defer', errorCode: 'remote_status_unknown' },
    )
})

test('卡已 disabled（分配仍在我们手上）→ 必须吊销，且绝不放回库存', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'disabled', 'acknowledged'),
        revoke: async (cardId) => ({ cardId, status: 'revoked' }),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 1, retained: 0, deferred: 0, failed: 0 })
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('分配已 expired/cancelled（卡状态仍 active）→ 不放回库存、不自动吊销，转人工复核', async () => {
    for (const allocationStatus of ['expired', 'cancelled']) {
        const ctx = createSqliteCardServiceDatabase()
        seedCard(ctx, 7)
        seedAllocation(ctx)
        seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

        const client = createFakeLicenseServiceClient({
            getCardStatus: async (cardId) => makeCardStatus(cardId, 'active', allocationStatus),
            revoke: async () => { throw new Error('分配已被中心回收，不得凭本单退款去吊销') },
        })
        const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

        const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
        const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

        assert.deepEqual(
            outcome,
            { requested: 1, revoked: 0, retained: 0, deferred: 0, failed: 1 },
            `allocationStatus=${allocationStatus} 的处置`,
        )
        assert.equal(client.callCount('revoke'), 0)
        // 映射保持原状（未作废、也未被放回），本地卡仍是隔离态。
        assert.equal(mapped(ctx, 'card_a1')?.state, 'acknowledged')
        assert.equal(card(ctx, 7)?.is_used, 1)
        const op = operation(ctx, 'card_a1')
        assert.equal(op?.state, 'failed')
        assert.equal(op?.last_error_code, 'allocation_unusable')
    }
})
