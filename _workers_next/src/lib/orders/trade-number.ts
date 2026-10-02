const POINTS_TRADE_PREFIX = 'POINTS_REDEMPTION'
const ZERO_PRICE_TRADE_PREFIX = 'ZERO_PRICE'
const UUID_PREFIXES = ['9900', '9901']
const TEXT_PREFIXES = ['9902', '9903']

/** 将完整订单身份编码为十进制交易号，避免截断 UUID 造成碰撞；同一订单重试稳定。 */
export function buildZeroPriceTradeNo(orderId: string, pointsUsed: number): string {
    const id = orderId.trim()
    if (!id) throw new Error('Missing order id')
    if (/[\u0000-\u001f\u007f]/.test(id)) throw new Error('Invalid order id')
    const kind = pointsUsed > 0 ? 0 : 1
    if (/^ORD[0-9A-F]{32}$/.test(id)) {
        return UUID_PREFIXES[kind] + BigInt('0x' + id.slice(3)).toString().padStart(39, '0')
    }
    // 兼容非 UUID 形式的历史订单号，保留全部 UTF-8 字节而非取哈希。
    const bytes = new TextEncoder().encode(id)
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return TEXT_PREFIXES[kind] + BigInt('0x' + hex).toString()
}

/** 交易号可逆到订单号，历史记录无需批量改写即可按显示交易号搜索。 */
export function getLocalTradeOrderId(tradeNo: string): string | null {
    const legacy = /^(?:POINTS_REDEMPTION|ZERO_PRICE):(.+)$/.exec(tradeNo)
    if (legacy) return legacy[1]
    if (!/^99[0-9]{3,512}$/.test(tradeNo)) return null
    const prefix = tradeNo.slice(0, 4)
    const decimal = tradeNo.slice(4)
    const value = BigInt(decimal)
    if (UUID_PREFIXES.includes(prefix)) {
        if (decimal.length !== 39 || value >= (BigInt(1) << BigInt(128))) return null
        return 'ORD' + value.toString(16).padStart(32, '0').toUpperCase()
    }
    if (!TEXT_PREFIXES.includes(prefix) || value === BigInt(0)) return null
    let hex = value.toString(16)
    if (hex.length % 2) hex = '0' + hex
    const bytes = Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16))
    try {
        const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return buildZeroPriceTradeNo(id, prefix === TEXT_PREFIXES[0] ? 1 : 0) === tradeNo ? id : null
    } catch {
        return null
    }
}

export function isLocalOrderTradeNo(tradeNo: string): boolean {
    return [POINTS_TRADE_PREFIX, ZERO_PRICE_TRADE_PREFIX].some((prefix) =>
        tradeNo === prefix || tradeNo.startsWith(`${prefix}:`),
    ) || getLocalTradeOrderId(tradeNo) !== null
}

/** 新旧零元交易号统一展示为独立数字编号，支付平台返回的交易号保持原样。 */
export function getOrderDisplayTradeNo(order: {
    orderId: string
    tradeNo?: string | null
    pointsUsed?: number | null
}): string | null {
    if ([POINTS_TRADE_PREFIX, ZERO_PRICE_TRADE_PREFIX].some((prefix) =>
        order.tradeNo === prefix || order.tradeNo?.startsWith(`${prefix}:`),
    )) {
        return buildZeroPriceTradeNo(order.orderId, order.pointsUsed ?? 0)
    }
    return order.tradeNo || null
}
