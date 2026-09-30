/**
 * 阶段 E 源码级单测：退款后的远端作废。
 *
 * 重点覆盖两类截然不同的分支，因为它们的代价相反：
 *   - 已 `sold` 的卡必须作废（用户已拿到明文，作废不回库存）；
 *   - 仅 `acknowledged` 的卡**不能**直接作废（那是本店库存），必须先查中心
 *     真实状态，只有中心确实已售/已作废才动手。
 *
 * 另外验证「中心超时不得说成已完成」：429/503 后待办必须仍是 `pending`
 * 且带 `next_retry_at`，能被重放入口原键再走一遍。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LicenseServiceError } from './errors.ts'
import {
    buildRevokeIntentStatements,
    executeOrderRevokes,
    listPendingRevokeOperations,
    loadOrderRevokePlan,
    loadRevokePlanForRemoteCards,
    revokePendingCardServiceOperations,
    type OrderRevokePlan,
    type RevokeDeps,
} from './revoke.ts'
import { createFakeLicenseServiceClient, createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

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

function makeCardStatus(cardId: string, status: string) {
    return {
        cardId,
        programId: 'prog_1',
        maskedKey: 'CS-****',
        status,
        allocationStatus: null,
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

test('未交付且中心仍可用 → 不作废，保留为本店库存', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'acknowledged'),
        revoke: async () => { throw new Error('revoke must not be called') },
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.deepEqual(outcome, { requested: 1, revoked: 0, retained: 1, deferred: 0, failed: 0 })
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'acknowledged')
    assert.equal(operation(ctx, 'card_a1')?.state, 'done')
})

test('未交付但中心其实已售出（交付响应丢失）→ 必须作废', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'sold'),
        revoke: async (cardId) => ({ cardId, status: 'revoked' }),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000 }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('未交付但中心已作废 → 幂等补记本地终态，不再调 revoke', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7)
    seedAllocation(ctx)
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1' })

    const client = createFakeLicenseServiceClient({
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'revoked'),
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

test('409 + 单查已 revoked → 判为已作废；409 只调一次 revoke、一次单查', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 })
        },
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'revoked'),
    })
    const deps: RevokeDeps = { client, database: ctx.database, now: () => 1_000, sleep: async () => {} }

    const plan = planOf(await loadOrderRevokePlan(ctx.database, { orderId: ORDER_ID, localCardIds: [7] }))
    const outcome = await executeOrderRevokes(deps, { orderId: ORDER_ID, cards: plan.cards, reason: 'ldc-shop:refund' })

    assert.equal(outcome.revoked, 1)
    assert.equal(client.callCount('revoke'), 1)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(mapped(ctx, 'card_a1')?.state, 'revoked')
})

test('409 + 单查仍是 sold（状态未知冲突）→ failed 交人工，不重试', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedCard(ctx, 7, { isUsed: true })
    seedAllocation(ctx, { state: 'sold' })
    seedMapping(ctx, { localCardId: 7, remoteCardId: 'card_a1', state: 'sold', orderId: ORDER_ID })

    const client = createFakeLicenseServiceClient({
        revoke: async () => {
            throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 })
        },
        getCardStatus: async (cardId) => makeCardStatus(cardId, 'sold'),
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
