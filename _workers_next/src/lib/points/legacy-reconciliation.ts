export interface LegacyPointOrderRow {
    orderId: string
    pointsUsed: number
    refunded: boolean
    createdAt: number
}

export interface LegacyPointLedgerEntry {
    userId: string
    eventType: "order_deduction" | "refund_return" | "admin_adjust"
    delta: number
    balanceAfter: number
    businessKey: string
    sourceType: string
    sourceId: string | null
    reason: string
    createdAt: number
}

/**
 * buildLegacyPointLedgerEntries 构造历史积分账本回填条目。
 *
 * 参数:
 *   - input object: 历史订单与当前余额信息
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化历史积分流水回放逻辑。
 */
export function buildLegacyPointLedgerEntries(input: {
    userId: string
    currentPoints: number
    orderRows: LegacyPointOrderRow[]
    initializationCreatedAt?: number
}) {
    const entries: LegacyPointLedgerEntry[] = []
    let reconstructedBalance = 0
    let lastCreatedAt = 0

    for (const row of [...input.orderRows].sort((a, b) => a.createdAt - b.createdAt)) {
        lastCreatedAt = Math.max(lastCreatedAt, row.createdAt)

        if (row.pointsUsed > 0) {
            reconstructedBalance -= row.pointsUsed
            entries.push({
                userId: input.userId,
                eventType: "order_deduction",
                delta: -row.pointsUsed,
                balanceAfter: reconstructedBalance,
                businessKey: `order_deduction:${row.orderId}`,
                sourceType: "order",
                sourceId: row.orderId,
                reason: `历史订单 ${row.orderId} 积分抵扣`,
                createdAt: row.createdAt,
            })
        }

        if (row.refunded && row.pointsUsed > 0) {
            reconstructedBalance += row.pointsUsed
            entries.push({
                userId: input.userId,
                eventType: "refund_return",
                delta: row.pointsUsed,
                balanceAfter: reconstructedBalance,
                businessKey: `refund_return:${row.orderId}`,
                sourceType: "refund",
                sourceId: row.orderId,
                reason: `历史订单 ${row.orderId} 退款返还积分`,
                createdAt: row.createdAt + 1,
            })
            lastCreatedAt = Math.max(lastCreatedAt, row.createdAt + 1)
        }
    }

    const gap = input.currentPoints - reconstructedBalance
    if (gap !== 0) {
        reconstructedBalance += gap
        entries.push({
            userId: input.userId,
            eventType: "admin_adjust",
            delta: gap,
            balanceAfter: reconstructedBalance,
            businessKey: `legacy_balance_init:${input.userId}`,
            sourceType: "system",
            sourceId: "legacy_balance_init",
            reason: "历史积分余额初始化",
            createdAt: input.initializationCreatedAt ?? Math.max(Date.now(), lastCreatedAt + 1),
        })
    }

    return entries
}
