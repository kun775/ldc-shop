const POINTS_TRADE_PREFIX = 'POINTS_REDEMPTION'
const ZERO_PRICE_TRADE_PREFIX = 'ZERO_PRICE'

/** 零元交易号绑定订单号，重试稳定且不同订单不会共用交易号。 */
export function buildZeroPriceTradeNo(orderId: string, pointsUsed: number): string {
    const id = orderId.trim()
    if (!id) throw new Error('Missing order id')
    return `${pointsUsed > 0 ? POINTS_TRADE_PREFIX : ZERO_PRICE_TRADE_PREFIX}:${id}`
}

export function isLocalOrderTradeNo(tradeNo: string): boolean {
    return [POINTS_TRADE_PREFIX, ZERO_PRICE_TRADE_PREFIX].some((prefix) =>
        tradeNo === prefix || tradeNo.startsWith(`${prefix}:`),
    )
}

/** 旧积分订单按订单号展示独立交易号；不批量改写历史支付数据。 */
export function getOrderDisplayTradeNo(order: {
    orderId: string
    tradeNo?: string | null
    pointsUsed?: number | null
}): string | null {
    if (order.tradeNo === POINTS_TRADE_PREFIX || order.tradeNo === ZERO_PRICE_TRADE_PREFIX) {
        return buildZeroPriceTradeNo(order.orderId, order.pointsUsed ?? 0)
    }
    return order.tradeNo || null
}
