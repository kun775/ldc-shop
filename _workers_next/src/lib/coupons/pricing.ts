import { couponFailure } from './errors.ts'
import type { CouponErrorCode } from './errors.ts'
import { centsToLdcNumber, parseLdcToCentsOrZero } from './money.ts'
import {
    evaluateCouponRule,
    getCouponStackingConflict,
    sortCouponsForApplication,
} from './rules.ts'
import {
    MAX_COUPONS_PER_ORDER,
    type CouponPricingLine,
    type CouponPricingResult,
    type CouponRecord,
    type CouponRuntimeState,
    type OrderPricingSnapshot,
} from './types.ts'
import {
    isCouponAllowedForProduct,
    normalizeProductCouponUsageRestriction,
    type ProductCouponUsageRestriction,
} from './product-policy.ts'

const PRICING_SNAPSHOT_VERSION = 1

export interface CouponRuntimeEntry {
    coupon: CouponRecord
    runtime: CouponRuntimeState
}

export interface CouponPricingInput {
    subtotalCents: number
    productId: string
    userId: string | null
    now: number
    usePoints: boolean
    availablePoints: number
    pointDiscountEnabled: boolean
    pointDiscountPercent: number
    productCouponUsageRestriction?: ProductCouponUsageRestriction | string | null
    entries: CouponRuntimeEntry[]
}

export type CouponPricingOutcome =
    | { ok: true; result: CouponPricingResult }
    | { ok: false; error: string }

function failure(code: CouponErrorCode): CouponPricingOutcome {
    return { ok: false, error: couponFailure(code).error }
}

function sanitizePointDiscountConfig(input: {
    pointDiscountEnabled: boolean
    pointDiscountPercent: number | string | null | undefined
}) {
    if (!input.pointDiscountEnabled) {
        return { enabled: false, percent: 0 }
    }
    const value = Number(input.pointDiscountPercent)
    if (!Number.isInteger(value) || value <= 0) {
        return { enabled: false, percent: 0 }
    }
    return { enabled: true, percent: Math.min(value, 100) }
}

function toSafeAvailablePoints(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

// resolveCheckoutPricing 计算优惠券与积分参与后的最终定价
//
// 参数:
//   - input.subtotalCents: 商品小计（整数分）
//   - input.entries: 候选优惠券与其实时占用情况
//   - input.usePoints: 用户是否选择积分抵扣
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增商品小计→优惠券→积分→应付的统一计算入口，金额全程使用整数分。
export function resolveCheckoutPricing(input: CouponPricingInput): CouponPricingOutcome {
    const subtotalCents = Math.max(0, Math.round(input.subtotalCents))
    const entries = Array.isArray(input.entries) ? input.entries : []

    if (entries.length > MAX_COUPONS_PER_ORDER) {
        return failure('COUPON_TOO_MANY')
    }

    const productRestriction = normalizeProductCouponUsageRestriction(input.productCouponUsageRestriction)
    if (entries.length > 0 && productRestriction === 'none') {
        return failure('COUPON_PRODUCT_DISABLED')
    }
    if (entries.some((entry) => !isCouponAllowedForProduct({
        restriction: productRestriction,
        coupon: entry.coupon,
        productId: input.productId,
    }))) {
        return failure('COUPON_PRODUCT_RESTRICTED')
    }

    if (getCouponStackingConflict(entries, (entry) => Boolean(entry.coupon.stackableWithCoupons))) {
        return failure('COUPON_NOT_STACKABLE')
    }

    const orderedEntries = sortCouponsForApplication(entries, (entry) => entry.coupon.discountType)

    const lines: CouponPricingLine[] = []
    let remainingCents = subtotalCents
    let couponDiscountCents = 0

    for (let index = 0; index < orderedEntries.length; index += 1) {
        const entry = orderedEntries[index]
        // 每张券在前一张折扣后的剩余金额上计算，保证叠加结果稳定且不超过应付金额。
        const evaluated = evaluateCouponRule({
            coupon: entry.coupon,
            now: input.now,
            userId: input.userId,
            productId: input.productId,
            subtotalCents: remainingCents,
            runtime: entry.runtime,
        })
        if (!evaluated.ok) {
            return { ok: false, error: evaluated.error }
        }

        const appliedDiscount = Math.max(0, Math.min(evaluated.discountAmountCents, remainingCents))
        if (appliedDiscount <= 0) {
            return failure('COUPON_NOT_ACTIVE')
        }

        remainingCents -= appliedDiscount
        couponDiscountCents += appliedDiscount

        lines.push({
            couponId: entry.coupon.id,
            code: entry.coupon.code,
            sequence: index,
            eligibleAmountCents: evaluated.eligibleAmountCents,
            discountAmountCents: appliedDiscount,
            stackableWithPoints: evaluated.stackableWithPoints,
            ruleSnapshot: evaluated.ruleSnapshot,
        })
    }

    const payableAfterCouponsCents = Math.max(0, subtotalCents - couponDiscountCents)

    if (input.usePoints && lines.some((line) => !line.stackableWithPoints)) {
        return failure('COUPON_POINTS_CONFLICT')
    }

    const pointConfig = sanitizePointDiscountConfig({
        pointDiscountEnabled: input.pointDiscountEnabled,
        pointDiscountPercent: input.pointDiscountPercent,
    })
    const availablePoints = toSafeAvailablePoints(input.availablePoints)
    const payableLdc = centsToLdcNumber(payableAfterCouponsCents)
    const maxDiscountPoints = pointConfig.enabled
        ? Math.max(0, Math.floor((payableLdc * pointConfig.percent) / 100))
        : 0
    const shouldUsePoints = pointConfig.enabled && input.usePoints && availablePoints > 0 && maxDiscountPoints > 0
    const pointsToUse = shouldUsePoints ? Math.min(availablePoints, maxDiscountPoints) : 0
    const pointsDiscountCents = pointsToUse * 100
    const finalAmountCents = Math.max(0, payableAfterCouponsCents - pointsDiscountCents)

    const snapshot: OrderPricingSnapshot = {
        version: PRICING_SNAPSHOT_VERSION,
        subtotalCents,
        couponDiscountCents,
        pointsDiscountCents,
        pointsUsed: pointsToUse,
        finalAmountCents,
        coupons: lines.map((line) => ({
            couponId: line.couponId,
            code: line.code,
            sequence: line.sequence,
            eligibleAmountCents: line.eligibleAmountCents,
            discountAmountCents: line.discountAmountCents,
            ruleSnapshot: line.ruleSnapshot,
        })),
        computedAt: input.now,
    }

    return {
        ok: true,
        result: {
            couponDiscountCents,
            payableAfterCouponsCents,
            pointsToUse,
            pointsDiscountCents,
            finalAmountCents,
            lines,
            pricingSnapshot: JSON.stringify(snapshot),
        },
    }
}

export function parseOrderPricingSnapshot(raw: string | null | undefined): OrderPricingSnapshot | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        return parsed as OrderPricingSnapshot
    } catch {
        return null
    }
}

export function getPricingDiscountCents(raw: string | null | undefined): {
    couponDiscountCents: number
    pointsDiscountCents: number
    subtotalCents: number | null
} {
    const snapshot = parseOrderPricingSnapshot(raw)
    if (!snapshot) {
        return { couponDiscountCents: 0, pointsDiscountCents: 0, subtotalCents: null }
    }
    return {
        couponDiscountCents: Number(snapshot.couponDiscountCents || 0),
        pointsDiscountCents: Number(snapshot.pointsDiscountCents || 0),
        subtotalCents: Number.isFinite(Number(snapshot.subtotalCents)) ? Number(snapshot.subtotalCents) : null,
    }
}

export function centsFromLdc(value: string | number | null | undefined): number {
    return parseLdcToCentsOrZero(value)
}
