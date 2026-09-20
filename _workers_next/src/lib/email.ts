import { db } from "./db"
import { settings } from "./db/schema"
import { inArray } from "drizzle-orm"
import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"
import { getOrderEmailSubject, renderOrderEmailHtml, type OrderEmailParams } from "@/lib/order-email-template"

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

export async function getEmailSettings() {
    const values = await getSettingsUncached([
        'resend_api_key',
        'resend_from_email',
        'resend_from_name',
        'resend_enabled',
        'email_language',
        'telegram_language',
    ])

    const apiKey = (values.resend_api_key || '').trim()
    const fromEmail = (values.resend_from_email || '').trim()
    const fromName = (values.resend_from_name || '').trim()
    const enabled = values.resend_enabled === 'true'
    const emailLanguage = (values.email_language || '').trim()
    const telegramLanguage = (values.telegram_language || '').trim()

    return {
        apiKey,
        fromEmail,
        fromName: fromName || 'LDC Shop',
        enabled,
        language: emailLanguage || telegramLanguage || null
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function getAppBaseUrl(): string {
    const raw = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
    if (!raw) return ""
    try {
        return new URL(raw).origin
    } catch {
        return ""
    }
}

export function isValidEmail(value: string | null | undefined): boolean {
    if (!value) return false
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export interface ManualDeliveryEmailParams {
    to: string
    orderId: string
    productName: string
    deliveryNote?: string | null
    hasAttachments?: boolean
    language?: 'zh' | 'en'
}

const manualDeliveryTemplates = {
    zh: {
        subject: (orderId: string) => `您的订单 ${orderId} 已发货`,
        body: (params: ManualDeliveryEmailParams & { orderUrl: string }) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>订单已发货</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">📦 订单已发货</h1>
    </div>
    
    <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin-top: 0;">您好！</p>
        <p>您购买的商品商家已完成发货，以下是发货详情：</p>
        
        <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>商品：</strong>${escapeHtml(params.productName)}</p>
            <p style="margin: 0 0 10px 0;"><strong>订单号：</strong><code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${escapeHtml(params.orderId)}</code></p>
        </div>
        
        ${params.deliveryNote ? `
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #bfdbfe; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #1e40af;">📝 商家交付说明：</p>
            <div style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: monospace; font-size: 13px; line-height: 1.6; color: #1f2937;">${escapeHtml(params.deliveryNote)}</div>
        </div>
        ` : ''}

        ${params.hasAttachments ? `
        <div style="background: #f0fdf4; padding: 15px 20px; border-radius: 8px; border: 1px solid #bbf7d0; margin: 20px 0; color: #166534; font-size: 14px;">
            📎 <strong>本次发货包含交付附件</strong>，请前往订单详情页下载查看。
        </div>
        ` : ''}
        
        ${params.orderUrl ? `
        <div style="text-align: center; margin: 30px 0;">
            <a href="${params.orderUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                查看订单详情与下载附件 →
            </a>
        </div>
        ` : ''}

        <p style="color: #6b7280; font-size: 14px;">如有任何疑问，请随时联系客服。</p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">此邮件由系统自动发送，请勿直接回复。</p>
    </div>
</body>
</html>
        `.trim()
    },
    en: {
        subject: (orderId: string) => `Your Order ${orderId} Has Been Delivered`,
        body: (params: ManualDeliveryEmailParams & { orderUrl: string }) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Delivered</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">📦 Order Delivered</h1>
    </div>
    
    <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin-top: 0;">Hello!</p>
        <p>Your order has been fulfilled by the merchant. Here are the delivery details:</p>
        
        <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>Product:</strong> ${escapeHtml(params.productName)}</p>
            <p style="margin: 0 0 10px 0;"><strong>Order ID:</strong> <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${escapeHtml(params.orderId)}</code></p>
        </div>
        
        ${params.deliveryNote ? `
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #bfdbfe; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #1e40af;">📝 Delivery Instructions:</p>
            <div style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: monospace; font-size: 13px; line-height: 1.6; color: #1f2937;">${escapeHtml(params.deliveryNote)}</div>
        </div>
        ` : ''}

        ${params.hasAttachments ? `
        <div style="background: #f0fdf4; padding: 15px 20px; border-radius: 8px; border: 1px solid #bbf7d0; margin: 20px 0; color: #166534; font-size: 14px;">
            📎 <strong>This delivery includes attachments</strong>. Please visit your order page to download them.
        </div>
        ` : ''}
        
        ${params.orderUrl ? `
        <div style="text-align: center; margin: 30px 0;">
            <a href="${params.orderUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                View Order & Download Files →
            </a>
        </div>
        ` : ''}

        <p style="color: #6b7280; font-size: 14px;">If you have any questions, please contact support.</p>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">This is an automated email. Please do not reply directly.</p>
    </div>
</body>
</html>
        `.trim()
    }
}

export async function sendManualDeliveryEmail(params: ManualDeliveryEmailParams) {
    try {
        const settings = await getEmailSettings()

        if (!settings.enabled) {
            console.log('[Email] Skipped: Email sending is disabled')
            return { success: false, error: 'Email sending is disabled' }
        }

        if (!settings.apiKey || !settings.fromEmail) {
            console.log('[Email] Skipped: Missing API key or from email')
            return { success: false, error: 'Missing configuration' }
        }

        if (!params.to || !isValidEmail(params.to)) {
            console.log('[Email] Skipped: Invalid recipient email')
            return { success: false, error: 'Invalid recipient email' }
        }

        const lang = params.language || settings.language || 'zh'
        const template = manualDeliveryTemplates[lang as keyof typeof manualDeliveryTemplates] || manualDeliveryTemplates.zh
        const baseUrl = getAppBaseUrl()
        const orderUrl = baseUrl ? `${baseUrl}/order/${params.orderId}` : ''

        const response = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                from: `${settings.fromName} <${settings.fromEmail}>`,
                to: params.to,
                subject: template.subject(params.orderId),
                html: template.body({ ...params, orderUrl })
            })
        }, 10_000)

        if (!response.ok) {
            const error = await response.text()
            console.error('[Email] Resend API Error for manual delivery:', error)
            return { success: false, error }
        }

        const result = await response.json()
        console.log('[Email] Manual delivery email sent successfully:', result.id)
        return { success: true, id: result.id }
    } catch (e: any) {
        console.error('[Email] Send manual delivery email error:', e)
        return { success: false, error: e.message }
    }
}

export async function sendOrderEmail(params: OrderEmailParams) {
    try {
        const settings = await getEmailSettings()

        if (!settings.enabled) {
            console.log('[Email] Skipped: Email sending is disabled')
            return { success: false, error: 'Email sending is disabled' }
        }

        if (!settings.apiKey || !settings.fromEmail) {
            console.log('[Email] Skipped: Missing API key or from email')
            return { success: false, error: 'Missing configuration' }
        }

        if (!params.to) {
            console.log('[Email] Skipped: No recipient email')
            return { success: false, error: 'No recipient email' }
        }

        const lang = params.language || settings.language || 'zh'
        const resolvedLanguage = lang === 'en' ? 'en' : 'zh'

        const response = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                from: `${settings.fromName} <${settings.fromEmail}>`,
                to: params.to,
                subject: getOrderEmailSubject(params.orderId, resolvedLanguage),
                html: renderOrderEmailHtml(params, resolvedLanguage)
            })
        }, 10_000)

        if (!response.ok) {
            const error = await response.text()
            console.error('[Email] Resend API Error:', error)
            return { success: false, error }
        }

        const result = await response.json()
        console.log('[Email] Sent successfully:', result.id)
        return { success: true, id: result.id }
    } catch (e: any) {
        console.error('[Email] Send Error:', e)
        return { success: false, error: e.message }
    }
}

export async function testResendEmail(to: string) {
    const settings = await getEmailSettings()

    if (!settings.apiKey || !settings.fromEmail) {
        return { success: false, error: 'Missing API key or from email' }
    }

    try {
        const response = await fetchWithTimeout('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                from: `${settings.fromName} <${settings.fromEmail}>`,
                to: to,
                subject: '🔔 LDC Shop Email Test',
                html: `
                    <div style="font-family: sans-serif; padding: 20px;">
                        <h2>✅ Email Configuration Successful!</h2>
                        <p>If you're reading this, your email settings are working correctly.</p>
                        <p style="color: #666; font-size: 14px;">This is a test email from LDC Shop.</p>
                    </div>
                `
            })
        }, 10_000)

        if (!response.ok) {
            const error = await response.text()
            return { success: false, error }
        }

        return { success: true }
    } catch (e: any) {
        return { success: false, error: e.message }
    }
}
