import test from "node:test"
import assert from "node:assert/strict"

process.env.ORDER_ACCESS_SECRET = "test-order-access-secret"

const access = await import(new URL("./order-access.ts", import.meta.url).href)
const {
    createOrderAccessToken,
    hasOrderAccessToken,
    readOrderIdFromAccessToken,
} = access

const NOW = Date.UTC(2026, 8, 16, 0, 0, 0)

test("signed order access token round-trips its order id", () => {
    const token = createOrderAccessToken("ORD-guest-123", NOW)

    assert.equal(readOrderIdFromAccessToken(token, NOW), "ORD-guest-123")
    assert.equal(hasOrderAccessToken(token, "ORD-guest-123", NOW), true)
    assert.equal(hasOrderAccessToken(token, "ORD-other", NOW), false)
})

test("tampered order access token is rejected", () => {
    const token = createOrderAccessToken("ORD-guest-123", NOW)
    const tampered = token.replace("ORD-guest-123", "ORD-victim-999")

    assert.equal(readOrderIdFromAccessToken(tampered, NOW), null)
})

test("expired and legacy raw order cookies are rejected", () => {
    const token = createOrderAccessToken("ORD-guest-123", NOW)
    const eightDaysLater = NOW + 8 * 24 * 60 * 60 * 1000

    assert.equal(readOrderIdFromAccessToken(token, eightDaysLater), null)
    assert.equal(readOrderIdFromAccessToken("ORD-guest-123", NOW), null)
})
