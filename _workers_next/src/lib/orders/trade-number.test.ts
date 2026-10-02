import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { buildZeroPriceTradeNo, getLocalTradeOrderId, getOrderDisplayTradeNo, isLocalOrderTradeNo } from './trade-number.ts'

const ORDER = 'ORD5BE0E641D8104DA0872F489F1BBE97D2'

test('零元数字交易号独立、稳定、可搜索，不截断完整订单身份', () => {
    const seen = new Set<string>()
    for (const id of [ORDER, 'ORD00000000000000000000000000000000', 'ORDFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'ORDER-A', '历史订单', ...Array.from({ length: 1000 }, () => 'ORD' + randomUUID().replaceAll('-', '').toUpperCase())]) {
        for (const points of [0, 10]) {
            const number = buildZeroPriceTradeNo(id, points)
            assert.match(number, /^\d+$/)
            if (id.startsWith('ORD') && id.length === 35) assert.equal(number.length, 43)
            assert.equal(getLocalTradeOrderId(number), id)
            assert.equal(isLocalOrderTradeNo(number), true)
            assert.equal(buildZeroPriceTradeNo(id, points), number)
            assert.equal(seen.has(number), false)
            seen.add(number)
        }
    }
    assert.throws(() => buildZeroPriceTradeNo(' ', 10), /Missing order id/)
})

test('历史固定和带订单号的零元交易号统一数字展示，真实网关交易号保持原样', () => {
    for (const tradeNo of ['POINTS_REDEMPTION', 'POINTS_REDEMPTION:' + ORDER, 'ZERO_PRICE', 'ZERO_PRICE:' + ORDER]) {
        const order = { orderId: ORDER, tradeNo, pointsUsed: 10 }
        assert.equal(getOrderDisplayTradeNo(order), buildZeroPriceTradeNo(ORDER, 10))
        assert.equal(order.tradeNo, tradeNo)
    }
    assert.equal(getLocalTradeOrderId('POINTS_REDEMPTION:' + ORDER), ORDER)
    assert.equal(getOrderDisplayTradeNo({ orderId: ORDER, tradeNo: '110207387872264192' }), '110207387872264192')
    assert.equal(getOrderDisplayTradeNo({ orderId: ORDER, tradeNo: null }), null)
})

test('非法编码不会被误认作本地编号，旧合成号继续阻止发送网关', () => {
    for (const number of ['POINTS_REDEMPTION', 'POINTS_REDEMPTION:ORDER', 'ZERO_PRICE', 'ZERO_PRICE:ORDER']) assert.equal(isLocalOrderTradeNo(number), true)
    for (const number of ['110207387872264192', '9900', '9900' + '9'.repeat(39), '99021', '9902255', 'abc', '99' + '1'.repeat(600)]) assert.equal(isLocalOrderTradeNo(number), false)
})
