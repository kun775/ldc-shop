import assert from 'node:assert/strict'
import test from 'node:test'
import { buildZeroPriceTradeNo } from './trade-number.ts'
import { executeOrderRefund, getOrderRefundMethod, type RefundOrderPayment } from './refund-policy.ts'

const pointsOrder: RefundOrderPayment = { orderId: 'ORDER-1', status: 'paid', amount: '0.00', pointsUsed: 50, userId: 'user' }

for (const tradeNo of [null, 'POINTS_REDEMPTION', 'POINTS_REDEMPTION:ORDER-1', buildZeroPriceTradeNo('ORDER-1', 50)]) {
    test(`纯积分退款 ${tradeNo} 无需交易号或网关配置`, async () => {
        let returned = 0
        const result = await executeOrderRefund({ ...pointsOrder, tradeNo }, {
            async markRefunded(id) { assert.equal(id, 'ORDER-1'); returned += 1 },
            async refundGateway() { throw new Error('must not access gateway') },
        })
        assert.equal(getOrderRefundMethod({ ...pointsOrder, tradeNo }), 'points')
        assert.equal(result.processed, true)
        assert.equal(returned, 1)
    })
}

test('现金加积分订单继续使用支付网关', async () => {
    let gatewayCalls = 0
    assert.equal(getOrderRefundMethod({ ...pointsOrder, amount: '1.25', tradeNo: 'real-trade' }), 'gateway')
    const result = await executeOrderRefund({ ...pointsOrder, amount: '1.25', tradeNo: 'real-trade' }, {
        async markRefunded() { throw new Error('gateway owns settlement') },
        async refundGateway() { gatewayCalls += 1; return { ok: true, processed: false, message: 'pending' } },
    })
    assert.equal(result.processed, false)
    assert.equal(gatewayCalls, 1)
})

for (const patch of [
    { pointsUsed: 0 }, { pointsUsed: -1 }, { pointsUsed: 1.5 }, { userId: null },
    { amount: 'NaN' }, { amount: 'Infinity' }, { amount: '-1' }, { amount: '' },
    { status: 'pending' }, { status: 'processing' }, { status: 'cancelled' },
    { amount: '1', tradeNo: 'POINTS_REDEMPTION' }, { amount: '1', tradeNo: 'POINTS_REDEMPTION:ORDER-1' },
    { amount: '1', tradeNo: null }, { amount: '1', tradeNo: buildZeroPriceTradeNo('ORDER-1', 50) },
]) {
    test(`非法或未支付订单不能退款 ${JSON.stringify(patch)}`, async () => {
        const order = { ...pointsOrder, ...patch }
        assert.equal(getOrderRefundMethod(order), 'none')
        await assert.rejects(executeOrderRefund(order, {
            async markRefunded() { assert.fail('must not settle') },
            async refundGateway() { assert.fail('must not access gateway') },
        }), /admin.orders.refundNotAllowed/)
    })
}

test('已退款重放不再返积分或访问网关', async () => {
    const result = await executeOrderRefund({ ...pointsOrder, status: 'refunded' }, {
        async markRefunded() { assert.fail('must not settle again') },
        async refundGateway() { assert.fail('must not refund again') },
    })
    assert.equal(result.processed, true)
})

test('积分返还失败不切换网关或报告成功', async () => {
    await assert.rejects(executeOrderRefund(pointsOrder, {
        async markRefunded() { throw new Error('settlement failed') },
        async refundGateway() { assert.fail('must not access gateway') },
    }), /settlement failed/)
})