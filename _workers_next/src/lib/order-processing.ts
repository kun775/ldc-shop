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
    pickSharedDeliveryCard,
    recalcProductAggregates,
} from "@/lib/db/queries"
import { pullOneCardFromApi } from "@/lib/card-api"
import { getProductCardDeliveryNote } from "@/lib/card-delivery-note"
import { consumeCouponReservations } from "@/lib/coupons/reservation"
import {
    OrderSaleError,
    buildDeliverOrderStatements,
    buildOrderSaleDeps,
    executeOrderRemoteSales,
    isLicenseServiceConfigured,
    listPendingSellOperations,
    loadOrderRemoteSalePlan,
    mapOrderSaleFailure,
    mapOrderSalePlanFailure,
    type OrderRemoteSaleGroup,
} from "@/lib/license-service"
import { createD1CardServiceDatabase } from "@/lib/license-service/database"
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

/**
 * 自动化发卡订单的交付结论。
 *
 * `delivered = false` 表示明文**尚未**对用户开放（订单被回落到 `paid`，等待
 * 回调重试或对账补偿），调用方不得发送卡密邮件，也不能把订单说成交付完成。
 * 阶段 D 的「Sell 未确认不交付」就体现在这个字段上。
 */
export interface AutomatedDeliveryOutcome {
    orderStatus: "delivered" | "paid" | "processing"
    delivered: boolean
    cardKeys: string
    deliveryNote: string
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
    deliveryNote: string,
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
            deliveryNote,
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
    deliveryNote: string,
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
            deliveryNote: deliveryNote || null,
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

/**
 * 交付批次：**订单、本地卡、远端映射、操作台账一次性写入**。
 *
 * 语句由 `buildDeliverOrderStatements` 构造，顺序本身就是安全边界：
 * ① 订单行带全部前置条件（claim 仍属于本线程、卡仍在预留、映射可售），
 * 不满足就 0 行受影响；② 之后的每条语句都以「本批次刚把订单写成 delivered」
 * 为前置条件。D1 的 batch 整批原子，因此不存在「卡已用而订单未交付」的中间态。
 *
 * `remoteGroups` 为空时不引用任何 `card_service_*` 表 —— 升级项 `0038`
 * 未执行时纯本地交付必须照常工作。
 */
async function finalizeCardDelivery(
    order: typeof orders.$inferSelect,
    claimId: string,
    tradeNo: string,
    selectedCards: Array<{ id: number; cardKey: string }>,
    deliveryNote: string,
    remoteGroups: ReadonlyArray<{ allocationId: string; localCardIds: number[] }>,
) {
    const joinedKeys = selectedCards.map((card) => card.cardKey).join("\n")
    const selectedIds = selectedCards.map((card) => card.id)
    const database = createD1CardServiceDatabase()

    const results = await database.write(buildDeliverOrderStatements({
        orderId: order.orderId,
        claimId,
        tradeNo,
        cardKey: joinedKeys,
        localCardIds: selectedIds,
        deliveryNote: deliveryNote || null,
        nowMs: Date.now(),
        remoteGroups,
    }))

    if (!results[0]?.changes) {
        throw new Error(`Order ${order.orderId} lost fulfillment claim before delivery`)
    }
    if (results[1]?.changes !== selectedIds.length) {
        throw new Error(`Order ${order.orderId} lost reserved cards before delivery`)
    }

    return joinedKeys
}

/**
 * 阶段 D 的核心闸门：**远端卡必须在本地交付之前全部售出**。
 *
 * 返回需要标记 `sold` 的批次；空数组表示纯本地订单，走既有路径（连中心配置
 * 都不需要）。任何不可交付的情形都抛 `OrderSaleError`：调用方会把订单回落到
 * `paid`，由支付回调重试或对账重放推进 —— 绝不「先交付再补 Sell」。
 */
async function sellRemoteCardsForOrder(
    order: typeof orders.$inferSelect,
    selectedCards: Array<{ id: number; cardKey: string }>,
): Promise<OrderRemoteSaleGroup[]> {
    const database = createD1CardServiceDatabase()
    const plan = await loadOrderRemoteSalePlan(database, {
        orderId: order.orderId,
        localCardIds: selectedCards.map((card) => card.id),
    })

    if (plan.kind === "none") return []

    if (plan.kind === "blocked") {
        console.error(
            `[Fulfill] Order ${order.orderId} remote sale blocked: reason=${plan.reason} allocation=${plan.allocationId || "n/a"} detail=${plan.detail}`,
        )
        throw mapOrderSalePlanFailure(plan)
    }

    // 只有在确认订单确实含远端卡之后才要求中心配置：否则纯本地订单会被一个
    // 与它无关的配置缺失挡住。
    if (!isLicenseServiceConfigured()) {
        throw new OrderSaleError({
            reason: "config_error",
            errorCode: "config_error",
            retryable: false,
            detail: "LICENSE_SERVICE_BASE_URL / LICENSE_SERVICE_API_KEY is not configured",
        })
    }

    const outcome = await executeOrderRemoteSales(buildOrderSaleDeps(), {
        orderId: order.orderId,
        groups: plan.groups,
    })

    if (outcome.status !== "confirmed") {
        console.error(
            `[Fulfill] Order ${order.orderId} remote sell not confirmed: status=${outcome.status}`
            + ` reason=${outcome.status === "deferred" ? "deferred" : outcome.reason}`
            + ` code=${outcome.status === "deferred" ? outcome.error.code : outcome.errorCode}`,
        )
        throw mapOrderSaleFailure(outcome)
    }

    return plan.groups
}

/**
 * 自动化发卡（普通商品）的交付核心：预留 → 远端 Sell → 原子交付。
 *
 * 付费回调与零元订单共用这一条路径，因此「Sell 先于展示」只有一个实现点，
 * 不会出现某条分支绕过远端 Sell 的情况。
 */
async function deliverAutomatedCardOrder(
    order: typeof orders.$inferSelect,
    claimId: string,
    tradeNo: string,
): Promise<AutomatedDeliveryOutcome> {
    const quantity = Math.max(1, Number(order.quantity || 1))
    const selectedCards = await reserveCardsForFulfillment(order)

    if (selectedCards.length < quantity) {
        // 已收款但卡不足：退回预留、订单留在 `paid` 等待补货/人工，绝不能交付部分卡。
        await db.update(cards)
            .set({ reservedOrderId: null, reservedAt: null })
            .where(and(
                eq(cards.reservedOrderId, order.orderId),
                or(eq(cards.isUsed, false), isNull(cards.isUsed)),
            ))
        await finalizePaidOrder(order.orderId, claimId, tradeNo)
        return { orderStatus: "paid", delivered: false, cardKeys: "", deliveryNote: "" }
    }

    const deliveryNote = await getProductCardDeliveryNote(order.productId).catch((error) => {
        console.error("[Order] Failed to load card delivery note:", error)
        return ""
    })

    const soldGroups = await sellRemoteCardsForOrder(order, selectedCards)

    // 券核销放在交付批次之前：批次必须是「一次成功」的最后一步，不能在其中夹带
    // 跨模块调用。`consumeCouponReservations` 自身幂等，重放安全。
    await consumeCouponReservations(order.orderId)

    const joinedKeys = await finalizeCardDelivery(
        order,
        claimId,
        tradeNo,
        selectedCards,
        deliveryNote,
        soldGroups.map((group) => ({ allocationId: group.allocationId, localCardIds: group.localCardIds })),
    )

    return { orderStatus: "delivered", delivered: true, cardKeys: joinedKeys, deliveryNote }
}

/**
 * 释放失败时的履约声明。
 *
 * `asPaid` 用于「支付已确认、只是交付没做完」的场景（阶段 D 的 Sell 未确认、
 * 卡不足等）：此时必须回落到 `paid` 而不是 `pending`，否则订单会被
 * `cancelExpiredOrders` 当成未支付订单取消，而已收款的订单是不能被取消的。
 */
async function restoreClaimAfterFailure(
    order: typeof orders.$inferSelect,
    claimId: string,
    asPaid?: { paidAt: Date; tradeNo: string },
) {
    try {
        await db.update(orders)
            .set({
                status: asPaid ? "paid" : (order.status || "pending"),
                paidAt: asPaid ? asPaid.paidAt : order.paidAt,
                tradeNo: asPaid ? asPaid.tradeNo : order.tradeNo,
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

    // 支付已确认、交付未完成时的回落目标（见 restoreClaimAfterFailure）。
    let paidFallback: { paidAt: Date; tradeNo: string } | null = null

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
            // 共享商品取一张可用卡作为交付引用。取卡口径收敛在
            // `pickSharedDeliveryCard`：它排除了**有远端映射的卡** —— 那些卡归通用
            // 卡密服务中心管理，而共享交付发明文**绕过 Sell**，取到就等于造出一张
            // 中心永远显示「未售出」的卡（账目对不上、退款也无从作废）。
            const pickedCard = await pickSharedDeliveryCard(existing.productId)

            if (!pickedCard) {
                await finalizePaidOrder(orderId, claimId, tradeNo)
                scheduleAdminNotification(existing, tradeNo, productName)
                await refreshProductAggregates(existing.productId)
                return { success: true, status: "processed", orderStatus: "paid" }
            }

            const deliveryNote = await getProductCardDeliveryNote(existing.productId).catch((error) => {
                console.error("[Order] Failed to load card delivery note:", error)
                return ""
            })
            const joinedKeys = await finalizeSharedDelivery(existing, claimId, tradeNo, pickedCard.cardKey, deliveryNote)
            await notifyUserDelivered(existing, productName)
            scheduleAdminNotification(existing, tradeNo, productName)
            scheduleDeliveryEmail(existing, productName, joinedKeys, deliveryNote)
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "delivered" }
        }

        // 自动化发卡：远端 Sell 未确认前一律不得交付，失败时订单回落到 `paid`
        //（而不是 `pending`），由回调重试或对账重放推进。
        paidFallback = { paidAt: now, tradeNo }
        const delivery = await deliverAutomatedCardOrder(existing, claimId, tradeNo)

        if (!delivery.delivered) {
            console.warn(`[Fulfill] Order ${orderId} is paid but not delivered; waiting for stock or compensation`)
            scheduleAdminNotification(existing, tradeNo, productName)
            await refreshProductAggregates(existing.productId)
            return { success: true, status: "processed", orderStatus: "paid" }
        }

        await notifyUserDelivered(existing, productName)
        scheduleAdminNotification(existing, tradeNo, productName)
        scheduleDeliveryEmail(existing, productName, delivery.cardKeys, delivery.deliveryNote)
        await refreshProductAggregates(existing.productId)
        await autoReplenishByApi(existing.productId, `order:${orderId}`)
        console.log(`[Fulfill] Order ${orderId} delivered successfully`)
        return { success: true, status: "processed", orderStatus: "delivered" }
    } catch (error) {
        await restoreClaimAfterFailure(existing, claimId, paidFallback ?? undefined)
        throw error
    }
}

/**
 * 零元订单（积分/券全额抵扣）的交付入口 —— 阶段 D 第 5 条。
 *
 * 零元订单由 `checkout.ts` 直接落成 `paid`（不经过支付回调），因此不能走
 * `processOrderFulfillment` 的 `pending` 认领分支；但它**必须**与付费订单
 * 共用同一条「Sell → 原子交付」核心，否则零元订单会绕开远端 Sell 直接发卡。
 *
 * 认领条件收紧为「已支付且 `card_key` 为空」；调用方必须先排除手动履约商品
 *（手动履约订单同样是 `paid`，但不需要自动化发卡）。
 *
 * 与 `processOrderFulfillment` 的关键差别：**交付未完成不抛错**，返回
 * `delivered: false` 并把订单留在 `paid`。原因是抛错会让下单流程走回滚分支，
 * 而零元订单的积分/券已经扣掉，删单重建就等于重复扣减 —— 方案要求所有补偿
 * 都依据原订单号推进，所以订单必须留下来。
 *
 * 声明租约（`fulfillment_claimed_at` + 10 分钟）在这里是**可回收**的：租约一过
 * 就允许重新认领。零元订单没有支付回调这条重放路径，如果 `processing` 是不可
 * 逆的终态，一次进程被杀就能让订单永久卡住（既不会交付、也不会过期取消）。
 */
export async function completePaidOrderDelivery(orderId: string): Promise<AutomatedDeliveryOutcome> {
    await ensureDatabaseInitialized()

    const existing = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!existing) throw new Error(`Order ${orderId} not found`)

    if (existing.status === "delivered") {
        return { orderStatus: "delivered", delivered: true, cardKeys: existing.cardKey || "", deliveryNote: existing.deliveryNote || "" }
    }
    if (existing.status === "pending") {
        // 订单尚未被标记为已支付：不做任何事。
        return { orderStatus: "processing", delivered: false, cardKeys: "", deliveryNote: "" }
    }
    // 租约已过期的 `processing` 是**可回收**的声明：它必须能继续往下重新认领，
    // 否则进程在交付中途被杀留下的 `processing` 会让订单**永久卡死** ——
    // 既不会被重新认领，也不会被 `cancelExpiredOrders` 取消（那不是 `pending`）。
    // 零元订单是重灾区：它没有支付回调这条重放路径，只有本函数能把它救回来。
    let reclaimableStaleClaim = false
    if (existing.status === FULFILLMENT_CLAIM_STATUS) {
        // 声明租约**尚未过期**才让开 —— 那是别的请求正在交付。
        const claimedAt = existing.fulfillmentClaimedAt
        const claimedAtMs = claimedAt instanceof Date ? claimedAt.getTime() : Number(claimedAt ?? 0)
        const leaseUntilMs = Number.isFinite(claimedAtMs) && claimedAtMs > 0
            ? claimedAtMs + FULFILLMENT_CLAIM_TTL_MS
            : 0
        if (leaseUntilMs > Date.now()) {
            return { orderStatus: "processing", delivered: false, cardKeys: "", deliveryNote: "" }
        }
        reclaimableStaleClaim = true
    }
    // 只处理「已付款且未交付」的订单，外加租约已过期的 `processing` 声明（可回收）。
    // 其余终态（`refunded` / `cancelled` 等）一律不动 —— 交付自动化不能复活终态订单。
    // ⚠️ 这个判断必须放行 `reclaimableStaleClaim`：漏掉它，上面「租约过期则继续往下抢」
    // 就成了一段走到这里又被挡回去的死代码（下方 `claimable` 条件与这里同一口径）。
    if (existing.cardKey || (existing.status !== "paid" && !reclaimableStaleClaim)) {
        return { orderStatus: "processing", delivered: false, cardKeys: "", deliveryNote: "" }
    }

    const now = new Date()
    const claimId = randomUUID()
    const staleBefore = new Date(now.getTime() - FULFILLMENT_CLAIM_TTL_MS)
    const claimable = and(
        eq(orders.orderId, orderId),
        isNull(orders.cardKey),
        or(
            eq(orders.status, "paid"),
            and(
                eq(orders.status, FULFILLMENT_CLAIM_STATUS),
                or(isNull(orders.fulfillmentClaimedAt), lt(orders.fulfillmentClaimedAt, staleBefore)),
            ),
        ),
    )

    const claimed = await db.update(orders)
        .set({
            status: FULFILLMENT_CLAIM_STATUS,
            currentPaymentId: null,
            fulfillmentClaimId: claimId,
            fulfillmentClaimedAt: now,
        })
        .where(claimable)
        .returning({ orderId: orders.orderId })

    if (!claimed.length) {
        // 另一个请求持有声明（10 分钟租约）或订单已交付：交给调用方稍后重试。
        return { orderStatus: "processing", delivered: false, cardKeys: "", deliveryNote: "" }
    }

    const tradeNo = existing.tradeNo || "POINTS_REDEMPTION"
    try {
        const delivery = await deliverAutomatedCardOrder(existing, claimId, tradeNo)
        if (delivery.delivered) {
            await notifyUserDelivered(existing)
            scheduleDeliveryEmail(existing, existing.productName || "Product", delivery.cardKeys, delivery.deliveryNote)
            console.log(`[Fulfill] Zero-price order ${orderId} delivered successfully`)
        }
        return delivery
    } catch (error) {
        // 交付未完成：回落到 `paid` 并保留原订单，由对账/重试入口继续推进。
        const saleError = error instanceof OrderSaleError ? error : null
        console.error(
            `[Fulfill] Zero-price order ${orderId} delivery deferred:`
            + ` reason=${saleError?.reason ?? "unexpected"}`
            + ` retryable=${saleError ? saleError.retryable : "unknown"}`
            + ` code=${saleError?.errorCode ?? "n/a"}`,
        )
        await restoreClaimAfterFailure(existing, claimId, { paidAt: existing.paidAt ?? now, tradeNo })
        return { orderStatus: "paid", delivered: false, cardKeys: "", deliveryNote: "" }
    }
}

/**
 * 补偿入口：把「已支付但未交付」的远端订单按原样重放到交付核心。
 *
 * 触发源是操作台账里的 `sell` 待办（`pending`/`failed`），因此不会误碰手动履约
 * 订单，也不需要扫描全部订单。定时任务（阶段 E）调用它；同一次运行里每个订单
 * 只处理一次，重放用的幂等键与原订单号绑定，重复执行不会多卖一张卡。
 */
export async function retryPendingCardServiceDeliveries(
    options: { limit?: number } = {},
): Promise<{ attempted: number; delivered: number; deferred: number }> {
    await ensureDatabaseInitialized()

    const database = createD1CardServiceDatabase()
    const pending = await listPendingSellOperations(database, { limit: options.limit ?? 20, respectBackoff: true })
    const orderIds = Array.from(new Set(pending.map((row) => row.orderId).filter((id): id is string => !!id)))

    let delivered = 0
    let deferred = 0
    for (const orderId of orderIds) {
        try {
            const outcome = await completePaidOrderDelivery(orderId)
            if (outcome.delivered) delivered += 1
            else deferred += 1
        } catch (error) {
            deferred += 1
            console.error(`[Fulfill] Retry delivery failed for order ${orderId}:`, error)
        }
    }

    return { attempted: orderIds.length, delivered, deferred }
}
