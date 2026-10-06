import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_SERVICE_DDL_STATEMENTS } from '../db/license-service-schema.ts'
import { CARD_SERVICE_CREDENTIALS_TABLE, CARD_SERVICE_CREDENTIALS_DDL_STATEMENTS, CARD_SERVICE_CREDENTIALS_SCHEMA_PROBES } from '../db/license-service-credentials-schema.ts'
import { encryptProductApiKey, decryptProductApiKey, describeProductLicenseServiceConfig, listProductCredentialIdentities, clearDerivedCredentialKeys } from './credentials.ts'
import { saveCardServiceProductConnection } from './product-connection.ts'
import { loadCardServiceProductConfig } from './product-config.ts'
import { createProductLicenseServiceClient } from './product-client.ts'
import { createLicenseServiceClient, type AllocateInput, type LicenseServiceClientOptions } from './client.ts'
import { createSqliteCardServiceDatabase, createFakeLicenseServiceClient, makeAllocationDetail, type SqliteTestContext } from './test-support.ts'
import { restockProductCards, loadCardServiceAllocation } from './restock.ts'
import { replenishLowStockProducts } from './replenish.ts'
import { resolveAllocationWithRemoteState } from './reconcile.ts'
import { executeOrderRemoteSales } from './delivery.ts'
import { executeOrderRevokes } from './revoke.ts'
import { LicenseServiceError } from './errors.ts'

const ENV = { AUTH_SECRET: 'test-only-auth-secret', LICENSE_SERVICE_BASE_URL: 'https://lks.test', LICENSE_SERVICE_API_KEY: 'must-never-use-global-key' }
const NOW = Date.parse('2026-10-01T08:00:00Z')
function setup() {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec("INSERT INTO products(id) VALUES ('p1'), ('p2')")
    return ctx
}
async function save(ctx: SqliteTestContext, productId: string, programKey: string, apiKey?: string, targetStock = 1) {
    return saveCardServiceProductConnection(ctx.database, { productId, supplyMode: 'license_service', programKey, apiKey, targetStock }, ENV, NOW)
}
function fakeFactory() {
    const events: Array<{ key: string; method: string; resource: string }> = []
    let sequence = 0
    const factory = (options: LicenseServiceClientOptions) => createFakeLicenseServiceClient({
        allocate: async (raw) => {
            const input = raw as AllocateInput
            events.push({ key: options.apiKey, method: 'allocate', resource: input.programKey })
            sequence += 1
            return makeAllocationDetail({ allocationId: `alloc_${sequence}`, programKey: input.programKey, externalRef: input.externalRef,
                cards: [{ id: `remote_${sequence}`, key: `CARD-${sequence}`, maskedKey: null }], expiresAtMs: NOW + 30 * 60_000 })
        },
        allocateBatch: async (raw) => {
            const input = raw as AllocateInput
            events.push({ key: options.apiKey, method: 'allocateBatch', resource: input.programKey })
            return Array.from({ length: input.quantity! }, (_, index) => {
                sequence += 1
                return makeAllocationDetail({ allocationId: `alloc_${sequence}`, programKey: input.programKey,
                    externalRef: input.externalRef ? `${input.externalRef}:${index + 1}` : '',
                    cards: [{ id: `remote_${sequence}`, key: `CARD-${sequence}`, maskedKey: null }], expiresAtMs: NOW + 30 * 60_000 })
            })
        },
        ack: async (raw) => {
            const input = raw as { allocationId: string }
            events.push({ key: options.apiKey, method: 'ack', resource: input.allocationId })
            return { allocationId: input.allocationId, status: 'acknowledged' }
        },
        sell: async (raw) => {
            const input = raw as { allocationId: string }
            events.push({ key: options.apiKey, method: 'sell', resource: input.allocationId })
            return { allocationId: input.allocationId, status: 'sold' }
        },
        getAllocation: async (id) => {
            events.push({ key: options.apiKey, method: 'getAllocation', resource: id })
            return makeAllocationDetail({ allocationId: id, status: 'acknowledged', expiresAtMs: NOW + 30 * 60_000 })
        },
        getCardStatus: async (id) => {
            events.push({ key: options.apiKey, method: 'getCardStatus', resource: id })
            return { cardId: id, programId: 'program', maskedKey: null, status: 'active', allocationStatus: 'acknowledged',
                usageLimit: null, usageHeld: null, usageCommitted: null, remaining: null, createdAtMs: null }
        },
        revoke: async (id) => {
            events.push({ key: options.apiKey, method: 'revoke', resource: id })
            return { cardId: id, status: 'revoked' }
        },
    })
    return { events, factory }
}

test('商品 Key 加密随机化，密文绑定商品和 Program，篡改或错误 Secret 不泄露 Key', async () => {
    const one = await encryptProductApiKey('key-p1', 'p1', 'program-a', ENV)
    const two = await encryptProductApiKey('key-p1', 'p1', 'program-a', ENV)
    assert.notEqual(one, two)
    assert.ok(!one.includes('key-p1'))
    assert.equal(await decryptProductApiKey(one, 'p1', 'program-a', ENV), 'key-p1')
    for (const [cipher, product, program, env] of [
        [one, 'p2', 'program-a', ENV], [one, 'p1', 'program-b', ENV],
        [one, 'p1', 'program-a', { ...ENV, AUTH_SECRET: 'wrong' }], ['v1.invalid.invalid', 'p1', 'program-a', ENV],
    ] as const) {
        await assert.rejects(() => decryptProductApiKey(cipher, product, program, env), (error: unknown) =>
            error instanceof LicenseServiceError && error.code === 'config_error' && !JSON.stringify(error).includes('key-p1'))
    }
})

test('连接状态依赖中心地址与加密 Secret，商品 Key 不受全局 Key 影响', () => {
    const withoutGlobal = { AUTH_SECRET: ENV.AUTH_SECRET, LICENSE_SERVICE_BASE_URL: ENV.LICENSE_SERVICE_BASE_URL }
    assert.equal(describeProductLicenseServiceConfig(withoutGlobal).configured, true)
    assert.equal(describeProductLicenseServiceConfig({ LICENSE_SERVICE_BASE_URL: ENV.LICENSE_SERVICE_BASE_URL, LICENSE_SERVICE_API_KEY: 'global' }).configured, false)
    assert.ok(!JSON.stringify(describeProductLicenseServiceConfig(ENV)).includes(ENV.AUTH_SECRET))
})

test('首次接入和新 Program 缺少 Key 时拒绝保存，原映射和库存目标保持原值', async () => {
    const ctx = setup()
    assert.deepEqual(await save(ctx, 'p1', 'program-a'), { ok: false, reason: 'api_key_required' })
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'p1')).configured, false)
    assert.deepEqual(await save(ctx, 'p1', 'program-a', 'key-a'), { ok: true })
    assert.deepEqual(await save(ctx, 'p1', 'program-b', undefined, 9), { ok: false, reason: 'api_key_required' })
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'p1')).programKey, 'program-a')
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'p1')).targetStock, 1)
})

test('空 Key 保留同商品同 Program 的凭据，修改目标库存不覆盖 Key；新 Program 保留历史 Key', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    const original = ctx.get(`SELECT encrypted_api_key FROM ${CARD_SERVICE_CREDENTIALS_TABLE}`)?.encrypted_api_key
    assert.deepEqual(await save(ctx, 'p1', 'program-a', '  ', 5), { ok: true })
    assert.equal(ctx.get(`SELECT encrypted_api_key FROM ${CARD_SERVICE_CREDENTIALS_TABLE}`)?.encrypted_api_key, original)
    assert.deepEqual(await save(ctx, 'p1', 'program-b', 'key-b'), { ok: true })
    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_CREDENTIALS_TABLE}`).length, 2)
    assert.deepEqual(await save(ctx, 'p1', 'program-a'), { ok: true })
    const status = await listProductCredentialIdentities(ctx.database)
    assert.equal(status.ready, true)
    assert.ok(!JSON.stringify(status).includes('encrypted_api_key'))
    assert.ok(!JSON.stringify(status).includes('key-a'))
})

test('同名 Program 在不同商品上的 Key 独立，缺少 Key 不借用另一商品或全局凭据', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'same-program', 'key-p1')
    assert.deepEqual(await save(ctx, 'p2', 'same-program'), { ok: false, reason: 'api_key_required' })
    const f = fakeFactory()
    const client = createProductLicenseServiceClient(ctx.database, ENV, f.factory)
    await assert.rejects(() => client.allocate({ productId: 'p2', programKey: 'same-program', idempotencyKey: 'restock:missing:allocate' }),
        (error: unknown) => error instanceof LicenseServiceError && error.code === 'config_error')
    assert.equal(f.events.length, 0)
    await save(ctx, 'p2', 'same-program', 'key-p2')
    const fresh = createProductLicenseServiceClient(ctx.database, ENV, f.factory)
    await fresh.allocate({ productId: 'p1', programKey: 'same-program', idempotencyKey: 'restock:p1:allocate' })
    await fresh.allocate({ productId: 'p2', programKey: 'same-program', idempotencyKey: 'restock:p2:allocate' })
    assert.deepEqual(f.events.map((e) => e.key), ['key-p1', 'key-p2'])
})

test('批量分配按商品和 Program 路由，同名 Program 不串 Key，缓存不串路由且无全局回退', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'same-program', 'key-p1')
    const f = fakeFactory()
    const missing = createProductLicenseServiceClient(ctx.database, ENV, f.factory)
    const input = { programKey: 'same-program', quantity: 2, externalRef: '父引用', idempotencyKey: 'batch:product:allocate' }
    for (const overrides of [{ productId: 'p2' }, { productId: undefined }, { productId: 'p1', programKey: 'missing' }]) {
        await assert.rejects(missing.allocateBatch({ ...input, ...overrides }),
            (error: unknown) => error instanceof LicenseServiceError && error.code === 'config_error')
    }
    assert.equal(f.events.length, 0)
    await save(ctx, 'p2', 'same-program', 'key-p2')
    await save(ctx, 'p1', 'new-program', 'key-new')
    let factories = 0
    const client = createProductLicenseServiceClient(ctx.database, ENV, (options) => {
        factories += 1
        return f.factory(options)
    })
    const [one, two] = await Promise.all([
        client.allocateBatch({ ...input, productId: 'p1' }),
        client.allocateBatch({ ...input, productId: 'p2' }),
    ])
    assert.equal(one.length, 2)
    assert.equal(two.length, 2)
    assert.deepEqual(one.map((a) => a.externalRef), ['父引用:1', '父引用:2'])
    await client.allocateBatch({ ...input, productId: 'p1', programKey: 'new-program' })
    await client.allocateBatch({ ...input, productId: 'p1' })
    assert.equal(factories, 3)
    assert.deepEqual(f.events.map(({ key, method }) => [key, method]), [
        ['key-p1', 'allocateBatch'], ['key-p2', 'allocateBatch'], ['key-new', 'allocateBatch'], ['key-p1', 'allocateBatch'],
    ])
})

test('批量分配真实 HTTP 使用商品 Key 且 productId 仅本地路由，错误从底层原样传回', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'same-program', 'key-p1')
    await save(ctx, 'p2', 'same-program', 'key-p2')
    const captured: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        captured.push({ url: String(url), auth: new Headers(init.headers).get('Authorization'), body })
        return Response.json({ ok: true, data: { allocations: Array.from({ length: body.quantity as number }, (_, index) => ({
            allocation_id: `allocation-${index}`, program_id: 'program-id', program_key: body.program_key,
            external_ref: body.external_ref ? `${body.external_ref}:${index + 1}` : '', quantity: 1, status: 'allocated',
            cards: [{ id: `card-${index}`, key: `CARD-KEY-${index}` }],
            expires_at: '2026-10-01T08:30:00Z', created_at: '2026-10-01T08:00:00Z',
        })) } }, { status: 201 })
    }) as typeof fetch
    const client = createProductLicenseServiceClient(ctx.database, ENV, (options) => createLicenseServiceClient({ ...options, fetchImpl }))
    const input = { programKey: 'same-program', quantity: 2, idempotencyKey: 'batch:product:allocate' }
    await client.allocateBatch({ ...input, productId: 'p1', externalRef: 'parent', metadata: { source: 'manual' } })
    await client.allocateBatch({ ...input, productId: 'p2' })
    assert.deepEqual(captured.map((c) => c.auth), ['Bearer key-p1', 'Bearer key-p2'])
    assert.ok(captured.every((c) => c.url === 'https://lks.test/api/v1/allocations/batch'))
    assert.deepEqual(captured.map((c) => c.body), [
        { program_key: 'same-program', quantity: 2, external_ref: 'parent', metadata: { source: 'manual' } },
        { program_key: 'same-program', quantity: 2 },
    ])
    const failure = new LicenseServiceError({ code: 'not_found', operation: 'allocateBatch', httpStatus: 404 })
    const failing = createProductLicenseServiceClient(ctx.database, ENV, () => createFakeLicenseServiceClient({
        allocateBatch: async () => { throw failure },
    }))
    await assert.rejects(failing.allocateBatch({ ...input, productId: 'p1' }), (error) => error === failure)
})

test('Program 和 Key 同批次保存；凭据写入失败时配置更新原子回滚', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    ctx.exec(`CREATE TRIGGER reject_credentials BEFORE INSERT ON ${CARD_SERVICE_CREDENTIALS_TABLE} BEGIN SELECT RAISE(ABORT, 'test write rejected'); END`)
    await assert.rejects(() => save(ctx, 'p1', 'program-b', 'key-b'), /test write rejected/)
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'p1')).programKey, 'program-a')
    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_CREDENTIALS_TABLE}`).length, 1)
})

test('0039 未执行、加密 Secret 缺失与非法 Key 都明确拒绝且不写配置', async () => {
    const ctx = setup()
    assert.deepEqual(await save(ctx, 'p1', 'program-a', 'key\nline'), { ok: false, reason: 'invalid_api_key' })
    assert.deepEqual(await save(ctx, 'p1', 'program-a', 'x'.repeat(4097)), { ok: false, reason: 'invalid_api_key' })
    assert.deepEqual(await saveCardServiceProductConnection(ctx.database, { productId: 'p1', supplyMode: 'license_service', programKey: 'a', apiKey: 'key', targetStock: 1 }, {}),
        { ok: false, reason: 'encryption_secret_missing' })
    ctx.exec(`DROP TABLE ${CARD_SERVICE_CREDENTIALS_TABLE}`)
    assert.deepEqual(await save(ctx, 'p1', 'program-a', 'key'), { ok: false, reason: 'credential_storage_not_ready' })
    assert.deepEqual(await listProductCredentialIdentities(ctx.database), { ready: false, identities: [] })
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'p1')).configured, false)
})

test('同一 secret 并发加解密只派生一次，secret 变化后旧缓存不复用', async () => {
    clearDerivedCredentialKeys()
    const original = crypto.subtle.deriveKey.bind(crypto.subtle)
    let derivations = 0
    crypto.subtle.deriveKey = (async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
        derivations += 1
        return original(...args)
    }) as SubtleCrypto['deriveKey']
    try {
        const [first, second] = await Promise.all([
            encryptProductApiKey('key-a', 'p1', 'program-a', ENV),
            encryptProductApiKey('key-b', 'p2', 'program-b', ENV),
        ])
        assert.equal(derivations, 1)
        assert.equal(await decryptProductApiKey(first, 'p1', 'program-a', ENV), 'key-a')
        assert.equal(await decryptProductApiKey(second, 'p2', 'program-b', ENV), 'key-b')
        const changed = { ...ENV, AUTH_SECRET: 'another-secret' }
        await assert.rejects(() => decryptProductApiKey(first, 'p1', 'program-a', changed))
        assert.equal(derivations, 2)
        const again = await encryptProductApiKey('key-c', 'p1', 'program-a', ENV)
        assert.equal(derivations, 2)
        assert.equal(await decryptProductApiKey(again, 'p1', 'program-a', ENV), 'key-c')
    } finally {
        crypto.subtle.deriveKey = original
        clearDerivedCredentialKeys()
    }
})

test('派生失败不留在缓存里，下一次会重新派生', async () => {
    clearDerivedCredentialKeys()
    const original = crypto.subtle.deriveKey.bind(crypto.subtle)
    let attempts = 0
    crypto.subtle.deriveKey = (async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
        attempts += 1
        if (attempts === 1) throw new Error('hkdf unavailable')
        return original(...args)
    }) as SubtleCrypto['deriveKey']
    try {
        await assert.rejects(() => encryptProductApiKey('key-a', 'p1', 'program-a', ENV))
        assert.equal(await decryptProductApiKey(await encryptProductApiKey('key-a', 'p1', 'program-a', ENV), 'p1', 'program-a', ENV), 'key-a')
        assert.equal(attempts, 2)
    } finally {
        crypto.subtle.deriveKey = original
        clearDerivedCredentialKeys()
    }
})

test('新增凭据迁移幂等且探针可运行，升级 0038 不会隐式建立凭据表', () => {
    const ctx = setup()
    ctx.exec(`DROP TABLE ${CARD_SERVICE_CREDENTIALS_TABLE}`)
    for (const ddl of CARD_SERVICE_DDL_STATEMENTS) ctx.exec(ddl)
    assert.equal(ctx.all("SELECT name FROM sqlite_master WHERE name = 'card_service_credentials'").length, 0)
    for (let round = 0; round < 2; round += 1) for (const ddl of CARD_SERVICE_CREDENTIALS_DDL_STATEMENTS) ctx.exec(ddl)
    for (const probe of CARD_SERVICE_CREDENTIALS_SCHEMA_PROBES) assert.deepEqual(ctx.all(probe), [])
    const keys = ctx.all(`PRAGMA table_info(${CARD_SERVICE_CREDENTIALS_TABLE})`).filter((c) => Number(c.pk) > 0).map((c) => c.name)
    assert.deepEqual(keys, ['product_id', 'program_key'])
})

test('两个商品低水位补货分别使用对应 Key 完成 Allocate 和 Ack', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    await save(ctx, 'p2', 'program-b', 'key-b')
    const f = fakeFactory()
    const summary = await replenishLowStockProducts({ database: ctx.database,
        client: createProductLicenseServiceClient(ctx.database, ENV, f.factory), now: () => NOW })
    assert.equal(summary.restocked, 2)
    assert.deepEqual(f.events.map(({ key, method }) => [key, method]), [['key-a', 'allocate'], ['key-a', 'ack'], ['key-b', 'allocate'], ['key-b', 'ack']])
    assert.equal(ctx.all('SELECT * FROM cards').length, 2)
})

test('更换 Program 后新补货用新 Key，旧卡销售、状态查询和退款作废仍用旧 Key', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    const f = fakeFactory()
    const deps = () => ({ database: ctx.database, client: createProductLicenseServiceClient(ctx.database, ENV, f.factory), now: () => NOW })
    const old = await restockProductCards(deps(), { productId: 'p1' })
    assert.equal(old.status, 'restocked')
    if (old.status !== 'restocked') return
    await save(ctx, 'p1', 'program-b', 'key-b')
    assert.equal((await restockProductCards(deps(), { productId: 'p1' })).status, 'restocked')
    const row = await loadCardServiceAllocation(ctx.database, old.allocationId)
    assert.ok(row)
    assert.equal(await executeOrderRemoteSales(deps(), { orderId: 'order-old', groups: [{ allocationId: old.allocationId,
        externalRef: row.externalRef, localCardIds: old.localCardIds, remoteCardIds: old.remoteCardIds, alreadySold: false }] }).then((r) => r.status), 'confirmed')
    await deps().client.getAllocation(old.allocationId)
    await deps().client.getCardStatus(old.remoteCardIds[0])
    const result = await executeOrderRevokes(deps(), { orderId: 'order-old', reason: 'test refund', cards: [{
        localCardId: old.localCardIds[0], remoteCardId: old.remoteCardIds[0], allocationId: old.allocationId, state: 'sold', alreadyRevoked: false,
    }] })
    assert.equal(result.revoked, 1)
    assert.deepEqual(f.events.map(({ key, method }) => [key, method]), [
        ['key-a', 'allocate'], ['key-a', 'ack'], ['key-b', 'allocate'], ['key-b', 'ack'],
        ['key-a', 'sell'], ['key-a', 'getAllocation'], ['key-a', 'getCardStatus'], ['key-a', 'revoke'],
    ])
})

test('Ack 超时留下的旧 Program 在更换 Program 后可用原 Key 对账入库', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    const f = fakeFactory()
    let failAck = true
    const client = createProductLicenseServiceClient(ctx.database, ENV, (options) => {
        const c = f.factory(options)
        const ack = c.ack.bind(c)
        c.ack = async (input) => {
            if (failAck) throw new LicenseServiceError({ code: 'timeout' })
            return ack(input)
        }
        return c
    })
    const deps = { database: ctx.database, client, now: () => NOW, policy: { maxAttempts: 1 } }
    const pending = await restockProductCards(deps, { productId: 'p1' })
    assert.equal(pending.status, 'deferred')
    if (pending.status !== 'deferred') return
    await save(ctx, 'p1', 'program-b', 'key-b')
    failAck = false
    const row = await loadCardServiceAllocation(ctx.database, pending.allocationId)
    assert.ok(row)
    assert.equal(await resolveAllocationWithRemoteState(deps, row), 'acknowledged')
    assert.ok(f.events.every((e) => e.key === 'key-a'))
    assert.equal(ctx.all('SELECT * FROM cards').length, 1)
})

test('真实请求头分别使用商品 Key，本地 productId 不改变中心接口请求体', async () => {
    const ctx = setup()
    await save(ctx, 'p1', 'program-a', 'key-a')
    await save(ctx, 'p2', 'program-b', 'key-b')
    const captured: Array<{ auth: string | null; body: Record<string, unknown> }> = []
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        captured.push({ auth: new Headers(init.headers).get('Authorization'), body })
        return Response.json({ ok: true, data: { allocation_id: `allocation-${captured.length}`, program_id: 'program-id', program_key: body.program_key,
            external_ref: '', quantity: 1, status: 'allocated', cards: [{ id: 'card-id', key: 'CARD-KEY', masked_key: null }],
            expires_at: '2026-10-01T08:30:00Z', created_at: '2026-10-01T08:00:00Z', acknowledged_at: null } })
    }) as typeof fetch
    const client = createProductLicenseServiceClient(ctx.database, ENV, (options) => createLicenseServiceClient({ ...options, fetchImpl }))
    await client.allocate({ productId: 'p1', programKey: 'program-a', idempotencyKey: 'restock:p1:allocate' })
    await client.allocate({ productId: 'p2', programKey: 'program-b', idempotencyKey: 'restock:p2:allocate' })
    assert.deepEqual(captured.map((c) => c.auth), ['Bearer key-a', 'Bearer key-b'])
    assert.deepEqual(captured.map((c) => Object.keys(c.body).sort()), [['program_key', 'quantity'], ['program_key', 'quantity']])
})
