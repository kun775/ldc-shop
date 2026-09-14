import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders, reviews, products } from "@/lib/db/schema"
import { eq, desc, inArray } from "drizzle-orm"
import { redirect } from "next/navigation"
import { OrdersContent } from "@/components/orders-content"
import { normalizeTimestampMs, getProductVariantLabels } from "@/lib/db/queries"
import { unstable_noStore } from "next/cache"

export default async function OrdersPage() {
    unstable_noStore()
    const session = await auth()
    if (!session?.user) redirect('/login')

    const userOrders = await db.query.orders.findMany({
        where: eq(orders.userId, session.user.id || ''),
        orderBy: [desc(normalizeTimestampMs(orders.createdAt))]
    })

    // Get reviewed order IDs for delivered orders
    const deliveredOrderIds = userOrders
        .filter((o: any) => o.status === 'delivered')
        .map((o: any) => o.orderId)
    
    let reviewedOrderIds: string[] = []
    if (deliveredOrderIds.length > 0) {
        try {
            const reviewedOrders = await db.select({ orderId: reviews.orderId })
                .from(reviews)
                .where(inArray(reviews.orderId, deliveredOrderIds))
            reviewedOrderIds = reviewedOrders.map((r: { orderId: string }) => r.orderId)
        } catch {
            // Ignore errors (table might not exist)
        }
    }

    const productIds = Array.from(new Set(userOrders.map((o: any) => o.productId).filter(Boolean)))
    const productVariantLabels = productIds.length > 0 ? await getProductVariantLabels(productIds) : {}

    let productImages: Record<string, string | null> = {}
    if (productIds.length > 0) {
        try {
            const rows = await db.select({ id: products.id, image: products.image })
                .from(products)
                .where(inArray(products.id, productIds))
            for (const row of rows) {
                if (row.image) productImages[row.id] = row.image
            }
        } catch {
            productImages = {}
        }
    }

    return (
        <OrdersContent
            orders={userOrders.map((o: any) => ({
                orderId: o.orderId,
                productId: o.productId,
                productName: o.productName,
                amount: o.amount,
                quantity: Number(o.quantity || 1),
                status: o.status,
                createdAt: o.createdAt,
                paidAt: o.paidAt,
                fulfillmentMode: o.fulfillmentMode,
                canReview: o.status === 'delivered' && !reviewedOrderIds.includes(o.orderId)
            }))}
            productVariantLabels={productVariantLabels}
            productImages={productImages}
        />
    )
}
