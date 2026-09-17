import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./refund-policy.ts', import.meta.url).href)
const {
    resolveCouponRefundPolicy,
    selectReversibleCouponUsageIds,
} = mod

test('refund policy prefers the immutable usage snapshot', () => {
    assert.equal(
        resolveCouponRefundPolicy(JSON.stringify({ refundPolicy: 'never' }), 'always'),
        'never'
    )
    assert.equal(resolveCouponRefundPolicy('{broken', 'always'), 'always')
})

test('mixed coupon refund policies reverse only eligible usages', () => {
    const usages = [
        {
            usageId: 'usage_always',
            ruleSnapshot: JSON.stringify({ refundPolicy: 'always' }),
            refundPolicy: 'never',
        },
        {
            usageId: 'usage_never',
            ruleSnapshot: JSON.stringify({ refundPolicy: 'never' }),
            refundPolicy: 'always',
        },
        {
            usageId: 'usage_unfulfilled',
            ruleSnapshot: JSON.stringify({ refundPolicy: 'unfulfilled_full_refund' }),
            refundPolicy: 'always',
        },
    ]

    assert.deepEqual(
        selectReversibleCouponUsageIds(usages, true),
        ['usage_always']
    )
    assert.deepEqual(
        selectReversibleCouponUsageIds(usages, false),
        ['usage_always', 'usage_unfulfilled']
    )
})
