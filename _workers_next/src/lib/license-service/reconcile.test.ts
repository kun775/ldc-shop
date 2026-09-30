import test from 'node:test'
import assert from 'node:assert/strict'

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
    CARD_SERVICE_STAGED_CARDS_TABLE,
} from '../db/license-service-schema.ts'
import { LicenseServiceError } from './errors.ts'
import {
    abandonStaleAllocations,
    emptyReconcileSummary,
    reconcileCardServiceState,
    reconcilePendingAckOperations,
    resolveAllocationWithRemoteState,
} from './reconcile.ts'
import {
    ACK_RETRY_SAFETY_MARGIN_MS,
    buildInsertAckOperationStatement,
    buildInsertAllocationStatements,
    buildInsertStagedCardStatements,
    createRestockIntent,
    loadCardServiceAllocation,
    type RestockDeps,
} from './restock.ts'
import {
    createFakeLicenseServiceClient,
    createSqliteCardServiceDatabase,
    makeAllocationDetail,
    type FakeClientBehavior,
    type SqliteTestContext,
} from './test-support.ts'

const PRODUCT_ID = 'prod_1'
const PROGRAM_KEY = 'bill-service'
const NOW = 1_700_000_000_000

/** 只重试一次，避免单测被真实退避拖慢；重试行为由 retry.test.ts 覆盖。 */
const SINGLE_ATTEMPT = { maxAttempts: 1 }

function setup(): SqliteTestContext {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec(`INSERT INTO products (id) VALUES ('${PRODUCT_ID}')`)
    return ctx
}

/** 造一笔「已领到卡但尚未确认」的本地账本：台账 + 不可售暂存 + pending Ack 待办。 */
async function seedAllocation(
    ctx: SqliteTestContext,
    options: { allocationId: string; expiresAtMs: number; stagedIds?: string[] } ,
): Promise<void> {
    const intent = createRestockIntent({
        productId: PRODUCT_ID,
        programKey: PROGRAM_KEY,
        quantity: 1,
        reason: 'reconcile-test',
        taskId: `task-${options.allocationId}`,
    })
    const stagedIds = options.stagedIds ?? [`remote-${options.allocationId}`]
    await ctx.database.write([
        ...buildInsertAllocationStatements(intent, {
            allocationId: options.allocationId,
            expiresAtMs: options.expiresAtMs,
        }, NOW),
        ...buildInsertStagedCardStatements(
            intent,
            options.allocationId,
            stagedIds.map((id) => ({ id, key: `KEY-${id}`, maskedKey: null })),
            NOW,
        ),
        buildInsertAckOperationStatement({
            operationKey: intent.ackIdempotencyKey,
            allocationId: options.allocationId,
            nowMs: NOW,
        }),
    ])
}

function depsOf(ctx: SqliteTestContext, behavior: FakeClientBehavior, nowMs = NOW): RestockDeps {
    return {
        client: createFakeLicenseServiceClient(behavior),
        database: ctx.database,
        now: () => nowMs,
        policy: SINGLE_ATTEMPT,
    }
}

async function rowOf(ctx: SqliteTestContext, allocationId: string) {
    const row = await loadCardServiceAllocation(ctx.database, allocationId)
    assert.ok(row, `缺少台账 ${allocationId}`)
    return row
}

function countOf(ctx: SqliteTestContext, table: string): number {
    return Number(ctx.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
}

test('远程仍为 allocated 且窗口充足：继续 Ack 并物化进可售库存', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_ok', expiresAtMs: NOW + ACK_RETRY_SAFETY_MARGIN_MS + 60_000 })
    const deps = depsOf(ctx, {
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'allocated' }),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_ok'))

    assert.equal(outcome, 'acknowledged')
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)?.state, 'acknowledged')
})

test('远程 allocated 但剩余窗口小于安全边际：主动放弃本地副本，不再发 Ack', async () => {
    const ctx = setup()
    await seedAllocation(ctx, {
        allocationId: 'alloc_barely',
        expiresAtMs: NOW + ACK_RETRY_SAFETY_MARGIN_MS - 1,
    })
    const deps = depsOf(ctx, {
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'allocated' }),
        ack: async () => {
            throw new Error('窗口不足时不应发出 Ack')
        },
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_barely'))

    assert.equal(outcome, 'expired')
    assert.equal(deps.client.callCount('ack'), 0)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'expired')
    assert.equal(ledger?.last_error_code, 'allocation_expired')
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)?.state, 'abandoned')
})

test('远程 expired / cancelled：本地副本按对应终态作废', async () => {
    for (const [remoteStatus, expectedState, expectedError] of [
        ['expired', 'expired', 'allocation_expired'],
        ['cancelled', 'cancelled', 'allocation_cancelled'],
    ] as const) {
        const ctx = setup()
        const allocationId = `alloc_${remoteStatus}`
        await seedAllocation(ctx, { allocationId, expiresAtMs: NOW + 10 * 60_000 })
        const deps = depsOf(ctx, {
            getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: remoteStatus }),
        })

        const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, allocationId))

        assert.equal(outcome, expectedState === 'expired' ? 'expired' : 'cancelled')
        assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
        const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
        assert.equal(ledger?.state, expectedState)
        assert.equal(ledger?.last_error_code, expectedError)
    }
})

test('远程已 sold 属于预期外状态：保留暂存并交人工核查，不凭空物化成可售卡', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_sold', expiresAtMs: NOW + 10 * 60_000 })
    const deps = depsOf(ctx, {
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'sold' }),
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_sold'))

    assert.equal(outcome, 'requires_review')
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)?.state, 'allocated')
})

test('查询返回 not_found：本地副本无法再转正，就地作废并留痕', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_gone', expiresAtMs: NOW + 10 * 60_000 })
    const deps = depsOf(ctx, {
        getAllocation: async () => {
            throw new LicenseServiceError({ code: 'not_found', httpStatus: 404 })
        },
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_gone'))

    assert.equal(outcome, 'cancelled')
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'cancelled')
    assert.equal(ledger?.last_error_code, 'not_found')
})

test('查询暂时不可用：留待下一轮，什么都不改', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_later', expiresAtMs: NOW + 10 * 60_000 })
    const deps = depsOf(ctx, {
        getAllocation: async () => {
            throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503 })
        },
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_later'))

    assert.equal(outcome, 'deferred')
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'allocated')
    assert.equal(ledger?.last_error_code, null)
})

test('查询遇到鉴权/契约错误：保持暂存不动，标记需人工处理', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_auth', expiresAtMs: NOW + 10 * 60_000 })
    const deps = depsOf(ctx, {
        getAllocation: async () => {
            throw new LicenseServiceError({ code: 'forbidden', httpStatus: 403 })
        },
    })

    const outcome = await resolveAllocationWithRemoteState(deps, await rowOf(ctx, 'alloc_auth'))

    assert.equal(outcome, 'failed')
    // 远程可能仍持有这批卡，删掉等于把库存白送出去。
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)?.state, 'allocated')
})

test('待办重放：先核对远程真实状态再决定动作，台账缺失与终态分别计入需核查 / 跳过', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_active', expiresAtMs: NOW + 10 * 60_000 })
    // 台账已被人工改成终态，但待办还挂着：不该再动它。
    await seedAllocation(ctx, { allocationId: 'alloc_done', expiresAtMs: NOW + 10 * 60_000 })
    ctx.exec(`UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE} SET state = 'acknowledged' WHERE allocation_id = 'alloc_done'`)
    // 待办指向一个不存在的台账：永远无法推进。
    await ctx.database.write([buildInsertAckOperationStatement({
        operationKey: 'restock:task-ghost:ack',
        allocationId: 'alloc_ghost',
        nowMs: NOW,
    })])

    const deps = depsOf(ctx, {
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'allocated' }),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })

    const summary = await reconcilePendingAckOperations(deps)

    assert.deepEqual(summary, {
        ...emptyReconcileSummary(),
        checked: 3,
        acknowledged: 1,
        requiresReview: 1,
        skipped: 1,
        changedProductIds: [PRODUCT_ID],
    })
    assert.equal(countOf(ctx, 'cards'), 1)

    const ghost = ctx.get(`SELECT state FROM ${CARD_SERVICE_OPERATIONS_TABLE} WHERE operation_key = 'restock:task-ghost:ack'`)
    assert.equal(ghost?.state, 'pending')
})

test('过期分配清理会先查远程状态：时钟误判时不会把确认成功的库存当垃圾删掉', async () => {
    const ctx = setup()
    const deadLine = NOW - 5 * 60_000
    await seedAllocation(ctx, { allocationId: 'alloc_stale_ok', expiresAtMs: deadLine })
    await seedAllocation(ctx, { allocationId: 'alloc_fresh', expiresAtMs: NOW + 10 * 60_000 })

    const deps = depsOf(ctx, {
        // 本地认为已超窗，但远程其实还持有（Ack 幂等补提交即可转正）。
        getAllocation: async (id) => makeAllocationDetail({ allocationId: id, status: 'acknowledged' }),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })

    const summary = await abandonStaleAllocations(deps)

    assert.deepEqual(summary, {
        ...emptyReconcileSummary(),
        checked: 1,
        acknowledged: 1,
        changedProductIds: [PRODUCT_ID],
    })
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} WHERE allocation_id = 'alloc_stale_ok'`)?.state, 'acknowledged')
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} WHERE allocation_id = 'alloc_fresh'`)?.state, 'allocated')
    assert.equal(countOf(ctx, CARD_SERVICE_CARDS_TABLE), 1)
})

test('对账入口把待办推进与过期清理合并计数', async () => {
    const ctx = setup()
    await seedAllocation(ctx, { allocationId: 'alloc_pending', expiresAtMs: NOW + 10 * 60_000 })
    await seedAllocation(ctx, { allocationId: 'alloc_stale', expiresAtMs: NOW - 60_000 })

    const deps = depsOf(ctx, {
        getAllocation: async (id) => makeAllocationDetail({
            allocationId: id,
            status: id === 'alloc_stale' ? 'expired' : 'allocated',
        }),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })

    const summary = await reconcileCardServiceState(deps)

    assert.deepEqual(summary, {
        ...emptyReconcileSummary(),
        checked: 2,
        acknowledged: 1,
        expired: 1,
        changedProductIds: [PRODUCT_ID],
    })
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
})
