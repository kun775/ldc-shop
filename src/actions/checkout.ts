'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { products, cards, orders, loginUsers } from "@/lib/db/schema"
import { cancelExpiredOrders } from "@/lib/db/queries"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { eq, sql, and, or } from "drizzle-orm"
import { cookies } from "next/headers"

export async function createOrder(productId: string, email?: string, usePoints: boolean = false) {
    const session = await auth()
    const user = session?.user

    // 1. Get Product
    const product = await db.query.products.findFirst({
        where: eq(products.id, productId)
    })
    if (!product) return { success: false, error: 'buy.productNotFound' }

    // 2. Check Blocked Status
    if (user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { isBlocked: true }
        });
        if (userRec?.isBlocked) {
            return { success: false, error: 'buy.userBlocked' };
        }
    }

    try {
        await cancelExpiredOrders({ productId })
    } catch {
        // Best effort cleanup
    }

    // Points Calculation
    let pointsToUse = 0
    let finalAmount = Number(product.price)

    if (usePoints && user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { points: true }
        })
        const currentPoints = userRec?.points || 0

        if (currentPoints > 0) {
            // Logic: 1 Point = 1 Unit of currency
            pointsToUse = Math.min(currentPoints, Math.ceil(finalAmount))
            finalAmount = Math.max(0, finalAmount - pointsToUse)
        }
    }

    const isZeroPrice = finalAmount <= 0

    const ensureCardsReservationColumns = async () => {
        await db.execute(sql`
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        `);
    }

    const ensureCardsIsUsedDefaults = async () => {
        await db.execute(sql`
            ALTER TABLE cards ALTER COLUMN is_used SET DEFAULT FALSE;
            UPDATE cards SET is_used = FALSE WHERE is_used IS NULL;
        `);
    }

    const getAvailableStock = async () => {
        const result = await db.select({ count: sql<number>`count(*)::int` })
            .from(cards)
            .where(sql`
                ${cards.productId} = ${productId}
                AND (COALESCE(${cards.isUsed}, false) = false)
                AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '5 minutes')
            `)
        return result[0]?.count || 0
    }

    // 2. Check Stock
    let stock = 0
    try {
        stock = await getAvailableStock()
    } catch (error: any) {
        const errorString = JSON.stringify(error)
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703')

        if (isMissingColumn) {
            await ensureCardsReservationColumns()
            stock = await getAvailableStock()
        } else {
            throw error
        }
    }

    if (stock <= 0) {
        try {
            const nullUsed = await db.select({ count: sql<number>`count(*)::int` })
                .from(cards)
                .where(sql`${cards.productId} = ${productId} AND ${cards.isUsed} IS NULL`)
            if ((nullUsed[0]?.count || 0) > 0) {
                await ensureCardsIsUsedDefaults()
                stock = await getAvailableStock()
            }
        } catch {
            // ignore
        }
    }

    if (stock <= 0) return { success: false, error: 'buy.outOfStock' }

    // 3. Check Purchase Limit
    if (product.purchaseLimit && product.purchaseLimit > 0) {
        const currentUserId = user?.id
        const currentUserEmail = email || user?.email

        if (currentUserId || currentUserEmail) {
            const conditions = [eq(orders.productId, productId)]
            const userConditions = []

            if (currentUserId) userConditions.push(eq(orders.userId, currentUserId))
            if (currentUserEmail) userConditions.push(eq(orders.email, currentUserEmail))

            if (userConditions.length > 0) {
                // For zero price instant delivery, we must count 'delivered' too (already covered)
                const countResult = await db.select({ count: sql<number>`count(*)::int` })
                    .from(orders)
                    .where(and(
                        eq(orders.productId, productId),
                        or(...userConditions),
                        or(eq(orders.status, 'paid'), eq(orders.status, 'delivered'))
                    ))

                const existingCount = countResult[0]?.count || 0
                if (existingCount >= product.purchaseLimit) {
                    return { success: false, error: 'buy.limitExceeded' }
                }
            }
        }
    }

    // 4. Create Order + Reserve Stock (1 minute) OR Deliver Immediately
    const orderId = generateOrderId()

    const reserveAndCreate = async () => {
        // Import inside function to avoid circular deps if any, though epay/db are safe
        const { queryOrderStatus } = await import("@/lib/epay")

        // 1. Try to find FREE stock first (most efficient)
        // We do this in a loop to handle the "Expired but actually Paid" case
        // If we find an expired one that is actually Paid, we fix it and try again.

        let attempts = 0
        const maxAttempts = 3 // Don't loop forever

        while (attempts < maxAttempts) {
            attempts++

            // A. Try strictly free card
            let reservedResult = await db.execute(sql`
                UPDATE cards
                SET reserved_order_id = ${orderId}, reserved_at = NOW()
                WHERE id = (
                    SELECT id
                    FROM cards
                    WHERE product_id = ${productId}
                      AND COALESCE(is_used, false) = false
                      AND reserved_at IS NULL
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id, card_key
            `);

            if (reservedResult.rows.length > 0) {
                // Found free card!
                await createOrderRecord(reservedResult, isZeroPrice, pointsToUse, finalAmount, user, email, product, orderId)
                return
            }

            // B. If no free card, look for expired ones to "steal" or "fix"
            const expiredCandidates = await db.execute(sql`
                SELECT id, reserved_order_id
                FROM cards
                WHERE product_id = ${productId}
                  AND COALESCE(is_used, false) = false
                  AND reserved_at < NOW() - INTERVAL '5 minutes'
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `)

            if (expiredCandidates.rows.length === 0) {
                // No free and no expired => Stock Locked / Out of Stock
                throw new Error('stock_locked')
            }

            const candidate = expiredCandidates.rows[0]
            const candidateCardId = candidate.id
            const candidateOrderId = candidate.reserved_order_id as string

            // Verify the candidate order status
            let isPaid = false
            try {
                if (candidateOrderId) {
                    const statusRes = await queryOrderStatus(candidateOrderId)
                    if (statusRes.success && statusRes.status === 1) {
                        isPaid = true
                    }
                }
            } catch (e) {
                console.error("Failed to verify candidate order", e)
                // If verify fails, conservative approach: don't steal.
                // But if we don't steal, we might block forever.
                // Let's assume if query fails, we skip this one? Or treat as unpaid? 
                // Treat as unpaid to avoid indefinite lock? Or treat as paid to be safe?
                // Safe: treat as paid (don't steal).
                // But then we might fail order creation. 
                // Let's treat as 'skip' aka 'continue loop' without fixing?
                // Actually, if we can't verify, we probably shouldn't steal.
                continue
            }

            if (isPaid) {
                // It was paid! Fix the data.
                await db.execute(sql`
                    UPDATE cards SET is_used = true, used_at = NOW() WHERE id = ${candidateCardId};
                    UPDATE orders SET status = 'paid', paid_at = NOW() WHERE order_id = ${candidateOrderId} AND status = 'pending';
                `)
                // Continue loop to find next available card
                continue
            } else {
                // It is NOT paid (or cancelled/refunded/pending-timeout). Steal it!
                reservedResult = await db.execute(sql`
                    UPDATE cards
                    SET reserved_order_id = ${orderId}, reserved_at = NOW()
                    WHERE id = ${candidateCardId}
                    RETURNING id, card_key
                `)

                if (reservedResult.rows.length > 0) {
                    await createOrderRecord(reservedResult, isZeroPrice, pointsToUse, finalAmount, user, email, product, orderId)
                    return
                }
                // If update failed (race?), continue loop
            }
        }

        throw new Error('stock_locked')
    };

    const createOrderRecord = async (reservedResult: any, isZeroPrice: boolean, pointsToUse: number, finalAmount: number, user: any, email: any, product: any, orderId: string) => {
        const cardKey = reservedResult.rows[0].card_key as string;
        const cardId = reservedResult.rows[0].id as number;

        // ... Verify points again if needed inside tx (already checked in outer logic? No, need to do it here)
        if (pointsToUse > 0) {
            const updatedUser = await db.update(loginUsers)
                .set({ points: sql`${loginUsers.points} - ${pointsToUse}` })
                .where(and(eq(loginUsers.userId, user!.id!), sql`${loginUsers.points} >= ${pointsToUse}`))
                .returning({ points: loginUsers.points });

            if (!updatedUser.length) {
                throw new Error('insufficient_points');
            }
        }

        // If Zero Price: Mark card used and order delivered immediately
        if (isZeroPrice) {
            await db.update(cards).set({
                isUsed: true,
                usedAt: new Date(),
                reservedOrderId: null,
                reservedAt: null
            }).where(eq(cards.id, cardId));

            await db.insert(orders).values({
                orderId,
                productId: product.id,
                productName: product.name,
                amount: finalAmount.toString(), // 0.00
                email: email || user?.email || null,
                userId: user?.id || null,
                username: user?.username || null,
                status: 'delivered',
                cardKey: cardKey,
                paidAt: new Date(),
                deliveredAt: new Date(),
                tradeNo: 'POINTS_REDEMPTION',
                pointsUsed: pointsToUse
            });

        } else {
            // Normal Pending Order
            await db.insert(orders).values({
                orderId,
                productId: product.id,
                productName: product.name,
                amount: finalAmount.toString(),
                email: email || user?.email || null,
                userId: user?.id || null,
                username: user?.username || null,
                status: 'pending',
                pointsUsed: pointsToUse
            });
        }
    }

    try {
        await reserveAndCreate();
    } catch (error: any) {
        if (error?.message === 'stock_locked') {
            return { success: false, error: 'buy.stockLocked' };
        }
        if (error?.message === 'insufficient_points') {
            return { success: false, error: 'Points mismatch, please try again.' };
        }

        // Schema retry logic 
        const errorString = JSON.stringify(error);
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703');

        if (isMissingColumn) {
            await db.execute(sql`
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
            `);

            try {
                await reserveAndCreate();
            } catch (retryError: any) {
                if (retryError?.message === 'stock_locked') return { success: false, error: 'buy.stockLocked' };
                if (retryError?.message === 'insufficient_points') return { success: false, error: 'Points mismatch' };
                throw retryError;
            }
        } else {
            throw error;
        }
    }

    // If Zero Price, return Success (redirect to order view)
    if (isZeroPrice) {
        return {
            success: true,
            url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/order/${orderId}`,
            isZeroPrice: true
        }
    }

    // Set Pending Cookie
    const cookieStore = await cookies()
    cookieStore.set('ldc_pending_order', orderId, { secure: true, path: '/', sameSite: 'lax' })

    // 4. Generate Pay Params
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: product.name,
        money: Number(finalAmount).toFixed(2),
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
    if (order.status !== 'pending') return { success: false, error: 'order.status.paid' } // Or just generic error

    // Generate Pay Params
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: order.orderId,
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
