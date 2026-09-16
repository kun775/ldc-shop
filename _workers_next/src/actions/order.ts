'use server'

import { auth } from "@/lib/auth"
import { queryOrderStatus } from "@/lib/epay"
import { processOrderFulfillment } from "@/lib/order-processing"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { orders, cards } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { withOrderColumnFallback, recalcProductAggregates } from "@/lib/db/queries"
import { cookies } from "next/headers"
import { updateTag } from "next/cache"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import { isAdminIdentity } from "@/lib/admin-auth"
import { hasOrderAccessToken, ORDER_ACCESS_COOKIE } from "@/lib/order-access"

export async function checkOrderStatus(orderId: string) {
    const session = await auth()

    // Check ownership
    const order = await withOrderColumnFallback(async () => {
        return await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: { userId: true, status: true, amount: true, currentPaymentId: true }
        })
    })

    if (!order) return { success: false, error: 'Order not found' }

    const cookieStore = await cookies()
    const hasGuestAccess = !order.userId && hasOrderAccessToken(
        cookieStore.get(ORDER_ACCESS_COOKIE)?.value,
        orderId
    )
    const isOwner = !!(session?.user?.id && order.userId === session.user.id)
    const isAdmin = isAdminIdentity(session?.user)

    if (!isOwner && !hasGuestAccess && !isAdmin) {
        return { success: false, error: 'Unauthorized' }
    }

    if (order.status === 'paid' || order.status === 'delivered') {
        return { success: true, status: order.status }
    }

    try {
        // Use the latest payment ID (retry ID) if available, otherwise fallback to orderId
        const tradeNoToCheck = order.currentPaymentId || orderId
        const result = await queryOrderStatus(tradeNoToCheck)

        if (result.success && result.status === 1) { // 1 = Paid
            // trade_no might be in result.data or result.trade_no?
            // queryOrderStatus returns { ..., data: fullResponse }

            const tradeNo = result.data?.trade_no || result.data?.transaction_id || `MANUAL_CHECK_${Date.now()}`
            const paidAmount = parseFloat(result.data?.money || order.amount)

            const fulfillment = await processOrderFulfillment(orderId, paidAmount, tradeNo)

            revalidatePath(`/order/${orderId}`)
            if (fulfillment.status === 'processing') {
                return { success: false, status: 'pending' }
            }
            return { success: true, status: fulfillment.orderStatus || 'paid' }
        }

        return { success: false, status: 'pending' }

    } catch (e: any) {
        console.error("Check order status failed", e)
        return { success: false, error: e.message }
    }
}

export async function cancelPendingOrder(orderId: string) {
    const session = await auth()
    if (!session?.user) return { success: false, error: 'common.error' }

    // Check ownership and status
    const order = await withOrderColumnFallback(async () => {
        return await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: {
                userId: true,
                username: true,
                email: true,
                status: true,
                productId: true,
                pointsUsed: true,
            }
        })
    })

    if (!order) return { success: false, error: 'order.notFound' }
    if (order.userId !== session.user.id) return { success: false, error: 'common.error' }
    if (order.status !== 'pending') return { success: false, error: 'order.cannotCancel' }

    try {
        const cancelled = await db.update(orders)
            .set({ status: 'cancelled' })
            .where(and(
                eq(orders.orderId, orderId),
                eq(orders.userId, session.user.id),
                eq(orders.status, 'pending'),
            ))
            .returning({ orderId: orders.orderId })
        if (!cancelled.length) return { success: false, error: 'order.cannotCancel' }

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
                sourceType: "order",
                sourceId: orderId,
                reason: `订单 ${orderId} 用户取消返还积分`,
                metadata: JSON.stringify({
                    action: "user_cancel",
                }),
            })
        }

        // Release reserved cards
        await db.update(cards)
            .set({ reservedOrderId: null, reservedAt: null })
            .where(eq(cards.reservedOrderId, orderId))

        revalidatePath(`/order/${orderId}`)
        revalidatePath('/orders')
        revalidatePath('/admin/users')
        revalidatePath(`/admin/users/${order.userId}`)
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
        
        return { success: true }
    } catch (e: any) {
        console.error("Cancel order failed", e)
        return { success: false, error: 'common.error' }
    }
}
