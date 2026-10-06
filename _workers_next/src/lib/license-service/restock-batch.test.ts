import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AllocateInput } from './client.ts'
import type { AllocationDetail } from './contract.ts'
import type { CardServiceDatabase } from './db-port.ts'
import {
    CARD_SERVICE_ALLOCATIONS_TABLE as ALLOCATIONS,
    CARD_SERVICE_CARDS_TABLE as MAPPINGS,
    CARD_SERVICE_OPERATIONS_TABLE as OPERATIONS,
    CARD_SERVICE_STAGED_CARDS_TABLE as STAGED,
} from '../db/license-service-schema.ts'
import { LicenseServiceError } from './errors.ts'
import { buildAckIdempotencyKey, buildAllocateIdempotencyKey, buildRestockExternalRef } from './idempotency.ts'
import { saveCardServiceProductConfig } from './product-config.ts'
import { reconcilePendingAckOperations } from './reconcile.ts'
import { loadOrderRemoteSalePlan } from './delivery.ts'
import { restockProductCardsBatch, type RestockBatchResult } from './restock.ts'
import { createFakeLicenseServiceClient, createSqliteCardServiceDatabase, makeAllocationDetail } from './test-support.ts'

const PRODUCT = 'prod_1'
const PROGRAM = 'bill-service'
const NOW = 1_800_000_000_000
const TASK = 'batch-fixed'
const runtime = { now: () => NOW, randomUUID: () => TASK, policy: { maxAttempts: 1 } }

async function setup() {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec(`INSERT INTO products (id) VALUES ('${PRODUCT}')`)
    await saveCardServiceProductConfig(ctx.database, {
        productId: PRODUCT, supplyMode: 'license_service', programKey: PROGRAM, targetStock: 100,
    }, NOW)
    return ctx
}

type Context = Awaited<ReturnType<typeof setup>>
function count(ctx: Context, table: string) {
    return Number(ctx.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n)
}

function batchDetails(input: unknown): AllocationDetail[] {
    const request = input as AllocateInput
    return Array.from({ length: request.quantity }, (_, index) => makeAllocationDetail({
        allocationId: `alloc_${index + 1}`,
        programKey: request.programKey,
        externalRef: `${request.externalRef}:${index + 1}`,
        quantity: 1,
        cards: [{ id: `remote_${index + 1}`, key: `SECRET_CARD_${index + 1}`, maskedKey: null }],
        createdAtMs: NOW, expiresAtMs: NOW + 1_800_000,
    }))
}

function batchClient() {
    return createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })
}

function assertNoSecrets(result: RestockBatchResult) {
    assert.doesNotMatch(JSON.stringify(result), /SECRET_CARD_|SECRET_EXCEPTION/)
}

test('100 张独立分配：三条 SQL 原子暂存、Paid 预算内逐子 Ack、100 组可分别交付', async (t) => {
    const ctx = await setup()
    const sqlStart = ctx.sqlCalls.length
    const writes: number[] = []
    const database: CardServiceDatabase = {
        query: ctx.database.query,
        write: async (statements) => {
            writes.push(statements.length)
            return ctx.database.write(statements)
        },
    }
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input, attempt) => {
            if (attempt === 1) {
                assert.equal(count(ctx, ALLOCATIONS), 100)
                assert.equal(count(ctx, STAGED), 100)
                assert.equal(count(ctx, OPERATIONS), 100)
                assert.equal(count(ctx, 'cards'), 0)
            }
            return { allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }
        },
    })
    const result = await restockProductCardsBatch({ client, database, ...runtime }, { productId: PRODUCT, quantity: 100 })
    assert.equal(result.requested, 100)
    assert.equal(result.restocked, 100)
    assert.equal(result.results.length, 100)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 0)
    assert.equal(client.callCount('ack'), 100)
    assert.equal(writes[0], 3)
    assert.equal(writes.filter((n) => n === 3).length, 1)
    assert.deepEqual(writes.slice(1), Array(100).fill(5))
    // 只计补货全链路，不把 setup 或后面的交付计划查询混进预算。
    // sqlCalls 将 batch 内每条语句分别记账，不能仅凭 write 调用数放行。
    const restockSql = ctx.sqlCalls.slice(sqlStart)
    const stagingSql = restockSql.filter((call) => call.kind === 'write').slice(0, 3)
    assert.deepEqual(stagingSql.map((call) => call.sql.match(/^INSERT INTO (\w+)/)?.[1]), [ALLOCATIONS, STAGED, OPERATIONS])
    assert.ok(stagingSql.every((call) => call.sql.includes('FROM json_each(?)') && call.params?.length === 1))
    assert.ok(stagingSql.every((call) => call.params?.[0] === stagingSql[0].params?.[0]))
    assert.equal(JSON.parse(stagingSql[0].params?.[0] as string).length, 100)
    assert.equal(restockSql.filter((call) => call.kind === 'write').length, 503)
    assert.equal(restockSql.filter((call) => call.kind === 'query').length, 203)
    assert.equal(restockSql.length, 706)
    assert.ok(restockSql.length <= 950)
    // product-client 每子 Ack 查归属 + 首次读凭据，共约 101 SQL；另留装配层余量。
    assert.ok(restockSql.length + 101 < 1000)
    // 再保守地给每次 batch 调用额外记一笔，仍留下 Paid 配额余量。
    const conservativeBudget = restockSql.length + 101 + writes.length
    assert.equal(conservativeBudget, 908)
    assert.ok(conservativeBudget <= 950)
    assert.ok(restockSql.every((call) => (call.params?.length ?? 0) <= 100))
    t.diagnostic(`N100 核心 SQL=${restockSql.length}，凭据路由预留后=${restockSql.length + 101}，另计 batch 开销=${conservativeBudget}；Free 50 不保证，默认 20 需 Paid 或分批`)

    assert.equal(count(ctx, 'cards'), 100)
    assert.equal(count(ctx, MAPPINGS), 100)
    assert.equal(count(ctx, STAGED), 0)
    assert.equal(count(ctx, OPERATIONS), 100)
    assert.equal(ctx.get(`SELECT COUNT(DISTINCT request_key) AS n FROM ${ALLOCATIONS}`)?.n, 1)
    assert.equal(ctx.get(`SELECT COUNT(DISTINCT ack_key) AS n FROM ${ALLOCATIONS}`)?.n, 100)
    assert.equal(ctx.get(`SELECT COUNT(*) AS n FROM ${OPERATIONS} WHERE state = 'done'`)?.n, 100)
    const ids: number[] = []
    for (const [index, child] of result.results.entries()) {
        assert.equal(child.status, 'restocked')
        if (child.status !== 'restocked') continue
        const childTask = `${TASK}:${index + 1}`
        assert.equal(child.taskId, childTask)
        assert.equal(child.localCardIds.length, 1)
        ids.push(...child.localCardIds)
        const ledger = ctx.get(`SELECT * FROM ${ALLOCATIONS} WHERE allocation_id = ?`, [child.allocationId])
        assert.equal(ledger?.quantity, 1)
        assert.equal(ledger?.program_key, PROGRAM)
        assert.equal(ledger?.request_key, buildAllocateIdempotencyKey(TASK))
        assert.equal(ledger?.external_ref, `${buildRestockExternalRef(TASK)}:${index + 1}`)
        assert.equal(ledger?.ack_key, buildAckIdempotencyKey(childTask))
        assert.equal(ledger?.expires_at, NOW + 1_800_000)
        assert.equal(ledger?.state, 'acknowledged')
        assert.equal(ledger?.acked_at, NOW)
        assert.equal(ledger?.sold_at, null)
        assert.equal(ledger?.last_error_code, null)
        assert.equal(ledger?.created_at, NOW)
        assert.equal(ledger?.updated_at, NOW)
        assert.equal(ctx.get('SELECT card_key FROM cards WHERE id = ?', child.localCardIds)?.card_key, `SECRET_CARD_${index + 1}`)
        const operation = ctx.get(`SELECT * FROM ${OPERATIONS} WHERE operation_key = ?`, [ledger?.ack_key])
        assert.equal(operation?.operation, 'ack')
        assert.equal(operation?.resource_id, child.allocationId)
        assert.equal(operation?.order_id, null)
        assert.equal(operation?.attempts, 1)
        assert.equal(operation?.next_retry_at, null)
        assert.equal(operation?.request_id, null)
        assert.equal(operation?.last_error_code, null)
        assert.equal(operation?.created_at, NOW)
        assert.equal(operation?.updated_at, NOW)
        const ack = client.callsOf('ack')[index] as Record<string, unknown>
        assert.equal(ack.idempotencyKey, ledger?.ack_key)
        assert.equal(ack.externalRef, ledger?.external_ref)
        assert.deepEqual(ack.receivedCardIds, child.remoteCardIds)
        const plan = await loadOrderRemoteSalePlan(database, { orderId: `order_${index}`, localCardIds: child.localCardIds })
        assert.equal(plan.kind, 'remote')
        if (plan.kind === 'remote') {
            assert.equal(plan.groups.length, 1)
            assert.equal(plan.groups[0].allocationId, child.allocationId)
            assert.deepEqual(plan.groups[0].remoteCardIds, child.remoteCardIds)
        }
    }
    assert.equal(new Set(ids).size, 100)
    const plan = await loadOrderRemoteSalePlan(database, { orderId: 'order_all', localCardIds: ids })
    assert.equal(plan.kind, 'remote')
    if (plan.kind === 'remote') assert.equal(plan.groups.length, 100)
    assert.ok(ctx.sqlCalls.every((call) => (call.params?.length ?? 0) <= 100))
    assertNoSecrets(result)
})

test('批次中段暂存约束失败：全部台账/暂存/待办回滚，零 Ack，结果逐子明确失败', async () => {
    const ctx = await setup()
    ctx.exec(`CREATE TRIGGER reject_middle BEFORE INSERT ON ${STAGED}
        WHEN NEW.remote_card_id = 'remote_51'
          AND (SELECT COUNT(*) FROM ${ALLOCATIONS}) = 100
          AND (SELECT COUNT(*) FROM ${STAGED}) = 50
          AND EXISTS (SELECT 1 FROM ${STAGED} WHERE remote_card_id = 'remote_50')
          AND (SELECT COUNT(*) FROM ${OPERATIONS}) = 0
        BEGIN SELECT RAISE(ABORT, 'SECRET_EXCEPTION middle staging constraint failed'); END`)
    let stagingError = ''
    const database: CardServiceDatabase = {
        query: ctx.database.query,
        write: async (statements) => {
            assert.equal(statements.length, 3)
            try {
                return await ctx.database.write(statements)
            } catch (error) {
                stagingError = (error as Error).message
                throw error
            }
        },
    }
    const client = batchClient()
    const result = await restockProductCardsBatch({ client, database, ...runtime }, { productId: PRODUCT, quantity: 100 })
    assert.match(stagingError, /SECRET_EXCEPTION middle staging constraint failed/)

    assert.equal(result.restocked, 0)
    assert.equal(result.results.length, 100)
    assert.ok(result.results.every((r) => r.status === 'failed' && r.message === 'local_batch_staging_failed_unacked'))
    for (const table of [ALLOCATIONS, STAGED, OPERATIONS, MAPPINGS, 'cards']) assert.equal(count(ctx, table), 0)
    assert.equal(client.callCount('ack'), 0)
    assert.equal(client.callCount('cancel'), 0)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 0)
    const stagingSql = ctx.sqlCalls.filter((call) => call.kind === 'write' && call.sql.includes('FROM json_each(?)'))
    assert.equal(stagingSql.length, 2)
    assert.ok(stagingSql[1].sql.startsWith(`INSERT INTO ${STAGED}`))
    const stagedRows = JSON.parse(stagingSql[1].params?.[0] as string)
    assert.equal(stagedRows.length, 100)
    assert.equal(stagedRows[49].remoteCardId, 'remote_50')
    assert.equal(stagedRows[50].remoteCardId, 'remote_51')
    assertNoSecrets(result)
})

test('同一父任务重入保留唯一约束：不重复暂存、不新增卡、不再次 Ack', async () => {
    const ctx = await setup()
    const client = batchClient()
    const deps = { client, database: ctx.database, ...runtime }
    const first = await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 2 })
    assert.equal(first.restocked, 2)
    const second = await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 2 })
    assert.equal(second.restocked, 0)
    assert.ok(second.results.every((r) => r.status === 'failed' && r.message === 'local_batch_staging_failed_unacked'))
    assert.equal(client.callCount('allocateBatch'), 2)
    assert.equal(client.callCount('ack'), 2)
    for (const table of [ALLOCATIONS, OPERATIONS, MAPPINGS, 'cards']) assert.equal(count(ctx, table), 2)
    assert.equal(count(ctx, STAGED), 0)
    assert.equal(ctx.get(`SELECT COUNT(*) AS n FROM ${OPERATIONS} WHERE state = 'done' AND attempts = 1`)?.n, 2)
    assertNoSecrets(second)
})

test('首子 Ack failed、第二子 deferred、其余成功：保留原待办，阻断新领取，按原键对账恢复', async () => {
    const ctx = await setup()
    let recovered = false
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input) => {
            const { allocationId } = input as { allocationId: string }
            if (!recovered && allocationId === 'alloc_1') throw new LicenseServiceError({ code: 'allocation_conflict', cause: 'SECRET_EXCEPTION' })
            if (!recovered && allocationId === 'alloc_2') throw new LicenseServiceError({ code: 'rate_limited', retryAfterMs: 1_000 })
            return { allocationId, status: 'acknowledged' }
        },
        getAllocation: async (allocationId) => makeAllocationDetail({ allocationId, status: 'acknowledged', cards: [] }),
    })
    const deps = { client, database: ctx.database, ...runtime }
    const first = await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 4 })
    assert.deepEqual(first.results.map((r) => r.status), ['failed', 'deferred', 'restocked', 'restocked'])
    assert.equal(first.restocked, 2)
    assert.equal(client.callCount('ack'), 4)
    assert.equal(count(ctx, STAGED), 2)
    assert.equal(ctx.get(`SELECT state FROM ${OPERATIONS} WHERE resource_id = 'alloc_1'`)?.state, 'failed')
    const original = client.callsOf('ack').slice(0, 2)
    const second = await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 4 })
    assert.deepEqual(second, { requested: 4, restocked: 0, results: [{ status: 'skipped', reason: 'materialize_pending' }] })
    assert.equal(client.callCount('allocateBatch'), 1)
    recovered = true
    const summary = await reconcilePendingAckOperations({ ...deps, now: () => NOW + 60_000 }, { limit: 100 })
    assert.equal(summary.acknowledged, 2)
    assert.equal(client.callCount('getAllocation'), 2)
    assert.deepEqual(new Set(client.callsOf('ack').slice(4).map((r) => JSON.stringify(r))), new Set(original.map((r) => JSON.stringify(r))))
    assert.equal(count(ctx, 'cards'), 4)
    assert.equal(count(ctx, STAGED), 0)
    assert.equal(ctx.get(`SELECT COUNT(*) AS n FROM ${OPERATIONS} WHERE state = 'done'`)?.n, 4)
    await reconcilePendingAckOperations({ ...deps, now: () => NOW + 120_000 }, { limit: 100 })
    assert.equal(client.callCount('ack'), 6)
    assert.equal(client.callCount('allocateBatch'), 1)
    assertNoSecrets(first)
})

test('某子读取暂存异常、某子 Ack 失败落账异常：不遗漏其余待办并可恢复', async () => {
    const ctx = await setup()
    let injected = true
    const database: CardServiceDatabase = {
        query: async <T,>(sql: string, params?: readonly unknown[]) => {
            if (injected && sql.includes(`FROM ${STAGED}`) && params?.[0] === 'alloc_1') throw new Error('SECRET_EXCEPTION read')
            return ctx.database.query<T>(sql, params)
        },
        write: async (statements) => {
            if (injected && statements[0].sql.startsWith(`UPDATE ${ALLOCATIONS}`)) throw new Error('SECRET_EXCEPTION write')
            return ctx.database.write(statements)
        },
    }
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input) => {
            const { allocationId } = input as { allocationId: string }
            if (injected && allocationId === 'alloc_2') throw new LicenseServiceError({ code: 'allocation_conflict' })
            return { allocationId, status: 'acknowledged' }
        },
        getAllocation: async (allocationId) => makeAllocationDetail({ allocationId, status: 'acknowledged' }),
    })
    const result = await restockProductCardsBatch({ client, database, ...runtime }, { productId: PRODUCT, quantity: 3 })
    assert.deepEqual(result.results.map((r) => r.status), ['failed', 'failed', 'restocked'])
    assert.equal(result.restocked, 1)
    assert.equal(count(ctx, STAGED), 2)
    assert.equal(ctx.get(`SELECT COUNT(*) AS n FROM ${OPERATIONS} WHERE state = 'pending' AND attempts = 0`)?.n, 2)
    assert.equal(client.callCount('ack'), 2)
    injected = false
    const summary = await reconcilePendingAckOperations({ client, database, ...runtime }, { limit: 100 })
    assert.equal(summary.acknowledged, 2)
    assert.equal(count(ctx, 'cards'), 3)
    assert.equal(client.callCount('allocateBatch'), 1)
    assertNoSecrets(result)
})

test('某子 Ack 成功后物化失败：该子原键可重放，其他子继续进可售池', async () => {
    const ctx = await setup()
    ctx.exec(`CREATE TRIGGER reject_materialize BEFORE INSERT ON cards
        WHEN NEW.card_key = 'SECRET_CARD_2' BEGIN SELECT RAISE(ABORT, 'constraint failed'); END`)
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
        getAllocation: async (allocationId) => makeAllocationDetail({ allocationId, status: 'acknowledged' }),
    })
    const deps = { client, database: ctx.database, ...runtime }
    const result = await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 3 })
    assert.deepEqual(result.results.map((r) => r.status), ['restocked', 'failed', 'restocked'])
    assert.equal(result.restocked, 2)
    assert.equal(count(ctx, MAPPINGS), 2)
    assert.equal(count(ctx, STAGED), 1)
    assert.equal(ctx.get(`SELECT state FROM ${OPERATIONS} WHERE resource_id = 'alloc_2'`)?.state, 'failed')
    assert.equal(client.callCount('ack'), 3)
    assert.equal((await restockProductCardsBatch(deps, { productId: PRODUCT, quantity: 3 })).results[0].status, 'skipped')
    ctx.exec('DROP TRIGGER reject_materialize')
    const summary = await reconcilePendingAckOperations({ ...deps, now: () => NOW + 60_000 }, { limit: 100 })
    assert.equal(summary.acknowledged, 1)
    assert.deepEqual(client.callsOf('ack')[3], client.callsOf('ack')[1])
    assert.equal(count(ctx, 'cards'), 3)
    assert.equal(client.callCount('allocateBatch'), 1)
    assertNoSecrets(result)
})

test('首子 Ack 超窗只作废该子暂存，其余子继续确认', async () => {
    const ctx = await setup()
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input) => batchDetails(input),
        ack: async (input) => {
            const { allocationId } = input as { allocationId: string }
            if (allocationId === 'alloc_1') throw new LicenseServiceError({ code: 'allocation_expired' })
            return { allocationId, status: 'acknowledged' }
        },
    })
    const result = await restockProductCardsBatch({ client, database: ctx.database, ...runtime }, { productId: PRODUCT, quantity: 2 })
    assert.deepEqual(result.results.map((r) => r.status), ['expired', 'restocked'])
    assert.equal(result.restocked, 1)
    assert.equal(client.callCount('ack'), 2)
    assert.equal(count(ctx, STAGED), 0)
    assert.equal(ctx.get(`SELECT state FROM ${ALLOCATIONS} WHERE allocation_id = 'alloc_1'`)?.state, 'expired')
    assert.equal(ctx.get(`SELECT state FROM ${OPERATIONS} WHERE resource_id = 'alloc_1'`)?.state, 'abandoned')
    assert.equal(ctx.get(`SELECT state FROM ${OPERATIONS} WHERE resource_id = 'alloc_2'`)?.state, 'done')
    assertNoSecrets(result)
})

test('已物化但 ID 读回失败：按成功单卡分配计数，不因缺少 localCardIds 少计', async () => {
    const ctx = await setup()
    const database: CardServiceDatabase = {
        query: async <T,>(sql: string, params?: readonly unknown[]) => {
            if (sql.startsWith('SELECT local_card_id') && params?.[0] === 'alloc_1') throw new Error('SECRET_EXCEPTION readback')
            return ctx.database.query<T>(sql, params)
        },
        write: ctx.database.write,
    }
    const result = await restockProductCardsBatch({ client: batchClient(), database, ...runtime }, { productId: PRODUCT, quantity: 2 })
    assert.deepEqual(result.results.map((r) => r.status), ['restocked', 'restocked'])
    assert.equal(result.restocked, 2)
    assert.equal(count(ctx, 'cards'), 2)
    assert.equal(count(ctx, MAPPINGS), 2)
    assert.equal(count(ctx, STAGED), 0)
    const first = result.results[0]
    assert.equal(first.status, 'restocked')
    if (first.status === 'restocked') {
        assert.deepEqual(first.localCardIds, [])
        assert.deepEqual(first.remoteCardIds, ['remote_1'])
    }
    assertNoSecrets(result)
})

test('quantity 1 已物化但 ID 读回失败仍计一张，不走批量领取', async () => {
    const ctx = await setup()
    const database: CardServiceDatabase = {
        query: async <T,>(sql: string, params?: readonly unknown[]) => {
            if (sql.startsWith('SELECT local_card_id')) throw new Error('SECRET_EXCEPTION readback')
            return ctx.database.query<T>(sql, params)
        },
        write: ctx.database.write,
    }
    const client = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'legacy' }),
        ack: async () => ({ allocationId: 'legacy', status: 'acknowledged' }),
    })
    const result = await restockProductCardsBatch({ client, database, ...runtime }, { productId: PRODUCT, quantity: 1 })
    assert.equal(result.restocked, 1)
    assert.equal(result.results[0].status, 'restocked')
    if (result.results[0].status === 'restocked') assert.deepEqual(result.results[0].localCardIds, [])
    assert.equal(count(ctx, 'cards'), 1)
    assert.equal(count(ctx, MAPPINGS), 1)
    assert.equal(count(ctx, STAGED), 0)
    assert.equal(client.callCount('allocate'), 1)
    assert.equal(client.callCount('allocateBatch'), 0)
    assert.equal(client.callCount('ack'), 1)
    assertNoSecrets(result)
})

test('非法数量严格拒绝且不读库、不生成任务、不联网；缺省 1 兼容旧中心', async () => {
    const ctx = await setup()
    const client = batchClient()
    const forbidden: CardServiceDatabase = {
        query: async () => { throw new Error('不应读库') },
        write: async () => { throw new Error('不应写库') },
    }
    for (const quantity of [0, -1, 101, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
        const result = await restockProductCardsBatch({ client, database: forbidden, randomUUID: () => { throw new Error('不应生成任务') } }, {
            productId: PRODUCT, quantity: quantity as number,
        })
        assert.equal(result.restocked, 0)
        assert.equal(result.results[0].status, 'failed')
        if (result.results[0].status === 'failed') assert.equal(result.results[0].errorCode, 'invalid_request')
    }
    assert.equal(client.calls.length, 0)
    const legacy = createFakeLicenseServiceClient({
        allocate: async () => makeAllocationDetail({ allocationId: 'legacy' }),
        ack: async () => ({ allocationId: 'legacy', status: 'acknowledged' }),
    })
    const result = await restockProductCardsBatch({ client: legacy, database: ctx.database, ...runtime }, { productId: PRODUCT })
    assert.equal(result.requested, 1)
    assert.equal(result.restocked, 1)
    assert.equal(legacy.callCount('allocate'), 1)
    assert.equal(legacy.callCount('allocateBatch'), 0)
})

test('批量重试使用固定父意图、同参数和原幂等键，不 fallback 单张领取', async () => {
    const ctx = await setup()
    let tasks = 0
    const client = createFakeLicenseServiceClient({
        allocateBatch: async (input, attempt) => {
            if (attempt === 1) throw new LicenseServiceError({ code: 'temporarily_unavailable' })
            return batchDetails(input)
        },
        ack: async (input) => ({ allocationId: (input as { allocationId: string }).allocationId, status: 'acknowledged' }),
    })
    const result = await restockProductCardsBatch({
        client, database: ctx.database, ...runtime,
        randomUUID: () => { tasks += 1; return TASK }, policy: { maxAttempts: 2 }, sleep: async () => {},
    }, { productId: PRODUCT, quantity: 2, reason: 'manual' })
    assert.equal(result.restocked, 2)
    assert.equal(tasks, 1)
    assert.equal(client.callCount('allocate'), 0)
    assert.deepEqual(client.callsOf('allocateBatch')[0], client.callsOf('allocateBatch')[1])
    assert.deepEqual(client.callsOf('allocateBatch')[0], {
        productId: PRODUCT, programKey: PROGRAM, quantity: 2,
        externalRef: buildRestockExternalRef(TASK), idempotencyKey: buildAllocateIdempotencyKey(TASK), metadata: { source: 'manual' },
    })
})

const malformed: Array<[string, (details: AllocationDetail[]) => unknown]> = [
    ['少一笔', (a) => a.slice(0, 1)],
    ['多一笔', (a) => [...a, a[0]]],
    ['非数组', () => ({ allocations: [] })],
    ['空子分配', (a) => [a[0], null]],
    ['重复 allocation', (a) => { a[1].allocationId = a[0].allocationId; return a }],
    ['空 allocation', (a) => { a[1].allocationId = ' '; return a }],
    ['重复卡 ID', (a) => { a[1].cards[0].id = a[0].cards[0].id; return a }],
    ['空卡 ID', (a) => { a[1].cards[0].id = ''; return a }],
    ['quantity 非 1', (a) => { a[1].quantity = 2; return a }],
    ['quantity 小数', (a) => { a[1].quantity = 1.1; return a }],
    ['卡数不等于 1', (a) => { a[1].cards = []; return a }],
    ['缺明文', (a) => { a[1].cards[0].key = ''; return a }],
    ['Program key 错配', (a) => { a[1].programKey = 'other'; return a }],
    ['Program id 错配', (a) => { a[1].programId = 'other'; return a }],
    ['Program id 缺失', (a) => { a[1].programId = ''; return a }],
    ['externalRef 错配', (a) => { a[1].externalRef = a[0].externalRef; return a }],
    ['分配顺序错配', (a) => a.reverse()],
    ['不是 allocated', (a) => { a[1].status = 'acknowledged'; return a }],
    ['过期时间非法', (a) => { a[1].expiresAtMs = NaN; return a }],
]
for (const [name, mutate] of malformed) {
    test(`假客户端响应绕过契约：${name}，全批拒绝且零暂存/Ack`, async () => {
        const ctx = await setup()
        const client = createFakeLicenseServiceClient({
            allocateBatch: async (input) => mutate(batchDetails(input)) as AllocationDetail[],
        })
        const result = await restockProductCardsBatch({ client, database: ctx.database, ...runtime }, { productId: PRODUCT, quantity: 2 })
        assert.equal(result.restocked, 0)
        assert.equal(result.results[0].status, 'failed')
        if (result.results[0].status === 'failed') assert.equal(result.results[0].errorCode, 'invalid_response')
        for (const table of [ALLOCATIONS, STAGED, OPERATIONS, 'cards']) assert.equal(count(ctx, table), 0)
        assert.equal(client.callCount('ack'), 0)
        assert.equal(client.callCount('allocate'), 0)
        assertNoSecrets(result)
    })
}

test('批量准入不放松旧闸门：未接入、模式/Program、删除、共享、未上架全都零请求', async () => {
    for (const [sql, reason] of [
        ['DELETE FROM card_service_product_configs', 'not_configured'],
        ["UPDATE card_service_product_configs SET supply_mode = 'local'", 'supply_mode_not_license_service'],
        ['UPDATE card_service_product_configs SET program_key = NULL', 'program_key_missing'],
        ['DELETE FROM products', 'product_not_found'],
        ['UPDATE products SET is_shared = 1', 'shared_product'],
        ['UPDATE products SET is_active = 0', 'product_inactive'],
        ['UPDATE products SET is_active = NULL', 'product_inactive'],
    ]) {
        const ctx = await setup()
        ctx.exec(sql)
        const client = batchClient()
        const result = await restockProductCardsBatch({ client, database: ctx.database, ...runtime }, { productId: PRODUCT, quantity: 2 })
        assert.deepEqual(result.results, [{ status: 'skipped', reason }])
        assert.equal(client.calls.length, 0)
    }
})

test('中心拒绝 batch 时不降级单张，不落账；异常信息不泄密', async () => {
    const ctx = await setup()
    const client = createFakeLicenseServiceClient({
        allocateBatch: async () => { throw new LicenseServiceError({ code: 'not_found', cause: 'SECRET_EXCEPTION' }) },
    })
    const result = await restockProductCardsBatch({ client, database: ctx.database, ...runtime }, { productId: PRODUCT, quantity: 2 })
    assert.equal(result.restocked, 0)
    assert.equal(client.callCount('allocateBatch'), 1)
    assert.equal(client.callCount('allocate'), 0)
    assert.equal(count(ctx, ALLOCATIONS), 0)
    assertNoSecrets(result)
})

test('index 批量装配：部分成功和读回失败均只重算一次，聚合故障不影响结果', async () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf('export async function restockProductCardBatch(')
    const end = source.indexOf('\n}', start)
    assert.ok(start > 0 && end > start)
    const body = source.slice(source.indexOf('{\n', start) + 2, end)
    // 运行真实函数体，依赖替换为窄端口，避开装配层的 Next.js/D1 别名。
    let recalcs = 0
    const deps = {}
    let expected: RestockBatchResult = { requested: 2, restocked: 1, results: [
        { status: 'restocked', taskId: 't', allocationId: 'a', remoteCardIds: ['r'], localCardIds: [1], expiresAtMs: NOW },
        { status: 'failed', taskId: 't2', allocationId: 'a2', errorCode: 'invalid_response', category: 'invalid', message: 'failed' },
    ] }
    const execute = new Function('restockProductCardsBatch', 'buildCardServiceDeps', 'recalcStorefrontStock',
        `return async function(productId, quantity, env) {${body}}`)(
        async (actualDeps: unknown, options: unknown) => {
            assert.equal(actualDeps, deps)
            assert.deepEqual(options, { productId: PRODUCT, quantity: 2 })
            return expected
        },
        () => deps,
        async (ids: string[]) => { assert.deepEqual(ids, [PRODUCT]); recalcs += 1 },
    )
    assert.equal(await execute(PRODUCT, 2, {}), expected)
    assert.equal(recalcs, 1)
    expected = { requested: 2, restocked: 1, results: [{ ...expected.results[0], localCardIds: [] } as RestockBatchResult['results'][number]] }
    assert.equal(await execute(PRODUCT, 2, {}), expected)
    assert.equal(recalcs, 2)
    expected = { requested: 2, restocked: 0, results: [{ status: 'skipped', reason: 'materialize_pending' }] }
    assert.equal(await execute(PRODUCT, 2, {}), expected)
    assert.equal(recalcs, 2)
    const recalcStart = source.indexOf('async function recalcStorefrontStock(')
    const recalcEnd = source.indexOf('\n}', recalcStart)
    const recalcBody = source.slice(source.indexOf('{\n', recalcStart) + 2, recalcEnd)
    const recalc = new Function('recalcProductAggregatesForMany', 'console', `return async function(productIds) {${recalcBody}}`)(
        async () => { throw new Error('聚合不可用') }, { error: () => {} },
    )
    await assert.doesNotReject(recalc([PRODUCT]))
})
