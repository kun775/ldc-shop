import test from 'node:test'
import assert from 'node:assert/strict'

import { LicenseServiceError } from './errors.ts'
import { saveCardServiceProductConfig } from './product-config.ts'
import {
    CARD_SERVICE_DEFAULT_TARGET_STOCK,
    CARD_SERVICE_REPLENISH_BATCH_LIMIT,
    countReplenishableLocalCards,
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

/** 每次返回不同的分配 ID 与卡 ID，模拟连续多次领卡。 */
function sequentialClient(failOnAllocate?: () => boolean) {
    let counter = 0
    return createFakeLicenseServiceClient({
        allocate: async (input) => {
            if (failOnAllocate?.()) {
                throw new LicenseServiceError({ code: 'network_error' })
            }
            counter += 1
            const index = counter
            return makeAllocationDetail({
                allocationId: `alloc_${index}`,
                programKey: (input as { programKey: string }).programKey,
                quantity: 1,
                cards: [{ id: `card_${index}`, key: `KEY-${index}`, maskedKey: null }],
            })
        },
        ack: async (input) => ({
            allocationId: (input as { allocationId: string }).allocationId,
            status: 'acknowledged',
        }),
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
        ('${PROGRAM_PRODUCT}', 'k3', 0, 5, NULL, 1),
        ('${PROGRAM_PRODUCT}', 'k4', 0, NULL, 5, 1),
        ('${PROGRAM_PRODUCT}', 'k5', 0, NULL, 9999999999999, 1),
        ('${LOCAL_PRODUCT}', 'k6', 0, NULL, NULL, 1)`)

    assert.equal(await countReplenishableLocalCards(depsOf(ctx, {}), PROGRAM_PRODUCT, NOW), 2)
    // is_used = NULL 也要按未使用处理（历史数据里存在）。
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES ('${PROGRAM_PRODUCT}', 'k7', NULL, 1)`)
    assert.equal(await countReplenishableLocalCards(depsOf(ctx, {}), PROGRAM_PRODUCT, NOW), 3)
})

test('低水位补货：串行补齐到目标库存，每张卡独立领卡', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 3 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, restocked: 3 })
    assert.equal(client.callCount('allocate'), 3)
    assert.equal(countOf(ctx, 'cards'), 3)
    // 串行领卡：三次 Allocate 的 external_ref 必须互不相同（external_ref 中心终身唯一）。
    const refs = client.callsOf('allocate').map((call) => (call as { externalRef: string }).externalRef)
    assert.equal(new Set(refs).size, 3)
})

test('目标库存为 0 视为暂停自动补货，不发起任何请求', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 0 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, skipped: 1 })
    assert.equal(client.calls.length, 0)
})

test('已有可用卡时只补差额，不会补过头', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 2 })
    ctx.exec(`INSERT INTO cards (product_id, card_key, is_used, created_at) VALUES ('${PROGRAM_PRODUCT}', 'k1', 0, 1)`)
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, restocked: 1 })
    assert.equal(countOf(ctx, 'cards'), 2)
})

test('单商品单轮有上限，剩余额度留给下一轮', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 50 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW }, {
        maxPerProduct: 2,
    })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, restocked: 2 })
    assert.equal(client.callCount('allocate'), 2)
    assert.ok(CARD_SERVICE_REPLENISH_BATCH_LIMIT < 50)
})

test('一旦补不到就停止本轮：不会在同一个故障上连续失败', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 5 })
    // 首次 Allocate 即失败（单次尝试下折算为 failed），后续不该再被调用。
    const client = sequentialClient(() => true)

    const summary = await replenishLowStockProducts({
        client,
        database: ctx.database,
        now: () => NOW,
        policy: { maxAttempts: 1 },
    })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, failed: 1 })
    assert.equal(client.callCount('allocate'), 1)
})

test('只扫描走通用卡密服务的商品，本地供应商品不参与补货', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 1 })
    await configure(ctx, LOCAL_PRODUCT, { supplyMode: 'local', targetStock: 5 })
    const client = sequentialClient()

    const summary = await replenishLowStockProducts({ client, database: ctx.database, now: () => NOW })

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, restocked: 1 })
    assert.equal(countOf(ctx, 'cards'), 1)
    assert.equal(
        ctx.get(`SELECT product_id FROM cards ORDER BY id ASC LIMIT 1`)?.product_id,
        PROGRAM_PRODUCT,
    )
})

test('Ack 失败时本轮计入 deferred 并停止，留给对账重放', async () => {
    const ctx = setup()
    await configure(ctx, PROGRAM_PRODUCT, { targetStock: 3 })
    const failing: FakeClientBehavior = {
        allocate: async () => makeAllocationDetail({ allocationId: 'alloc_defer', quantity: 1 }),
        ack: async () => {
            throw new LicenseServiceError({ code: 'temporarily_unavailable', httpStatus: 503 })
        },
    }

    const summary = await replenishLowStockProducts(depsOf(ctx, failing))

    assert.deepEqual(summary, { ...emptyReplenishSummary(), products: 1, deferred: 1 })
    // 暂存保留，等对账推进；可售库存仍为 0。
    assert.equal(countOf(ctx, 'cards'), 0)
    assert.equal(countOf(ctx, 'card_service_staged_cards'), 1)
})
