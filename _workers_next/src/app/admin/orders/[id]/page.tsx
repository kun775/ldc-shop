import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { AdminOrderDetailContent } from "@/components/admin/order-detail-content"
import { ensureDatabaseInitialized, getProductVariantLabels } from "@/lib/db/queries"
import { listDeliveryFiles } from "@/lib/delivery-files"
import { unstable_noStore } from "next/cache"

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  unstable_noStore()
  const { id } = await params
  await ensureDatabaseInitialized()
  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, id) })
  if (!order) return notFound()

  const labels = order.productId ? await getProductVariantLabels([order.productId]) : {}
  const productVariantLabel = order.productId ? labels[order.productId] ?? null : null
  const deliveryFiles = await listDeliveryFiles(order.orderId)

  return (
    <AdminOrderDetailContent
      order={{
        orderId: order.orderId,
        username: order.username,
        userId: order.userId,
        email: order.email,
        productId: order.productId,
        productName: order.productName,
        productVariantLabel,
        amount: order.amount,
        pointsUsed: Number(order.pointsUsed || 0),
        quantity: Number(order.quantity || 1),
        status: order.status,
        tradeNo: order.tradeNo,
        cardKey: order.cardKey,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        deliveredAt: order.deliveredAt,
        checkoutFieldValues: order.checkoutFieldValues,
        fulfillmentMode: order.fulfillmentMode,
        deliveryNote: order.deliveryNote,
        deliveryFiles,
      }}
    />
  )
}
