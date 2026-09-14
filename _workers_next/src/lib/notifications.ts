import { db } from "./db"
import { settings } from "./db/schema"
import { inArray } from "drizzle-orm"
import { resolveEffectiveShopLogo } from "@/lib/shop-logo"
import { parseCheckoutFieldValues, type CheckoutFieldValue } from "@/lib/checkout-fields"

async function getSettingsUncached(keys: string[]): Promise<Record<string, string>> {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(inArray(settings.key, keys))

        const map: Record<string, string> = {}
        for (const row of rows) {
            map[row.key] = row.value || ""
        }
        return map
    } catch (error: any) {
        const text = `${error?.message || ""}${JSON.stringify(error || {})}`.toLowerCase()
        if (text.includes("no such table") && text.includes("settings")) {
            return {}
        }
        throw error
    }
}

function getAppBaseUrl() {
    const raw = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
    if (!raw) return ""
    try {
        return new URL(raw).origin
    } catch {
        return ""
    }
}

function toAbsoluteUrl(input: string, baseUrl: string) {
    const raw = (input || "").trim()
    if (!raw) return ""
    try {
        return new URL(raw).toString()
    } catch {
        if (!baseUrl) return ""
        try {
            return new URL(raw, baseUrl).toString()
        } catch {
            return ""
        }
    }
}

function escapeHtml(value: string) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

export async function getNotificationSettings() {
    const values = await getSettingsUncached([
        'telegram_bot_token',
        'telegram_chat_id',
        'telegram_language',
        'telegram_enabled',
        'bark_enabled',
        'bark_server_url',
        'bark_device_key',
        'shop_logo',
        'shop_logo_source',
        'shop_logo_updated_at',
    ])

    const token = (values.telegram_bot_token || '').trim()
    const chatId = (values.telegram_chat_id || '').trim()
    const language = values.telegram_language || 'zh' // 默认中文
    // Backward compatible: if explicit switch not set, treat configured token+chat as enabled.
    const telegramEnabledRaw = values.telegram_enabled
    const telegramEnabled =
        telegramEnabledRaw === 'true' ||
        (telegramEnabledRaw !== 'false' && !!token && !!chatId)
    const barkEnabled = values.bark_enabled === 'true'
    const barkServerUrl = (values.bark_server_url || 'https://api.day.app').trim() || 'https://api.day.app'
    const barkDeviceKey = (values.bark_device_key || '').trim()
    const appBaseUrl = getAppBaseUrl()
    const shopLogo = resolveEffectiveShopLogo(values.shop_logo || "", values.shop_logo_source || "").effectiveLogo
    const shopLogoUpdatedAt = (values.shop_logo_updated_at || "").trim()
    const barkIconUrl = shopLogo
        ? toAbsoluteUrl(shopLogo, appBaseUrl)
        : (appBaseUrl ? `${appBaseUrl}/favicon${shopLogoUpdatedAt ? `?v=${encodeURIComponent(shopLogoUpdatedAt)}` : ""}` : "")

    return {
        token,
        chatId,
        language,
        telegramEnabled,
        barkEnabled,
        barkServerUrl,
        barkDeviceKey,
        barkIconUrl,
    }
}

export async function sendTelegramMessage(text: string) {
    try {
        const { telegramEnabled, token, chatId } = await getNotificationSettings()

        if (!telegramEnabled) {
            console.log('[Notification] Telegram skipped: disabled')
            return { success: false, error: 'Telegram disabled' }
        }

        if (!token || !chatId) {
            console.log('[Notification] Skipped: Missing token or chat_id')
            return { success: false, error: 'Missing configuration' }
        }

        const url = `https://api.telegram.org/bot${token}/sendMessage`
        const body = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const error = await response.text()
            console.error('[Notification] Telegram API Error:', error)
            return { success: false, error }
        }

        return { success: true }
    } catch (e: any) {
        console.error('[Notification] Send Error:', e)
        return { success: false, error: e.message }
    }
}

function normalizeBarkServerUrl(raw: string) {
    const trimmed = (raw || "").trim()
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withProtocol)
    const pathname = parsed.pathname.replace(/\/+$/, "")
    return `${parsed.origin}${pathname}`
}

export async function sendBarkMessage(
    title: string,
    body: string,
    options?: { url?: string; group?: string }
) {
    try {
        const { barkEnabled, barkServerUrl, barkDeviceKey, barkIconUrl } = await getNotificationSettings()

        if (!barkEnabled) {
            console.log('[Notification] Bark skipped: disabled')
            return { success: false, error: 'Bark disabled' }
        }

        if (!barkDeviceKey) {
            console.log('[Notification] Bark skipped: missing device key')
            return { success: false, error: 'Missing Bark device key' }
        }

        const baseUrl = normalizeBarkServerUrl(barkServerUrl || 'https://api.day.app')
        const safeTitle = (title || 'LDC Shop').trim() || 'LDC Shop'
        const safeBody = (body || '-').trim() || '-'

        let requestUrl = `${baseUrl}/${encodeURIComponent(barkDeviceKey)}/${encodeURIComponent(safeTitle)}/${encodeURIComponent(safeBody)}`
        const query = new URLSearchParams()
        if (options?.url) query.set('url', options.url)
        if (options?.group) query.set('group', options.group)
        if (barkIconUrl) query.set('icon', barkIconUrl)
        const queryString = query.toString()
        if (queryString) {
            requestUrl += `?${queryString}`
        }

        const response = await fetch(requestUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
            },
            cache: 'no-store'
        })

        if (!response.ok) {
            const error = await response.text()
            console.error('[Notification] Bark API Error:', error)
            return { success: false, error }
        }

        return { success: true }
    } catch (e: any) {
        console.error('[Notification] Bark Send Error:', e)
        return { success: false, error: e.message }
    }
}

// 消息模板
const messages = {
    zh: {
        paymentTitle: '💰 收到新付款！',
        userMessageTitle: '📩 收到用户消息',
        order: '订单号',
        product: '商品',
        amount: '金额',
        title: '标题',
        content: '内容',
        user: '用户',
        tradeNo: '交易号',
        guest: '访客',
        noEmail: '无邮箱',
        checkoutFields: '下单信息',
        refundTitle: '↩️ 收到退款申请',
        reason: '原因',
        noReason: '未提供原因',
        manageRefunds: '管理退款',
        manageMessages: '查看消息'
    },
    en: {
        paymentTitle: '💰 New Payment Received!',
        userMessageTitle: '📩 New User Message',
        order: 'Order',
        product: 'Product',
        amount: 'Amount',
        title: 'Title',
        content: 'Content',
        user: 'User',
        tradeNo: 'Trade No',
        guest: 'Guest',
        noEmail: 'No email',
        checkoutFields: 'Checkout information',
        refundTitle: '↩️ Refund Requested',
        reason: 'Reason',
        noReason: 'No reason provided',
        manageRefunds: 'Manage Refunds',
        manageMessages: 'View Messages'
    }
}

function resolveCheckoutFieldLines(order: {
    checkoutFieldValues?: string | CheckoutFieldValue[] | null
}) {
    const values = Array.isArray(order.checkoutFieldValues)
        ? order.checkoutFieldValues
        : parseCheckoutFieldValues(order.checkoutFieldValues)
    return values.map((item) => `${item.label}: ${item.value}`)
}

export async function notifyAdminPaymentSuccess(order: {
    orderId: string,
    productName: string,
    amount: string,
    email?: string | null,
    username?: string | null,
    tradeNo?: string | null,
    checkoutFieldValues?: string | CheckoutFieldValue[] | null
}) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh
    const checkoutLines = resolveCheckoutFieldLines(order)
    const checkoutTelegram = checkoutLines.length
        ? `\n<b>${t.checkoutFields}:</b>\n${checkoutLines.map((line) => escapeHtml(line)).join('\n')}`
        : ''

    const telegramText = `
<b>${t.paymentTitle}</b>

<b>${t.order}:</b> <code>${order.orderId}</code>
<b>${t.product}:</b> ${order.productName}
<b>${t.amount}:</b> ${order.amount}
<b>${t.user}:</b> ${order.username || t.guest} (${order.email || t.noEmail})
<b>${t.tradeNo}:</b> <code>${order.tradeNo || 'N/A'}</code>${checkoutTelegram}
`.trim()

    const barkBody = [
        `${t.order}: ${order.orderId}`,
        `${t.product}: ${order.productName}`,
        `${t.amount}: ${order.amount}`,
        `${t.user}: ${order.username || t.guest} (${order.email || t.noEmail})`,
        `${t.tradeNo}: ${order.tradeNo || 'N/A'}`,
        ...(checkoutLines.length ? [`${t.checkoutFields}:`, ...checkoutLines] : [])
    ].join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        sendTelegramMessage(telegramText),
        sendBarkMessage(t.paymentTitle, barkBody, { group: 'LDC Shop' })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success }
}

export async function notifyAdminRefundRequest(order: {
    orderId: string,
    productName: string,
    amount: string,
    username?: string | null,
    reason?: string | null
}) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh
    const appBaseUrl = getAppBaseUrl()
    const refundsUrl = appBaseUrl ? `${appBaseUrl}/admin/refunds` : ""

    const telegramText = `
<b>${t.refundTitle}</b>

<b>${t.order}:</b> <code>${escapeHtml(order.orderId)}</code>
<b>${t.product}:</b> ${escapeHtml(order.productName)}
<b>${t.amount}:</b> ${escapeHtml(order.amount)}
<b>${t.user}:</b> ${escapeHtml(order.username || t.guest)}
<b>${t.reason}:</b> ${escapeHtml(order.reason || t.noReason)}
${refundsUrl ? `\n<a href="${refundsUrl}">${t.manageRefunds}</a>` : ""}
`.trim()

    const barkBody = [
        `${t.order}: ${order.orderId}`,
        `${t.product}: ${order.productName}`,
        `${t.amount}: ${order.amount}`,
        `${t.user}: ${order.username || t.guest}`,
        `${t.reason}: ${order.reason || t.noReason}`,
        refundsUrl ? `${t.manageRefunds}: ${refundsUrl}` : ""
    ].filter(Boolean).join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        sendTelegramMessage(telegramText),
        sendBarkMessage(t.refundTitle, barkBody, { group: 'LDC Shop', ...(refundsUrl ? { url: refundsUrl } : {}) })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success }
}

export async function notifyAdminUserMessage(params: {
    userId: string
    username?: string | null
    title: string
    body: string
}) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh
    const appBaseUrl = getAppBaseUrl()
    const messagesUrl = appBaseUrl ? `${appBaseUrl}/admin/messages` : ""

    const safeUsername = params.username || t.guest
    const safeTitle = (params.title || '').trim()
    const safeBody = (params.body || '').trim()

    const telegramText = `
<b>${t.userMessageTitle}</b>

<b>${t.user}:</b> ${escapeHtml(safeUsername)} (<code>${escapeHtml(params.userId)}</code>)
<b>${t.title}:</b> ${escapeHtml(safeTitle)}
<b>${t.content}:</b>
<pre>${escapeHtml(safeBody)}</pre>
${messagesUrl ? `\n<a href="${messagesUrl}">${t.manageMessages}</a>` : ""}
`.trim()

    const barkBody = [
        `${t.user}: ${safeUsername} (${params.userId})`,
        `${t.title}: ${safeTitle}`,
        `${t.content}: ${safeBody}`,
        messagesUrl ? `${t.manageMessages}: ${messagesUrl}` : ""
    ].filter(Boolean).join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        sendTelegramMessage(telegramText),
        sendBarkMessage(t.userMessageTitle, barkBody, { group: 'LDC Shop', ...(messagesUrl ? { url: messagesUrl } : {}) })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success }
}
