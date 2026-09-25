'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { products, cards, orders, loginUsers } from "@/lib/db/schema"
import { cancelExpiredOrders, cleanupExpiredCardsIfNeeded, createUserNotification, ensureDatabaseInitialized, getLoginUserEmail, recalcProductAggregates } from "@/lib/db/queries"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { eq, sql, and, or, isNull, lt, gt, inArray } from "drizzle-orm"
import { cookies } from "next/headers"
import { revalidatePath, updateTag } from "next/cache"
import { after } from "next/server"
import { notifyAdminPaymentSuccess } from "@/lib/notifications"
import { sendOrderEmail } from "@/lib/email"
import { INFINITE_STOCK, RESERVATION_TTL_MS, SHARED_CARD_CANDIDATE_WINDOW } from "@/lib/constants"
import { pullOneCardFromApi } from "@/lib/card-api"
import { getProductCardDeliveryNote } from "@/lib/card-delivery-note"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import { POINT_AUTOMATIC_ERROR_KEY_MAP } from "@/lib/points/point-errors"
import { resolveClientErrorKey } from "@/lib/errors/safe-error"
import { normalizeCouponCodeList } from "@/lib/coupons/code"
import { resolveCouponQuote } from "@/lib/coupons/checkout-quote"
import { centsToLdcNumber, centsToLdcString } from "@/lib/coupons/money"
import { consumeCouponReservations, releaseCouponUsages, reserveCouponUsages } from "@/lib/coupons/reservation"
import type { CouponReservationLine } from "@/lib/coupons/reservation"
import { isCouponsEnabled } from "@/lib/coupons/flag"
import { parseCheckoutFieldConfigs, validateCheckoutFieldValues } from "@/lib/checkout-fields"
import { isManualFulfillment, parseFulfillmentMode } from "@/lib/fulfillment"
import { createOrderAccessToken, ORDER_ACCESS_COOKIE, ORDER_ACCESS_TTL_SECONDS } from "@/lib/order-access"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"
import { processOrderFulfillment } from "@/lib/order-processing"
import { enforceRateLimit } from "@/lib/rate-limit"

const MAX_ORDER_QUANTITY = 10000
const CARD_UPDATE_BATCH_SIZE = 80
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(value: string | null | undefined) {
    if (!value) return false
    return EMAIL_REGEX.test(value.trim())
}

async function autoReplenishByApi(productId: string, reason: string) {
    try {
        const result = await pullOneCardFromApi(productId)
        if (result.ok) {
            console.log(`[Card API] Auto replenished for product ${productId}, reason=${reason}`)
            return
        }
        if (result.skipped) {
            console.info(`[Card API] Auto replenish skipped for product ${productId}, reason=${reason}, detail=${result.error || "skipped"}`)
            return
        }
        console.warn(`[Card API] Auto replenish failed for product ${productId}, reason=${reason}, detail=${result.error || "unknown_error"}`)
    } catch (error: any) {
        console.warn(`[Card API] Auto replenish exception for product ${productId}, reason=${reason}, detail=${error?.message || "unknown_error"}`)
    }
}

export async function createOrder(productId: string, quantity: number = 1, email?: string, usePoints: boolean = false, answers?: string[], checkoutFieldValues?: Record<string, string>, couponCodesInput?: string[]) {
    await ensureDatabaseInitialized()
    const session = await auth()
    const user = session?.user

    // 限流必须挡在商品校验与卡密预留之前：
    // 刷单请求的真实代价是「预留卡密 + 写 pending 订单」，越早拦截越省资源。
    const rateLimit = await enforceRateLimit('order:create', user?.id)
    if (!rateLimit.allowed) {
        return { success: false, error: 'common.tooManyRequests' }
    }

    const normalizedQuantity = Number(quantity)

    if (!Number.isFinite(normalizedQuantity) || !Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
        return { success: false, error: 'buy.invalidQuantity' }
    }

    quantity = normalizedQuantity

    // 1. Get Product
    const product = await db.query.products.findFirst({
        where: eq(products.id, productId),
        columns: {
            id: true,
            name: true,
            price: true,
            purchaseLimit: true,
            isShared: true,
            purchaseQuestions: true,
            checkoutFields: true,
            fulfillmentMode: true,
            manualStockCount: true,
            pointDiscountEnabled: true,
            pointDiscountPercent: true,
            couponUsageRestriction: true,
        }
    })
    if (!product) return { success: false, error: 'buy.productNotFound' }

    if (product.purchaseQuestions) {
        try {
            const qs: Array<{ q: string; a: string }> = JSON.parse(product.purchaseQuestions)
            if (Array.isArray(qs) && qs.length > 0) {
                if (!answers || answers.length !== qs.length) {
                    return { success: false, error: 'buy.answersRequired' }
                }
                const allCorrect = qs.every((q, i) => {
                    const userAnswer = (answers[i] || '').trim().toLowerCase()
                    return userAnswer === q.a.trim().toLowerCase()
                })
                if (!allCorrect) {
                    return { success: false, error: 'buy.questionsWrong' }
                }
            }
        } catch { /* malformed JSON, skip */ }
    }

    const checkoutFieldValidation = validateCheckoutFieldValues(
        parseCheckoutFieldConfigs(product.checkoutFields),
        checkoutFieldValues
    )
    if (!checkoutFieldValidation.ok) {
        return { success: false, error: checkoutFieldValidation.error }
    }
    const checkoutFieldValuesPayload = checkoutFieldValidation.payload

    const purchaseLimit = product.purchaseLimit && product.purchaseLimit > 0 ? product.purchaseLimit : null
    const maxQuantity = purchaseLimit ?? MAX_ORDER_QUANTITY

    if (quantity > maxQuantity) {
        return { success: false, error: purchaseLimit ? 'buy.limitExceeded' : 'buy.quantityTooLarge' }
    }

    // 2. Check Blocked Status
    if (user?.id) {
        await ensurePointLedgerUserRecord({
            userId: user.id,
            username: session?.user?.username ?? null,
            email: user.email ?? null,
        })

        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { isBlocked: true }
        });
        if (userRec?.isBlocked) {
            return { success: false, error: 'buy.userBlocked' };
        }
    }

    let availablePoints = 0
    if (user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { points: true }
        })
        availablePoints = userRec?.points || 0
    }

    // 优惠券定价：商品小计 → 优惠券优惠 → 券后金额 → 积分抵扣 → 最终应付
    const couponCodes = normalizeCouponCodeList(couponCodesInput)
    if (couponCodes.length > 0 && !(await isCouponsEnabled())) {
        return { success: false, error: 'coupon.errors.unavailable' }
    }

    const quote = await resolveCouponQuote({
        product,
        quantity,
        codes: couponCodes,
        usePoints,
        userId: user?.id ?? null,
        availablePoints,
    })
    if (!quote.ok) {
        return { success: false, error: quote.error }
    }

    const pricing = quote.result
    const pointsToUse = pricing.pointsToUse
    const finalAmountCents = pricing.finalAmountCents
    const finalAmount = centsToLdcNumber(finalAmountCents)

    const couponByCouponId = new Map(quote.entries.map((entry) => [entry.coupon.id, entry.coupon]))
    const couponReservationLines: CouponReservationLine[] = pricing.lines
        .map((line) => {
            const coupon = couponByCouponId.get(line.couponId)
            if (!coupon) return null
            return {
                coupon,
                sequence: line.sequence,
                eligibleAmountCents: line.eligibleAmountCents,
                discountAmountCents: line.discountAmountCents,
                ruleSnapshot: line.ruleSnapshot,
            } satisfies CouponReservationLine
        })
        .filter((line): line is CouponReservationLine => line !== null)

    const isZeroPrice = finalAmountCents <= 0

    // 订单金额快照：历史订单只依赖快照，不随优惠券主表变更而漂移
    const orderSnapshotFields = {
        amount: centsToLdcString(finalAmountCents),
        subtotalAmountCents: quote.subtotalCents,
        couponDiscountAmountCents: pricing.couponDiscountCents,
        pointsDiscountAmountCents: pricing.pointsDiscountCents,
        pricingSnapshot: pricing.pricingSnapshot,
    }
    const fulfillmentMode = parseFulfillmentMode(product.fulfillmentMode)
    const manualFulfillment = isManualFulfillment(fulfillmentMode)
    const rawContact = (email || '').trim()
    let customProfileEmail = ''
    if (user?.id) {
        try {
            customProfileEmail = ((await getLoginUserEmail(user.id)) || '').trim()
        } catch {
            // best effort
        }
    }
    const oauthEmail = (user?.email || '').trim()
    const contactInfo = rawContact || customProfileEmail || oauthEmail
    const resolvedContactInfo = contactInfo || null
    const resolvedDeliveryEmail = isValidEmail(contactInfo) ? contactInfo : null

    // 2. Check Stock
    const getAvailableStock = async () => {
        if (manualFulfillment) {
            const row = await db.select({ stock: products.manualStockCount })
                .from(products)
                .where(eq(products.id, productId))
                .limit(1)
            return Math.max(0, Number(row[0]?.stock || 0))
        }
        // For shared products, we just need ANY unused card to exist. Reservation status doesn't matter since we don't reserve.
        if (product.isShared) {
            const result = await db.select({ count: sql<number>`count(*)` })
                .from(cards)
                .where(and(
                    eq(cards.productId, productId),
                    or(isNull(cards.isUsed), eq(cards.isUsed, false))
                ));
            // If we have at least 1 card, treat as infinite stock
            return (result[0]?.count || 0) > 0 ? INFINITE_STOCK : 0;
        }

        // SQLite count returns number directly usually
        const result = await db.select({ count: sql<number>`count(*)` })
            .from(cards)
            .where(and(
                eq(cards.productId, productId),
                or(isNull(cards.isUsed), eq(cards.isUsed, false)),
                or(isNull(cards.reservedAt), lt(cards.reservedAt, new Date(Date.now() - RESERVATION_TTL_MS)))
            ))
        return result[0]?.count || 0
    }

    const runStockCleanupFallback = async () => {
        await Promise.allSettled([
            cleanupExpiredCardsIfNeeded(0, productId),
            cancelExpiredOrders({ productId }),
        ])
    }

    let stock = await getAvailableStock()
    if (stock < quantity) {
        await runStockCleanupFallback()
        stock = await getAvailableStock()
    }

    if (stock < quantity) return { success: false, error: 'buy.outOfStock' }

    // 3. Check Purchase Limit
    if (product.purchaseLimit && product.purchaseLimit > 0) {
        const currentUserId = user?.id
        const currentUserEmail = resolvedDeliveryEmail || user?.email || null

        if (currentUserId || currentUserEmail) {
            const conditions = [eq(orders.productId, productId)]
            const userConditions = []

            if (currentUserId) userConditions.push(eq(orders.userId, currentUserId))
            if (currentUserEmail) userConditions.push(eq(orders.email, currentUserEmail))

            if (userConditions.length > 0) {
                const countResult = await db.select({
                    totalQuantity: sql<number>`coalesce(sum(${orders.quantity}), count(*))`
                })
                    .from(orders)
                    .where(and(
                        eq(orders.productId, productId),
                        or(...userConditions),
                        or(eq(orders.status, 'paid'), eq(orders.status, 'delivered'))
                    ))

                const existingCount = countResult[0]?.totalQuantity || 0
                if (existingCount + quantity > product.purchaseLimit) {
                    return { success: false, error: 'buy.limitExceeded' }
                }
            }
        }
    }

    // 4. Create Order + Reserve Stock (1 minute) OR Deliver Immediately
    const orderId = generateOrderId()
    // Fail before any database write if the server cannot issue the guest capability.
    const orderAccessToken = createOrderAccessToken(orderId)

    const reserveAndCreate = async () => {
        const { queryOrderStatus } = await import("@/lib/epay")

        const reservedCards: { id: number, key: string }[] = []

        if (manualFulfillment) {
            await createOrderRecord([], '', isZeroPrice, pointsToUse, user, session?.user?.username, resolvedContactInfo, product, orderId, quantity, checkoutFieldValuesPayload)
            return
        }

        // If shared product, SKIP reservation logic. We just confirm we have stock (already checked above)
        if (product.isShared) {
            // For shared products, we don't lock cards. We just proceed.
            // But we need to pass a valid key to 'createOrderRecord' if it's a zero-price order for immediate fulfillment?
            // Actually createOrderRecord handles fulfillment logic slightly differently for zero price.
            // If zero price + shared => we need to grab a key NOW to deliver it?

            // However, createOrderRecord logic (lines 246-256) marks cards as USED if zero price. 
            // We MUST careful with shared products + zero price.

            // Let's grab ONE key for reference (randomly) just in case
            const nowMs = Date.now()
            // 先按 id 取有界候选窗口，再在窗口内随机：避免 ORDER BY RANDOM()
            // 对该商品全部可用卡做全量排序（详见 SHARED_CARD_CANDIDATE_WINDOW 注释）。
            const availableCard = await db.all(sql`
                SELECT id, card_key FROM (
                    SELECT id, card_key FROM cards
                    WHERE product_id = ${productId}
                      AND (is_used = 0 OR is_used IS NULL)
                      AND (expires_at IS NULL OR expires_at > ${nowMs})
                    ORDER BY id
                    LIMIT ${SHARED_CARD_CANDIDATE_WINDOW}
                ) ORDER BY RANDOM() LIMIT 1
            `) as Array<{ id: unknown; card_key?: string | null }>;

            if (availableCard.length > 0) {
                const referenceId = Number(availableCard[0].id);
                const referenceKey = availableCard[0].card_key ?? '';
                // We push the SAME key 'quantity' times
                for (let i = 0; i < quantity; i++) {
                    reservedCards.push({ id: referenceId, key: referenceKey });
                }
            } else {
                throw new Error('stock_locked') // Should be caught by stock check, but race condition possible
            }

            // We do NOT update DB to reserve.
        } else {
            // Normal Product Reservation Logic
            for (let i = 0; i < quantity; i++) {
                let attempts = 0
                const maxAttempts = 3
                let success = false

                while (attempts < maxAttempts && !success) {
                    attempts++

                    // A. Try strictly free card (single atomic UPDATE ... RETURNING)
                    const nowMs = Date.now();
                    const claimResult: any = await db.run(sql`
                        UPDATE cards
                        SET reserved_order_id = ${orderId}, reserved_at = ${nowMs}
                        WHERE id = (
                            SELECT id FROM cards
                            WHERE product_id = ${productId}
                              AND (is_used = 0 OR is_used IS NULL)
                              AND reserved_at IS NULL
                              AND (expires_at IS NULL OR expires_at > ${nowMs})
                            LIMIT 1
                        )
                        RETURNING id, card_key
                    `);

                    const claimedRows = claimResult?.results || claimResult?.rows || [];
                    if (claimedRows.length > 0) {
                        const row = claimedRows[0];
                        const id = Number(row.id);
                        const key = row.card_key ?? row.cardKey;
                        reservedCards.push({ id, key });
                        success = true;
                        continue;
                    }

                    // B. Fallback: Expired reservation
                    const fiveMinutesAgo = new Date(Date.now() - RESERVATION_TTL_MS);
                    const nowMsExpired = Date.now();
                    const expiredCandidates = await db.select({
                        id: cards.id,
                        cardKey: cards.cardKey,
                        reservedOrderId: cards.reservedOrderId
                    })
                        .from(cards)
                        .where(and(
                            eq(cards.productId, productId),
                            or(eq(cards.isUsed, false), isNull(cards.isUsed)),
                            lt(cards.reservedAt, fiveMinutesAgo),
                            or(isNull(cards.expiresAt), gt(cards.expiresAt, new Date(nowMsExpired)))
                        ))
                        .limit(1);

                    if (expiredCandidates.length === 0) {
                        break
                    }

                    const candidate = expiredCandidates[0]
                    const candidateCardId = candidate.id
                    const candidateOrderId = candidate.reservedOrderId

                    let reservationCanBeReclaimed = !candidateOrderId
                    if (candidateOrderId) {
                        const candidateOrder = await db.query.orders.findFirst({
                            where: eq(orders.orderId, candidateOrderId),
                            columns: {
                                status: true,
                                amount: true,
                                currentPaymentId: true,
                            },
                        })

                        if (!candidateOrder || candidateOrder.status === 'cancelled' || candidateOrder.status === 'refunded') {
                            reservationCanBeReclaimed = true
                        } else if (candidateOrder.status === 'pending') {
                            const statusRes = await queryOrderStatus(candidateOrder.currentPaymentId || candidateOrderId)
                            if (statusRes.success && statusRes.status === 1) {
                                const paidAmount = Number.parseFloat(statusRes.data?.money || candidateOrder.amount)
                                const tradeNo = statusRes.data?.trade_no
                                    || statusRes.data?.transaction_id
                                    || `RESERVATION_RECOVERY_${Date.now()}`
                                try {
                                    await processOrderFulfillment(candidateOrderId, paidAmount, tradeNo)
                                } catch (error) {
                                    console.error(`[Checkout] Failed to fulfill paid expired reservation ${candidateOrderId}:`, error)
                                }
                                // Never steal from an order that the gateway confirmed as paid,
                                // even when fulfillment needs a later retry.
                                continue
                            }
                            reservationCanBeReclaimed = statusRes.success && statusRes.status === 0
                        }
                    }

                    if (reservationCanBeReclaimed) {
                        // Steal the expired card only if it is still expired and unchanged
                        const now = new Date();
                        const updated = await db.update(cards)
                            .set({ reservedOrderId: orderId, reservedAt: now })
                            .where(and(
                                eq(cards.id, candidateCardId),
                                or(eq(cards.isUsed, false), isNull(cards.isUsed)),
                                lt(cards.reservedAt, fiveMinutesAgo),
                                candidateOrderId
                                    ? eq(cards.reservedOrderId, candidateOrderId)
                                    : isNull(cards.reservedOrderId)
                            ))
                            .returning({ id: cards.id, cardKey: cards.cardKey });

                        if (updated.length > 0) {
                            reservedCards.push({ id: updated[0].id, key: updated[0].cardKey });
                            success = true;
                        }
                    } else {
                        // Gateway errors and active paid/processing orders are inconclusive.
                        // Keep their reservation instead of risking duplicate delivery.
                        continue
                    }
                } // end while

                if (!success) {
                    throw new Error('stock_locked')
                }
            } // end for
        }

        const joinedKeys = reservedCards.map(c => c.key).join('\n')

        await createOrderRecord(reservedCards, joinedKeys, isZeroPrice, pointsToUse, user, session?.user?.username, resolvedContactInfo, product, orderId, quantity, checkoutFieldValuesPayload)
    };

    const createOrderRecord = async (reservedCards: any[], joinedKeys: string, isZeroPrice: boolean, pointsToUse: number, user: any, canonicalUsername: any, contactInfo: any, product: any, orderId: string, qty: number, checkoutFieldValuesJson: string | null) => {
        let orderInserted = false
        let automaticDeliveryNote = ""
        const normalizedUsername = canonicalUsername || user?.username || user?.name || null
        const uniqueCardIds = Array.from(new Set(reservedCards.map(c => c.id).filter((id: any) => id !== null && id !== undefined)));
        const cardIdsValue = uniqueCardIds.length > 0 ? uniqueCardIds.join(',') : null;

        try {
            // 先原子预占优惠券次数；失败则不创建订单，避免一次性券被并发超用
            if (couponReservationLines.length > 0) {
                const reservation = await reserveCouponUsages({
                    orderId,
                    userId: user?.id || null,
                    username: normalizedUsername,
                    now: Date.now(),
                    reservationTtlMs: RESERVATION_TTL_MS,
                    lines: couponReservationLines,
                })
                if (!reservation.ok) {
                    const reservationError: any = new Error('coupon_reservation_failed')
                    reservationError.couponError = reservation.error
                    throw reservationError
                }
            }

            if (isZeroPrice) {
                if (manualFulfillment) {
                    await db.insert(orders).values({
                        orderId,
                        productId: product.id,
                        productName: product.name,
                        ...orderSnapshotFields,
                        email: resolvedContactInfo,
                        userId: user?.id || null,
                        username: normalizedUsername,
                        status: 'paid',
                        paidAt: new Date(),
                        tradeNo: 'POINTS_REDEMPTION',
                        pointsUsed: pointsToUse,
                        quantity: qty,
                        manualStockQuantity: qty,
                        checkoutFieldValues: checkoutFieldValuesJson,
                        fulfillmentMode,
                        createdAt: new Date()
                    });
                    orderInserted = true
                } else {
                    automaticDeliveryNote = await getProductCardDeliveryNote(product.id).catch((error) => {
                        console.error('[Order] Failed to load card delivery note:', error)
                        return ''
                    })
                    if (!product.isShared) {
                        // 控制每条 UPDATE 的绑定变量数，避免大额零元订单超过 D1/SQLite 上限。
                        for (let offset = 0; offset < uniqueCardIds.length; offset += CARD_UPDATE_BATCH_SIZE) {
                            await db.update(cards).set({
                                isUsed: true,
                                usedAt: new Date(),
                                reservedOrderId: null,
                                reservedAt: null
                            }).where(inArray(cards.id, uniqueCardIds.slice(offset, offset + CARD_UPDATE_BATCH_SIZE)));
                        }
                    }

                    await db.insert(orders).values({
                        orderId,
                        productId: product.id,
                        productName: product.name,
                        ...orderSnapshotFields,
                        email: resolvedContactInfo,
                        userId: user?.id || null,
                        username: normalizedUsername,
                        status: 'delivered',
                        cardKey: joinedKeys,
                        cardIds: cardIdsValue,
                        deliveryNote: automaticDeliveryNote || null,
                        paidAt: new Date(),
                        deliveredAt: new Date(),
                        tradeNo: 'POINTS_REDEMPTION',
                        pointsUsed: pointsToUse,
                        quantity: qty,
                        manualStockQuantity: 0,
                        checkoutFieldValues: checkoutFieldValuesJson,
                        fulfillmentMode,
                        createdAt: new Date()
                    });
                    orderInserted = true
                }
            }

            if (!isZeroPrice) {
                await db.insert(orders).values({
                    orderId,
                    productId: product.id,
                    productName: product.name,
                    ...orderSnapshotFields,
                    email: resolvedContactInfo,
                    userId: user?.id || null,
                    username: normalizedUsername,
                    status: 'pending',
                    pointsUsed: pointsToUse,
                    currentPaymentId: orderId, // Store current payment ID
                    cardIds: cardIdsValue,
                    quantity: qty,
                    manualStockQuantity: manualFulfillment ? qty : 0,
                    checkoutFieldValues: checkoutFieldValuesJson,
                    fulfillmentMode,
                    createdAt: new Date()
                });
                orderInserted = true
            }

            if (pointsToUse > 0 && user?.id) {
                await applyUserAutomaticPointEvent({
                    userId: user.id,
                    username: normalizedUsername,
                    email: user.email ?? null,
                    eventType: "order_deduction",
                    delta: -pointsToUse,
                    businessKey: `order_deduction:${orderId}`,
                    sourceType: "order",
                    sourceId: orderId,
                    reason: `订单 ${orderId} 积分抵扣`,
                    metadata: JSON.stringify({
                        productId: product.id,
                        quantity: qty,
                    }),
                })
            }

            if (isZeroPrice) {
                // 零元订单不经过支付回调，直接完成核销
                if (couponReservationLines.length > 0) {
                    try {
                        await consumeCouponReservations(orderId)
                    } catch (couponConsumeError) {
                        console.error('[Coupon] Zero-price consume failed:', couponConsumeError)
                    }
                }

                if (user?.id) {
                    try {
                        await createUserNotification({
                            userId: user.id,
                            type: manualFulfillment ? 'order_paid' : 'order_delivered',
                            titleKey: manualFulfillment ? 'profile.notifications.orderPaidManualTitle' : 'profile.notifications.orderDeliveredTitle',
                            contentKey: manualFulfillment ? 'profile.notifications.orderPaidManualBody' : 'profile.notifications.orderDeliveredBody',
                            data: {
                                params: {
                                    orderId,
                                    productName: product.name
                                },
                                href: `/order/${orderId}`
                            }
                        })
                    } catch {
                        // best effort
                    }
                }

                if (!manualFulfillment && !product.isShared && !!cardIdsValue) {
                    await autoReplenishByApi(product.id, `order:${orderId}:zero_price`)
                }

                after(async () => {
                    // Notify admin for points-only payment
                    console.log('[Checkout] Points payment completed, sending notification for order:', orderId);
                    try {
                        await notifyAdminPaymentSuccess({
                            orderId,
                            productName: product.name,
                            amount: pointsToUse.toString() + ' (积分)',
                            username: normalizedUsername,
                            email: contactInfo || user?.email,
                            tradeNo: 'POINTS_REDEMPTION',
                            checkoutFieldValues: checkoutFieldValuesJson
                        });
                        console.log('[Checkout] Points payment notification sent successfully');
                    } catch (err) {
                        console.error('[Notification] Points payment notify failed:', err);
                    }

                    // Send email with card keys (only for automatic fulfillment)
                    const orderEmail = resolvedDeliveryEmail;
                    if (orderEmail && !manualFulfillment) {
                        await sendOrderEmail({
                            to: orderEmail,
                            orderId,
                            productName: product.name,
                            cardKeys: joinedKeys,
                            deliveryNote: automaticDeliveryNote,
                        }).catch(err => console.error('[Email] Points payment email failed:', err));
                    }
                })
            }
        } catch (error) {
            if (orderInserted) {
                try {
                    await db.delete(orders).where(eq(orders.orderId, orderId))
                } catch {
                    // best effort rollback
                }
            }

            if (uniqueCardIds.length > 0) {
                for (let offset = 0; offset < uniqueCardIds.length; offset += CARD_UPDATE_BATCH_SIZE) {
                    const batchIds = uniqueCardIds.slice(offset, offset + CARD_UPDATE_BATCH_SIZE)
                    try {
                        if (isZeroPrice && !product.isShared) {
                            await db.update(cards).set({
                                isUsed: false,
                                usedAt: null,
                                reservedOrderId: null,
                                reservedAt: null
                            }).where(inArray(cards.id, batchIds))
                        } else {
                            await db.update(cards).set({
                                reservedOrderId: null,
                                reservedAt: null
                            }).where(inArray(cards.id, batchIds))
                        }
                    } catch {
                        // best effort rollback；一批失败仍尝试释放其余卡密
                    }
                }
            }

            if (couponReservationLines.length > 0) {
                try {
                    await releaseCouponUsages(orderId, 'order_create_failed')
                } catch {
                    // best effort rollback
                }
            }

            throw error;
        }
    }

    try {
        await reserveAndCreate();
        try {
            await recalcProductAggregates(productId)
        } catch {
            // best effort
        }
        try {
            updateTag('home:products')
        } catch {
            // best effort
        }
        if (user?.id && pointsToUse > 0) {
            try {
                revalidatePath('/admin/users')
                revalidatePath(`/admin/users/${user.id}`)
            } catch {
                // best effort
            }
        }
    } catch (error: any) {
        const errorMessage = String(error?.message || error || '')
        const recordBusinessFailure = async (errorKey: string) => {
            await recordAuditEvent({
                eventName: 'order.created',
                result: 'failure',
                actorType: user?.id ? 'user' : 'system',
                actorUserId: user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: orderId,
                errorKey,
                source: 'checkout',
                metadata: {
                    orderId,
                    productId,
                    quantity,
                    errorKey,
                },
            })
        }
        if (errorMessage.includes('manual_stock_insufficient')) {
            await recordBusinessFailure('buy.outOfStock')
            return { success: false, error: 'buy.outOfStock' };
        }
        if (error?.message === 'stock_locked') {
            await recordBusinessFailure('buy.stockLocked')
            return { success: false, error: 'buy.stockLocked' };
        }
        if (error?.message === 'POINT_BALANCE_NEGATIVE' || error?.message === 'insufficient_points') {
            // 必须返回稳定的 i18n key：返回值不会被 Next.js 脱敏，
            // 任何明文句子都会原样显示在下单页（历史上这里直接返回英文句子）。
            const errorKey = resolveClientErrorKey(error, POINT_AUTOMATIC_ERROR_KEY_MAP, 'common.error')
            await recordBusinessFailure(errorKey)
            return { success: false, error: errorKey };
        }
        if (error?.couponError) {
            const errorKey = String(error.couponError)
            await recordBusinessFailure(errorKey)
            return { success: false, error: errorKey };
        }
        if (error?.message === 'coupon_reservation_failed') {
            await recordBusinessFailure('coupon.errors.reservationConflict')
            return { success: false, error: 'coupon.errors.reservationConflict' };
        }
        const errorId = await recordServerError('order.create', error, {
            actorType: user?.id ? 'user' : 'system',
            actorUserId: user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            auditEvent: {
                eventName: 'order.created',
                actorType: user?.id ? 'user' : 'system',
                actorUserId: user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: orderId,
                errorKey: 'common.error',
                source: 'checkout',
                metadata: { orderId, productId, quantity },
            },
        })
        return { success: false, error: 'common.error', errorId }
    }

    const cookieStore = await cookies()
    cookieStore.set(ORDER_ACCESS_COOKIE, orderAccessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        sameSite: 'lax',
        maxAge: ORDER_ACCESS_TTL_SECONDS,
    })

    await recordAuditEvent({
        eventName: 'order.created',
        actorType: user?.id ? 'user' : 'system',
        actorUserId: user?.id ?? null,
        actorUsername: session?.user?.username ?? null,
        targetId: orderId,
        source: 'checkout',
        metadata: {
            orderId,
            productId,
            productName: product.name,
            amountCents: finalAmountCents,
            quantity,
            status: isZeroPrice ? (manualFulfillment ? 'paid' : 'delivered') : 'pending',
            fulfillmentMode,
            points: pointsToUse,
            couponCount: couponReservationLines.length,
        },
    })

    if (isZeroPrice) {
        return {
            success: true,
            url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/order/${orderId}`,
            isZeroPrice: true
        }
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: product.name,
        money: centsToLdcString(finalAmountCents),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}

export async function getRetryPaymentParams(orderId: string) {
    const session = await auth()
    const user = session?.user

    if (!user?.id) return { success: false, error: 'common.error' }

    const order = await db.query.orders.findFirst({
        where: and(eq(orders.orderId, orderId), eq(orders.userId, user.id))
    })

    if (!order) return { success: false, error: 'buy.productNotFound' }
    if (order.status !== 'pending') return { success: false, error: 'order.status.paid' }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    const uniqueTradeNo = `${order.orderId}_retry${Date.now()}`;

    await db.update(orders)
        .set({ currentPaymentId: uniqueTradeNo })
        .where(eq(orders.orderId, orderId))

    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: uniqueTradeNo,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${order.orderId}`,
        name: order.productName,
        money: Number(order.amount).toFixed(2),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}
