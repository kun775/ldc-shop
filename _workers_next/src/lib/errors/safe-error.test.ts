import test from "node:test"
import assert from "node:assert/strict"

const mod = await import(new URL("./safe-error.ts", import.meta.url).href)
const {
    isInternalErrorMessage,
    sanitizeClientErrorMessage,
    createErrorId,
    resolveClientActionErrorKey,
    resolveClientErrorKey,
} = mod

// 线上实际泄漏出来的原文（签到故障），必须被判为内部错误
const REAL_LEAK = 'Failed query: insert into "user_point_ledger" ("id", "user_id", "event_type", "delta", "balance_after", "business_key", "source_type", "source_id", "reason", "operator_user_id", "operator_username", "metadata", "status", "claim_id", "claimed_at", "created_at") values (null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning "id" params: 10785,checkin_reward,10,,checkin_reward:10785:1789603200000,checkin,2026-09-17,每日签到奖励,,,{"consecutiveDays":4},pending,8b7dfc0e-4b4c-4b65-8867-7f7f0812f85c,1789603754380,1789603754380'

test("real production leak string is detected as internal", () => {
    assert.equal(isInternalErrorMessage(REAL_LEAK), true)
})

test("common database error shapes are detected as internal", () => {
    const samples = [
        'no such column: claim_id',
        'no such table: user_point_ledger',
        'UNIQUE constraint failed: user_point_ledger.business_key',
        'FOREIGN KEY constraint failed',
        'duplicate column name: claim_id',
        'SQLITE_ERROR: near "select": syntax error',
        'D1_ERROR: too many SQL variables',
        'select * from "coupons" where "id" = ?',
        'update "orders" set "status" = ? where "order_id" = ?',
        'delete from "coupon_usages" where "order_id" = ?',
        'POINT_LEDGER_CLAIM_LOST',
    ]
    for (const sample of samples) {
        assert.equal(isInternalErrorMessage(sample), true, `should be internal: ${sample}`)
    }
})

test("safe business messages pass through", () => {
    const samples = [
        'Already checked in today',
        '优惠券已过期',
        'Product out of stock',
    ]
    for (const sample of samples) {
        assert.equal(isInternalErrorMessage(sample), false, `should be safe: ${sample}`)
    }
    assert.equal(sanitizeClientErrorMessage('Already checked in today', 'fallback'), 'Already checked in today')
})

test("sanitize replaces internal messages with the fallback", () => {
    assert.equal(sanitizeClientErrorMessage(REAL_LEAK, 'checkin.failed'), 'checkin.failed')
    assert.equal(sanitizeClientErrorMessage('no such column: claim_id', 'common.error'), 'common.error')
    assert.equal(sanitizeClientErrorMessage('', 'common.error'), 'common.error')
    assert.equal(sanitizeClientErrorMessage(null, 'common.error'), 'common.error')
    assert.equal(sanitizeClientErrorMessage(undefined, 'common.error'), 'common.error')
})

test("client action errors only expose stable i18n keys", () => {
    assert.equal(
        resolveClientActionErrorKey(new Error('admin.orders.deliveryContentRequired')),
        'admin.orders.deliveryContentRequired'
    )
    assert.equal(
        resolveClientActionErrorKey(new Error('Minified React error #441; visit https://react.dev/errors/441')),
        'common.error'
    )
    assert.equal(
        resolveClientActionErrorKey(new Error('D1_ERROR: no such column: nickname')),
        'common.error'
    )
})

test("over-long messages are treated as internal", () => {
    assert.equal(isInternalErrorMessage('x'.repeat(400)), true)
})

test("resolveClientErrorKey only exposes mapped business codes", () => {
    const mapping = {
        POINT_LEDGER_EVENT_IN_PROGRESS: 'checkin.inProgress',
        POINT_BALANCE_NEGATIVE: 'checkin.balanceNegative',
    }
    const asError = (message: string) => ({ message })

    assert.equal(
        resolveClientErrorKey(asError('POINT_LEDGER_EVENT_IN_PROGRESS'), mapping, 'checkin.failed'),
        'checkin.inProgress'
    )
    assert.equal(
        resolveClientErrorKey(asError('POINT_BALANCE_NEGATIVE'), mapping, 'checkin.failed'),
        'checkin.balanceNegative'
    )
    // 未映射的错误码与 SQL 原文都必须退化为兜底 key
    assert.equal(resolveClientErrorKey(asError(REAL_LEAK), mapping, 'checkin.failed'), 'checkin.failed')
    assert.equal(resolveClientErrorKey(asError('POINT_LEDGER_CLAIM_LOST'), mapping, 'checkin.failed'), 'checkin.failed')
    assert.equal(resolveClientErrorKey(new Error('weird'), mapping, 'checkin.failed'), 'checkin.failed')
})

test("resolveClientErrorKey reads mapped codes from nested database causes", () => {
    const mapping = {
        POINT_BALANCE_NEGATIVE: 'admin.users.adjustNegativeNotAllowed',
    }
    const error = Object.assign(new Error('Failed query: update login_users'), {
        cause: Object.assign(new Error('D1_ERROR: POINT_BALANCE_NEGATIVE'), {
            cause: { code: 'SQLITE_CONSTRAINT_TRIGGER' },
        }),
    })

    assert.equal(
        resolveClientErrorKey(error, mapping, 'common.error'),
        'admin.users.adjustNegativeNotAllowed'
    )
    assert.equal(
        resolveClientErrorKey({ cause: new Error('POINT_BALANCE_NEGATIVE_EXTRA') }, mapping, 'common.error'),
        'common.error'
    )
})

test("createErrorId produces distinct readable ids", () => {
    const first = createErrorId()
    const second = createErrorId()
    assert.equal(typeof first, 'string')
    assert.ok(first.length > 6)
    assert.notEqual(first, second)
})
