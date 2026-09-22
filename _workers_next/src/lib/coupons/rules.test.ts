import test from "node:test"
import assert from "node:assert/strict"

const money = await import(new URL("./money.ts", import.meta.url).href)
const code = await import(new URL("./code.ts", import.meta.url).href)
const rules = await import(new URL("./rules.ts", import.meta.url).href)
const pricing = await import(new URL("./pricing.ts", import.meta.url).href)

const { parseLdcToCents, centsToLdcString, applyRateBps, multiplyCentsByQuantity } = money
const {
    normalizeCouponCode,
    normalizeCouponCodeList,
    isValidCouponCodeFormat,
    orderCouponEntriesByCode,
} = code
const { evaluateCouponRule, sortCouponsForApplication } = rules
const { resolveCheckoutPricing } = pricing

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)

function makeCoupon(overrides = {}) {
    return {
        id: "cpn_test",
        code: "TESTCODE",
        name: "测试券",
        description: null,
        discountType: "fixed",
        rateBps: null,
        discountAmountCents: 1000,
        minSpendCents: 0,
        maxDiscountCents: null,
        scope: "all",
        productIds: [],
        totalUseLimit: null,
        perUserLimit: null,
        reservedCount: 0,
        consumedCount: 0,
        stackableWithCoupons: true,
        stackableWithPoints: true,
        refundPolicy: "unfulfilled_full_refund",
        status: "active",
        startsAt: null,
        endsAt: null,
        createdBy: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    }
}

function emptyRuntime(overrides = {}) {
    return { totalReserved: 0, totalConsumed: 0, userReserved: 0, userConsumed: 0, ...overrides }
}

test("money parsing keeps two-decimal precision without float drift", () => {
    assert.equal(parseLdcToCents("10.005"), 1001)
    assert.equal(parseLdcToCents("10.004"), 1000)
    assert.equal(parseLdcToCents("0.1"), 10)
    assert.equal(parseLdcToCents("12"), 1200)
    assert.equal(parseLdcToCents(""), null)
    assert.equal(parseLdcToCents(null), null)
    assert.equal(parseLdcToCents("not-a-price"), null)
    assert.equal(centsToLdcString(1001), "10.01")
    assert.equal(centsToLdcString(0), "0.00")
    assert.equal(multiplyCentsByQuantity(1999, 3), 5997)
    assert.equal(applyRateBps(10000, 9000), 9000)
})

test("coupon code normalization is case and whitespace insensitive", () => {
    assert.equal(normalizeCouponCode("  abc-123 "), "ABC-123")
    assert.deepEqual(normalizeCouponCodeList(["a1", " A1 ", "b2"]), ["A1", "B2"])
    assert.equal(isValidCouponCodeFormat("ABCD"), true)
    assert.equal(isValidCouponCodeFormat("ab"), false)
    assert.equal(isValidCouponCodeFormat("AB CD"), false)
})

test("database coupon rows are restored to submitted code order", () => {
    const unordered = [
        { coupon: { code: "SECOND" } },
        { coupon: { code: " first " } },
    ]

    assert.deepEqual(
        orderCouponEntriesByCode(
            ["FIRST", "second"],
            unordered,
            (entry) => entry.coupon.code
        ),
        [unordered[1], unordered[0]]
    )
})

test("percent coupon applies rate cap and maximum discount", () => {
    const percent = makeCoupon({
        discountType: "percent",
        rateBps: 9000,
        discountAmountCents: null,
        maxDiscountCents: 500,
    })

    const capped = evaluateCouponRule({
        coupon: percent,
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 10000,
        runtime: emptyRuntime(),
    })
    assert.equal(capped.ok, true)
    assert.equal(capped.discountAmountCents, 500)

    const uncapped = evaluateCouponRule({
        coupon: { ...percent, maxDiscountCents: null },
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 10000,
        runtime: emptyRuntime(),
    })
    assert.equal(uncapped.ok, true)
    assert.equal(uncapped.discountAmountCents, 1000)
})

test("threshold coupon enforces minimum spend", () => {
    const threshold = makeCoupon({ discountType: "threshold_fixed", discountAmountCents: 2000, minSpendCents: 10000 })

    const below = evaluateCouponRule({
        coupon: threshold,
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 9999,
        runtime: emptyRuntime(),
    })
    assert.equal(below.ok, false)
    assert.equal(below.error, "coupon.errors.minSpendNotMet")

    const exact = evaluateCouponRule({
        coupon: threshold,
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 10000,
        runtime: emptyRuntime(),
    })
    assert.equal(exact.ok, true)
    assert.equal(exact.discountAmountCents, 2000)
})

test("coupon window and status are enforced at boundaries", () => {
    const started = makeCoupon({ startsAt: NOW })
    assert.equal(evaluateCouponRule({ coupon: started, now: NOW, userId: null, productId: "p1", subtotalCents: 5000, runtime: emptyRuntime() }).ok, true)

    const notStarted = makeCoupon({ startsAt: NOW + 1 })
    const early = evaluateCouponRule({ coupon: notStarted, now: NOW, userId: null, productId: "p1", subtotalCents: 5000, runtime: emptyRuntime() })
    assert.equal(early.error, "coupon.errors.notStarted")

    const endsAt = makeCoupon({ endsAt: NOW })
    assert.equal(evaluateCouponRule({ coupon: endsAt, now: NOW, userId: null, productId: "p1", subtotalCents: 5000, runtime: emptyRuntime() }).ok, true)

    const expired = makeCoupon({ endsAt: NOW - 1 })
    const late = evaluateCouponRule({ coupon: expired, now: NOW, userId: null, productId: "p1", subtotalCents: 5000, runtime: emptyRuntime() })
    assert.equal(late.error, "coupon.errors.expired")

    const draft = makeCoupon({ status: "draft" })
    const inactive = evaluateCouponRule({ coupon: draft, now: NOW, userId: null, productId: "p1", subtotalCents: 5000, runtime: emptyRuntime() })
    assert.equal(inactive.error, "coupon.errors.notActive")
})

test("total and per-user quotas block overuse", () => {
    const exhausted = makeCoupon({ totalUseLimit: 2 })
    const totalBlocked = evaluateCouponRule({
        coupon: exhausted,
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 5000,
        runtime: emptyRuntime({ totalReserved: 1, totalConsumed: 1 }),
    })
    assert.equal(totalBlocked.error, "coupon.errors.exhausted")

    const perUser = makeCoupon({ perUserLimit: 1 })
    const perUserBlocked = evaluateCouponRule({
        coupon: perUser,
        now: NOW,
        userId: "u1",
        productId: "p1",
        subtotalCents: 5000,
        runtime: emptyRuntime({ userConsumed: 1 }),
    })
    assert.equal(perUserBlocked.error, "coupon.errors.userLimitReached")

    const anonymous = evaluateCouponRule({
        coupon: perUser,
        now: NOW,
        userId: null,
        productId: "p1",
        subtotalCents: 5000,
        runtime: emptyRuntime(),
    })
    assert.equal(anonymous.error, "coupon.errors.loginRequired")
})

test("selected-scope coupon only applies to listed products", () => {
    const scoped = makeCoupon({ scope: "selected", productIds: ["p1", "p2"] })

    const allowed = evaluateCouponRule({ coupon: scoped, now: NOW, userId: "u1", productId: "p2", subtotalCents: 5000, runtime: emptyRuntime() })
    assert.equal(allowed.ok, true)

    const denied = evaluateCouponRule({ coupon: scoped, now: NOW, userId: "u1", productId: "p9", subtotalCents: 5000, runtime: emptyRuntime() })
    assert.equal(denied.error, "coupon.errors.productNotEligible")
})

test("product can disable all coupons without affecting points-only pricing", () => {
    const disabled = resolveCheckoutPricing({
        subtotalCents: 5000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        productCouponUsageRestriction: "none",
        entries: [{ coupon: makeCoupon(), runtime: emptyRuntime() }],
    })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.error, "coupon.errors.productDisabled")

    const pointsOnly = resolveCheckoutPricing({
        subtotalCents: 5000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: true,
        availablePoints: 100,
        pointDiscountEnabled: true,
        pointDiscountPercent: 20,
        productCouponUsageRestriction: "none",
        entries: [],
    })
    assert.equal(pointsOnly.ok, true)
    assert.equal(pointsOnly.result.pointsToUse, 10)
})

test("selected-only products reject all-product coupons and allow assigned product coupons", () => {
    const allProductsCoupon = makeCoupon({ scope: "all", productIds: [] })
    const rejected = resolveCheckoutPricing({
        subtotalCents: 5000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        productCouponUsageRestriction: "selected",
        entries: [{ coupon: allProductsCoupon, runtime: emptyRuntime() }],
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, "coupon.errors.productRestricted")

    const assignedCoupon = makeCoupon({ scope: "selected", productIds: ["p1"] })
    const allowed = resolveCheckoutPricing({
        subtotalCents: 5000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        productCouponUsageRestriction: "selected",
        entries: [{ coupon: assignedCoupon, runtime: emptyRuntime() }],
    })
    assert.equal(allowed.ok, true)
})

test("pricing follows subtotal then coupon then points order", () => {
    const coupon = makeCoupon({ discountType: "threshold_fixed", discountAmountCents: 2000, minSpendCents: 10000 })

    const outcome = resolveCheckoutPricing({
        subtotalCents: 20000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: true,
        availablePoints: 500,
        pointDiscountEnabled: true,
        pointDiscountPercent: 50,
        entries: [{ coupon, runtime: emptyRuntime() }],
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.couponDiscountCents, 2000)
    assert.equal(outcome.result.payableAfterCouponsCents, 18000)
    assert.equal(outcome.result.pointsToUse, 90)
    assert.equal(outcome.result.finalAmountCents, 9000)
})

test("pricing without coupons matches legacy point behaviour", () => {
    const outcome = resolveCheckoutPricing({
        subtotalCents: 1001,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: true,
        availablePoints: 500,
        pointDiscountEnabled: true,
        pointDiscountPercent: 50,
        entries: [],
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.couponDiscountCents, 0)
    assert.equal(outcome.result.pointsToUse, 5)
    assert.equal(outcome.result.finalAmountCents, 501)
})

test("pricing never goes negative and caps discount at subtotal", () => {
    const huge = makeCoupon({ discountAmountCents: 999999 })

    const outcome = resolveCheckoutPricing({
        subtotalCents: 1500,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        entries: [{ coupon: huge, runtime: emptyRuntime() }],
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.couponDiscountCents, 1500)
    assert.equal(outcome.result.finalAmountCents, 0)
})

test("points conflict is reported when coupon forbids stacking with points", () => {
    const noPoints = makeCoupon({ stackableWithPoints: false })

    const outcome = resolveCheckoutPricing({
        subtotalCents: 5000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: true,
        availablePoints: 100,
        pointDiscountEnabled: true,
        pointDiscountPercent: 100,
        entries: [{ coupon: noPoints, runtime: emptyRuntime() }],
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, "coupon.errors.pointsConflict")
})

test("non-stackable coupons reject multi-coupon orders", () => {
    const a = makeCoupon({ id: "cpn_a", code: "AAAA" })
    const b = makeCoupon({ id: "cpn_b", code: "BBBB", stackableWithCoupons: false })

    const outcome = resolveCheckoutPricing({
        subtotalCents: 10000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        entries: [
            { coupon: a, runtime: emptyRuntime() },
            { coupon: b, runtime: emptyRuntime() },
        ],
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, "coupon.errors.notStackable")
})

test("stacking order is deterministic and independent of input order", () => {
    const percentCoupon = makeCoupon({ id: "cpn_pct", code: "PCT", discountType: "percent", rateBps: 8000, discountAmountCents: null })
    const fixedCoupon = makeCoupon({ id: "cpn_fix", code: "FIX", discountType: "fixed", discountAmountCents: 1000 })

    assert.deepEqual(
        sortCouponsForApplication([percentCoupon, fixedCoupon]).map((coupon) => coupon.id),
        ["cpn_fix", "cpn_pct"]
    )
    assert.deepEqual(
        sortCouponsForApplication([fixedCoupon, percentCoupon]).map((coupon) => coupon.id),
        ["cpn_fix", "cpn_pct"]
    )

    const build = (entries) => resolveCheckoutPricing({
        subtotalCents: 10000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        entries,
    })

    const first = build([
        { coupon: percentCoupon, runtime: emptyRuntime() },
        { coupon: fixedCoupon, runtime: emptyRuntime() },
    ])
    const second = build([
        { coupon: fixedCoupon, runtime: emptyRuntime() },
        { coupon: percentCoupon, runtime: emptyRuntime() },
    ])

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.result.finalAmountCents, second.result.finalAmountCents)
    assert.equal(first.result.finalAmountCents, 7200)
    assert.deepEqual(first.result.lines.map((line) => line.code), ["FIX", "PCT"])
})

test("too many coupons per order are rejected", () => {
    const entries = ["A1", "A2", "A3", "A4"].map((codeValue, index) => ({
        coupon: makeCoupon({ id: `cpn_${index}`, code: codeValue }),
        runtime: emptyRuntime(),
    }))

    const outcome = resolveCheckoutPricing({
        subtotalCents: 10000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        entries,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, "coupon.errors.tooMany")
})

test("pricing snapshot records every applied coupon", () => {
    const fixed = makeCoupon({ id: "cpn_fix", code: "FIX", discountType: "fixed", discountAmountCents: 500 })

    const outcome = resolveCheckoutPricing({
        subtotalCents: 3000,
        productId: "p1",
        userId: "u1",
        now: NOW,
        usePoints: false,
        availablePoints: 0,
        pointDiscountEnabled: false,
        pointDiscountPercent: 0,
        entries: [{ coupon: fixed, runtime: emptyRuntime() }],
    })

    assert.equal(outcome.ok, true)
    const snapshot = JSON.parse(outcome.result.pricingSnapshot)
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.subtotalCents, 3000)
    assert.equal(snapshot.couponDiscountCents, 500)
    assert.equal(snapshot.finalAmountCents, 2500)
    assert.equal(snapshot.coupons.length, 1)
    assert.equal(snapshot.coupons[0].code, "FIX")
    assert.equal(snapshot.coupons[0].discountAmountCents, 500)
})
