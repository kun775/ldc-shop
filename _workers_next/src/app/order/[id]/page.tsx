import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders, refundRequests } from "@/lib/db/schema"
import { and, desc, eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { cookies } from "next/headers"
import { OrderContent } from "@/components/order-content"
import { ensureDatabaseInitialized, getProductVariantLabels } from "@/lib/db/queries"
import { listDeliveryFiles } from "@/lib/delivery-files"

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    await ensureDatabaseInitialized()
    const session = await auth()
    const user = session?.user

    const order = await db.query.orders.findFirst({
        where: eq(orders.orderId, id)
    })

    if (!order) return notFound()

    // Access Control
    let canViewKey = false
    const isOwner = !!(user && (user.id === order.userId || user.username === order.username))
    if (isOwner) canViewKey = true

    // Check Cookie
    const cookieStore = await cookies()
    const pending = cookieStore.get('ldc_pending_order')
    if (pending?.value === id) canViewKey = true

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
    const deliveryFiles = (isOwner || pending?.value === id) ? await listDeliveryFiles(order.orderId) : []

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
                deliveryNote: order.deliveryNote,
                deliveryFiles,
            }}
            canViewKey={canViewKey}
            isOwner={isOwner}
            refundRequest={refundRequest ? { status: refundRequest.status, reason: refundRequest.reason, adminNote: refundRequest.adminNote } : null}
        />
    )
}
