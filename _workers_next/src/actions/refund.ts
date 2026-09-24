'use server'

import { db, runAtomicD1Batch, type AtomicD1Statement } from "@/lib/db"
import { orders, products, refundRequests } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { revalidatePath, updateTag } from "next/cache"
import { recalcProductAggregates } from "@/lib/db/queries"
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
import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"

export async function markOrderRefunded(orderId: string) {
    const session = await auth()
    try {
        await checkAdmin()

        // Points and coupon operations are idempotent. The order/key/card state
        // transition below is committed in one D1 batch.
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
        if (!order) throw new Error("Order not found")
        if (order.status === 'refunded') {
            return { success: true }
        }
        if (order.status !== 'paid' && order.status !== 'delivered') {
            throw new Error(`Order ${orderId} cannot be refunded from status ${order.status || 'unknown'}`)
        }
        const product = order.productId
            ? await db.query.products.findFirst({
                where: eq(products.id, order.productId),
                columns: { isShared: true },
            })
            : null

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

        const refundStatements: AtomicD1Statement[] = []

        // Only delivered keys are permanently consumed. A paid manual or
        // out-of-stock order never disclosed a key, so its reservations can be released.
        const rawIds = order.cardIds || '';
        const parsedIds = rawIds
            .split(',')
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isInteger(id) && id > 0);
        const uniqueIds = Array.from(new Set(parsedIds));
        const consumedAt = Date.now()

        if (order.status === 'delivered' && !product?.isShared && uniqueIds.length > 0) {
            const placeholders = uniqueIds.map(() => '?').join(', ')
            refundStatements.push({
                query: `UPDATE cards
                    SET is_used = 1, used_at = ?, reserved_order_id = NULL, reserved_at = NULL
                    WHERE id IN (${placeholders})`,
                bindings: [consumedAt, ...uniqueIds],
            })
        } else if (order.status === 'delivered' && !product?.isShared && order.cardKey && order.productId) {
            const keys = order.cardKey.split('\n').map((k: string) => k.trim()).filter((k: string) => k !== '')
            if (keys.length > 0) {
                const uniqueKeys = Array.from(new Set(keys)) as string[]
                const placeholders = uniqueKeys.map(() => '?').join(', ')
                refundStatements.push({
                    query: `UPDATE cards
                        SET is_used = 1, used_at = ?, reserved_order_id = NULL, reserved_at = NULL
                        WHERE product_id = ? AND card_key IN (${placeholders})`,
                    bindings: [consumedAt, order.productId, ...uniqueKeys],
                })
            }
        } else if (order.status === 'paid') {
            refundStatements.push({
                query: `UPDATE cards
                    SET reserved_order_id = NULL, reserved_at = NULL
                    WHERE reserved_order_id = ? AND (is_used = 0 OR is_used IS NULL)`,
                bindings: [orderId],
            })
        }

        refundStatements.push({
            query: `UPDATE orders
                SET status = 'refunded',
                    card_key = NULL,
                    card_ids = NULL,
                    current_payment_id = NULL,
                    fulfillment_claim_id = NULL,
                    fulfillment_claimed_at = NULL
                WHERE order_id = ? AND status IN ('paid', 'delivered')`,
            bindings: [orderId],
        })
        await runAtomicD1Batch(refundStatements)

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

    const resp = await fetchWithTimeout('https://credit.linux.do/epay/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    }, 15_000)

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
