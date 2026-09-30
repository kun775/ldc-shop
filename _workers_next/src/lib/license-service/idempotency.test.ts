import test from 'node:test'
import assert from 'node:assert/strict'

import {
    buildAckIdempotencyKey,
    buildAllocateIdempotencyKey,
    buildCancelIdempotencyKey,
    buildRestockExternalRef,
    buildRestockTaskId,
    buildRevokeIdempotencyKey,
    buildSellIdempotencyKey,
    canonicalizeJsonBody,
    fingerprintIdempotentRequest,
    IDEMPOTENCY_KEY_PATTERN,
    isValidIdempotencyKey,
    LICENSE_SERVICE_EXTERNAL_REF_MAX_LENGTH,
    RESTOCK_EXTERNAL_REF_PREFIX,
    sanitizeIdempotencyKeySegment,
} from './idempotency.ts'

test('字符集清洗：非法字符折叠为单个 -，并去掉首尾的 - 与 .', () => {
    assert.equal(sanitizeIdempotencyKeySegment('ord_01H 2'), 'ord_01H-2')
    assert.equal(sanitizeIdempotencyKeySegment('a  $$  b'), 'a-b')
    assert.equal(sanitizeIdempotencyKeySegment('--a--'), 'a')
    assert.equal(sanitizeIdempotencyKeySegment('..a..'), 'a')
    assert.equal(sanitizeIdempotencyKeySegment('订单 123/abc'), '123/abc')
    assert.equal(sanitizeIdempotencyKeySegment(''), '')
    assert.equal(sanitizeIdempotencyKeySegment(null), '')
    assert.equal(sanitizeIdempotencyKeySegment(undefined), '')
    assert.equal(sanitizeIdempotencyKeySegment(123), '123')
    // `/` 与 `:` 是服务端白名单字符，必须原样保留（路径式键依赖它们）。
    assert.equal(sanitizeIdempotencyKeySegment('a/b:c.d_e-f'), 'a/b:c.d_e-f')
})

test('幂等键长度下限 8：短键会被服务端 400 拒绝，必须在本地就拦住', () => {
    assert.equal(isValidIdempotencyKey('abc'), false)
    assert.equal(isValidIdempotencyKey('1234567'), false)
    assert.equal(isValidIdempotencyKey('12345678'), true)
    assert.equal(isValidIdempotencyKey('has space'), false)
    assert.equal(isValidIdempotencyKey('has+plus'), false)
    assert.equal(isValidIdempotencyKey(null), false)
    assert.equal(IDEMPOTENCY_KEY_PATTERN.test('restock:0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d:allocate'), true)
})

test('任务 ID 用随机值：可推导的串会让并发触发复用同一个 external_ref', () => {
    const randomUUID = () => '0F1E2D3C-4B5A-6978-8C9D-0E1F2A3B4C5D'
    const taskId = buildRestockTaskId(randomUUID)
    assert.equal(taskId, '0F1E2D3C-4B5A-6978-8C9D-0E1F2A3B4C5D')
    assert.notEqual(buildRestockTaskId(), buildRestockTaskId())

    const ref = buildRestockExternalRef(taskId)
    assert.equal(ref, `${RESTOCK_EXTERNAL_REF_PREFIX}${taskId}`)
    assert.ok(ref.length <= LICENSE_SERVICE_EXTERNAL_REF_MAX_LENGTH)
})

test('external_ref 超长会被截断在服务端上限内（截断后仍是合法字符集）', () => {
    const ref = buildRestockExternalRef('x'.repeat(400))
    assert.equal(ref.length, LICENSE_SERVICE_EXTERNAL_REF_MAX_LENGTH)
})

test('各操作的幂等键都在字符集与长度约束内，且互不相同', () => {
    const taskId = '0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d'
    const keys = [
        buildAllocateIdempotencyKey(taskId),
        buildAckIdempotencyKey(taskId),
        buildCancelIdempotencyKey(taskId),
        buildSellIdempotencyKey('all_1', 'order_1'),
        buildRevokeIdempotencyKey('card_1', 'order_1'),
    ]

    for (const key of keys) {
        assert.equal(isValidIdempotencyKey(key), true, key)
        assert.ok(key.length <= 255, key)
    }
    assert.equal(new Set(keys).size, keys.length)
})

test('Sell / Revoke 的键按「资源 + 订单」固定，同一订单重放不会重复售出或重复作废', () => {
    assert.equal(buildSellIdempotencyKey('all_1', 'order_1'), buildSellIdempotencyKey('all_1', 'order_1'))
    assert.notEqual(buildSellIdempotencyKey('all_1', 'order_1'), buildSellIdempotencyKey('all_1', 'order_2'))
    assert.notEqual(buildSellIdempotencyKey('all_1', 'order_1'), buildSellIdempotencyKey('all_2', 'order_1'))
    assert.equal(buildRevokeIdempotencyKey('card_1', 'order_1'), buildRevokeIdempotencyKey('card_1', 'order_1'))
    assert.notEqual(buildRevokeIdempotencyKey('card_1', 'order_1'), buildRevokeIdempotencyKey('card_2', 'order_1'))
})

test('规范化请求体：对象键排序、丢弃 undefined、保留数组顺序', () => {
    assert.equal(canonicalizeJsonBody({ b: 1, a: 2 }), '{"a":2,"b":1}')
    assert.equal(canonicalizeJsonBody({ a: 2, b: 1 }), '{"a":2,"b":1}')
    assert.equal(canonicalizeJsonBody({ a: undefined, b: 1 }), '{"b":1}')
    assert.equal(canonicalizeJsonBody({ a: null }), '{"a":null}')
    assert.equal(canonicalizeJsonBody([2, 1]), '[2,1]')
    assert.equal(canonicalizeJsonBody({ a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}]}')
    assert.equal(canonicalizeJsonBody('plain'), '"plain"')
    assert.equal(canonicalizeJsonBody(undefined), 'null')
})

test('数组顺序必须保留：顺序不同就是不同请求体（同键重放不能改顺序）', () => {
    const ascending = canonicalizeJsonBody({ received_card_ids: ['card_1', 'card_2'] })
    const descending = canonicalizeJsonBody({ received_card_ids: ['card_2', 'card_1'] })
    assert.notEqual(ascending, descending)
    // 数组内的对象仍然要规范化，否则内容相同、字面不同的重放会被判成冲突。
    assert.equal(
        canonicalizeJsonBody({ received_card_ids: ['b', 'a'] }),
        canonicalizeJsonBody({ received_card_ids: ['b', 'a'] }),
    )
})

test('请求体指纹：键序无关、数组序有关、固定 16 位十六进制且不含卡密', async () => {
    const first = await fingerprintIdempotentRequest({ quantity: 1, program_key: 'bill-service' })
    const reordered = await fingerprintIdempotentRequest({ program_key: 'bill-service', quantity: 1 })
    assert.equal(first, reordered)
    assert.match(first, /^[0-9a-f]{16}$/)

    const ordered = await fingerprintIdempotentRequest({ received_card_ids: ['a', 'b'] })
    const reversed = await fingerprintIdempotentRequest({ received_card_ids: ['b', 'a'] })
    assert.notEqual(ordered, reversed)

    const secret = 'CS-7K2M-9XPT-4WQH-8CDE-1'
    const fingerprint = await fingerprintIdempotentRequest({ card_key: secret })
    assert.equal(fingerprint.includes(secret), false)
})
