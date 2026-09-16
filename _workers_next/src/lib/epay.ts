import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"

export async function queryOrderStatus(orderId: string) {
    const merchantId = process.env.MERCHANT_ID
    const merchantKey = process.env.MERCHANT_KEY
    if (!merchantId || !merchantKey) throw new Error("Missing merchant config")

    // Use the API URL from pay url or default
    const payUrl = process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php'

    let apiUrl = 'https://credit.linux.do/epay/api.php' // Default fallback
    try {
        const urlObj = new URL(payUrl)
        // If payUrl is .../pay/submit.php, api is usually .../api.php
        // construct api url
        apiUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.replace('/pay/submit.php', '/api.php').replace('/submit.php', '/api.php')}`
        if (!apiUrl.endsWith('api.php')) {
            apiUrl = `${urlObj.protocol}//${urlObj.host}/epay/api.php`
        }
    } catch (e) {
        // ignore invalid pay url
    }

    const query = new URLSearchParams({
        act: 'order',
        pid: merchantId,
        key: merchantKey,
        out_trade_no: orderId
    })

    try {
        const res = await fetchWithTimeout(`${apiUrl}?${query.toString()}`, {
            headers: { Accept: 'application/json' },
        }, 8_000)
        if (!res.ok) throw new Error(`Payment query failed with HTTP ${res.status}`)
        const data = await res.json()

        if (data.code === 1) {
            // status 1 = Paid
            // status 0 = Refunded (as per previous context, though EPay usually uses 1 for success)
            // But user said status 0 is refunded. 
            // Standard EPay: 1=Paid, 0=Unpaid/Fail? 
            // Wait, previous context said:
            // "If the API returns code: 1 and status: 0 (indicating a refunded payment)"
            // "If status: 1 (paid)"
            // So: 1 = Paid, 0 = Refunded (or Unpaid?)
            // Actually usually 1=Paid, 0=Unpaid. Refunded might be a specific case or just handled as "not paid" if full refund?
            // User said: "如果查询到退款成功 (status=0)" 
            // So we stick to: 
            // code=1, status=1 => Paid
            // code=1, status=0 => Refunded (or Unpaid/Closed)? User calls it "Refunded".

            return { success: true, status: data.status, msg: data.msg || 'Query success', data }
        } else {
            return { success: false, error: data.msg || 'Query failed' }
        }

    } catch (e: any) {
        console.error('Query order error', e)
        return { success: false, error: e.message }
    }
}
