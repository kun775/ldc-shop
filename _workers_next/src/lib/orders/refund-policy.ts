import { isLocalOrderTradeNo } from './trade-number.ts'

export interface RefundOrderPayment {
    orderId: string
    status?: string | null
    amount: string | number | null | undefined
    tradeNo?: string | null
    pointsUsed?: number | null
    userId?: string | null
}

export type OrderRefundMethod = 'points' | 'gateway' | 'none'
export interface OrderRefundResult {
    ok: true
    processed: boolean
    message: string
}

/** 前后端共用退款准入：积分退款需有积分归属，真实支付才使用网关交易号。 */
export function getOrderRefundMethod(order: RefundOrderPayment): OrderRefundMethod {
    if (order.status !== 'paid' && order.status !== 'delivered') return 'none'
    if (order.amount == null || String(order.amount).trim() === '') return 'none'
    const amount = Number(order.amount)
    if (!Number.isFinite(amount) || amount < 0) return 'none'
    if (amount === 0) {
        return order.userId && Number.isSafeInteger(order.pointsUsed) && (order.pointsUsed ?? 0) > 0
            ? 'points' : 'none'
    }
    const tradeNo = order.tradeNo?.trim()
    return tradeNo && !isLocalOrderTradeNo(tradeNo) ? 'gateway' : 'none'
}

/**
 * 根据数据库订单选择退款路径。纯积分订单直接走本地结算，网关配置及网络请求
 * 只在真实支付分支执行；终态重放不重复调用任何退款依赖。
 */
export async function executeOrderRefund(
    order: RefundOrderPayment,
    deps: {
        markRefunded: (orderId: string) => Promise<unknown>
        refundGateway: () => Promise<OrderRefundResult>
    },
): Promise<OrderRefundResult> {
    if (order.status === 'refunded') return { ok: true, processed: true, message: '' }
    const method = getOrderRefundMethod(order)
    if (method === 'none') throw new Error('admin.orders.refundNotAllowed')
    if (method === 'points') {
        await deps.markRefunded(order.orderId)
        return { ok: true, processed: true, message: '' }
    }
    return deps.refundGateway()
}
