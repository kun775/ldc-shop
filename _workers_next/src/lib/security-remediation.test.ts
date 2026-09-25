import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('expired paid reservations use the shared fulfillment state machine', () => {
    const checkout = source('../actions/checkout.ts')
    const start = checkout.indexOf('// B. Fallback: Expired reservation')
    const end = checkout.indexOf('const joinedKeys', start)
    const recoveryBlock = checkout.slice(start, end)

    assert.match(recoveryBlock, /processOrderFulfillment\(candidateOrderId, paidAmount, tradeNo\)/)
    assert.match(recoveryBlock, /statusRes\.success && statusRes\.status === 0/)
    assert.doesNotMatch(recoveryBlock, /status:\s*['"]delivered['"]/)
})

test('refunds reject non-payable states and remove disclosed keys', () => {
    const refund = source('../actions/refund.ts')
    const orderPage = source('../app/order/[id]/page.tsx')

    assert.match(refund, /order\.status !== 'paid' && order\.status !== 'delivered'/)
    assert.match(refund, /card_key = NULL/)
    assert.match(refund, /runAtomicD1Batch\(refundStatements\)/)
    assert.match(orderPage, /order\.status === 'delivered' \? order\.cardKey : null/)
})

test('cancel cleanup attempts points, coupons, and cards independently', () => {
    const order = source('../actions/order.ts')
    const points = order.indexOf("runCleanupStep('points'")
    const coupons = order.indexOf("runCleanupStep('coupons'")
    const cards = order.indexOf("runCleanupStep('cards'")
    const errorCheck = order.indexOf('if (cleanupErrors.length > 0)')

    assert.ok(points > 0)
    assert.ok(coupons > points)
    assert.ok(cards > coupons)
    assert.ok(errorCheck > cards)
    assert.match(order, /order\.status !== 'pending' && order\.status !== 'cancelled'/)
})

test('schema metadata includes the point-ledger history upgrade', () => {
    const queries = source('./db/queries.ts')
    assert.match(queries, /CURRENT_SCHEMA_VERSION = 37/)
    assert.match(queries, /runAtomicD1Batch\(USER_POINT_LEDGER_REBUILD_STATEMENTS/)
})

test('github account migration failures abort the login migration', () => {
    const auth = source('./auth.ts')
    const start = auth.indexOf('async function migrateLegacyUserId')
    const end = auth.indexOf('\nif (githubClientId && githubClientSecret)', start)
    const migration = auth.slice(start, end)

    assert.match(migration, /legacy user id migration failed/)
    assert.match(migration, /throw error/)
})
