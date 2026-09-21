import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders, refundRequests } from "@/lib/db/schema"
import { and, desc, eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { cookies } from "next/headers"
import { OrderContent } from "@/components/order-content"
import { ensureDatabaseInitialized, getProductVariantLabels } from "@/lib/db/queries"
import { listDeliveryFiles } from "@/lib/delivery-files"
import { isAdminIdentity } from "@/lib/admin-auth"
import { hasOrderAccessToken, ORDER_ACCESS_COOKIE } from "@/lib/order-access"
import { getProductCardDeliveryNote } from "@/lib/card-delivery-note"
import { isManualFulfillment } from "@/lib/fulfillment"

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    await ensureDatabaseInitialized()
    const session = await auth()
    const user = session?.user

    const order = await db.query.orders.findFirst({
        where: eq(orders.orderId, id)
    })

    if (!order) return notFound()

    // Sensitive order data is available only to the stable account owner, an admin,
    // or a guest holding the server-signed, short-lived capability token.
    const isOwner = !!(user?.id && user.id === order.userId)
    const isAdmin = isAdminIdentity(user)
    const cookieStore = await cookies()
    const hasGuestAccess = !order.userId && hasOrderAccessToken(
        cookieStore.get(ORDER_ACCESS_COOKIE)?.value,
        id
    )
    const canViewKey = isOwner || isAdmin || hasGuestAccess

    if (!canViewKey) return notFound()

    // Refund request status (best effort)
    let refundRequest: any = null
    if (user?.id) {
        try {
            refundRequest = await db.query.refundRequests.findFirst({
                where: and(eq(refundRequests.orderId, id), eq(refundRequests.userId, user.id)),
                orderBy: [desc(refundRequests.createdAt)]
            })
        } catch {
            refundRequest = null
        }
    }

    const labels = order.productId ? await getProductVariantLabels([order.productId]) : {}
    const productVariantLabel = order.productId ? labels[order.productId] ?? null : null
    const deliveryFiles = canViewKey ? await listDeliveryFiles(order.orderId) : []
    let deliveryNote = order.deliveryNote
    if (!deliveryNote && order.status === 'delivered' && order.productId && !isManualFulfillment(order.fulfillmentMode)) {
        deliveryNote = await getProductCardDeliveryNote(order.productId).catch(() => null)
    }

    return (
        <OrderContent
            order={{
                orderId: order.orderId,
                productId: order.productId,
                productName: order.productName,
                productVariantLabel,
                amount: order.amount,
                pointsUsed: Number(order.pointsUsed || 0),
                quantity: Number(order.quantity || 1),
                status: order.status || 'pending',
                cardKey: order.cardKey,
                payee: order.payee,
                createdAt: order.createdAt,
                paidAt: order.paidAt,
                deliveredAt: order.deliveredAt,
                checkoutFieldValues: order.checkoutFieldValues,
                fulfillmentMode: order.fulfillmentMode,
                deliveryNote,
                deliveryFiles,
            }}
            canViewKey={canViewKey}
            isOwner={isOwner}
            refundRequest={refundRequest ? { status: refundRequest.status, reason: refundRequest.reason, adminNote: refundRequest.adminNote } : null}
        />
    )
}
