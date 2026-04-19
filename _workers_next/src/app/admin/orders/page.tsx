import { db } from "@/lib/db"
import { loginUsers, orders } from "@/lib/db/schema"
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { AdminOrdersContent } from "@/components/admin/orders-content"
import { normalizeTimestampMs, withOrderColumnFallback, getProductVariantLabels } from "@/lib/db/queries"
import { PAYMENT_PRODUCT_ID } from "@/lib/payment"
import { unstable_noStore } from "next/cache"

const LOGIN_USER_LOOKUP_BATCH_SIZE = 50

function parseIntParam(value: unknown, fallback: number) {
    const num = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
    return Number.isFinite(num) && num > 0 ? num : fallback
}

function firstParam(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined
    return Array.isArray(value) ? value[0] : value
}

function chunkArray<T>(items: T[], size: number) {
    const chunks: T[][] = []
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size))
    }
    return chunks
}

export default async function AdminOrdersPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    unstable_noStore()
    const searchParams = await props.searchParams

    const q = (firstParam(searchParams.q) || '').trim()
    const status = (firstParam(searchParams.status) || 'all').trim()
    const page = parseIntParam(firstParam(searchParams.page), 1)
    const pageSize = Math.min(parseIntParam(firstParam(searchParams.pageSize), 50), 200)

    const whereParts: any[] = []
    if (status !== 'all') {
        whereParts.push(eq(orders.status, status))
    }
    if (q) {
        const like = `%${q}%`
        whereParts.push(or(
            sql`${orders.orderId} LIKE ${like}`,
            sql`${orders.productName} LIKE ${like}`,
            sql`COALESCE(${orders.username}, '') LIKE ${like}`,
            sql`COALESCE(${orders.email}, '') LIKE ${like}`,
            sql`COALESCE(${orders.tradeNo}, '') LIKE ${like}`,
            sql`COALESCE(${orders.cardKey}, '') LIKE ${like}`
        ))
    }
    const whereExpr = whereParts.length ? and(...whereParts) : undefined

    const offset = (page - 1) * pageSize

    const countQuery = db.select({ count: sql<number>`count(*)` }).from(orders)
    const countResPromise = whereExpr ? countQuery.where(whereExpr as any) : countQuery

    const [rows, countRes] = await withOrderColumnFallback(async () => {
        return await Promise.all([
            db.query.orders.findMany({
                where: whereExpr,
                orderBy: [desc(normalizeTimestampMs(orders.createdAt))],
                limit: pageSize,
                offset,
            }),
            countResPromise,
        ])
    })

    const orderUserIds = Array.from(new Set(
        rows
            .map((o: any) => (typeof o.userId === "string" ? o.userId.trim() : ""))
            .filter((id: string) => id.length > 0)
    ))

    const loginUserRows = orderUserIds.length > 0
        ? (await Promise.all(
            chunkArray(orderUserIds, LOGIN_USER_LOOKUP_BATCH_SIZE).map((batch) =>
                db
                    .select({
                        userId: loginUsers.userId,
                        username: loginUsers.username,
                    })
                    .from(loginUsers)
                    .where(inArray(loginUsers.userId, batch))
            )
        )).flat()
        : []

    const usernameByUserId = new Map<string, string>()
    for (const row of loginUserRows) {
        if (!row.userId || !row.username) continue
        usernameByUserId.set(row.userId, row.username)
    }

    const total = countRes[0]?.count || 0

    const productIds = Array.from(new Set(rows.map((o: any) => o.productId).filter(Boolean)))
    const productVariantLabels = productIds.length > 0 ? await getProductVariantLabels(productIds) : {}

    return (
        <AdminOrdersContent
            orders={rows.map((o: any) => ({
                orderId: o.orderId,
                productId: o.productId,
                userId: o.userId,
                username: (o.userId && usernameByUserId.get(o.userId)) || o.username,
                email: o.email,
                productName: o.productName,
                amount: o.amount,
                pointsUsed: Number(o.pointsUsed || 0),
                status: o.status,
                cardKey: o.cardKey,
                tradeNo: o.tradeNo,
                createdAt: o.createdAt
            }))}
            productVariantLabels={productVariantLabels}
            total={total}
            page={page}
            pageSize={pageSize}
            query={q}
            status={status}
        />
    )
}
