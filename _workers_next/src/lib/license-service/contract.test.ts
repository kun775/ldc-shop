import test from 'node:test'
import assert from 'node:assert/strict'

import {
    extractErrorRequestId,
    fallbackErrorCodeForStatus,
    parseAllocationBatch,
    parseAllocationDetail,
    parseAllocationListPage,
    parseAllocationStatusUpdate,
    parseCardStatus,
    parseContractTimestamp,
    parseErrorEnvelope,
    parseRetryAfterMs,
    parseRevokeResult,
    unwrapSuccessEnvelope,
} from './contract.ts'

/** 构造一份与中心响应同形的分配详情信封。 */
function rawAllocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const quantity = (overrides.quantity as number | undefined) ?? 1
    const cards = (overrides.cards as unknown[] | undefined) ?? Array.from({ length: quantity }, (_, index) => ({
        id: `card_${index + 1}`,
        key: `CS-7K2M-9XPT-4WQH-8CDE-${index + 1}`,
        masked_key: `CS-7K2M-****-****-${index + 1}`,
    }))

    return {
        ok: true,
        data: {
            allocation_id: 'all_1',
            program_id: 'prog_1',
            program_key: 'bill-service',
            external_ref: 'ldc-shop:restock:task-1',
            status: 'allocated',
            quantity,
            cards,
            expires_at: '2026-09-22T08:30:00.123456789Z',
            created_at: '2026-09-22T08:00:00Z',
            acknowledged_at: null,
            ...overrides,
        },
    }
}

function rawBatch(quantity = 2, externalRef = '批量父引用') {
    return {
        ok: true,
        data: { allocations: Array.from({ length: quantity }, (_, index) => rawAllocation({
            allocation_id: `all_${index + 1}`,
            external_ref: externalRef ? `${externalRef}:${index + 1}` : '',
            cards: [{ id: `card_${index + 1}`, key: `KEY-${index + 1}` }],
        }).data as Record<string, unknown>) },
    }
}

const batchExpectation = { programKey: 'bill-service', quantity: 2, externalRef: '批量父引用' }

test('批量分配解析独立单卡分配，保持顺序、子引用和明文；空父引用不添加序号', () => {
    const parsed = parseAllocationBatch(rawBatch(), batchExpectation)
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.map((a) => [a.allocationId, a.quantity, a.externalRef, a.cards[0].id, a.cards[0].key]), [
        ['all_1', 1, '批量父引用:1', 'card_1', 'KEY-1'],
        ['all_2', 1, '批量父引用:2', 'card_2', 'KEY-2'],
    ])
    assert.ok(parseAllocationBatch(rawBatch(2, ''), { ...batchExpectation, externalRef: '' }).ok)
})

test('批量响应必须使用标准成功信封和 allocations 数组且长度匹配请求', () => {
    for (const [payload, reason] of [
        [null, 'not_object'],
        [{ ok: false, data: {} }, 'not_ok_envelope'],
        [{ ok: true }, 'missing_data'],
        [{ ok: true, data: null }, 'invalid_data'],
        [{ ok: true, data: [] }, 'invalid_data'],
        [rawAllocation(), 'invalid_allocations'],
        [{ ok: true, data: { allocations: {} } }, 'invalid_allocations'],
        [rawBatch(0), 'allocation_count_mismatch'],
        [rawBatch(1), 'allocation_count_mismatch'],
        [rawBatch(3), 'allocation_count_mismatch'],
    ] as const) {
        assert.deepEqual(parseAllocationBatch(payload, batchExpectation), { ok: false, reason })
    }
    const invalid = rawBatch()
    invalid.data.allocations[1] = null as unknown as Record<string, unknown>
    assert.deepEqual(parseAllocationBatch(invalid, batchExpectation), { ok: false, reason: 'invalid_allocation' })
})

const invalidBatchItems: Array<[Record<string, unknown>, string]> = [
    [{ quantity: 1.9 }, 'invalid_quantity'],
    [{ quantity: '1' }, 'invalid_quantity'],
    [{ quantity: 2 }, 'invalid_quantity'],
    [{ status: 'acknowledged' }, 'invalid_allocation_status'],
    [{ status: 'sold' }, 'invalid_allocation_status'],
    [{ program_key: 'other-program' }, 'program_key_mismatch'],
    [{ allocation_id: '' }, 'empty_allocation_id'],
    [{ allocation_id: 'all_1' }, 'duplicate_allocation_id'],
    [{ cards: [{ id: 'card_1', key: 'OTHER-KEY' }] }, 'duplicate_card_id'],
    [{ cards: [{ id: 'card_2' }] }, 'missing_card_key'],
    [{ cards: [{ id: 'card_2', key: '  ' }] }, 'missing_card_key'],
    [{ cards: [] }, 'quantity_mismatch'],
    [{ cards: [{ id: 'card_2', key: 'K2' }, { id: 'card_3', key: 'K3' }] }, 'quantity_mismatch'],
    [{ external_ref: '批量父引用:1' }, 'external_ref_mismatch'],
    [{ external_ref: '批量父引用' }, 'external_ref_mismatch'],
    [{ external_ref: undefined }, 'external_ref_mismatch'],
    [{ external_ref: null }, 'external_ref_mismatch'],
    [{ created_at: 'invalid' }, 'invalid_created_at'],
    [{ expires_at: null }, 'invalid_expires_at'],
    [{ expires_at: 'invalid' }, 'invalid_expires_at'],
    [{ created_at: '0001-01-01T00:00:00Z' }, 'invalid_allocation_time'],
    [{ expires_at: '2026-09-22T08:00:00Z' }, 'invalid_allocation_time'],
    [{ expires_at: '2026-09-21T08:00:00Z' }, 'invalid_allocation_time'],
]

for (const [overrides, reason] of invalidBatchItems) {
    test(`批量响应整批拒绝异常项：${reason} ${Object.keys(overrides).join(',')}`, () => {
        const payload = rawBatch()
        Object.assign(payload.data.allocations[1], overrides)
        assert.deepEqual(parseAllocationBatch(payload, batchExpectation), { ok: false, reason })
    })
}

test('批量子引用不做 trim，空父引用必须精确返回空字符串', () => {
    assert.ok(parseAllocationBatch(rawBatch(2, '  '), { ...batchExpectation, externalRef: '  ' }).ok)
    const payload = rawBatch(2, '')
    payload.data.allocations[1].external_ref = ' '
    assert.deepEqual(parseAllocationBatch(payload, { ...batchExpectation, externalRef: '' }), { ok: false, reason: 'external_ref_mismatch' })
})

test('成功信封必须 ok===true 且有 data：代理错误页不会被当成功响应', () => {
    assert.deepEqual(unwrapSuccessEnvelope(null), { ok: false, reason: 'not_object' })
    assert.deepEqual(unwrapSuccessEnvelope([]), { ok: false, reason: 'not_object' })
    assert.deepEqual(unwrapSuccessEnvelope({ ok: true }), { ok: false, reason: 'missing_data' })
    assert.deepEqual(unwrapSuccessEnvelope({ ok: 'true', data: {} }), { ok: false, reason: 'not_ok_envelope' })
    assert.deepEqual(unwrapSuccessEnvelope({ data: {} }), { ok: false, reason: 'not_ok_envelope' })
    assert.deepEqual(unwrapSuccessEnvelope({ ok: true, data: { a: 1 } }), { ok: true, value: { a: 1 } })
})

test('时间戳裁剪 RFC3339 纳秒到毫秒，避免 Date.parse 在部分实现上返回 NaN', () => {
    assert.equal(parseContractTimestamp('2026-09-22T08:30:00.123456789Z'), Date.parse('2026-09-22T08:30:00.123Z'))
    assert.equal(parseContractTimestamp('2026-09-22T08:30:00.123456789+08:00'), Date.parse('2026-09-22T08:30:00.123+08:00'))
    // 无小数位、已到毫秒精度的一律原样解析。
    assert.equal(parseContractTimestamp('2026-09-22T08:30:00Z'), Date.parse('2026-09-22T08:30:00Z'))
    assert.equal(parseContractTimestamp('2026-09-22T08:30:00.123Z'), Date.parse('2026-09-22T08:30:00.123Z'))
    // 数值直接当毫秒时间戳（中心只回字符串，这里保证不回退成 NaN）。
    assert.equal(parseContractTimestamp(1_700_000_000_000), 1_700_000_000_000)
    assert.equal(parseContractTimestamp(undefined), null)
    assert.equal(parseContractTimestamp(''), null)
    assert.equal(parseContractTimestamp(null), null)
    assert.equal(parseContractTimestamp('not-a-timestamp'), null)
})

test('分配详情：合法响应解析出完整结构，含纳秒裁剪后的 expires_at', () => {
    const parsed = parseAllocationDetail(rawAllocation({ quantity: 2 }))
    assert.ok(parsed.ok)
    assert.equal(parsed.value.allocationId, 'all_1')
    assert.equal(parsed.value.programKey, 'bill-service')
    assert.equal(parsed.value.quantity, 2)
    assert.equal(parsed.value.cards.length, 2)
    assert.equal(parsed.value.cards[0].key, 'CS-7K2M-9XPT-4WQH-8CDE-1')
    assert.equal(parsed.value.cards[0].maskedKey, 'CS-7K2M-****-****-1')
    assert.equal(parsed.value.expiresAtMs, Date.parse('2026-09-22T08:30:00.123Z'))
    assert.equal(parsed.value.acknowledgedAtMs, null)
})

test('单查响应带明文 key 必须判失败：明文只允许出现在 Allocate 响应里', () => {
    const withKeys = parseAllocationDetail(rawAllocation(), { requireCardKeys: false })
    assert.deepEqual(withKeys, { ok: false, reason: 'unexpected_card_key' })

    const withoutKeys = parseAllocationDetail(
        rawAllocation({ cards: [{ id: 'card_1', masked_key: 'CS-****' }] }),
        { requireCardKeys: false },
    )
    assert.ok(withoutKeys.ok)
    assert.equal(withoutKeys.value.cards[0].key, '')
    assert.equal(withoutKeys.value.cards[0].maskedKey, 'CS-****')
})

test('Allocate 响应缺明文 key 必须判失败：没有 key 就无法入库可售', () => {
    const parsed = parseAllocationDetail(rawAllocation({ cards: [{ id: 'card_1' }] }))
    assert.deepEqual(parsed, { ok: false, reason: 'missing_card_key' })
})

test('卡集与数量不一致、卡 ID 重复、字段缺失都判失败', () => {
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({ quantity: 2, cards: [{ id: 'card_1', key: 'K1' }] })),
        { ok: false, reason: 'quantity_mismatch' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({
            quantity: 2,
            cards: [{ id: 'card_dup', key: 'K1' }, { id: 'card_dup', key: 'K2' }],
        })),
        { ok: false, reason: 'duplicate_card_id' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({ cards: [{ id: '', key: 'K1' }] })),
        { ok: false, reason: 'invalid_card_id' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({ quantity: 0, cards: [] })),
        { ok: false, reason: 'invalid_quantity' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({ status: '  ' })),
        { ok: false, reason: 'empty_status' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation({ expires_at: null })),
        { ok: false, reason: 'invalid_expires_at' },
    )
})

test('请求与响应错配（program_key / quantity）直接判失败，宁可拒绝也不入库', () => {
    assert.deepEqual(
        parseAllocationDetail(rawAllocation(), { requireCardKeys: true, expectation: { programKey: 'other-program' } }),
        { ok: false, reason: 'program_key_mismatch' },
    )
    assert.deepEqual(
        parseAllocationDetail(rawAllocation(), { requireCardKeys: true, expectation: { quantity: 3 } }),
        { ok: false, reason: 'quantity_mismatch' },
    )
    const matched = parseAllocationDetail(rawAllocation(), {
        requireCardKeys: true,
        expectation: { programKey: 'bill-service', quantity: 1 },
    })
    assert.ok(matched.ok)
})

test('列表页只认 {card_id}，且 has_more 必须同时有游标才算真', () => {
    const page = parseAllocationListPage({
        ok: true,
        data: {
            items: [{
                allocation_id: 'all_1',
                program_id: 'prog_1',
                status: 'acknowledged',
                external_ref: 'ldc-shop:restock:task-1',
                cards: [{ card_id: 'card_1' }, { card_id: 'card_2' }, { unrelated: true }],
                allocated_at: '2026-09-22T08:00:00.5Z',
                acknowledged_at: '2026-09-22T08:01:00Z',
            }],
            next_cursor: 'cur_2',
            has_more: true,
        },
    })
    assert.ok(page.ok)
    assert.equal(page.value.hasMore, true)
    assert.equal(page.value.nextCursor, 'cur_2')
    assert.deepEqual(page.value.items[0].cardIds, ['card_1', 'card_2'])
    assert.equal(page.value.items[0].allocatedAtMs, Date.parse('2026-09-22T08:00:00.500Z'))

    const bogus = parseAllocationListPage({ ok: true, data: { items: [], next_cursor: null, has_more: true } })
    assert.ok(bogus.ok)
    assert.equal(bogus.value.hasMore, false)

    assert.deepEqual(parseAllocationListPage({ ok: true, data: { items: {} } }), { ok: false, reason: 'invalid_items' })
})

test('卡状态与状态回执：缺主键即失败，用量字段可为空', () => {
    const status = parseCardStatus({
        ok: true,
        data: {
            id: 'card_1',
            program_id: 'prog_1',
            masked_key: 'CS-****',
            status: 'available',
            allocation_status: 'acknowledged',
            usage_limit: 1,
            usage_held: 1.9,
            usage_committed: 0,
            remaining: 0,
            created_at: '2026-09-22T08:00:00Z',
        },
    })
    assert.ok(status.ok)
    assert.equal(status.value.usageHeld, 1)
    assert.equal(status.value.cardId, 'card_1')

    assert.deepEqual(parseCardStatus({ ok: true, data: { status: 'available' } }), { ok: false, reason: 'invalid_id' })

    const update = parseAllocationStatusUpdate({ ok: true, data: { allocation_id: 'all_1', status: 'acknowledged' } })
    assert.deepEqual(update, { ok: true, value: { allocationId: 'all_1', status: 'acknowledged' } })
    assert.deepEqual(
        parseAllocationStatusUpdate({ ok: true, data: { allocation_id: 'all_1' } }),
        { ok: false, reason: 'invalid_status' },
    )

    const revoked = parseRevokeResult({ ok: true, data: { id: 'card_1', status: 'revoked' } })
    assert.deepEqual(revoked, { ok: true, value: { cardId: 'card_1', status: 'revoked' } })
    assert.deepEqual(parseRevokeResult({ ok: true, data: { status: 'revoked' } }), { ok: false, reason: 'missing_id' })
})

test('错误信封只取 code/message/retryable 三键，request_id 在顶层', () => {
    const fields = parseErrorEnvelope({
        ok: false,
        error: { code: 'allocation_expired', message: 'allocation expired', retryable: false, detail: 'ignored' },
        request_id: 'req_01K',
    })
    assert.deepEqual(fields, { code: 'allocation_expired', message: 'allocation expired', retryable: false })

    assert.deepEqual(parseErrorEnvelope({ ok: false }), { code: null, message: null, retryable: null })
    assert.deepEqual(parseErrorEnvelope('boom'), { code: null, message: null, retryable: null })
    assert.deepEqual(
        parseErrorEnvelope({ error: { code: 'x', message: '', retryable: 'yes' } }),
        { code: 'x', message: null, retryable: null },
    )

    assert.equal(extractErrorRequestId({ request_id: 'req_01K' }, 'req_header'), 'req_01K')
    assert.equal(extractErrorRequestId({ ok: false }, 'req_header'), 'req_header')
    assert.equal(extractErrorRequestId(null, null), null)
})

test('无信封时按状态码兜底错误码，未知状态归 invalid_response', () => {
    assert.equal(fallbackErrorCodeForStatus(409), 'allocation_conflict')
    assert.equal(fallbackErrorCodeForStatus(404), 'not_found')
    assert.equal(fallbackErrorCodeForStatus(429), 'rate_limited')
    assert.equal(fallbackErrorCodeForStatus(418), 'invalid_response')
})

test('Retry-After 支持秒数与 HTTP-date，过期与非法一律不当成等待信号', () => {
    assert.equal(parseRetryAfterMs('5', 0), 5_000)
    assert.equal(parseRetryAfterMs('0', 0), 0)
    assert.equal(parseRetryAfterMs(' 30 ', 0), 30_000)
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 0), 10_000)
    // 已经过去的时间点归零，绝不返回负数（否则退避计算会变成提前重试）。
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:01 GMT', 5_000), 0)
    assert.equal(parseRetryAfterMs(null, 0), null)
    assert.equal(parseRetryAfterMs('', 0), null)
    assert.equal(parseRetryAfterMs('soon', 0), null)
})
