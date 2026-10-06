import test from 'node:test'
import assert from 'node:assert/strict'

import { createLicenseServiceClient, type AllocateInput, type LicenseServiceClientOptions } from './client.ts'
import { createFakeLicenseServiceClient, makeAllocationDetail } from './test-support.ts'
import { isLicenseServiceError } from './errors.ts'

interface CapturedRequest {
    url: string
    init: RequestInit
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: CapturedRequest[] = []
    const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push({ url, init })
        return handler(url, init)
    }) as unknown as typeof fetch
    return { impl, calls }
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

function allocationEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ok: true,
        data: {
            allocation_id: 'all_1',
            program_id: 'prog_1',
            program_key: 'bill-service',
            external_ref: 'ldc-shop:restock:task-1',
            status: 'allocated',
            quantity: 1,
            cards: [{ id: 'card_1', key: 'CS-7K2M-9XPT-4WQH-8CDE-1', masked_key: 'CS-7K2M-****-1' }],
            expires_at: '2026-09-22T08:30:00Z',
            created_at: '2026-09-22T08:00:00Z',
            acknowledged_at: null,
            ...overrides,
        },
    }
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<LicenseServiceClientOptions> = {}) {
    return createLicenseServiceClient({
        baseUrl: 'https://lks.test',
        apiKey: 'cs_live_sales',
        fetchImpl,
        timeoutMs: 5_000,
        requestIdFactory: () => 'req_fixed',
        now: () => 1_000,
        ...overrides,
    })
}

function headerOf(call: CapturedRequest, name: string): string | undefined {
    return (call.init.headers as Record<string, string> | undefined)?.[name]
}

test('Allocate 请求形态：路径、方法、三个头与严格请求体', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(allocationEnvelope()))
    const client = makeClient(impl)

    const detail = await client.allocate({
        programKey: 'bill-service',
        quantity: 1,
        externalRef: 'ldc-shop:restock:task-1',
        metadata: { source: 'manual' },
        idempotencyKey: 'restock:task-1:allocate',
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://lks.test/api/v1/allocations')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(headerOf(calls[0], 'Authorization'), 'Bearer cs_live_sales')
    assert.equal(headerOf(calls[0], 'Idempotency-Key'), 'restock:task-1:allocate')
    assert.equal(headerOf(calls[0], 'X-Request-ID'), 'req_fixed')
    assert.equal(headerOf(calls[0], 'Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        program_key: 'bill-service',
        quantity: 1,
        external_ref: 'ldc-shop:restock:task-1',
        metadata: { source: 'manual' },
    })

    assert.equal(detail.allocationId, 'all_1')
    assert.equal(detail.cards[0].key, 'CS-7K2M-9XPT-4WQH-8CDE-1')
})

function batchEnvelope(quantity: number, externalRef = '', programKey = 'bill-service') {
    return { ok: true, data: { allocations: Array.from({ length: quantity }, (_, index) => allocationEnvelope({
        allocation_id: `all_${index + 1}`,
        program_key: programKey,
        external_ref: externalRef ? `${externalRef}:${index + 1}` : '',
        cards: [{ id: `card_${index + 1}`, key: `KEY-${index + 1}` }],
    }).data) } }
}

const batchInput: AllocateInput = {
    programKey: 'bill-service', quantity: 2, idempotencyKey: 'batch:task-1:allocate',
}

test('AllocateBatch 只发一次 POST，严格四字段请求体且 productId 不发给中心', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(batchEnvelope(2, '父引用'), 201))
    const details = await makeClient(impl).allocateBatch({
        ...batchInput, productId: 'local-product', externalRef: '父引用', metadata: { source: 'manual' },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://lks.test/api/v1/allocations/batch')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(headerOf(calls[0], 'Authorization'), 'Bearer cs_live_sales')
    assert.equal(headerOf(calls[0], 'Accept'), 'application/json')
    assert.equal(headerOf(calls[0], 'Idempotency-Key'), batchInput.idempotencyKey)
    assert.equal(headerOf(calls[0], 'X-Request-ID'), 'req_fixed')
    assert.equal(headerOf(calls[0], 'Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        program_key: 'bill-service', quantity: 2, external_ref: '父引用', metadata: { source: 'manual' },
    })
    assert.deepEqual(details.map((a) => [a.allocationId, a.cards[0].id, a.externalRef]), [
        ['all_1', 'card_1', '父引用:1'], ['all_2', 'card_2', '父引用:2'],
    ])
})

test('AllocateBatch 数量严格 integer 1..100，不默认、不截断且非法输入不联网', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(batchEnvelope(2)))
    const client = makeClient(impl)
    for (const quantity of [undefined, 0, -1, 101, 1.9, 100.9, NaN, Infinity, -Infinity, '2', null]) {
        await assert.rejects(client.allocateBatch({ ...batchInput, quantity: quantity as number }),
            (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_request' && error.operation === 'allocateBatch')
    }
    for (const input of [
        { ...batchInput, programKey: '  ' },
        { ...batchInput, idempotencyKey: 'short' },
        { ...batchInput, externalRef: 123 as unknown as string },
    ]) {
        await assert.rejects(client.allocateBatch(input),
            (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_request')
    }
    assert.equal(calls.length, 0)
})

test('AllocateBatch 1/9/10/99/100 数量边界与 Unicode 父引用长度预留最大序号', async () => {
    const { impl, calls } = stubFetch((_url, init) => {
        const body = JSON.parse(String(init.body))
        return jsonResponse(batchEnvelope(body.quantity, body.external_ref))
    })
    const client = makeClient(impl)
    for (const quantity of [1, 9, 10, 99, 100]) {
        const maxParentLength = 128 - 1 - String(quantity).length
        for (const char of ['x', '中', '😀']) {
            const externalRef = char.repeat(maxParentLength)
            assert.equal((await client.allocateBatch({ ...batchInput, quantity, externalRef })).length, quantity)
            const before = calls.length
            await assert.rejects(client.allocateBatch({ ...batchInput, quantity, externalRef: externalRef + char }),
                (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_request')
            assert.equal(calls.length, before)
        }
    }
    for (const externalRef of [undefined, '']) {
        const details = await client.allocateBatch({ ...batchInput, externalRef })
        assert.deepEqual(details.map((a) => a.externalRef), ['', ''])
        assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { program_key: 'bill-service', quantity: 2 })
    }
})

test('AllocateBatch HTTP 404 明确要求升级中心，不降级成 N 次 Allocate', async () => {
    for (const payload of ['404 page not found', { ok: false, error: { code: 'not_found', message: 'missing', retryable: false } }]) {
        const { impl, calls } = stubFetch(() => typeof payload === 'string'
            ? new Response(payload, { status: 404, headers: { 'X-Request-ID': 'req_old' } })
            : jsonResponse({ ...payload, request_id: 'req_old' }, 404))
        await assert.rejects(makeClient(impl).allocateBatch(batchInput), (error: unknown) => {
            assert.ok(isLicenseServiceError(error))
            assert.equal(error.operation, 'allocateBatch')
            assert.equal(error.httpStatus, 404)
            assert.equal(error.code, 'not_found')
            assert.equal(error.retryable, false)
            assert.equal(error.requestId, 'req_old')
            assert.match(error.message, /升级中心/)
            assert.match(error.causeMessage!, /不会降级/)
            return true
        })
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'https://lks.test/api/v1/allocations/batch')
    }
})

test('AllocateBatch 异常响应整批 invalid_response，携带 operation 且不重试或泄露明文', async () => {
    const mutations: Array<(payload: ReturnType<typeof batchEnvelope>) => void> = [
        (p) => { p.ok = false },
        (p) => { p.data.allocations.pop() },
        (p) => { p.data.allocations[1] = p.data.allocations[0] },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).quantity = 1.9 },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).program_key = 'other' },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).status = 'sold' },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).cards = [{ id: 'card_1', key: 'SECRET-KEY' }] },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).cards = [{ id: 'card_2' }] },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).external_ref = ':2' },
        (p) => { (p.data.allocations[1] as Record<string, unknown>).expires_at = 'invalid' },
    ]
    for (const mutate of mutations) {
        const payload = batchEnvelope(2)
        mutate(payload)
        const { impl, calls } = stubFetch(() => jsonResponse(payload))
        await assert.rejects(makeClient(impl).allocateBatch(batchInput), (error: unknown) => {
            assert.ok(isLicenseServiceError(error))
            assert.equal(error.code, 'invalid_response')
            assert.equal(error.operation, 'allocateBatch')
            assert.equal(error.retryable, false)
            assert.ok(!JSON.stringify(error).includes('SECRET-KEY'))
            return true
        })
        assert.equal(calls.length, 1)
    }
})

test('AllocateBatch 复用错误信封映射、幂等冲突指纹和响应大小限制', async () => {
    for (const [status, code, retryable] of [[409, 'idempotency_conflict', false], [403, 'program_not_allowed', false], [503, 'temporarily_unavailable', true]] as const) {
        const { impl, calls } = stubFetch(() => jsonResponse({
            ok: false, error: { code, message: '批量请求失败', retryable }, request_id: 'req_batch',
        }, status, { 'Retry-After': '2' }))
        await assert.rejects(makeClient(impl).allocateBatch(batchInput), (error: unknown) => {
            assert.ok(isLicenseServiceError(error))
            assert.equal(error.operation, 'allocateBatch')
            assert.equal(error.code, code)
            assert.equal(error.retryable, retryable)
            assert.equal(error.requestId, 'req_batch')
            assert.equal(error.retryAfterMs, 2_000)
            assert.equal(error.bodyFingerprint?.length ?? null, code === 'idempotency_conflict' ? 16 : null)
            return true
        })
        assert.equal(calls.length, 1)
    }
    const { impl } = stubFetch(() => jsonResponse(batchEnvelope(2)))
    await assert.rejects(makeClient(impl, { maxResponseBytes: 64 }).allocateBatch(batchInput),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'response_too_large' && error.operation === 'allocateBatch')
})

test('单次 Allocate 保持一个分配包含多卡的原协议，不走 batch 路径', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(allocationEnvelope({
        quantity: 2, cards: [{ id: 'card_a', key: 'KEY-A' }, { id: 'card_b', key: 'KEY-B' }],
    })))
    const detail = await makeClient(impl).allocate({ ...batchInput, productId: 'local-only' })
    assert.equal(detail.quantity, 2)
    assert.equal(detail.cards.length, 2)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://lks.test/api/v1/allocations')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { program_key: 'bill-service', quantity: 2 })
})

test('FakeClient 批量行为独立计次、记录参数并原样返回或抛错，不调用单次 Allocate', async () => {
    const result = [makeAllocationDetail()]
    const failure = new Error('批量失败')
    const attempts: number[] = []
    const fake = createFakeLicenseServiceClient({ allocateBatch: async (input, attempt) => {
        assert.equal(input, batchInput)
        attempts.push(attempt)
        if (attempt === 2) throw failure
        return result
    } })
    assert.equal(await fake.allocateBatch(batchInput), result)
    await assert.rejects(fake.allocateBatch(batchInput), (error) => error === failure)
    assert.deepEqual(attempts, [1, 2])
    assert.equal(fake.callCount('allocateBatch'), 2)
    assert.equal(fake.callCount('allocate'), 0)
    assert.deepEqual(fake.callsOf('allocateBatch'), [batchInput, batchInput])
    const unstubbed = createFakeLicenseServiceClient()
    await assert.rejects(unstubbed.allocateBatch(batchInput), /allocateBatch is not stubbed/)
    assert.equal(unstubbed.callCount('allocateBatch'), 1)
})

test('本地参数缺陷就地失败：不发请求，也不会把注定被 400 的请求发出去', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(allocationEnvelope()))
    const client = makeClient(impl)

    const cases: Array<() => Promise<unknown>> = [
        () => client.allocate({ programKey: 'p', quantity: 0, idempotencyKey: 'restock:task-1:allocate' }),
        () => client.allocate({ programKey: 'p', quantity: 101, idempotencyKey: 'restock:task-1:allocate' }),
        () => client.allocate({ programKey: '  ', idempotencyKey: 'restock:task-1:allocate' }),
        () => client.allocate({ programKey: 'p', externalRef: 'x'.repeat(129), idempotencyKey: 'restock:task-1:allocate' }),
        // 幂等键字符集/长度由服务端中间件强制，本地必须同规则先拦。
        () => client.allocate({ programKey: 'p', idempotencyKey: 'short' }),
        () => client.ack({ allocationId: 'all_1', receivedCardIds: [], idempotencyKey: 'restock:task-1:ack' }),
        () => client.listAllocations({ limit: 0 }),
        () => client.listAllocations({ limit: 101 }),
    ]

    for (const run of cases) {
        await assert.rejects(run(), (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_request')
    }
    assert.equal(calls.length, 0)
})

test('契约错配（响应 program_key 与请求不一致）判 invalid_response，不把错配数据当成功', async () => {
    const { impl } = stubFetch(() => jsonResponse(allocationEnvelope({ program_key: 'someone-else' })))
    const client = makeClient(impl)

    await assert.rejects(
        client.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_response' && error.category === 'invalid',
    )
})

test('Ack / Sell / Cancel 的路径与请求体，卡序原样提交', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ ok: true, data: { allocation_id: 'all_1', status: 'acknowledged' } }))
    const client = makeClient(impl)

    await client.ack({
        allocationId: 'all_1',
        receivedCardIds: ['card_a', 'card_b'],
        externalRef: 'ldc-shop:restock:task-1',
        idempotencyKey: 'restock:task-1:ack',
    })
    assert.equal(calls[0].url, 'https://lks.test/api/v1/allocations/all_1/ack')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        received_card_ids: ['card_a', 'card_b'],
        external_ref: 'ldc-shop:restock:task-1',
    })

    await client.sell({ allocationId: 'all_1', cardIds: ['card_a'], idempotencyKey: 'sell:all_1:order_1' })
    assert.equal(calls[1].url, 'https://lks.test/api/v1/allocations/all_1/sell')
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { card_ids: ['card_a'] })

    await client.cancel({
        allocationId: 'all_1',
        cardIds: ['card_a'],
        reason: 'local insert failed',
        idempotencyKey: 'restock:task-1:cancel',
    })
    assert.equal(calls[2].url, 'https://lks.test/api/v1/allocations/all_1/cancel')
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), { card_ids: ['card_a'], reason: 'local insert failed' })
    for (const call of calls) assert.equal(headerOf(call, 'Authorization'), 'Bearer cs_live_sales')
})

test('单查接口拒绝回明文：带 key 的响应直接判契约破坏', async () => {
    const { impl } = stubFetch(() => jsonResponse(allocationEnvelope()))
    const client = makeClient(impl)

    await assert.rejects(
        client.getAllocation('all_1'),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_response',
    )

    const withoutKey = stubFetch(() => jsonResponse(allocationEnvelope({
        cards: [{ id: 'card_1', masked_key: 'CS-****' }],
    })))
    const ok = await makeClient(withoutKey.impl).getAllocation('all_1')
    assert.equal(ok.cards[0].key, '')
    assert.equal(ok.cards[0].maskedKey, 'CS-****')
})

test('错误信封映射成带类别与 retryAfterMs 的 LicenseServiceError', async () => {
    const { impl } = stubFetch(() => jsonResponse({
        ok: false,
        error: { code: 'allocation_expired', message: 'allocation expired', retryable: false },
        request_id: 'req_01K',
    }, 409, { 'Retry-After': '3' }))
    const client = makeClient(impl)

    await assert.rejects(
        client.ack({ allocationId: 'all_1', receivedCardIds: ['card_1'], idempotencyKey: 'restock:task-1:ack' }),
        (error: unknown) => {
            assert.ok(isLicenseServiceError(error))
            assert.equal(error.code, 'allocation_expired')
            assert.equal(error.httpStatus, 409)
            assert.equal(error.category, 'expired')
            assert.equal(error.requestId, 'req_01K')
            assert.equal(error.retryAfterMs, 3_000)
            assert.equal(error.retryable, false)
            assert.equal(error.operation, 'ack')
            // 日志上下文不含卡密与凭据。
            assert.equal(JSON.stringify(error.toLogContext()).includes('Bearer'), false)
            return true
        },
    )
})

test('无信封的错误响应按状态码兜底，5xx 归入可重试类别', async () => {
    const { impl } = stubFetch(() => new Response('gateway blew up', { status: 503 }))
    const client = makeClient(impl)

    await assert.rejects(
        client.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => {
            assert.ok(isLicenseServiceError(error))
            assert.equal(error.code, 'temporarily_unavailable')
            assert.equal(error.category, 'unavailable')
            return true
        },
    )
})

test('HTTP 200 但信封不是 ok:true 属于确定性契约破坏，不可重试', async () => {
    const { impl } = stubFetch(() => jsonResponse({ result: 'something else' }))
    const client = makeClient(impl)

    await assert.rejects(
        client.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'invalid_response' && error.category === 'invalid',
    )
})

test('Revoke 只需共用 API Key，保留路径、幂等键与作废请求体', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ ok: true, data: { id: 'card_1', status: 'revoked' } }))
    const client = makeClient(impl)

    const revoked = await client.revoke('card_1', { reason: 'refunded', idempotencyKey: 'revoke:card_1:order_1' })
    assert.equal(revoked.status, 'revoked')
    assert.equal(calls[0].url, 'https://lks.test/api/v1/cards/card_1/revoke')
    assert.equal(headerOf(calls[0], 'Authorization'), 'Bearer cs_live_sales')
    assert.equal(headerOf(calls[0], 'Idempotency-Key'), 'revoke:card_1:order_1')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { reason: 'refunded' })
})

test('列表接口只把有值的查询参数拼进 URL', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({
        ok: true,
        data: { items: [], next_cursor: null, has_more: false },
    }))
    const client = makeClient(impl)

    await client.listAllocations({ externalRef: 'ldc-shop:restock:t1', limit: 50 })
    assert.equal(
        calls[0].url,
        'https://lks.test/api/v1/allocations?external_ref=ldc-shop%3Arestock%3At1&limit=50',
    )
})

test('响应体超过上限立即失败：不把超大响应拖进内存', async () => {
    const { impl } = stubFetch(() => jsonResponse({ ok: true, data: { blob: 'x'.repeat(500) } }))
    const client = makeClient(impl, { maxResponseBytes: 64 })

    await assert.rejects(
        client.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'response_too_large',
    )
})

test('超时与网络失败分别折算成 timeout / network_error，两者都可重试', async () => {
    const hanging = (async (_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => reject(signal.reason))
    })) as unknown as typeof fetch
    const timeoutClient = makeClient(hanging, { timeoutMs: 5 })
    await assert.rejects(
        timeoutClient.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'timeout' && error.category === 'unavailable',
    )

    const failing = (async () => {
        throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const networkClient = makeClient(failing)
    await assert.rejects(
        networkClient.allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'network_error' && error.retryable === true,
    )
})

test('只有幂等冲突才计算请求指纹，普通错误和成功都不计算', async () => {
    const original = crypto.subtle.digest.bind(crypto.subtle)
    let digests = 0
    crypto.subtle.digest = (async (...args: Parameters<SubtleCrypto['digest']>) => {
        digests += 1
        return original(...args)
    }) as SubtleCrypto['digest']
    try {
        const success = stubFetch(() => jsonResponse(allocationEnvelope()))
        await makeClient(success.impl).allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' })
        assert.equal(digests, 0)

        const ordinary = stubFetch(() => jsonResponse({ ok: false, error: { code: 'rate_limited', message: 'slow down', retryable: true } }, 429))
        await assert.rejects(
            makeClient(ordinary.impl).allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
            (error: unknown) => isLicenseServiceError(error) && error.code === 'rate_limited' && error.bodyFingerprint === null,
        )
        assert.equal(digests, 0)

        const conflict = stubFetch(() => jsonResponse({ ok: false, error: { code: 'idempotency_conflict', message: 'different body', retryable: false } }, 409))
        await assert.rejects(
            makeClient(conflict.impl).allocate({ programKey: 'bill-service', quantity: 1, idempotencyKey: 'restock:task-1:allocate' }),
            (error: unknown) => isLicenseServiceError(error) && error.code === 'idempotency_conflict' && error.bodyFingerprint?.length === 16,
        )
        const reversed = stubFetch(() => jsonResponse({ ok: false, error: { code: 'idempotency_conflict', message: 'different body', retryable: false } }, 409))
        await assert.rejects(
            makeClient(reversed.impl).allocate({ quantity: 1, programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
            (error: unknown) => isLicenseServiceError(error) && error.bodyFingerprint?.length === 16,
        )
        assert.equal(digests, 2)
    } finally {
        crypto.subtle.digest = original
    }
})

test('指纹计算失败时保留原来的幂等冲突，不改成计算错误', async () => {
    const original = crypto.subtle.digest.bind(crypto.subtle)
    crypto.subtle.digest = (async () => {
        throw new Error('digest unavailable')
    }) as SubtleCrypto['digest']
    try {
        const conflict = stubFetch(() => jsonResponse({ ok: false, error: { code: 'idempotency_conflict', message: 'different body', retryable: false } }, 409))
        await assert.rejects(
            makeClient(conflict.impl).allocate({ programKey: 'bill-service', idempotencyKey: 'restock:task-1:allocate' }),
            (error: unknown) => isLicenseServiceError(error) && error.code === 'idempotency_conflict' && error.bodyFingerprint === null,
        )
    } finally {
        crypto.subtle.digest = original
    }
})

test('构造期就拒绝不可用配置：非 HTTPS Base URL 与空 Key 直接抛 config_error', () => {
    const { impl } = stubFetch(() => jsonResponse({ ok: true }))
    assert.throws(
        () => makeClient(impl, { baseUrl: 'http://lks.test' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'config_error',
    )
    assert.throws(
        () => makeClient(impl, { apiKey: '   ' }),
        (error: unknown) => isLicenseServiceError(error) && error.code === 'config_error',
    )
})
