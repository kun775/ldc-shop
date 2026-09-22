import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { md5, secretsEqual } from "@/lib/crypto"
import { eq } from "drizzle-orm"
import { withOrderColumnFallback } from "@/lib/db/queries"

const LOG_NOTIFY_DETAILS = process.env.NODE_ENV !== "production"
const SUCCESS_TRADE_STATUSES = new Set(["TRADE_SUCCESS", "TRADE_FINISHED"])

function summarizeNotifyParams(params: Record<string, string>) {
    return {
        out_trade_no: params.out_trade_no,
        trade_status: params.trade_status,
        money: params.money,
    }
}

function failure(status: number) {
    return new Response("fail", { status })
}

function normalizeOrderId(rawTradeNumber: string) {
    const trimmed = rawTradeNumber.trim()
    if (!trimmed) return null
    return trimmed.includes("_retry") ? trimmed.split("_retry", 1)[0] || null : trimmed
}

function validateRequiredParams(params: Record<string, string>) {
    return Boolean(
        params.sign &&
        params.out_trade_no &&
        params.trade_status &&
        params.money,
    )
}

function verifySignature(params: Record<string, string>, merchantKey: string) {
    const sorted = Object.keys(params)
        .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&")

    return secretsEqual(params.sign, md5(`${sorted}${merchantKey}`))
}

async function processNotify(params: Record<string, string>) {
    if (LOG_NOTIFY_DETAILS) {
        console.log("[Notify] Processing params:", JSON.stringify(params))
    } else {
        console.log("[Notify] Processing:", summarizeNotifyParams(params))
    }

    const merchantKey = process.env.MERCHANT_KEY?.trim()
    if (!merchantKey) {
        console.error("[Notify] MERCHANT_KEY is not configured")
        return failure(500)
    }
    if (!validateRequiredParams(params)) {
        console.warn("[Notify] Missing required callback parameters")
        return failure(400)
    }
    if (!verifySignature(params, merchantKey)) {
        console.warn("[Notify] Signature mismatch")
        return failure(400)
    }

    if (!SUCCESS_TRADE_STATUSES.has(params.trade_status)) {
        // Acknowledge valid non-success state notifications; no fulfillment is needed.
        return new Response("success")
    }

    const orderId = normalizeOrderId(params.out_trade_no)
    const notifyMoney = Number.parseFloat(params.money)
    if (!orderId || !Number.isFinite(notifyMoney)) {
        return failure(400)
    }

    const order = await withOrderColumnFallback(async () => {
        return await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: { orderId: true, amount: true, status: true },
        })
    })
    if (!order) {
        console.error(`[Notify] Order not found: ${orderId}`)
        return failure(404)
    }

    const orderMoney = Number.parseFloat(order.amount)
    if (!Number.isFinite(orderMoney) || Math.abs(notifyMoney - orderMoney) > 0.01) {
        console.error(`[Notify] Amount mismatch! Order: ${orderMoney}, Notify: ${notifyMoney}`)
        return failure(400)
    }

    const tradeNo = params.trade_no?.trim() || params.out_trade_no

    try {
        const { processOrderFulfillment } = await import("@/lib/order-processing")
        const result = await processOrderFulfillment(orderId, notifyMoney, tradeNo)
        if (result.status === "processing") {
            // Another request owns the short-lived claim. Ask the gateway to retry so a
            // simultaneous worker failure cannot turn into a permanently acknowledged order.
            return failure(503)
        }
        return new Response("success")
    } catch (error) {
        console.error("[Notify] Fulfillment error:", error)
        return failure(500)
    }
}

function paramsFromSearchParams(searchParams: URLSearchParams) {
    const params: Record<string, string> = {}
    searchParams.forEach((value, key) => {
        params[key] = value
    })
    return params
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        return await processNotify(paramsFromSearchParams(url.searchParams))
    } catch (error) {
        console.error("[Notify] Error:", error)
        return failure(500)
    }
}

export async function POST(request: Request) {
    try {
        const formData = await request.formData()
        const params: Record<string, string> = {}
        formData.forEach((value, key) => {
            if (typeof value === "string") params[key] = value
        })
        return await processNotify(params)
    } catch (error) {
        console.error("[Notify] Error:", error)
        return failure(500)
    }
}
