export type CouponDiscountType = 'percent' | 'fixed' | 'threshold_fixed'

export type CouponScope = 'all' | 'selected'

export type CouponStatus = 'draft' | 'active' | 'disabled'

export type CouponRefundPolicy = 'never' | 'unfulfilled_full_refund' | 'always'

export type CouponUsageStatus = 'reserved' | 'consumed' | 'released' | 'reversed'

export const COUPON_DISCOUNT_TYPES: CouponDiscountType[] = ['percent', 'fixed', 'threshold_fixed']
export const COUPON_SCOPES: CouponScope[] = ['all', 'selected']
export const COUPON_STATUSES: CouponStatus[] = ['draft', 'active', 'disabled']
export const COUPON_REFUND_POLICIES: CouponRefundPolicy[] = [
    'never',
    'unfulfilled_full_refund',
    'always',
]

export const MAX_COUPONS_PER_ORDER = 3
export const COUPON_CODE_MIN_LENGTH = 4
export const COUPON_CODE_MAX_LENGTH = 32

export interface CouponRecord {
    id: string
    code: string
    name: string
    description: string | null
    discountType: CouponDiscountType
    rateBps: number | null
    discountAmountCents: number | null
    minSpendCents: number
    maxDiscountCents: number | null
    scope: CouponScope
    productIds: string[]
    totalUseLimit: number | null
    perUserLimit: number | null
    reservedCount: number
    consumedCount: number
    stackableWithCoupons: boolean
    stackableWithPoints: boolean
    refundPolicy: CouponRefundPolicy
    status: CouponStatus
    startsAt: number | null
    endsAt: number | null
    createdBy: string | null
    createdAt: number | null
    updatedAt: number | null
}

export interface CouponRuntimeState {
    totalReserved: number
    totalConsumed: number
    userReserved: number
    userConsumed: number
}

export interface CouponPricingLine {
    couponId: string
    code: string
    sequence: number
    eligibleAmountCents: number
    discountAmountCents: number
    stackableWithPoints: boolean
    ruleSnapshot: string
}

export interface CouponPricingResult {
    couponDiscountCents: number
    payableAfterCouponsCents: number
    pointsToUse: number
    pointsDiscountCents: number
    finalAmountCents: number
    lines: CouponPricingLine[]
    pricingSnapshot: string
}

export interface CouponPreviewDiscount {
    couponId: string
    code: string
    name: string
    discountAmountCents: number
}

export interface CouponPreviewResult {
    success: true
    subtotalCents: number
    couponDiscountCents: number
    totalDiscountCents: number
    finalAmountCents: number
    discounts: CouponPreviewDiscount[]
}

export interface CouponValidationSuccess {
    ok: true
    eligibleAmountCents: number
    discountAmountCents: number
    stackableWithPoints: boolean
    ruleSnapshot: string
}

export interface CouponValidationFailure {
    ok: false
    error: string
}

export type CouponValidationResult = CouponValidationSuccess | CouponValidationFailure

export interface OrderPricingSnapshot {
    version: number
    subtotalCents: number
    couponDiscountCents: number
    pointsDiscountCents: number
    pointsUsed: number
    finalAmountCents: number
    coupons: Array<{
        couponId: string
        code: string
        sequence: number
        eligibleAmountCents: number
        discountAmountCents: number
        ruleSnapshot: string
    }>
    computedAt: number
}
