'use server'

import { db } from "@/lib/db"
import { cards, orders, refundRequests, products } from "@/lib/db/schema"
import { and, eq, inArray } from "drizzle-orm"
import { revalidatePath, updateTag } from "next/cache"
import { getSetting, recalcProductAggregates } from "@/lib/db/queries"
import { checkAdmin } from "@/actions/admin"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import {
    getOrderCouponsForReverse,
    releaseCouponUsages,
    reverseCouponUsages,
} from "@/lib/coupons/reservation"
import { selectReversibleCouponUsageIds } from "@/lib/coupons/refund-policy"
import { auth } from "@/lib/auth"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"

export async function markOrderRefunded(orderId: string) {
    const session = await auth()
    try {
        await checkAdmin()

        // No transaction - D1 doesn't support SQL transactions in HTTP api easily
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
        if (!order) throw new Error("Order not found")
        if (order.status === 'refunded') {
            return { success: true }
        }

        // Refund points if used
        if (order.userId && order.pointsUsed && order.pointsUsed > 0) {
            await ensurePointLedgerUserRecord({
                userId: order.userId,
                username: order.username ?? null,
                email: order.email ?? null,
            })
            await applyUserAutomaticPointEvent({
                userId: order.userId,
                username: order.username ?? null,
                email: order.email ?? null,
                eventType: "refund_return",
                delta: order.pointsUsed,
                businessKey: `refund_return:${orderId}`,
                sourceType: "refund",
                sourceId: orderId,
                reason: `订单 ${orderId} 退款返还积分`,
                metadata: JSON.stringify({
                    status: order.status ?? null,
                }),
            })
        }

        // Update order status
        await db.update(orders).set({ status: 'refunded' }).where(eq(orders.orderId, orderId))

        // 优惠券处理：未核销的预占一律释放；已核销的按券的退款策略决定是否返还次数
        try {
            await releaseCouponUsages(orderId, 'refund_release')
            const fulfilled = order.status === 'delivered'
            const consumedCoupons = await getOrderCouponsForReverse(orderId)
            const reversibleUsageIds = selectReversibleCouponUsageIds(consumedCoupons, fulfilled)
            if (reversibleUsageIds.length > 0) {
                await reverseCouponUsages(
                    orderId,
                    fulfilled ? 'refund_reverse_fulfilled' : 'refund_reverse',
                    Date.now(),
                    reversibleUsageIds
                )
            }
        } catch (error) {
            console.error('[Coupon] Refund reversal failed:', error)
        }

        // Reclaim card back to stock (best effort)
        let reclaimCards = true
        try {
            const v = await getSetting('refund_reclaim_cards')
            reclaimCards = v !== 'false'
        } catch {
            reclaimCards = true
        }
        if (reclaimCards && order.productId) {
            const product = await db.query.products.findFirst({
                where: eq(products.id, order.productId),
                columns: { isShared: true }
            });
            if (product?.isShared) {
                reclaimCards = false;
            }
        }

        if (reclaimCards) {
            const rawIds = order.cardIds || '';
            const parsedIds = rawIds
                .split(',')
                .map((id) => Number(id.trim()))
                .filter((id) => Number.isFinite(id));

            const uniqueIds = Array.from(new Set(parsedIds));

            if (uniqueIds.length > 0) {
                await db.update(cards).set({ isUsed: false, usedAt: null, reservedOrderId: null, reservedAt: null })
                    .where(inArray(cards.id, uniqueIds));
            } else if (order.cardKey) {
                const keys = order.cardKey.split('\n').map((k: string) => k.trim()).filter((k: string) => k !== '')
                if (keys.length > 0) {
                    const uniqueKeys = Array.from(new Set(keys)) as string[]
                    await db.update(cards).set({ isUsed: false, usedAt: null, reservedOrderId: null, reservedAt: null })
                        .where(and(eq(cards.productId, order.productId), inArray(cards.cardKey, uniqueKeys)))
                }
            }
        }

        // Mark refund request processed if table exists
        try {
            await db.update(refundRequests).set({ status: 'processed', processedAt: new Date(), updatedAt: new Date() })
                .where(eq(refundRequests.orderId, orderId))
        } catch {
            // ignore (table may not exist)
        }

        revalidatePath('/admin/orders')
        revalidatePath('/admin/refunds')
        revalidatePath('/admin/users')
        if (order.userId) {
            revalidatePath(`/admin/users/${order.userId}`)
        }
        revalidatePath(`/order/${orderId}`)

        if (order.productId) {
            try {
                await recalcProductAggregates(order.productId)
            } catch {
                // best effort
            }
        }
        try {
            updateTag('home:products')
        } catch {
            // best effort
        }

        await recordAuditEvent({
            eventName: 'refund.completed',
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            targetId: orderId,
            source: 'admin.refunds',
            metadata: {
                orderId,
                status: 'processed',
                points: order.pointsUsed || 0,
            },
        })

        return { success: true }
    } catch (error) {
        await recordServerError('refund.complete', error, {
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            auditEvent: {
                eventName: 'refund.completed',
                actorType: 'admin',
                actorUserId: session?.user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: orderId || null,
                source: 'admin.refunds',
                metadata: { orderId },
            },
        })
        throw error
    }
}

export async function proxyRefund(orderId: string) {
    await checkAdmin()

    const pid = process.env.MERCHANT_ID
    const key = process.env.MERCHANT_KEY
    if (!pid || !key) throw new Error("Missing merchant config")

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) throw new Error("Order not found")
    if (!order.tradeNo) throw new Error("Missing trade_no")

    const body = new URLSearchParams({
        pid,
        key,
        trade_no: order.tradeNo,
        out_trade_no: order.orderId,
        money: Number(order.amount).toFixed(2),
    })

    const resp = await fetch('https://credit.linux.do/epay/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    })

    const text = await resp.text()

    let success = false
    try {
        const json = JSON.parse(text)
        success = json?.code === 1 || json?.status === 'success' || json?.msg === 'success'
    } catch {
        success = /success/i.test(text)
    }

    if (!resp.ok) {
        throw new Error(`Refund proxy failed (${resp.status})`)
    }

    if (success) {
        await markOrderRefunded(orderId)
        return { ok: true, processed: true, message: text.slice(0, 500) }
    }

    return { ok: true, processed: false, message: text.slice(0, 500) }
}
