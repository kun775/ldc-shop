import test from 'node:test'
import assert from 'node:assert/strict'
import { toCouponFormInitial } from './form-initial.ts'
import type { CouponRecord } from './types.ts'

function coupon(overrides: Partial<CouponRecord> = {}): CouponRecord {
    return {
        id: 'coupon-1',
        code: 'SAVE20',
        name: 'Save 20',
        description: null,
        discountType: 'threshold_fixed',
        rateBps: null,
        discountAmountCents: 2000,
        minSpendCents: 10000,
        maxDiscountCents: null,
        scope: 'selected',
        productIds: ['product-1'],
        totalUseLimit: 100,
        perUserLimit: 2,
        reservedCount: 0,
        consumedCount: 0,
        stackableWithCoupons: false,
        stackableWithPoints: true,
        refundPolicy: 'unfulfilled_full_refund',
        status: 'active',
        startsAt: null,
        endsAt: null,
        createdBy: 'admin',
        createdAt: null,
        updatedAt: null,
        ...overrides,
    }
}

test('coupon records are converted into editable form values', () => {
    const startsAt = new Date(2026, 8, 17, 12, 34).getTime()
    const initial = toCouponFormInitial(coupon({ startsAt }))

    assert.equal(initial.discountValue, '20')
    assert.equal(initial.minSpendValue, '100')
    assert.equal(initial.totalUseLimit, '100')
    assert.equal(initial.perUserLimit, '2')
    assert.equal(initial.startsAtInput, '2026-09-17T12:34:00')
    assert.equal(initial.endsAtInput, '')
    assert.deepEqual(initial.productIds, ['product-1'])
})

test('invalid persisted dates do not crash the coupon edit page', () => {
    const initial = toCouponFormInitial(coupon({ startsAt: Number.NaN, endsAt: Number.POSITIVE_INFINITY }))
    assert.equal(initial.startsAtInput, '')
    assert.equal(initial.endsAtInput, '')
})
