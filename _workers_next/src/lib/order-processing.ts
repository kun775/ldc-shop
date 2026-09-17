import { randomUUID } from "crypto"
import { db } from "@/lib/db"
import { orders, cards, products, loginUsers as users } from "@/lib/db/schema"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { isPaymentOrder } from "@/lib/payment"
import { notifyAdminPaymentSuccess } from "@/lib/notifications"
import { sendOrderEmail } from "@/lib/email"
import {
    createUserNotification,
    ensureDatabaseInitialized,
    getLoginUserEmail,
    recalcProductAggregates,
} from "@/lib/db/queries"
import { pullOneCardFromApi } from "@/lib/card-api"
import { consumeCouponReservations } from "@/lib/coupons/reservation"
import { updateTag } from "next/cache"
import { after } from "next/server"
import { isManualFulfillment, parseFulfillmentMode } from "@/lib/fulfillment"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FULFILLMENT_CLAIM_STATUS = "processing"
const FULFILLMENT_CLAIM_TTL_MS = 10 * 60 * 1000

type FulfillmentResult = {
    success: true
    status: "processed" | "already_processed" | "processing"
    orderStatus?: string | null
}

function isValidEmail(value: string | null | undefined) {
    if (!value) return false
    return EMAIL_REGEX.test(value.trim())
}

function assertValidPaidAmount(paidAmount: number, orderAmount: string) {
    const orderMoney = Number.parseFloat(orderAmount)
    if (!Number.isFinite(paidAmount) || !Number.isFinite(orderMoney)) {
        throw new Error("Invalid payment amount")
    }
    if (Math.abs(paidAmount - orderMoney) > 0.01) {
        throw new Error(`Amount mismatch! Order: ${orderMoney}, Paid: ${paidAmount}`)
    }
}

async function refreshProductAggregates(productId: string) {
    try {
        await recalcProductAggregates(productId)
    } catch {
        // best effort
    }
    try {
        updateTag("home:products")
        updateTag("home:product-categories")
    } catch {
        // best effort
    }
}

async function notifyUserDelivered(order: typeof orders.$inferSelect, productName?: string | null) {
    if (!order.userId) return
    try {
        await createUserNotification({
            userId: order.userId,
            type: "order_delivered",
            titleKey: "profile.notifications.orderDeliveredTitle",
            contentKey: "profile.notifications.orderDeliveredBody",
            data: {
                params: {
                    orderId: order.orderId,
                    productName: productName || order.productName || "Product",
                },
                href: `/order/${order.orderId}`,
            },
        })
    } catch (error) {
        console.error("[Notification] User delivery notify failed:", error)
    }
}

async function notifyUserPaidForManualOrder(order: typeof orders.$inferSelect, productName?: string | null) {
    if (!order.userId) return
    try {
        await createUserNotification({
            userId: order.userId,
            type: "order_paid",
            titleKey: "profile.notifications.orderPaidManualTitle",
            contentKey: "profile.notifications.orderPaidManualBody",
            data: {
                params: {
                    orderId: order.orderId,
                    productName: productName || order.productName || "Product",
                },
                href: `/order/${order.orderId}`,
            },
        })
    } catch (error) {
        console.error("[Notification] Manual fulfillment user notify failed:", error)
    }
}

function scheduleAdminNotification(
    order: typeof orders.$inferSelect,
    tradeNo: string,
    productName?: string | null,
) {
    after(async () => {
        try {
            const user = order.userId
                ? await db.query.loginUsers.findFirst({
                    where: eq(users.userId, order.userId),
                    columns: { username: true },
                }).catch(() => null)
                : null

            await notifyAdminPaymentSuccess({
                orderId: order.orderId,
                productName: productName || order.productName || "Unknown Product",
                amount: order.amount,
                username: user?.username,
                email: order.email,
                tradeNo,
                checkoutFieldValues: order.checkoutFieldValues,
            })
        } catch (error) {
            console.error("[Notification] Payment success notify failed:", error)
        }
    })
}

function scheduleDeliveryEmail(
    order: typeof orders.$inferSelect,
    productName: string,
    cardKeys: string,
) {
    after(async () => {
        let recipientEmail = (order.email || "").trim()
        let profileEmail = ""

        if (order.userId) {
            try {
                profileEmail = ((await getLoginUserEmail(order.userId)) || "").trim()
            } catch {
                // best effort
            }
        }

        if (profileEmail && isValidEmail(profileEmail)) {
            if (!recipientEmail || recipientEmail.toLowerCase().endsWith("@privaterelay.linux.do")) {
                recipientEmail = profileEmail
            }
        } else if (!recipientEmail && profileEmail) {
            recipientEmail = profileEmail
        }

        if (!recipientEmail || !isValidEmail(recipientEmail)) return

        await sendOrderEmail({
            to: recipientEmail,
            orderId: order.orderId,
            productName,
            cardKeys,
        }).catch((error) => console.error("[Email] Send failed:", error))
    })
}

async function autoReplenishByApi(productId: string, reason: string) {
    try {
        const result = await pullOneCardFromApi(productId)
        if (result.ok) {
            await refreshProductAggregates(productId)
            console.log(`[Card API] Auto replenished for product ${productId}, reason=${reason}`)
            return
        }
        if (result.skipped) {
            console.info(`[Card API] Auto replenish skipped for product ${productId}, reason=${reason}, detail=${result.error || "skipped"}`)
            return
        }
        console.warn(`[Card API] Auto replenish failed for product ${productId}: ${result.error || "unknown_error"}`)
    } catch (error: any) {
        console.warn(`[Card API] Auto replenish exception for product ${productId}: ${error?.message || "unknown_error"}`)
    }
}

async function finalizePaidOrder(orderId: string, claimId: string, tradeNo: string, fulfillmentMode?: string | null) {
    // 核销优惠券预占：幂等，重复支付回调不会重复扣次数
    await consumeCouponReservations(orderId)

    const updated = await db.update(orders)
        .set({
            status: "paid",
            paidAt: new Date(),
            tradeNo,
            currentPaymentId: null,
            fulfillmentClaimId: null,
            fulfillmentClaimedAt: null,
            ...(fulfillmentMode ? { fulfillmentMode } : {}),
        })
        .where(and(
            eq(orders.orderId, orderId),
            eq(orders.status, FULFILLMENT_CLAIM_STATUS),
            eq(orders.fulfillmentClaimId, claimId),
        ))
        .returning({ status: orders.status })

    if (!updated.length) throw new Error(`Order ${orderId} lost fulfillment claim`)
}

async function finalizeSharedDelivery(
    order: typeof orders.$inferSelect,
    claimId: string,
    tradeNo: string,
    cardKey: string,
) {
    const quantity = Math.max(1, Number(order.quantity || 1))
    const joinedKeys = Array(quantity).fill(cardKey).join("\n")

    await consumeCouponReservations(order.orderId)

    const updated = await db.update(orders)
        .set({
            status: "delivered",
            paidAt: new Date(),
            deliveredAt: new Date(),
            tradeNo,
            cardKey: joinedKeys,
            currentPaymentId: null,
            fulfillmentClaimId: null,
            fulfillmentClaimedAt: null,
        })
        .where(and(
            eq(orders.orderId, order.orderId),
            eq(orders.status, FULFILLMENT_CLAIM_STATUS),
            eq(orders.fulfillmentClaimId, claimId),
        ))
        .returning({ status: orders.status })

    if (!updated.length) throw new Error(`Order ${order.orderId} lost fulfillment claim`)
    return joinedKeys
}

async function reserveCardsForFulfillment(order: typeof orders.$inferSelect) {
    const quantity = Math.max(1, Number(order.quantity || 1))
    const nowMs = Date.now()
    const refreshed: any = await db.run(sql`
        UPDATE cards
        SET reserved_at = ${nowMs}
        WHERE id IN (
            SELECT id FROM cards
            WHERE product_id = ${order.productId}
              AND reserved_order_id = ${order.orderId}
              AND (is_used = 0 OR is_used IS NULL)
              AND (expires_at IS NULL OR expires_at > ${nowMs})
            ORDER BY id
            LIMIT ${quantity}
        )
        RETURNING id, card_key
    `)
    const refreshedRows = refreshed?.results || refreshed?.rows || []
    const selected = refreshedRows.map((row: any) => ({
        id: Number(row.id),
        cardKey: String(row.card_key ?? row.cardKey ?? ""),
    }))
    const selectedIds = new Set(selected.map((card: { id: number }) => card.id))

    while (selected.length < quantity) {
        const claimTime = Date.now()
        const claimed: any = await db.run(sql`
            UPDATE cards
            SET reserved_order_id = ${order.orderId}, reserved_at = ${claimTime}
            WHERE id = (
                SELECT id FROM cards
                WHERE product_id = ${order.productId}
                  AND (is_used = 0 OR is_used IS NULL)
                  AND reserved_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ${claimTime})
                ORDER BY id
                LIMIT 1
            )
            RETURNING id, card_key
        `)
        const rows = claimed?.results || claimed?.rows || []
        if (!rows.length) break

        const row = rows[0]
        const id = Number(row.id)
        if (selectedIds.has(id)) continue
        selectedIds.add(id)
        selected.push({ id, cardKey: String(row.card_key ?? row.cardKey ?? "") })
    }

    return selected.slice(0, quantity)
}

async function finalizeCardDelivery(
    order: typeof orders.$inferSelect,
    claimId: string,
    tradeNo: string,
    selectedCards: Array<{ id: number; cardKey: string }>,
) {
    const joinedKeys = selectedCards.map((card) => card.cardKey).join("\n")
    const selectedIds = selectedCards.map((card) => card.id)
    const cardIdsValue = selectedIds.join(",")
    const nowMs = Date.now()
    const placeholders = sql.join(selectedIds.map((id) => sql`${id}`), sql`, `)

    const consumed: any = await db.run(sql`
        UPDATE cards
        SET is_used = 1,
            used_at = ${nowMs},
            reserved_order_id = NULL,
            reserved_at = NULL
        WHERE id IN (${placeholders})
          AND reserved_order_id = ${order.orderId}
          AND (is_used = 0 OR is_used IS NULL)
        RETURNING id
    `)
    const consumedRows = consumed?.results || consumed?.rows || []
    if (consumedRows.length !== selectedCards.length) {
        throw new Error(`Order ${order.orderId} lost reserved cards before delivery`)
    }

    await consumeCouponReservations(order.orderId)

    const finalized = await db.update(orders)
        .set({
            status: "delivered",
            paidAt: new Date(nowMs),
            deliveredAt: new Date(nowMs),
            tradeNo,
            cardKey: joinedKeys,
            cardIds: cardIdsValue,
            currentPaymentId: null,
            fulfillmentClaimId: null,
            fulfillmentClaimedAt: null,
        })
        .where(and(
            eq(orders.orderId, order.orderId),
            eq(orders.status, FULFILLMENT_CLAIM_STATUS),
            eq(orders.fulfillmentClaimId, claimId),
        ))
        .returning({ status: orders.status })

    if (!finalized.length) {
        throw new Error(`Order ${order.orderId} lost fulfillment claim before delivery`)
    }

    return joinedKeys
}

async function restoreClaimAfterFailure(
    order: typeof orders.$inferSelect,
    claimId: string,
) {
    try {
        await db.update(orders)
            .set({
                status: order.status || "pending",
                paidAt: order.paidAt,
                tradeNo: order.tradeNo,
                currentPaymentId: order.currentPaymentId,
                fulfillmentClaimId: order.fulfillmentClaimId,
                fulfillmentClaimedAt: order.fulfillmentClaimedAt,
            })
            .where(and(
                eq(orders.orderId, order.orderId),
                eq(orders.status, FULFILLMENT_CLAIM_STATUS),
                eq(orders.fulfillmentClaimId, claimId),
            ))
    } catch (error) {
        console.error(`[Fulfill] Failed to release claim for order ${order.orderId}:`, error)
    }
}

export async function processOrderFulfillment(
    orderId: string,
    paidAmount: number,
    tradeNo: string,
): Promise<FulfillmentResult> {
    await ensureDatabaseInitialized()

    const existing = await db.query.orders.findFirst({
        where: eq(orders.orderId, orderId),
    })
    if (!existing) throw new Error(`Order ${orderId} not found`)

    assertValidPaidAmount(paidAmount, existing.amount)

    if (existing.status === "paid" || existing.status === "delivered") {
        return { success: true, status: "already_processed", orderStatus: existing.status }
    }

    const now = new Date()
    const claimId = randomUUID()
    const staleBefore = new Date(now.getTime() - FULFILLMENT_CLAIM_TTL_MS)
    const claimableStatus = or(
        eq(orders.status, "pending"),
        and(
            eq(orders.status, FULFILLMENT_CLAIM_STATUS),
            or(isNull(orders.fulfillmentClaimedAt), lt(orders.fulfillmentClaimedAt, staleBefore)),
        ),
    )

    const claimed = await db.update(orders)
        .set({
            status: FULFILLMENT_CLAIM_STATUS,
            paidAt: now,
            tradeNo,
            currentPaymentId: null,
            fulfillmentClaimId: claimId,
            fulfillmentClaimedAt: now,
        })
        .where(and(eq(orders.orderId, orderId), claimableStatus))
        .returning({ orderId: orders.orderId })

    if (!claimed.length) {
        const latest = await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: { status: true },
        })
        if (!latest) throw new Error(`Order ${orderId} disappeared during fulfillment`)
        if (latest.status === FULFILLMENT_CLAIM_STATUS) {
            return { success: true, status: "processing", orderStatus: latest.status }
        }
        if (latest.status === "paid" || latest.status === "delivered") {
            return { success: true, status: "already_processed", orderStatus: latest.status }
        }
        throw new Error(`Order ${orderId} is not claimable from status ${latest.status || "unknown"}`)
    }

    try {
        if (isPaymentOrder(existing.productId)) {
            await finalizePaidOrder(orderId, claimId, tradeNo)
            scheduleAdminNotification(existing, tradeNo, "Payment (QR/Link)")
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "paid" }
        }

        const product = await db.query.products.findFirst({
            where: eq(products.id, existing.productId),
            columns: { isShared: true, name: true, fulfillmentMode: true },
        })
        const productName = product?.name || existing.productName || "Product"
        const fulfillmentMode = parseFulfillmentMode(existing.fulfillmentMode || product?.fulfillmentMode)

        if (isManualFulfillment(fulfillmentMode)) {
            await finalizePaidOrder(orderId, claimId, tradeNo, fulfillmentMode)
            await notifyUserPaidForManualOrder(existing, productName)
            scheduleAdminNotification(existing, tradeNo, productName)
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "paid" }
        }

        if (product?.isShared) {
            const availableCard = await db.select({ id: cards.id, cardKey: cards.cardKey })
                .from(cards)
                .where(and(
                    eq(cards.productId, existing.productId),
                    or(eq(cards.isUsed, false), isNull(cards.isUsed)),
                ))
                .orderBy(sql`RANDOM()`)
                .limit(1)

            if (!availableCard.length) {
                await finalizePaidOrder(orderId, claimId, tradeNo)
                scheduleAdminNotification(existing, tradeNo, productName)
                await refreshProductAggregates(existing.productId)
                return { success: true, status: "processed", orderStatus: "paid" }
            }

            const joinedKeys = await finalizeSharedDelivery(existing, claimId, tradeNo, availableCard[0].cardKey)
            await notifyUserDelivered(existing, productName)
            scheduleAdminNotification(existing, tradeNo, productName)
            scheduleDeliveryEmail(existing, productName, joinedKeys)
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "delivered" }
        }

        const selectedCards = await reserveCardsForFulfillment(existing)
        const quantity = Math.max(1, Number(existing.quantity || 1))
        if (selectedCards.length < quantity) {
            await db.update(cards)
                .set({ reservedOrderId: null, reservedAt: null })
                .where(and(
                    eq(cards.reservedOrderId, orderId),
                    or(eq(cards.isUsed, false), isNull(cards.isUsed)),
                ))
            await finalizePaidOrder(orderId, claimId, tradeNo)
            scheduleAdminNotification(existing, tradeNo, productName)
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "paid" }
        }

        const joinedKeys = await finalizeCardDelivery(existing, claimId, tradeNo, selectedCards)
        await notifyUserDelivered(existing, productName)
        scheduleAdminNotification(existing, tradeNo, productName)
        scheduleDeliveryEmail(existing, productName, joinedKeys)
        await refreshProductAggregates(existing.productId)
        await autoReplenishByApi(existing.productId, `order:${orderId}`)
        console.log(`[Fulfill] Order ${orderId} delivered successfully`)
        return { success: true, status: "processed", orderStatus: "delivered" }
    } catch (error) {
        await restoreClaimAfterFailure(existing, claimId)
        throw error
    }
}
