import { and, eq } from "drizzle-orm"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { generateSign } from "@/lib/crypto"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { hasOrderAccessToken, ORDER_ACCESS_COOKIE } from "@/lib/order-access"

const DEFAULT_PAY_URL = "https://credit.linux.do/epay/pay/submit.php"
const ALLOWED_PAYMENT_FIELDS = new Set([
  "pid",
  "type",
  "out_trade_no",
  "notify_url",
  "return_url",
  "name",
  "money",
  "sign",
  "sign_type",
])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function normalizeOrderId(rawTradeNumber: string) {
  const value = rawTradeNumber.trim()
  if (!value) return null
  return value.includes("_retry") ? value.split("_retry", 1)[0] || null : value
}

function rejectPaymentRequest() {
  return NextResponse.json({ error: "Invalid payment request" }, { status: 400 })
}

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/", request.url))
}

export async function POST(request: Request) {
  const merchantId = process.env.MERCHANT_ID?.trim()
  const merchantKey = process.env.MERCHANT_KEY?.trim()
  if (!merchantId || !merchantKey) {
    return NextResponse.json({ error: "Payment is not configured" }, { status: 503 })
  }

  const submitted = Object.fromEntries(
    Array.from((await request.formData()).entries())
      .filter(([key, value]) => ALLOWED_PAYMENT_FIELDS.has(key) && typeof value === "string")
      .map(([key, value]) => [key, String(value)]),
  )
  if (Object.values(submitted).some((value) => value.length > 10_000)) {
    return rejectPaymentRequest()
  }
  const rawTradeNumber = submitted.out_trade_no?.trim()
  const orderId = rawTradeNumber ? normalizeOrderId(rawTradeNumber) : null
  const submittedAmount = Number.parseFloat(submitted.money || "")

  if (
    !orderId ||
    !rawTradeNumber ||
    submitted.pid !== merchantId ||
    submitted.sign_type !== "MD5" ||
    submitted.sign !== generateSign(submitted, merchantKey) ||
    !Number.isFinite(submittedAmount)
  ) {
    return rejectPaymentRequest()
  }

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.orderId, orderId), eq(orders.status, "pending")),
    columns: {
      orderId: true,
      userId: true,
      amount: true,
      currentPaymentId: true,
    },
  })
  if (!order) return rejectPaymentRequest()

  const expectedPaymentId = order.currentPaymentId || order.orderId
  const expectedAmount = Number.parseFloat(order.amount)
  if (
    rawTradeNumber !== expectedPaymentId ||
    !Number.isFinite(expectedAmount) ||
    Math.abs(submittedAmount - expectedAmount) > 0.01
  ) {
    return rejectPaymentRequest()
  }

  const session = await auth()
  const cookieStore = await cookies()
  const isOwner = Boolean(order.userId && session?.user?.id === order.userId)
  const hasGuestAccess = !order.userId && hasOrderAccessToken(
    cookieStore.get(ORDER_ACCESS_COOKIE)?.value,
    order.orderId,
  )
  if (!isOwner && !hasGuestAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const payUrl = new URL(process.env.PAY_URL || DEFAULT_PAY_URL)
  if (payUrl.protocol !== "https:") {
    return NextResponse.json({ error: "Invalid payment configuration" }, { status: 503 })
  }

  const inputs = Object.entries(submitted)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("")
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>正在跳转到支付页面</title>
    <style nonce="${nonce}">
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 32px; color: #111; }
      .hint { max-width: 420px; margin: 0 auto; text-align: center; }
      .title { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
      .desc { font-size: 13px; color: #666; }
      button { margin-top: 16px; padding: 10px 16px; border: 0; background: #111; color: #fff; border-radius: 8px; }
    </style>
  </head>
  <body>
    <div class="hint">
      <div class="title">正在跳转到支付页面…</div>
      <div class="desc">如果没有自动跳转，请点击继续。</div>
    </div>
    <form id="pay-form" method="POST" action="${escapeHtml(payUrl.toString())}">
      ${inputs}
      <noscript><button type="submit">继续</button></noscript>
    </form>
    <script nonce="${nonce}">
      const form = document.getElementById("pay-form");
      if (form) form.submit();
    </script>
  </body>
</html>`

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action ${payUrl.origin}; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
