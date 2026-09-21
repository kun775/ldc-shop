import type { CouponRecord } from './types.ts'

export const PRODUCT_COUPON_USAGE_RESTRICTIONS = ['none', 'selected', 'all'] as const

export type ProductCouponUsageRestriction = (typeof PRODUCT_COUPON_USAGE_RESTRICTIONS)[number]

export interface SupportedProductCoupon {
    id: string
    code: string
    name: string
    description: string | null
    status: string
    startsAt: number | null
    endsAt: number | null
    runtimeStatus: 'draft' | 'disabled' | 'scheduled' | 'expired' | 'active'
}

export function normalizeProductCouponUsageRestriction(value: unknown): ProductCouponUsageRestriction {
    const normalized = String(value || '').trim()
    return (PRODUCT_COUPON_USAGE_RESTRICTIONS as readonly string[]).includes(normalized)
        ? normalized as ProductCouponUsageRestriction
        : 'all'
}

export function isCouponAllowedForProduct(input: {
    restriction: unknown
    coupon: Pick<CouponRecord, 'scope' | 'productIds'>
    productId: string
}): boolean {
    const restriction = normalizeProductCouponUsageRestriction(input.restriction)
    if (restriction === 'none') return false
    if (restriction === 'all') return true
    return input.coupon.scope === 'selected' && input.coupon.productIds.includes(input.productId)
}
