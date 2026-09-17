import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./schema-errors.ts', import.meta.url).href)
const { isMissingRelationError, isMissingColumnError, isMissingSchemaError } = mod

test('detects missing table and view errors', () => {
    assert.equal(isMissingRelationError(new Error('no such table: coupons')), true)
    assert.equal(isMissingRelationError(new Error('no such view: coupon_stats')), true)
    assert.equal(isMissingRelationError(new Error('D1_ERROR: d1_relation_notfound')), true)
    assert.equal(isMissingRelationError(new Error('relation "coupons" does not exist')), true)
    assert.equal(isMissingRelationError(new Error('table coupons does not exist')), true)
})

test('detects missing column errors', () => {
    assert.equal(isMissingColumnError(new Error('no such column: rate_bps')), true)
    assert.equal(isMissingColumnError(new Error('column not found: discount_amount_cents')), true)
    assert.equal(isMissingColumnError(new Error('D1_ERROR: d1_column_notfound')), true)
})

test('does not treat transient errors as schema errors', () => {
    const transient = [
        new Error('Network connection lost'),
        new Error('D1_ERROR: database is locked'),
        new Error('Too many requests, please retry'),
        new Error('The operation timed out'),
        new Error('fetch failed'),
        new Error('syntax error near FROM'),
    ]
    for (const error of transient) {
        assert.equal(isMissingSchemaError(error), false, `should not be schema error: ${error.message}`)
    }
})

test('bare does-not-exist without a relation or column noun is not a schema error', () => {
    assert.equal(isMissingSchemaError(new Error('The requested resource does not exist')), false)
    assert.equal(isMissingRelationError(new Error('user does not exist')), false)
    assert.equal(isMissingColumnError(new Error('value does not exist')), false)
})

test('unwraps nested causes', () => {
    const wrapped = new Error('Query failed', {
        cause: new Error('no such table: coupon_usages'),
    })
    assert.equal(isMissingSchemaError(wrapped), true)
})

test('handles non-error values without throwing', () => {
    assert.equal(isMissingSchemaError(null), false)
    assert.equal(isMissingSchemaError(undefined), false)
    assert.equal(isMissingSchemaError('no such table: x'), true)
    assert.equal(isMissingSchemaError({ message: 'no such column: y' }), true)
})

test('schema error union covers relation and column cases', () => {
    assert.equal(isMissingSchemaError(new Error('no such table: a')), true)
    assert.equal(isMissingSchemaError(new Error('no such column: b')), true)
})
