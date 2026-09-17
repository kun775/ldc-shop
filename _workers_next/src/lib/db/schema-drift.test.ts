import test from "node:test"
import assert from "node:assert/strict"

const mod = await import(new URL("./schema-drift.ts", import.meta.url).href)
const { SCHEMA_DRIFT_PROBES, isSchemaDriftError, shouldReRunIncrementalMigration } = mod

test("drift probes are read-only and never read rows", () => {
    assert.ok(SCHEMA_DRIFT_PROBES.length > 0)
    for (const probe of SCHEMA_DRIFT_PROBES) {
        const normalized = String(probe).trim().toLowerCase()
        assert.ok(normalized.startsWith('select'), `probe must be a SELECT: ${probe}`)
        assert.ok(normalized.endsWith('limit 0'), `probe must use LIMIT 0: ${probe}`)
        for (const forbidden of ['insert', 'update', 'delete', 'alter', 'drop', 'create']) {
            assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(normalized), `probe must not write: ${probe}`)
        }
    }
})

test("drift probes cover the objects that historically went missing", () => {
    const joined = SCHEMA_DRIFT_PROBES.join(' ').toLowerCase()
    for (const required of [
        'products',
        'orders',
        'cards',
        'login_users',
        'review_replies',
        'wishlist_items',
        'wishlist_votes',
        'coupons',
        'coupon_products',
        'coupon_usages',
        'coupon_user_counters',
        'subtotal_amount_cents',
        'fulfillment_claim_id',
        'manual_stock_count',
        'manual_stock_quantity',
        'nickname',
        'rule_snapshot',
        'refund_policy',
    ]) {
        assert.ok(joined.includes(required), `missing drift probe coverage: ${required}`)
    }
})

test("missing table/column errors are recognised as drift", () => {
    const samples = [
        'no such table: coupons',
        'no such column: claim_id',
        'D1_ERROR: no such column: subtotal_amount_cents',
        'SQLITE_ERROR: no such column: pricing_snapshot',
        'column not found',
        'd1_column_notfound',
        'relation "coupons" does not exist',
        'column "claim_id" does not exist',
        'table orders does not exist',
    ]
    for (const sample of samples) {
        assert.equal(isSchemaDriftError(sample), true, `should be drift: ${sample}`)
        assert.equal(isSchemaDriftError({ message: sample }), true, `should be drift (Error): ${sample}`)
    }
})

test("missing columns in nested D1 causes are recognised as drift", () => {
    const error = new Error('Failed query: SELECT nickname FROM login_users LIMIT 0')
    error.cause = new Error('D1_ERROR: no such column: nickname')

    assert.equal(isSchemaDriftError(error), true)
})

test("transient or unrelated errors must NOT be treated as drift", () => {
    const samples = [
        'Network connection lost',
        'fetch failed',
        'D1_ERROR: too many requests',
        'rate limit exceeded',
        'The operation was aborted due to timeout',
        'database is locked',
        'internal error',
        '',
    ]
    for (const sample of samples) {
        assert.equal(isSchemaDriftError(sample), false, `should NOT be drift: ${JSON.stringify(sample)}`)
    }
})

test("shouldReRunIncrementalMigration truth table", () => {
    // 版本落后 -> 必须迁移（无论探测结果）
    assert.equal(shouldReRunIncrementalMigration({ versionSatisfied: false, driftDetected: false }), true)
    assert.equal(shouldReRunIncrementalMigration({ versionSatisfied: false, driftDetected: true }), true)
    // 版本达标 + 结构漂移 -> 必须迁移（本次修复的核心）
    assert.equal(shouldReRunIncrementalMigration({ versionSatisfied: true, driftDetected: true }), true)
    // 版本达标 + 结构一致 -> 走快速路径
    assert.equal(shouldReRunIncrementalMigration({ versionSatisfied: true, driftDetected: false }), false)
})
