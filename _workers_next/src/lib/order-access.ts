import { createHmac, timingSafeEqual } from "crypto"

export const ORDER_ACCESS_COOKIE = "ldc_pending_order"
export const ORDER_ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60

const TOKEN_VERSION = "v1"

function getSigningSecret() {
    const secret =
        process.env.ORDER_ACCESS_SECRET?.trim() ||
        process.env.AUTH_SECRET?.trim() ||
        process.env.NEXTAUTH_SECRET?.trim()

    if (!secret) {
        throw new Error("ORDER_ACCESS_SECRET_MISSING")
    }

    return secret
}

function signPayload(payload: string) {
    return createHmac("sha256", getSigningSecret()).update(payload).digest("hex")
}

function signaturesMatch(actual: string, expected: string) {
    if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) {
        return false
    }

    const actualBuffer = Buffer.from(actual, "hex")
    const expectedBuffer = Buffer.from(expected, "hex")
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function createOrderAccessToken(orderId: string, now = Date.now()) {
    const normalizedOrderId = orderId.trim()
    if (!normalizedOrderId) throw new Error("ORDER_ID_REQUIRED")

    const expiresAt = Math.floor(now / 1000) + ORDER_ACCESS_TTL_SECONDS
    const encodedOrderId = encodeURIComponent(normalizedOrderId)
    const payload = `${TOKEN_VERSION}.${encodedOrderId}.${expiresAt}`
    return `${payload}.${signPayload(payload)}`
}

export function readOrderIdFromAccessToken(token: string | null | undefined, now = Date.now()) {
    if (!token) return null

    const parts = token.split(".")
    if (parts.length !== 4) return null

    const [version, encodedOrderId, expiresAtRaw, signature] = parts
    if (version !== TOKEN_VERSION) return null

    const expiresAt = Number(expiresAtRaw)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return null

    const payload = `${version}.${encodedOrderId}.${expiresAtRaw}`
    let expectedSignature: string
    try {
        expectedSignature = signPayload(payload)
    } catch {
        return null
    }
    if (!signaturesMatch(signature, expectedSignature)) return null

    try {
        const orderId = decodeURIComponent(encodedOrderId).trim()
        return orderId || null
    } catch {
        return null
    }
}

export function hasOrderAccessToken(token: string | null | undefined, orderId: string, now = Date.now()) {
    return readOrderIdFromAccessToken(token, now) === orderId
}
