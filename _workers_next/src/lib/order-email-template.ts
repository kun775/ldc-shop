export interface OrderEmailParams {
    to: string
    orderId: string
    productName: string
    cardKeys: string
    deliveryNote?: string | null
    language?: 'zh' | 'en'
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

const emailTemplates = {
    zh: {
        subject: (orderId: string) => `您的订单 ${orderId} 已完成`,
        body: (params: OrderEmailParams) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>订单确认</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">🎉 订单已完成</h1>
    </div>

    <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin-top: 0;">您好！</p>
        <p>感谢您的购买，以下是您的订单信息：</p>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>商品：</strong>${escapeHtml(params.productName)}</p>
            <p style="margin: 0 0 10px 0;"><strong>订单号：</strong><code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${escapeHtml(params.orderId)}</code></p>
        </div>

        <div style="background: #fef3c7; padding: 20px; border-radius: 8px; border: 1px solid #fcd34d; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold;">📦 您的卡密：</p>
            <pre style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: 'Courier New', monospace; font-size: 14px;">${escapeHtml(params.cardKeys)}</pre>
        </div>

        ${params.deliveryNote ? `
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #bfdbfe; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #1e40af;">📝 发货备注：</p>
            <div style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 14px; line-height: 1.6; color: #1f2937;">${escapeHtml(params.deliveryNote)}</div>
        </div>
        ` : ''}

        <p style="color: #6b7280; font-size: 14px;">请妥善保管您的卡密信息。如有任何问题，请联系客服。</p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">

        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">此邮件由系统自动发送，请勿直接回复。</p>
    </div>
</body>
</html>
        `.trim()
    },
    en: {
        subject: (orderId: string) => `Your Order ${orderId} is Complete`,
        body: (params: OrderEmailParams) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Confirmation</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">🎉 Order Complete</h1>
    </div>

    <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin-top: 0;">Hello!</p>
        <p>Thank you for your purchase. Here is your order information:</p>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>Product:</strong> ${escapeHtml(params.productName)}</p>
            <p style="margin: 0 0 10px 0;"><strong>Order ID:</strong> <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${escapeHtml(params.orderId)}</code></p>
        </div>

        <div style="background: #fef3c7; padding: 20px; border-radius: 8px; border: 1px solid #fcd34d; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold;">📦 Your Card Key(s):</p>
            <pre style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: 'Courier New', monospace; font-size: 14px;">${escapeHtml(params.cardKeys)}</pre>
        </div>

        ${params.deliveryNote ? `
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #bfdbfe; margin: 20px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #1e40af;">📝 Delivery Note:</p>
            <div style="background: white; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 14px; line-height: 1.6; color: #1f2937;">${escapeHtml(params.deliveryNote)}</div>
        </div>
        ` : ''}

        <p style="color: #6b7280; font-size: 14px;">Please keep your card key(s) safe. If you have any questions, please contact support.</p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">

        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">This is an automated email. Please do not reply directly.</p>
    </div>
</body>
</html>
        `.trim()
    }
}

export function getOrderEmailSubject(orderId: string, language: 'zh' | 'en' = 'zh') {
    return emailTemplates[language].subject(orderId)
}

export function renderOrderEmailHtml(params: OrderEmailParams, language: 'zh' | 'en' = 'zh') {
    return emailTemplates[language].body(params)
}
