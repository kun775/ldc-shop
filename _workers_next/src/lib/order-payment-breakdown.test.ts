import test from 'node:test'
import assert from 'node:assert/strict'
import { getOrderPaymentBreakdown, parseOrderCouponLines } from './order-payment-breakdown.ts'

// 真实订单 ORD8C468929485241EBA61A817B00062CE 的快照：
// 商品小计 200，两张券共抵扣 100，积分抵扣 10，网关实付 90
const snapshotWithTwoCoupons = JSON.stringify({
    version: 1,
    subtotalCents: 20000,
    couponDiscountCents: 10000,
    pointsDiscountCents: 1000,
    pointsUsed: 10,
    finalAmountCents: 9000,
    coupons: [
        {
            couponId: 'cpn_a',
            code: 'SUMMER60',
            sequence: 0,
            eligibleAmountCents: 20000,
            discountAmountCents: 6000,
            ruleSnapshot: {},
        },
        {
            couponId: 'cpn_b',
            code: 'NEW40',
            sequence: 1,
            eligibleAmountCents: 14000,
            discountAmountCents: 4000,
            ruleSnapshot: {},
        },
    ],
    computedAt: 1758000000000,
})

test('订单合计取实付口径，不再回加优惠券与积分', () => {
    const breakdown = getOrderPaymentBreakdown({
        amount: '90.00',
        pointsUsed: 10,
        subtotalAmountCents: 20000,
        couponDiscountAmountCents: 10000,
        pointsDiscountAmountCents: 1000,
        pricingSnapshot: snapshotWithTwoCoupons,
    })

    // 回归：历史实现为 90 + 积分数量 10 + 优惠券 100 + 积分抵扣 10 = 210
    assert.equal(breakdown.totalAmount, '90.00')
    assert.equal(breakdown.ldcAmount, '90.00')
    assert.equal(breakdown.subtotalAmount, 200)
    assert.equal(breakdown.couponDiscountAmount, 100)
    assert.equal(breakdown.pointsDiscountAmount, 10)
    assert.equal(breakdown.pointsAmount, 10)
    assert.equal(breakdown.hasCouponBreakdown, true)

    // 账目必须闭合：商品小计 − 优惠券 − 积分 = 订单合计
    const {
        subtotalAmount,
        couponDiscountAmount,
        pointsDiscountAmount,
        totalAmount,
    } = breakdown
    assert.equal(
        Number((subtotalAmount! - couponDiscountAmount - pointsDiscountAmount).toFixed(2)),
        Number(totalAmount)
    )
})

test('优惠券抵扣细分到每一张券，且与汇总一致', () => {
    const breakdown = getOrderPaymentBreakdown({
        amount: '90.00',
        pointsUsed: 10,
        subtotalAmountCents: 20000,
        couponDiscountAmountCents: 10000,
        pointsDiscountAmountCents: 1000,
        pricingSnapshot: snapshotWithTwoCoupons,
    })

    assert.deepEqual(breakdown.couponLines, [
        { couponId: 'cpn_a', code: 'SUMMER60', discountAmount: 60 },
        { couponId: 'cpn_b', code: 'NEW40', discountAmount: 40 },
    ])

    const sum = breakdown.couponLines.reduce((acc, line) => acc + line.discountAmount, 0)
    assert.equal(sum, breakdown.couponDiscountAmount)
})

test('老订单（无定价快照）退回积分数量，并反推出抵扣前小计', () => {
    const breakdown = getOrderPaymentBreakdown({
        amount: '90.00',
        pointsUsed: 10,
        subtotalAmountCents: null,
        couponDiscountAmountCents: null,
        pointsDiscountAmountCents: null,
        pricingSnapshot: null,
    })

    assert.equal(breakdown.totalAmount, '90.00')
    assert.equal(breakdown.subtotalAmount, 100)
    assert.equal(breakdown.pointsDiscountAmount, 10)
    assert.equal(breakdown.couponDiscountAmount, 0)
    assert.equal(breakdown.hasCouponBreakdown, false)
    assert.deepEqual(breakdown.couponLines, [])
})

test('老订单未用积分时不猜测商品小计', () => {
    const breakdown = getOrderPaymentBreakdown({
        amount: '100.00',
        pointsUsed: 0,
    })

    assert.equal(breakdown.totalAmount, '100.00')
    assert.equal(breakdown.subtotalAmount, null)
    assert.equal(breakdown.pointsDiscountAmount, 0)
})

test('快照缺失或损坏时降级为无逐张明细，不影响合计', () => {
    const malformed = getOrderPaymentBreakdown({
        amount: '50.00',
        pointsUsed: 0,
        subtotalAmountCents: 15000,
        couponDiscountAmountCents: 10000,
        pointsDiscountAmountCents: 0,
        pricingSnapshot: '{ not json',
    })
    assert.deepEqual(malformed.couponLines, [])
    assert.equal(malformed.totalAmount, '50.00')

    const withoutCouponsKey = getOrderPaymentBreakdown({
        amount: '50.00',
        pointsUsed: 0,
        subtotalAmountCents: 15000,
        couponDiscountAmountCents: 10000,
        pointsDiscountAmountCents: 0,
        pricingSnapshot: JSON.stringify({ version: 1, subtotalCents: 15000 }),
    })
    assert.deepEqual(withoutCouponsKey.couponLines, [])
})

test('parseOrderCouponLines 过滤零额与残缺记录', () => {
    const lines = parseOrderCouponLines(JSON.stringify({
        coupons: [
            { couponId: 'cpn_zero', code: 'ZERO', discountAmountCents: 0 },
            { couponId: 'cpn_ok', code: 'OK', discountAmountCents: 1234 },
            { couponId: '', code: '  ', discountAmountCents: 500 },
            { couponId: 'cpn_no_code', discountAmountCents: 700 },
            null,
            'nope',
        ],
    }))

    assert.deepEqual(lines, [
        { couponId: 'cpn_ok', code: 'OK', discountAmount: 12.34 },
        { couponId: 'cpn_no_code', code: null, discountAmount: 7 },
    ])
})

test('金额字段缺失时按 0 处理，不产生 NaN', () => {
    const breakdown = getOrderPaymentBreakdown({ amount: null, pointsUsed: null })
    assert.equal(breakdown.totalAmount, '0.00')
    assert.equal(breakdown.ldcAmount, '0.00')
    assert.equal(breakdown.pointsAmount, 0)
})
