import assert from 'node:assert/strict'
import test from 'node:test'
import { buildZeroPriceTradeNo, getOrderDisplayTradeNo, isLocalOrderTradeNo } from './trade-number.ts'

test('积分与免费订单各有唯一交易号', () => {
    assert.equal(buildZeroPriceTradeNo('ORDER-A', 10), 'POINTS_REDEMPTION:ORDER-A')
    assert.equal(buildZeroPriceTradeNo('ORDER-A', 0), 'ZERO_PRICE:ORDER-A')
    assert.notEqual(buildZeroPriceTradeNo('ORDER-A', 10), buildZeroPriceTradeNo('ORDER-B', 10))
    assert.throws(() => buildZeroPriceTradeNo(' ', 10), /Missing order id/)
})

test('历史固定交易号展示补订单ID，真实交易号保持原样', () => {
    const legacy = { orderId: 'ORDER-A', tradeNo: 'POINTS_REDEMPTION', pointsUsed: 10 }
    assert.equal(getOrderDisplayTradeNo(legacy), 'POINTS_REDEMPTION:ORDER-A')
    assert.equal(legacy.tradeNo, 'POINTS_REDEMPTION')
    assert.equal(getOrderDisplayTradeNo({ ...legacy, tradeNo: 'real-trade' }), 'real-trade')
    assert.equal(getOrderDisplayTradeNo({ ...legacy, tradeNo: null }), null)
})

test('本地合成交易号不能发送到网关', () => {
    for (const number of ['POINTS_REDEMPTION', 'POINTS_REDEMPTION:ORDER', 'ZERO_PRICE', 'ZERO_PRICE:ORDER']) {
        assert.equal(isLocalOrderTradeNo(number), true)
    }
    assert.equal(isLocalOrderTradeNo('real-trade'), false)
})