'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { cookies } from "next/headers"
import { PAYMENT_PRODUCT_ID, PAYMENT_PRODUCT_NAME } from "@/lib/payment"
import { withOrderColumnFallback } from "@/lib/db/queries"
import { getAdminUsernames } from "@/lib/admin-auth"
import { createOrderAccessToken, ORDER_ACCESS_COOKIE, ORDER_ACCESS_TTL_SECONDS } from "@/lib/order-access"
import { enforceRateLimit } from "@/lib/rate-limit"

/**
 * 「按金额收款」链接的上限。
 *
 * 这是**边界约束**而不是业务上限：金额完全由客户端提交，此前只校验 > 0，
 * 可以写入任意大数（甚至 1e21 这类会被 toFixed 展开成超长字符串的值）。
 */
const MAX_PAYMENT_AMOUNT = 100_000

type NormalizedAmount =
    | { ok: true; value: number }
    | { ok: false; reason: 'invalid' | 'tooLarge' }

function normalizeAmount(input: number | string): NormalizedAmount {
    const parsed = Number.parseFloat(String(input))
    if (!Number.isFinite(parsed)) return { ok: false, reason: 'invalid' }
    const rounded = Math.round(parsed * 100) / 100
    if (rounded <= 0) return { ok: false, reason: 'invalid' }
    if (rounded > MAX_PAYMENT_AMOUNT) return { ok: false, reason: 'tooLarge' }
    return { ok: true, value: rounded }
}

export async function createPaymentOrder(amountInput: number | string, payeeInput?: string | null) {
    const session = await auth()
    const user = session?.user

    // 限流必须排在所有其它逻辑之前：它挡的是「请求洪峰」本身，
    // 放在参数校验之后等于让洪水绕过计数器直达业务代码。
    const rateLimit = await enforceRateLimit('payment:create', user?.id)
    if (!rateLimit.allowed) {
        return { success: false, error: 'common.tooManyRequests' }
    }

    // 商户配置缺失时必须在**写库之前**失败：此前用 `process.env.MERCHANT_ID!`
    // 非空断言，未配置时会把 "undefined" 拼进签名串，并留下一条无法支付的订单。
    const merchantId = process.env.MERCHANT_ID
    const merchantKey = process.env.MERCHANT_KEY
    if (!merchantId || !merchantKey) {
        console.error('[Payment] MERCHANT_ID / MERCHANT_KEY is not configured')
        return { success: false, error: 'payment.notConfigured' }
    }

    const normalized = normalizeAmount(amountInput)
    if (!normalized.ok) {
        return {
            success: false,
            error: normalized.reason === 'tooLarge' ? 'payment.amountTooLarge' : 'payment.invalidAmount',
        }
    }

    const adminUsers = getAdminUsernames()
    const fallbackPayee = adminUsers[0] || null
    const payeeCandidate = (payeeInput || '').trim()
    const matchedAdmin = payeeCandidate
        ? adminUsers.find((name) => name.toLowerCase() === payeeCandidate.toLowerCase())
        : undefined
    const payeeRaw = matchedAdmin || fallbackPayee || ''
    const payee = payeeRaw ? payeeRaw.slice(0, 80) : null

    const orderId = generateOrderId()
    const amount = normalized.value.toFixed(2)
    // Fail before inserting an order if the server cannot issue the guest capability.
    const orderAccessToken = createOrderAccessToken(orderId)

    await withOrderColumnFallback(async () => {
        await db.insert(orders).values({
            orderId,
            productId: PAYMENT_PRODUCT_ID,
            productName: PAYMENT_PRODUCT_NAME,
            amount,
            email: user?.email || null,
            userId: user?.id || null,
            username: user?.username || null,
            payee,
            status: 'pending',
            currentPaymentId: orderId,
            createdAt: new Date()
        })
    })

    const cookieStore = await cookies()
    cookieStore.set(ORDER_ACCESS_COOKIE, orderAccessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        sameSite: 'lax',
        maxAge: ORDER_ACCESS_TTL_SECONDS,
    })

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    const payParams: Record<string, any> = {
        pid: merchantId,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: PAYMENT_PRODUCT_NAME,
        money: amount,
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, merchantKey)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}
