import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { LicenseServiceError } from './errors.ts'
import { saveCardServiceProductConfig } from './product-config.ts'
import {
    CARD_SERVICE_DEFAULT_TARGET_STOCK,
    CARD_SERVICE_REPLENISH_BATCH_LIMIT,
    countReplenishableLocalCards,
    readReplenishCursor,
    writeReplenishCursor,
    emptyReplenishSummary,
    replenishLowStockProducts,
} from './replenish.ts'
import type { RestockDeps } from './restock.ts'
import {
    createFakeLicenseServiceClient,
    createSqliteCardServiceDatabase,
    makeAllocationDetail,
    type FakeClientBehavior,
    type SqliteTestContext,
} from './test-support.ts'

const PROGRAM_PRODUCT = 'prod_program'
const LOCAL_PRODUCT = 'prod_local'
const NOW = 1_700_000_000_000

function setup(): SqliteTestContext {
    const ctx = createSqliteCardServiceDatabase()
    for (const productId of [PROGRAM_PRODUCT, LOCAL_PRODUCT]) {
        ctx.exec(`INSERT INTO products (id) VALUES ('${productId}')`)
    }
    return ctx
}

async function configure(
    ctx: SqliteTestContext,
    productId: string,
    options: { supplyMode?: 'license_service' | 'local'; targetStock?: number | null } = {},
): Promise<void> {
    await saveCardServiceProductConfig(ctx.database, {
        productId,
        supplyMode: options.supplyMode ?? 'license_service',
        programKey: `program-${productId}`,
        targetStock: options.targetStock === undefined ? CARD_SERVICE_DEFAULT_TARGET_STOCK : options.targetStock,
    }, 1_000)
}

/** 单张与批量均生成独立分配；批量子引用沿用父意图和确定序号。 */
function sequentialClient(failOnAllocate?: () => boolean, ack?: FakeClientBehavior['ack']) {
    let counter = 0
    function detail(input: unknown, child?: number) {
        const request = input as { programKey: string; externalRef: string }
        counter += 1
        return makeAllocationDetail({
            allocationId: `alloc_${counter}`,
            programKey: request.programKey,
            externalRef: child === undefined ? request.externalRef : `${request.externalRef}:${child}`,
            quantity: 1,
            cards: [{ id: `card_${counter}`, key: `KEY-${counter}`, maskedKey: null }],
        })
    }
    function checkFailure() {
        if (failOnAllocate?.()) throw new LicenseServiceError({ code: 'network_error' })
    }
    return createFakeLicenseServiceClient({
        allocate: async (input) => {
            checkFailure()
            return detail(input)
        },
        allocateBatch: async (input) => {
            checkFailure()
            return Array.from({ length: (input as { quantity: number }).quantity }, (_, index) => detail(input, index + 1))
        },
        ack: ack ?? (async (input) => ({
            allocationId: (input as { allocationId: string }).allocationId,
            status: 'acknowledged',
        })),
    })
}

function depsOf(ctx: SqliteTestContext, behavior: FakeClientBehavior): RestockDeps {
    return {
        client: createFakeLicenseServiceClient(behavior),
        database: ctx.database,
        now: () => NOW,
        policy: { maxAttempts: 1 },
    }
}

function countOf(ctx: SqliteTestContext, table: string): number {
    return Number(ctx.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
}

test('补货阈值口径与订单预留口径一致：已用、已预留、已过期都不算可用', async () => {
    const ctx = setup()
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, reserved_at, expires_at, created_at) VALUES
        ('${PROGRAM_PRODUCT}', 'k1', 0, NULL, NULL, 1),
        ('${PROGRAM_PRODUCT}', 'k2', 1, NULL, NULL, 1),
        ('${PROGRAM_PRODUCT}', 'k3', 0, ${NOW}, NULL, 1),
        ('${PROGRAM_PRODUCT}', 'k4', 0, NULL, 5, 1),
        ('${PROGRAM_PRODUCT}', 'k5', 0, NULL, 9999999999999, 1),
        ('${LOCAL_PRODUCT}', 'k6', 0, NULL, NULL, 1)`)

    assert.equal(await countReplenishableLocalCards(depsOf(ctx, {}), PROGRAM_PRODUCT, NOW), 2)
    // is_used = NULL 也要按未使用处理（历史数据里存在）。
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES ('${PROGRAM_PRODUCT}', 'k7', NULL, 1)`)
    assert.equal(await countReplenishableLocalCards(depsOf(ctx, {}), PROGRAM_PRODUCT, NOW), 3)
})

test('低水位补货：一次批量补齐到目标库存，每张卡独立分配和确认', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 3 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, {
        ...emptyReplenishSummary(),
        cursor: PROGRAM_PRODUCT,
        products: 1,
        requested: 3,
        restocked: 3,
        changedProductIds: [PROGRAM_PRODUCT],
    })
    assert.equal(client.callCount('allocate'), 0)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal((client.callsOf('allocateBatch')[0] as { quantity: number }).quantity, 3)
    assert.equal(countOf(ctx, 'cards'), 3)
    // 子分配的 external_ref 和 Ack 键必须互不相同，不能共用一个确认任务。
    const acks = client.callsOf('ack') as Array<{ externalRef: string; idempotencyKey: string; receivedCardIds: string[] }>
    assert.equal(acks.length, 3)
    assert.equal(new Set(acks.map((call) => call.externalRef)).size, 3)
    assert.equal(new Set(acks.map((call) => call.idempotencyKey)).size, 3)
    assert.ok(acks.every((call) => call.receivedCardIds.length === 1))
})

test('目标库存为 0 视为暂停自动补货，不发起任何请求', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 0 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, skipped: 1, cursor: PROGRAM_PRODUCT })
    assert.equal(client.calls.length, 0)
})

test('已有可用卡时只补差额，不会补过头', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 2 })
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES ('${PROGRAM_PRODUCT}', 'k1', 0, 1)`)
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, {
        ...emptyReplenishSummary(),
        cursor: PROGRAM_PRODUCT,
        products: 1,
        requested: 1,
        restocked: 1,
        changedProductIds: [PROGRAM_PRODUCT],
    })
    assert.equal(countOf(ctx, 'cards'), 2)
})

test('单商品单轮有上限，剩余额度留给下一轮', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 50 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW }, {
        maxPerProduct: 2,
    })

    assert.deepEqual(summary, {
        ...emptyReplenishSummary(),
        cursor: PROGRAM_PRODUCT,
        products: 1,
        requested: 2,
        restocked: 2,
        changedProductIds: [PROGRAM_PRODUCT],
    })
    assert.equal(client.callCount('allocate'), 0)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal((client.callsOf('allocateBatch')[0] as { quantity: number }).quantity, 2)
    assert.equal(CARD_SERVICE_REPLENISH_BATCH_LIMIT, 20)
})

test('批量领取失败不重复申请：不会在同一个故障上连续失败', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 5 })
    // 首次 AllocateBatch 即失败，仍消耗全部 5 张申请预算，不拆单重领。
    const client = sequentialClient(() => true)

    const summary = await replenishLowStockProducts({
        client,
        database: ctx.database,
        now: () => NOW,
        policy: { maxAttempts: 1 },
    })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, requested: 5, failed: 1, cursor: PROGRAM_PRODUCT })
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 0)
})

test('只扫描走通用卡密服务的商品，本地供应商品不参与补货', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    await configure(ctx, LOCAL_PRODUCT, { supplyMode: 'local', targetStock: 5 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, {
        ...emptyReplenishSummary(),
        cursor: PROGRAM_PRODUCT,
        products: 1,
        requested: 1,
        restocked: 1,
        changedProductIds: [PROGRAM_PRODUCT],
    })
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(
        ctx.get(`SELECT product_id FROM cards ORDER BY id ASC LIMIT 1`)?.product_id,
        PROGRAM_PRODUCT,
    )
})

test('下架商品不查库存也不占 maxProducts=1 扫描预算，上架商品补货且重新上架恢复', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 1 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    // 下架商品排在上架商品前面，不能先占掉唯一的扫描名额。
    ctx.exec(`UPDATE products SET is_active = 0 WHERE id = '${LOCAL_PRODUCT}'`)
    const inventoryQueries: unknown[] = []
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            if (/\bFROM\s+cards\b/i.test(sql)) inventoryQueries.push(params[0])
            return ctx.database.query<T>(sql, params)
        },
        write: ctx.database.write.bind(ctx.database),
    } as SqliteTestContext['database']
    const client = sequentialClient()
    const deps = { client, database, now: () => NOW }

    const first = await replenishLowStockProducts(deps, { maxProducts: 1 })

    assert.deepEqual(first, {
        ...emptyReplenishSummary(),
        products: 1,
        requested: 1,
        restocked: 1,
        changedProductIds: [PROGRAM_PRODUCT],
        cursor: PROGRAM_PRODUCT,
    })
    assert.equal(inventoryQueries.includes(LOCAL_PRODUCT), false)
    assert.ok(inventoryQueries.includes(PROGRAM_PRODUCT))
    assert.deepEqual(client.callsOf('allocate').map((call) => (call as { productId: string }).productId), [PROGRAM_PRODUCT])
    assert.equal(countOf(ctx, 'cards'), 1)

    ctx.exec(`UPDATE products SET is_active = 1 WHERE id = '${LOCAL_PRODUCT}'`)
    const second = await replenishLowStockProducts(deps, { maxProducts: 1 })
    assert.deepEqual(second, {
        ...emptyReplenishSummary(),
        products: 2,
        requested: 1,
        restocked: 1,
        changedProductIds: [LOCAL_PRODUCT],
        cursor: LOCAL_PRODUCT,
    })
    assert.ok(inventoryQueries.includes(LOCAL_PRODUCT))
    assert.deepEqual(client.callsOf('allocate').map((call) => (call as { productId: string }).productId), [PROGRAM_PRODUCT, LOCAL_PRODUCT])
    assert.equal(countOf(ctx, 'cards'), 2)
})

test('全部商品下架时返回 empty summary，不查 cards、不联网也不写台账', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 1 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    ctx.exec('UPDATE products SET is_active = 0')
    const inventoryQueries: string[] = []
    let writes = 0
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            if (/\bFROM\s+cards\b/i.test(sql)) inventoryQueries.push(sql)
            return ctx.database.query<T>(sql, params)
        },
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            writes += 1
            return ctx.database.write(statements)
        },
    } as SqliteTestContext['database']
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database, now: () => NOW }, { maxProducts: 1 })

    assert.deepEqual(summary, emptyReplenishSummary())
    assert.deepEqual(inventoryQueries, [])
    assert.equal(client.calls.length, 0)
    assert.equal(writes, 0)
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(countOf(ctx, 'card_service_allocations'), 0)
})

test('一个商品物化失败不吞掉已成功商品，预算内的后续商品继续补', async () => {
    const ctx = setup()
    const third = 'prod_third'
    ctx.exec(`INSERT INTO products (id) VALUES ('${third}')`)
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 1 })
    await configure(ctx, third, { targetStock: 1 })

    let allocations = 0
    const allocationProduct = new Map<string, string>()
    const client = createFakeLicenseServiceClient({
        allocate: async (input) => {
            allocations += 1
            const allocationId = `alloc_${allocations}`
            allocationProduct.set(allocationId, (input as { productId: string }).productId)
            return makeAllocationDetail({
                allocationId,
                programKey: (input as { programKey: string }).programKey,
                cards: [{ id: `card_${allocations}`, key: `KEY-${allocations}`, maskedKey: null }],
            })
        },
        ack: async (input) => ({
            allocationId: (input as { allocationId: string }).allocationId,
            status: 'acknowledged' as const,
        }),
    })
    const database = {
        query: ctx.database.query.bind(ctx.database),
        write: async (statements: Parameters<SqliteTestContext['database']['write']>[0]) => {
            const materialize = statements.some((statement) => statement.sql.includes('INSERT INTO cards'))
            const target = statements
                .map((statement) => statement.params?.find((value) => allocationProduct.get(String(value)) === PROGRAM_PRODUCT))
                .find(Boolean)
            if (materialize && target) throw new Error('D1 is restarting')
            return ctx.database.write(statements)
        },
    }

    const summary = await replenishLowStockProducts({
        client,
        database,
        now: () => NOW,
        policy: { maxAttempts: 1 },
    })

    assert.equal(summary.products, 3)
    assert.equal(summary.restocked, 2)
    assert.equal(summary.failed, 1)
    assert.deepEqual([...summary.changedProductIds].sort(), [LOCAL_PRODUCT, third].sort())
    assert.equal(countOf(ctx, 'cards'), 2)
    assert.equal(countOf(ctx, 'card_service_staged_cards'), 1)
    const stuck = ctx.get(`SELECT product_id, state FROM card_service_allocations WHERE state = 'allocated'`)
    assert.equal(stuck?.product_id, PROGRAM_PRODUCT)
    assert.equal(client.callCount('allocate'), 3)
})

test('库存查询失败只算该商品失败：已成功摘要、后续商品与游标都保留', async () => {
    const ctx = setup()
    const third = 'prod_third'
    ctx.exec(`INSERT INTO products (id) VALUES ('${third}')`)
    // 排序后依次是 prod_local → prod_program → prod_third。
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 1 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    await configure(ctx, third, { targetStock: 1 })
    const client = sequentialClient()
    const database = {
        query: async <T,>(sql: string, params: readonly unknown[] = []) => {
            if (sql.includes('AS available FROM cards') && params[0] === PROGRAM_PRODUCT) {
                throw new Error('D1_ERROR: storage operation exceeded timeout')
            }
            return ctx.database.query<T>(sql, params)
        },
        write: ctx.database.write.bind(ctx.database),
    } as SqliteTestContext['database']

    const summary = await replenishLowStockProducts({ client, database, now: () => NOW })

    assert.equal(summary.products, 3)
    assert.equal(summary.restocked, 2)
    assert.equal(summary.failed, 1)
    assert.deepEqual([...summary.changedProductIds].sort(), [LOCAL_PRODUCT, third].sort())
    assert.equal(summary.cursor, third)
    assert.equal(client.callCount('allocate'), 2)
})

test('批量 Ack 失败逐笔计入 deferred，不重复领取，留给对账重放', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 3 })
    const client = sequentialClient(undefined, async () => {
        throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503 })
    })

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW, policy: { maxAttempts: 1 } })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, requested: 3, deferred: 3, cursor: PROGRAM_PRODUCT })
    // 全部暂存保留，等对账推进；可售库存仍为 0。
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(countOf(ctx, 'card_service_staged_cards'), 3)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('ack'), 3)
})


test('目标库存保存为 5 后从现有 2 张逐轮补齐，售出后继续补差额', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 5 })
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES
        ('${PROGRAM_PRODUCT}', 'existing-1', 0, 1), ('${PROGRAM_PRODUCT}', 'existing-2', 0, 1)`)
    const client = sequentialClient()
    const deps = { client, database: ctx.database, now: () => NOW }

    const first = await replenishLowStockProducts(deps, { maxPerProduct: 2 })
    assert.equal(first.restocked, 2)
    assert.equal(await countReplenishableLocalCards(deps, PROGRAM_PRODUCT, NOW), 4)
    const second = await replenishLowStockProducts(deps)
    assert.equal(second.restocked, 1)
    assert.equal(await countReplenishableLocalCards(deps, PROGRAM_PRODUCT, NOW), 5)
    assert.equal((await replenishLowStockProducts(deps)).restocked, 0)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 1)

    ctx.exec(`UPDATE cards SET is_used = 1 WHERE card_key = 'existing-1'`)
    assert.equal((await replenishLowStockProducts(deps)).restocked, 1)
    assert.equal(await countReplenishableLocalCards(deps, PROGRAM_PRODUCT, NOW), 5)
})

test('目标库存留空默认补到 1 张', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: null })
    const client = sequentialClient()
    const deps = { client, database: ctx.database, now: () => NOW }

    assert.equal((await replenishLowStockProducts(deps)).restocked, 1)
    assert.equal(await countReplenishableLocalCards(deps, PROGRAM_PRODUCT, NOW), 1)
    assert.equal((await replenishLowStockProducts(deps)).restocked, 0)
})

test('补货按商品轮转：本轮只扫一个，下一轮从它后面继续，不会总卡在第一个', async () => {
    const ctx = setup()
    const third = 'prod_third'
    ctx.exec(`INSERT INTO products (id) VALUES ('${third}')`)
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 1 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    await configure(ctx, third, { targetStock: 1 })
    const client = sequentialClient()
    const deps = { client, database: ctx.database, now: () => NOW, policy: { maxAttempts: 1 } }

    const first = await replenishLowStockProducts(deps, { maxProducts: 1, maxCards: 1 })
    const second = await replenishLowStockProducts(deps, { maxProducts: 1, maxCards: 1, afterProductId: first.cursor })
    const thirdRound = await replenishLowStockProducts(deps, { maxProducts: 1, maxCards: 1, afterProductId: second.cursor })

    assert.deepEqual([first.cursor, second.cursor, thirdRound.cursor], [LOCAL_PRODUCT, PROGRAM_PRODUCT, third])
    assert.equal(first.restocked, 1)
    assert.equal(second.restocked, 1)
    assert.equal(thirdRound.restocked, 1)
    assert.equal(client.callCount('allocate'), 3)
})

test('补货游标写入 settings 后，下一轮从该商品后面继续', async () => {
    const ctx = setup()
    const third = 'prod_third'
    ctx.exec(`INSERT INTO products (id) VALUES ('${third}')`)
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 0 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 0 })
    await configure(ctx, third, { targetStock: 0 })
    const deps = { client: sequentialClient(), database: ctx.database, now: () => NOW }

    const first = await replenishLowStockProducts(deps, { maxProducts: 1 })
    await writeReplenishCursor(ctx.database, first.cursor ?? '', NOW)
    const stored = await readReplenishCursor(ctx.database)
    const second = await replenishLowStockProducts(deps, { maxProducts: 1, afterProductId: stored })

    assert.equal(stored, first.cursor)
    assert.notEqual(second.cursor, first.cursor)
})

test('超时预留卡恢复可售，不重复补货；有效预留仍不计入目标库存', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, reserved_at, created_at) VALUES
        ('${PROGRAM_PRODUCT}', 'expired-reservation', 0, ${NOW - 5 * 60_000 - 1}, 1),
        ('${PROGRAM_PRODUCT}', 'active-reservation', 0, ${NOW}, 1)`)
    const client = sequentialClient()
    const deps = { client, database: ctx.database, now: () => NOW }

    assert.equal(await countReplenishableLocalCards(deps, PROGRAM_PRODUCT, NOW), 1)
    assert.equal((await replenishLowStockProducts(deps)).restocked, 0)
    assert.equal(client.callCount('allocate'), 0)
})

test('默认全轮申请预算为 20：单商品未占满时其余商品只使用剩余额度', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 12 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 50 })
    const client = sequentialClient()
    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })
    assert.equal(summary.requested, 20)
    assert.equal(summary.restocked, 20)
    assert.deepEqual(client.callsOf('allocateBatch').map((call) => (call as { quantity: number }).quantity), [12, 8])
    assert.equal(countOf(ctx, 'cards'), 20)
})

test('目标 20 从零库存默认一轮补齐：仅一次批量领取、20 次独立 Ack', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 20 })
    const client = sequentialClient()
    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })
    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, requested: 20, restocked: 20,
        changedProductIds: [PROGRAM_PRODUCT], cursor: PROGRAM_PRODUCT })
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 0)
    assert.equal(client.callCount('ack'), 20)
    assert.equal(countOf(ctx, 'cards'), 20)
    assert.equal(countOf(ctx, 'card_service_allocations'), 20)
})

test('单商品和全轮预算均有 100 硬上限，不把更大缺口传给 batch', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 500 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 500 })
    const client = sequentialClient()
    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW }, {
        maxPerProduct: 1000, maxCards: 1000, maxProducts: 1000,
    })
    assert.equal(summary.requested, 100)
    assert.equal(summary.restocked, 100)
    assert.equal(summary.cursor, LOCAL_PRODUCT)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal((client.callsOf('allocateBatch')[0] as { quantity: number }).quantity, 100)
    assert.equal(countOf(ctx, 'cards'), 100)
})

test('跨商品按全轮剩余申请预算截断：4 + 3 张后停止，下一轮从后续商品继续', async () => {
    const ctx = setup()
    const third = 'prod_third'
    ctx.exec(`INSERT INTO products (id) VALUES ('${third}')`)
    for (const id of [LOCAL_PRODUCT, PROGRAM_PRODUCT, third]) await configure(ctx, id, { targetStock: 50 })
    const client = sequentialClient()
    const deps = { client, database: ctx.database, now: () => NOW }
    const first = await replenishLowStockProducts(deps, { maxPerProduct: 4, maxCards: 7 })
    assert.equal(first.requested, 7)
    assert.equal(first.restocked, 7)
    assert.equal(first.cursor, PROGRAM_PRODUCT)
    assert.deepEqual(client.callsOf('allocateBatch').map((call) => {
        const { productId, quantity } = call as { productId: string; quantity: number }
        return [productId, quantity]
    }), [[LOCAL_PRODUCT, 4], [PROGRAM_PRODUCT, 3]])
    const second = await replenishLowStockProducts(deps, { maxPerProduct: 4, maxCards: 4, afterProductId: first.cursor })
    assert.equal(second.cursor, third)
    assert.equal(second.requested, 4)
    assert.deepEqual(second.changedProductIds, [third])
})

test('partial Ack 按逐子状态统计，成功数不能释放申请预算，游标仍公平推进', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 20 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 20 })
    const client = sequentialClient(undefined, async (input) => {
        const { allocationId } = input as { allocationId: string }
        if (allocationId === 'alloc_1') throw new LicenseServiceError({ code: 'allocation_conflict' })
        if (allocationId === 'alloc_2') throw new LicenseServiceError({ code: 'temporarily_unavailable' })
        if (allocationId === 'alloc_3') throw new LicenseServiceError({ code: 'allocation_expired' })
        return { allocationId, status: 'acknowledged' }
    })
    const deps = { client, database: ctx.database, now: () => NOW, policy: { maxAttempts: 1 } }
    const first = await replenishLowStockProducts(deps, { maxCards: 4 })
    assert.deepEqual(first, { ...emptyReplenishSummary(), products: 2, requested: 4, restocked: 1,
        failed: 1, deferred: 1, expired: 1, changedProductIds: [LOCAL_PRODUCT], cursor: LOCAL_PRODUCT })
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('ack'), 4)
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(countOf(ctx, 'card_service_staged_cards'), 2)
    const second = await replenishLowStockProducts(deps, { maxCards: 4, afterProductId: first.cursor })
    assert.equal(second.requested, 4)
    assert.equal(second.restocked, 4)
    assert.equal(second.cursor, PROGRAM_PRODUCT)
    assert.equal(client.callCount('allocateBatch'), 2)
})

test('全批领取失败也耗尽申请预算，不继续向下一商品领卡', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 20 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 20 })
    const client = sequentialClient(() => true)
    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW, policy: { maxAttempts: 1 } }, { maxCards: 5 })
    assert.equal(summary.requested, 5)
    assert.equal(summary.restocked, 0)
    assert.equal(summary.failed, 1)
    assert.equal(summary.cursor, LOCAL_PRODUCT)
    assert.equal(client.callCount('allocateBatch'), 1)
})

test('候选读取后下架不消耗申请预算，剩余商品仍能补满', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 20 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 20 })
    const database = {
        query: async <T,>(sql: string, params?: readonly unknown[]) => {
            const rows = await ctx.database.query<T>(sql, params)
            if (sql.includes('AS available FROM cards') && params?.[0] === LOCAL_PRODUCT) {
                ctx.exec(`UPDATE products SET is_active = 0 WHERE id = '${LOCAL_PRODUCT}'`)
            }
            return rows
        },
        write: ctx.database.write,
    }
    const client = sequentialClient()
    const summary = await replenishLowStockProducts({ client, database, now: () => NOW }, { maxCards: 20 })
    assert.equal(summary.requested, 20)
    assert.equal(summary.restocked, 20)
    assert.equal(summary.skipped, 1)
    assert.deepEqual(summary.changedProductIds, [PROGRAM_PRODUCT])
    assert.equal(client.callCount('allocateBatch'), 1)
})

for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    test(`非法预算 ${invalid} 使用独立默认值 20，而不是失去限制或降为 1`, async () => {
        for (const options of [
            { maxPerProduct: invalid, maxCards: 100 },
            { maxPerProduct: 100, maxCards: invalid },
            { maxPerProduct: invalid, maxCards: invalid, maxProducts: invalid },
        ]) {
            const ctx = setup()
            await configure(ctx, PROGRAM_PRODUCT, { targetStock: 50 })
            const client = sequentialClient()
            const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW }, options)
            assert.equal(summary.requested, 20)
            assert.equal(summary.restocked, 20)
            assert.equal(client.callCount('allocateBatch'), 1)
        }
    })
}

for (const [maxProducts, expected] of [[undefined, 20], [NaN, 20], [Infinity, 20], [-1, 20], [1000, 100], [2.9, 2], [0, 1]]) {
    test(`扫描预算 ${maxProducts} 限制为 ${expected}，独立于领卡预算`, async () => {
        const ctx = setup()
        for (let index = 0; index < 105; index += 1) {
            const id = `scan_${String(index).padStart(3, '0')}`
            ctx.exec(`INSERT INTO products (id) VALUES ('${id}')`)
            await configure(ctx, id, { targetStock: 0 })
        }
        const client = sequentialClient()
        const summary = await replenishLowStockProducts({ client, database: ctx.database }, { maxProducts })
        assert.equal(summary.skipped, expected)
        assert.equal(summary.requested, 0)
        assert.equal(summary.cursor, `scan_${String(expected - 1).padStart(3, '0')}`)
        assert.equal(client.calls.length, 0)
    })
}

test('预算小数截断、零至少为 1：单张仍沿用 allocate，不走批量中心', async () => {
    for (const [budget, quantity] of [[2.9, 2], [0, 1]]) {
        const ctx = setup()
        await configure(ctx, PROGRAM_PRODUCT, { targetStock: 50 })
        const client = sequentialClient()
        const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW }, {
            maxPerProduct: budget, maxCards: budget,
        })
        assert.equal(summary.requested, quantity)
        assert.equal(summary.restocked, quantity)
        assert.equal(client.callCount(quantity === 1 ? 'allocate' : 'allocateBatch'), 1)
    }
})

test('物化后 ID 读回失败仍按已提交张数统计，并保留 changedProductIds 触发重算', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 2 })
    const database = {
        query: async <T,>(sql: string, params?: readonly unknown[]) => {
            if (sql.startsWith('SELECT local_card_id')) throw new Error('readback failed')
            return ctx.database.query<T>(sql, params)
        },
        write: ctx.database.write,
    }
    const client = sequentialClient()
    const summary = await replenishLowStockProducts({ client, database, now: () => NOW })
    assert.equal(summary.requested, 2)
    assert.equal(summary.restocked, 2)
    assert.deepEqual(summary.changedProductIds, [PROGRAM_PRODUCT])
    assert.equal(countOf(ctx, 'cards'), 2)
})

test('未预期批量异常后仍保留已成功商品并经真实装配函数重算，游标保存失败也不阻断', async () => {
    const ctx = setup()
    await configure(ctx, LOCAL_PRODUCT, { targetStock: 2 })
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 2 })
    const client = sequentialClient()
    let tasks = 0
    const deps = { client, database: ctx.database, now: () => NOW, randomUUID: () => {
        tasks += 1
        if (tasks === 2) throw new Error('unexpected task failure')
        return 'first-task'
    } }
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf('export async function replenishCardStock(')
    const end = source.indexOf('\n}', start)
    assert.ok(start > 0 && end > start)
    const body = source.slice(source.indexOf('{\n', start) + 2, end)
    const recalculated: string[][] = []
    const execute = new Function('isLicenseServiceConfigured', 'buildCardServiceDeps', 'readReplenishCursor',
        'writeReplenishCursor', 'replenishLowStockProducts', 'recalcStorefrontStock', 'console',
        `return async function(options = {}, env = {}) {${body}}`)(
        () => true, () => deps, async () => null, async () => { throw new Error('cursor write failed') },
        replenishLowStockProducts, async (ids: string[]) => recalculated.push(ids), { error: () => {} },
    )
    const summary = await execute({ maxCards: 4 })
    assert.equal(summary.requested, 4)
    assert.equal(summary.restocked, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.cursor, PROGRAM_PRODUCT)
    assert.deepEqual(summary.changedProductIds, [LOCAL_PRODUCT])
    assert.deepEqual(recalculated, [[LOCAL_PRODUCT]])
    assert.equal(client.callCount('allocateBatch'), 1)
})
