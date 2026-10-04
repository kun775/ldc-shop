import test from 'node:test'
import assert from 'node:assert/strict'

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
    CARD_SERVICE_STAGED_CARDS_TABLE,
} from '../db/license-service-schema.ts'
import { LicenseServiceError } from './errors.ts'
import { loadProductSupplyGuard, saveCardServiceProductConfig } from './product-config.ts'
import { emptyReplenishSummary, replenishLowStockProducts } from './replenish.ts'
import { CARD_SERVICE_MAX_OPERATION_ATTEMPTS, CARD_SERVICE_RETRY_BACKOFF_BASE_MS } from './operation-queue.ts'
import {
    ackAndMaterializeAllocation,
    buildInsertAllocationStatements,
    createRestockIntent,
    loadCardServiceAllocation,
    restockProductCards,
} from './restock.ts'
import {
    createFakeLicenseServiceClient,
    createSqliteCardServiceDatabase,
    makeAllocationDetail,
    type SqliteTestContext,
} from './test-support.ts'

const PRODUCT_ID = 'prod_1'
const PROGRAM_KEY = 'bill-service'
const NOW = 1_700_000_000_000

function setup(): SqliteTestContext {
    const ctx = createSqliteCardServiceDatabase()
    // cards.product_id 有外键，物化前商品必须存在。
    ctx.exec(`INSERT INTO products (id) VALUES ('${PRODUCT_ID}')`)
    return ctx
}

async function configure(
    ctx: SqliteTestContext,
    overrides: { supplyMode?: string; programKey?: string | null; targetStock?: number | null } = {},
): Promise<void> {
    await saveCardServiceProductConfig(ctx.database, {
        productId: PRODUCT_ID,
        supplyMode: (overrides.supplyMode ?? 'license_service') as 'license_service',
        programKey: overrides.programKey === undefined ? PROGRAM_KEY : overrides.programKey,
        targetStock: overrides.targetStock === undefined ? 5 : overrides.targetStock,
    }, 1_000)
}

function countOf(ctx: SqliteTestContext, table: string): number {
    return Number(ctx.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
}

/** 只重试一次，避免单测被真实退避拖慢；重试行为本身由 retry.test.ts 覆盖。 */
const singleAttempt = { policy: { maxAttempts: 1 } }

test('未接入的商品不产生任何远端调用', async () => {
    const ctx = setup()
    const client = createFakeLicenseServiceClient()

    const result = await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID })
    assert.deepEqual(result, { status: 'skipped', reason: 'not_configured' })
    assert.equal(client.calls.length, 0)
})

test('供应模式不是 license_service 或缺少 program_key 时跳过，不联网取卡', async () => {
    const ctx = setup()
    const client = createFakeLicenseServiceClient()

    await configure(ctx, { supplyMode: 'local' })
    assert.deepEqual(
        await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID }),
        { status: 'skipped', reason: 'supply_mode_not_license_service' },
    )

    await configure(ctx, { programKey: null })
    assert.deepEqual(
        await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID }),
        { status: 'skipped', reason: 'program_key_missing' },
    )

    assert.equal(client.calls.length, 0)
})

test('商品已被删除（供应配置行还在）时不再补货，一张卡都不向中心领', async () => {
    // 这是删除商品后的真实残留形态：`deleteProduct` 级联带走 `products` 与本地
    // `cards`，但 `card_service_product_configs` 行仍在。低水位扫描若只看配置，
    // 就会继续对着一个不存在的商品 Allocate / Ack —— 中心库存被扣掉，物化时
    // 本地外键失败，白烧库存。所以兜底闸门必须同时看 `exists`。
    const ctx = setup()
    await configure(ctx)
    ctx.exec(`DELETE FROM products WHERE id = '${PRODUCT_ID}'`)

    const client = createFakeLicenseServiceClient()
    const result = await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID })

    assert.deepEqual(result, { status: 'skipped', reason: 'product_not_found' })
    assert.equal(client.calls.length, 0)
})

test('直接补货下架商品跳过，先于未物化查询且零远端调用、零台账写入', async () => {
    const ctx = setup()
    await configure(ctx)
    ctx.exec(`UPDATE products SET is_active = 0 WHERE id = '${PRODUCT_ID}'`)
    const queries: string[] = []
    let writes = 0
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            queries.push(sql)
            return ctx.database.query<T>(sql, params)
        },
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            return ctx.database.write(statements)
        },
    } as SqliteTestContext['database']
    const client = createFakeLicenseServiceClient()

    const result = await restockProductCards({ client, database, ...singleAttempt }, { productId: PRODUCT_ID })

    assert.deepEqual(result, { status: 'skipped', reason: 'product_inactive' })
    assert.equal(queries.some((sql) => sql.includes(CARD_SERVICE_ALLOCATIONS_TABLE)), false)
    assert.equal(queries.some((sql) => /\bFROM\s+cards\b/i.test(sql)), false)
    assert.equal(client.calls.length, 0)
    assert.equal(writes, 0)
    for (const table of ['cards', CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_STAGED_CARDS_TABLE, CARD_SERVICE_OPERATIONS_TABLE]) {
        assert.equal(countOf(ctx, table), 0, table)
    }
})

test('商品 is_active 为 NULL 时不可补货，不查询未物化分配也不联网', async () => {
    const ctx = setup()
    await configure(ctx)
    ctx.exec(`UPDATE products SET is_active = NULL WHERE id = '${PRODUCT_ID}'`)
    const queries: string[] = []
    let writes = 0
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            queries.push(sql)
            return ctx.database.query<T>(sql, params)
        },
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            return ctx.database.write(statements)
        },
    } as SqliteTestContext['database']
    const client = createFakeLicenseServiceClient()

    const result = await restockProductCards({ client, database, ...singleAttempt }, { productId: PRODUCT_ID })

    assert.deepEqual(result, { status: 'skipped', reason: 'product_inactive' })
    assert.equal(queries.some((sql) => sql.includes(CARD_SERVICE_ALLOCATIONS_TABLE)), false)
    assert.equal(client.calls.length, 0)
    assert.equal(writes, 0)
    for (const table of ['cards', CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_STAGED_CARDS_TABLE, CARD_SERVICE_OPERATIONS_TABLE]) {
        assert.equal(countOf(ctx, table), 0, table)
    }
})

test('商品读取失败时守卫 isActive 为 false，补货安全跳过而非继续领卡', async () => {
    const ctx = setup()
    await configure(ctx)
    let productReads = 0
    const queries: string[] = []
    let writes = 0
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            queries.push(sql)
            if (/\bFROM\s+products\b/i.test(sql)) {
                productReads += 1
                throw new Error('D1_ERROR: storage operation exceeded timeout')
            }
            return ctx.database.query<T>(sql, params)
        },
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            return ctx.database.write(statements)
        },
    } as SqliteTestContext['database']
    const client = createFakeLicenseServiceClient()

    assert.deepEqual(await loadProductSupplyGuard(database, PRODUCT_ID), {
        exists: true, isShared: false, isActive: false,
    })
    const result = await restockProductCards({ client, database, ...singleAttempt }, { productId: PRODUCT_ID })

    assert.deepEqual(result, { status: 'skipped', reason: 'product_inactive' })
    assert.equal(productReads, 2)
    assert.equal(queries.some((sql) => sql.includes(CARD_SERVICE_ALLOCATIONS_TABLE)), false)
    assert.equal(client.calls.length, 0)
    assert.equal(writes, 0)
    for (const table of ['cards', CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_STAGED_CARDS_TABLE, CARD_SERVICE_OPERATIONS_TABLE]) {
        assert.equal(countOf(ctx, table), 0, table)
    }
})

test('候选读取后商品下架的竞态：库存查询后由 restock 守卫阻断，不联网或写台账', async () => {
    const ctx = setup()
    await configure(ctx, { targetStock: 1 })
    const queries: string[] = []
    let inventoryReads = 0
    let writes = 0
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            queries.push(sql)
            const rows = await ctx.database.query<T>(sql, params)
            if (/\bFROM\s+cards\b/i.test(sql) && params[0] === PRODUCT_ID) {
                inventoryReads += 1
                ctx.exec(`UPDATE products SET is_active = 0 WHERE id = '${PRODUCT_ID}'`)
            }
            return rows
        },
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            return ctx.database.write(statements)
        },
    } as SqliteTestContext['database']
    const client = createFakeLicenseServiceClient()

    const summary = await replenishLowStockProducts({ client, database, now: () => NOW, ...singleAttempt })

    assert.deepEqual(summary, {
        ...emptyReplenishSummary(), products: 1, skipped: 1, cursor: PRODUCT_ID,
    })
    assert.equal(inventoryReads, 1)
    assert.equal(ctx.get(`SELECT is_active FROM products WHERE id = '${PRODUCT_ID}'`)?.is_active, 0)
    assert.equal(queries.some((sql) => sql.includes(CARD_SERVICE_ALLOCATIONS_TABLE)), false)
    assert.equal(client.calls.length, 0)
    assert.equal(writes, 0)
    for (const table of ['cards', CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_STAGED_CARDS_TABLE, CARD_SERVICE_OPERATIONS_TABLE]) {
        assert.equal(countOf(ctx, table), 0, table)
    }
})

test('正常补货：Ack 之前卡密只落在不可售暂存表，Ack 成功后才进 cards', async () => {
    const ctx = setup()
    await configure(ctx)
    const allocation = makeAllocationDetail({ allocationId: 'alloc_1', quantity: 1 })

    const observed: Array<{ staged: number; sellable: number }> = []
    const client = createFakeLicenseServiceClient({
        allocate: async () => allocation,
        ack: async () => {
            // 断言「Ack 请求发出的那一刻」本地状态：暂存已有、可售为 0。
            observed.push({
                staged: countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE),
                sellable: countOf(ctx, 'cards'),
            })
            return { allocationId: 'alloc_1', status: 'acknowledged' }
        },
    })

    const result = await restockProductCards({ client, database: ctx.database, now: () => NOW }, {
        productId: PRODUCT_ID,
        reason: 'manual-replenish',
    })

    assert.equal(result.status, 'restocked')
    assert.deepEqual(observed, [{ staged: 1, sellable: 0 }])

    if (result.status !== 'restocked') return
    assert.equal(result.remoteCardIds.length, 1)
    assert.equal(result.localCardIds.length, 1)
    assert.equal(result.expiresAtMs, allocation.expiresAtMs)

    // 落地形态：暂存清空、可售 +1、映射建立、台账与待办转终态。
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    assert.equal(countOf(ctx, 'cards'), 1)

    const mapping = ctx.get(`SELECT * FROM ${CARD_SERVICE_CARDS_TABLE}`)
    assert.equal(mapping?.state, 'acknowledged')
    assert.equal(mapping?.remote_card_id, allocation.cards[0].id)
    assert.equal(mapping?.order_id, null)
    assert.equal(mapping?.sold_at, null)

    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'acknowledged')
    assert.equal(ledger?.acked_at, NOW)
    assert.equal(ledger?.last_error_code, null)
    assert.equal(ledger?.program_key, PROGRAM_KEY)
    assert.ok(String(ledger?.external_ref).startsWith('ldc-shop:restock:'))

    const operation = ctx.get(`SELECT * FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.operation, 'ack')
    assert.equal(operation?.state, 'done')
    assert.equal(operation?.attempts, 1)
    assert.equal(operation?.resource_id, 'alloc_1')

    // 请求侧：Allocate 带 external_ref 与 metadata.source；Ack 复用台账里的键与卡序。
    const allocateArgs = client.callsOf('allocate')[0] as Record<string, unknown>
    assert.deepEqual(allocateArgs.metadata, { source: 'manual-replenish' })
    assert.equal(allocateArgs.externalRef, ledger?.external_ref)
    assert.equal(allocateArgs.quantity, 1)

    const ackArgs = client.callsOf('ack')[0] as Record<string, unknown>
    assert.deepEqual(ackArgs.receivedCardIds, [allocation.cards[0].id])
    assert.equal(ackArgs.externalRef, ledger?.external_ref)
    assert.equal(ackArgs.idempotencyKey, operation?.operation_key)
})

test('台账里的 program_key 取请求侧的受控 Program，而不是响应文本', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        // 响应的 program_key 与请求不一致时，契约层会拦；这里绕过契约直接看台账写法。
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_1', programKey: 'someone-else' }),
        ack: async () => ({ allocationId: 'alloc_1', status: 'acknowledged' }),
    })

    await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID })
    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.program_key, PROGRAM_KEY)
})

test('重复物化是幂等的：再跑一次 Ack+物化不会多发请求、不会多出卡', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_1' }),
        ack: async () => ({ allocationId: 'alloc_1', status: 'acknowledged' }),
    })

    await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID })
    const row = await loadCardServiceAllocation(ctx.database, 'alloc_1')
    assert.ok(row)

    const outcome = await ackAndMaterializeAllocation({ client, database: ctx.database }, row)
    assert.equal(outcome.status, 'acknowledged')
    if (outcome.status === 'acknowledged') {
        assert.deepEqual(outcome.remoteCardIds, [])
        assert.equal(outcome.localCardIds.length, 1)
    }
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(countOf(ctx, CARD_SERVICE_CARDS_TABLE), 1)
    assert.equal(client.callCount('ack'), 1)
})

test('Ack 成功后物化批次失败：不留半成品，暂存与原 Ack 键保留，且不新领卡', async () => {
    const ctx = setup()
    await configure(ctx)
    let writes = 0
    const database = {
        query: ctx.database.query.bind(ctx.database),
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            // 第 1 次是批次 A（台账+暂存+待办），第 2 次是物化批次。
            if (writes === 2) throw new Error('D1 is restarting')
            return ctx.database.write(statements)
        },
    }
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_mat' }),
        ack: async () => ({ allocationId: 'alloc_mat', status: 'acknowledged' }),
    })

    const result = await restockProductCards({ client, database, now: () => NOW, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })

    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
        assert.equal(result.allocationId, 'alloc_mat')
        assert.equal(result.errorCode, 'invalid_response')
    }
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(countOf(ctx, CARD_SERVICE_CARDS_TABLE), 0)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(client.callCount('allocate'), 1)
    assert.equal(client.callCount('ack'), 1)

    const ledger = ctx.get(`SELECT state, last_error_code, ack_key FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'allocated')
    assert.equal(ledger?.last_error_code, 'local_materialize_unavailable')
    const operation = ctx.get(`SELECT state, attempts, next_retry_at, operation_key FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'pending')
    assert.equal(operation?.attempts, 1)
    assert.equal(operation?.next_retry_at, NOW + CARD_SERVICE_RETRY_BACKOFF_BASE_MS)
    assert.equal(operation?.operation_key, ledger?.ack_key)
})

test('物化撞上约束时进入有限重试，到上限转 abandoned，仍不删暂存、不换任务', async () => {
    const ctx = setup()
    await configure(ctx)
    let writes = 0
    const database = {
        query: ctx.database.query.bind(ctx.database),
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            // 批次 A 放行；其后每次物化都撞约束，落账写入放行。
            if (writes === 2 || writes === 4) throw new Error('UNIQUE constraint failed: cards.id')
            return ctx.database.write(statements)
        },
    }
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_constraint' }),
        ack: async () => ({ allocationId: 'alloc_constraint', status: 'acknowledged' }),
    })

    const first = await restockProductCards({ client, database, now: () => NOW, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })
    assert.equal(first.status, 'failed')
    const pending = ctx.get(`SELECT state, attempts, last_error_code FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(pending?.state, 'failed')
    assert.equal(pending?.attempts, 1)
    assert.equal(pending?.last_error_code, 'local_materialize_constraint')
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(client.callCount('allocate'), 1)

    ctx.exec(`UPDATE ${CARD_SERVICE_OPERATIONS_TABLE} SET attempts = ${CARD_SERVICE_MAX_OPERATION_ATTEMPTS - 1}`)
    const row = await loadCardServiceAllocation(ctx.database, 'alloc_constraint')
    assert.ok(row)
    const capped = await ackAndMaterializeAllocation({ client, database, now: () => NOW }, row)
    assert.equal(capped.status, 'failed')
    const abandoned = ctx.get(`SELECT state, attempts FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(abandoned?.state, 'abandoned')
    assert.equal(abandoned?.attempts, CARD_SERVICE_MAX_OPERATION_ATTEMPTS)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(client.callCount('allocate'), 1)
})

test('物化已经提交后读取本地卡失败：仍按已补货恢复，不把空暂存当成缺失', async () => {
    const ctx = setup()
    await configure(ctx)
    const database = {
        query: async (sql: string, params?: readonly unknown[]) => {
            if (sql.includes('local_card_id') && countOf(ctx, 'cards') > 0) throw new Error('readback failed')
            return ctx.database.query(sql, params)
        },
        write: ctx.database.write.bind(ctx.database),
    }
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_read' }),
        ack: async () => ({ allocationId: 'alloc_read', status: 'acknowledged' }),
    })

    const result = await restockProductCards({ client, database, now: () => NOW, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })

    assert.equal(result.status, 'restocked')
    if (result.status === 'restocked') assert.deepEqual(result.localCardIds, [])
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    assert.equal(ctx.get(`SELECT state FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)?.state, 'done')
    assert.equal(client.callCount('allocate'), 1)
})

test('物化失败且错误本身也写不进去：不伪报已保存，原待办保持首次写入', async () => {
    const ctx = setup()
    await configure(ctx)
    let writes = 0
    const database = {
        query: ctx.database.query.bind(ctx.database),
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            if (writes > 1) throw new Error('database unavailable')
            return ctx.database.write(statements)
        },
    }
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_down' }),
        ack: async () => ({ allocationId: 'alloc_down', status: 'acknowledged' }),
    })

    const result = await restockProductCards({ client, database, now: () => NOW, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.match(result.message, /materialize_failure_unrecorded/)
    const operation = ctx.get(`SELECT state, attempts, last_error_code FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'pending')
    assert.equal(operation?.attempts, 0)
    assert.equal(operation?.last_error_code, null)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(countOf(ctx, 'cards'), 0)
})

test('超窗（409 allocation_expired）：删掉暂存、台账转 expired、待办 abandoned，并要求换新任务', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_exp' }),
        ack: async () => {
            throw new LicenseServiceError({ code: 'allocation_expired', httpStatus: 409 })
        },
    })

    const result = await restockProductCards({ client, database: ctx.database, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })

    assert.equal(result.status, 'expired')
    if (result.status === 'expired') {
        assert.equal(result.errorCode, 'allocation_expired')
        assert.equal(result.requiresNewTask, true)
    }

    // 卡密已回中心可分配池，本地副本必须删除而不是标记。
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    assert.equal(countOf(ctx, 'cards'), 0)

    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'expired')
    assert.equal(ledger?.last_error_code, 'allocation_expired')

    const operation = ctx.get(`SELECT * FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'abandoned')
    assert.equal(operation?.last_error_code, 'allocation_expired')
})

test('暂时性错误：保留暂存与待办，登记下次重试时间', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_retry' }),
        ack: async () => {
            throw new LicenseServiceError({
                code: 'rate_limited',
                httpStatus: 429,
                retryAfterMs: 3_000,
                requestId: 'req_01K',
            })
        },
    })

    const result = await restockProductCards({ client, database: ctx.database, now: () => NOW, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })

    assert.equal(result.status, 'deferred')
    if (result.status === 'deferred') {
        assert.equal(result.errorCode, 'rate_limited')
        assert.equal(result.category, 'unavailable')
        assert.equal(result.nextRetryAtMs, NOW + 3_000)
    }

    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    assert.equal(countOf(ctx, 'cards'), 0)

    const ledger = ctx.get(`SELECT * FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}`)
    assert.equal(ledger?.state, 'allocated')
    assert.equal(ledger?.last_error_code, 'rate_limited')

    const operation = ctx.get(`SELECT * FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'pending')
    assert.equal(operation?.attempts, 1)
    assert.equal(operation?.next_retry_at, NOW + 3_000)
    assert.equal(operation?.request_id, 'req_01K')
})

test('已有未物化分配时不再向中心领新卡', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_held' }),
        ack: async () => ({ allocationId: 'alloc_held', status: 'acknowledged' }),
    })
    let writes = 0
    const database = {
        query: ctx.database.query.bind(ctx.database),
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            if (writes === 2) throw new Error('D1 is restarting')
            return ctx.database.write(statements)
        },
    }
    const first = await restockProductCards({ client, database, now: () => NOW, ...singleAttempt }, { productId: PRODUCT_ID })
    assert.equal(first.status, 'failed')

    const second = await restockProductCards({ client, database: ctx.database, now: () => NOW, ...singleAttempt }, { productId: PRODUCT_ID })
    assert.deepEqual(second, { status: 'skipped', reason: 'materialize_pending' })
    assert.equal(client.callCount('allocate'), 1)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
})

test('可恢复失败到达尝试上限后转 abandoned，不再保持 pending', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_cap' }),
        ack: async () => {
            throw new LicenseServiceError({ code: 'rate_limited', httpStatus: 429, retryAfterMs: 1_000 })
        },
    })
    await restockProductCards({ client, database: ctx.database, now: () => NOW, ...singleAttempt }, { productId: PRODUCT_ID })
    ctx.exec(`UPDATE ${CARD_SERVICE_OPERATIONS_TABLE} SET attempts = ${CARD_SERVICE_MAX_OPERATION_ATTEMPTS - 1}`)
    const row = await loadCardServiceAllocation(ctx.database, 'alloc_cap')
    assert.ok(row)
    const outcome = await ackAndMaterializeAllocation({ client, database: ctx.database, now: () => NOW }, row)
    assert.equal(outcome.status, 'deferred')
    const operation = ctx.get(`SELECT state, attempts, next_retry_at FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'abandoned')
    assert.equal(operation?.attempts, CARD_SERVICE_MAX_OPERATION_ATTEMPTS)
    assert.equal(operation?.next_retry_at, null)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
})

test('冲突类失败：暂存保留、待办转 failed，等对账核实真实状态后再处理', async () => {
    const ctx = setup()
    await configure(ctx)
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_conflict' }),
        ack: async () => {
            throw new LicenseServiceError({ code: 'allocation_conflict', httpStatus: 409 })
        },
    })

    const result = await restockProductCards({ client, database: ctx.database, ...singleAttempt }, {
        productId: PRODUCT_ID,
    })

    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
        assert.equal(result.errorCode, 'allocation_conflict')
        assert.equal(result.allocationId, 'alloc_conflict')
    }

    // 删了就等于把库存白送给中心：远程此刻可能仍持有这批卡。
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 1)
    const operation = ctx.get(`SELECT * FROM ${CARD_SERVICE_OPERATIONS_TABLE}`)
    assert.equal(operation?.state, 'failed')
})

test('原子批次回滚：批次中任何一条失败，台账/暂存/待办都不会留下半截数据', async () => {
    const ctx = setup()
    await configure(ctx)
    const duplicated = makeAllocationDetail({
        allocationId: 'alloc_dup',
        quantity: 2,
        cards: [
            { id: 'card_dup', key: 'K1', maskedKey: null },
            { id: 'card_dup', key: 'K2', maskedKey: null },
        ],
    })
    const client = createFakeLicenseServiceClient({ allocate: async () => duplicated })

    await assert.rejects(restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID }))

    assert.equal(countOf(ctx, CARD_SERVICE_ALLOCATIONS_TABLE), 0)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)
    assert.equal(countOf(ctx, CARD_SERVICE_OPERATIONS_TABLE), 0)
})

test('一次领多张时逐张物化：本地卡 ID 与远端映射一一对应，不会撞主键', async () => {
    const ctx = setup()
    await configure(ctx)
    const two = makeAllocationDetail({ allocationId: 'alloc_two', quantity: 2 })
    const client = createFakeLicenseServiceClient({
        allocate: async () => two,
        ack: async () => ({ allocationId: 'alloc_two', status: 'acknowledged' }),
    })

    const result = await restockProductCards({ client, database: ctx.database }, {
        productId: PRODUCT_ID,
        quantity: 2,
    })

    assert.equal(result.status, 'restocked')
    if (result.status === 'restocked') assert.equal(result.localCardIds.length, 2)

    assert.equal(countOf(ctx, 'cards'), 2)
    assert.equal(countOf(ctx, CARD_SERVICE_CARDS_TABLE), 2)
    assert.equal(countOf(ctx, CARD_SERVICE_STAGED_CARDS_TABLE), 0)

    const joined = ctx.all(
        `SELECT c.id AS id, m.remote_card_id AS remote
         FROM cards c JOIN ${CARD_SERVICE_CARDS_TABLE} m ON m.local_card_id = c.id
         ORDER BY c.id ASC`,
    )
    assert.equal(joined.length, 2)
    assert.deepEqual(joined.map((row) => Number(row.id)), [1, 2])
    assert.deepEqual(
        joined.map((row) => row.remote),
        two.cards.map((card) => card.id).sort(),
    )

    // 显式分配的本地 ID 不会把 AUTOINCREMENT 序列留在后面，后续插入仍然连续。
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES ('${PRODUCT_ID}', 'manual', 0, ${NOW})`)
    assert.deepEqual(ctx.all(`SELECT id FROM cards ORDER BY id ASC`).map((row) => Number(row.id)), [1, 2, 3])
})

test('同一个补货任务重复领卡被唯一索引钉在数据库层', async () => {
    const ctx = setup()
    const intent = createRestockIntent({
        productId: PRODUCT_ID,
        programKey: PROGRAM_KEY,
        quantity: 1,
        reason: 'test',
        taskId: 'task-fixed',
    })

    await ctx.database.write(buildInsertAllocationStatements(intent, { allocationId: 'alloc_a', expiresAtMs: 1 }, NOW))
    await assert.rejects(
        ctx.database.write(buildInsertAllocationStatements(intent, { allocationId: 'alloc_b', expiresAtMs: 1 }, NOW)),
    )
    assert.equal(countOf(ctx, CARD_SERVICE_ALLOCATIONS_TABLE), 1)
})

test('Ack 的卡序由本地暂存按 remote_card_id 升序重建，与响应顺序无关', async () => {
    const ctx = setup()
    await configure(ctx)
    // 响应里刻意给一个乱序卡集，物化与重放都必须按同一确定顺序提交。
    const allocation = makeAllocationDetail({
        allocationId: 'alloc_ordered',
        quantity: 3,
        cards: [
            { id: 'card_c', key: 'KC', maskedKey: null },
            { id: 'card_a', key: 'KA', maskedKey: null },
            { id: 'card_b', key: 'KB', maskedKey: null },
        ],
    })
    const client = createFakeLicenseServiceClient({
        allocate: async () => allocation,
        ack: async () => ({ allocationId: 'alloc_ordered', status: 'acknowledged' }),
    })

    await restockProductCards({ client, database: ctx.database }, { productId: PRODUCT_ID, quantity: 3 })

    const ackArgs = client.callsOf('ack')[0] as Record<string, unknown>
    assert.deepEqual(ackArgs.receivedCardIds, ['card_a', 'card_b', 'card_c'])
})
