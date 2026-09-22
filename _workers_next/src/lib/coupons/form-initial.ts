import { centsToLdcNumber } from './money.ts'
import type { CouponRecord } from './types.ts'

export interface CouponFormInitial {
    id: string
    code: string
    name: string
    description: string
    discountType: 'percent' | 'fixed' | 'threshold_fixed'
    ratePercent: string
    discountValue: string
    minSpendValue: string
    maxDiscountValue: string
    scope: 'all' | 'selected'
    productIds: string[]
    totalUseLimit: string
    perUserLimit: string
    stackableWithCoupons: boolean
    stackableWithPoints: boolean
    refundPolicy: string
    status: string
    startsAtInput: string
    endsAtInput: string
}

function msToLocalInput(ms: number | null): string {
    if (ms === null) return ''
    const date = new Date(ms)
    if (!Number.isFinite(date.getTime())) return ''
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function toCouponFormInitial(coupon: CouponRecord): CouponFormInitial {
    return {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        description: coupon.description || '',
        discountType: coupon.discountType,
        ratePercent: coupon.rateBps ? String(coupon.rateBps / 100) : '',
        discountValue: coupon.discountAmountCents ? String(centsToLdcNumber(coupon.discountAmountCents)) : '',
        minSpendValue: coupon.minSpendCents > 0 ? String(centsToLdcNumber(coupon.minSpendCents)) : '',
        maxDiscountValue: coupon.maxDiscountCents ? String(centsToLdcNumber(coupon.maxDiscountCents)) : '',
        scope: coupon.scope,
        productIds: coupon.productIds,
        totalUseLimit: coupon.totalUseLimit === null ? '' : String(coupon.totalUseLimit),
        perUserLimit: coupon.perUserLimit === null ? '' : String(coupon.perUserLimit),
        stackableWithCoupons: coupon.stackableWithCoupons,
        stackableWithPoints: coupon.stackableWithPoints,
        refundPolicy: coupon.refundPolicy,
        status: coupon.status,
        startsAtInput: msToLocalInput(coupon.startsAt),
        endsAtInput: msToLocalInput(coupon.endsAt),
    }
}
