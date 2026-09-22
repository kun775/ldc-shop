import { parseLdcToCents } from './money.ts'
import { resolveCheckoutPricing } from './pricing.ts'
import type { CouponRuntimeEntry } from './pricing.ts'
import { couponFailure } from './errors.ts'
import { normalizeCouponCodeList } from './code.ts'
import { loadCouponRuntimeEntries } from './repository.ts'
import type { CouponPricingResult } from './types.ts'

export interface CouponQuoteProduct {
    id: string
    price: string | number | null | undefined
    pointDiscountEnabled?: boolean | null
    pointDiscountPercent?: number | string | null
    couponUsageRestriction?: string | null
}

export interface CouponQuoteInput {
    product: CouponQuoteProduct
    quantity: number
    codes: string[]
    usePoints: boolean
    userId: string | null
    availablePoints: number
    now?: number
}

export type CouponQuoteOutcome =
    | { ok: true; subtotalCents: number; result: CouponPricingResult; entries: CouponRuntimeEntry[]; missing: string[] }
    | { ok: false; error: string }

// resolveCouponQuote 统一解析结算优惠（服务端唯一价格来源）
//
// 参数:
//   - input.product: 商品价格与积分抵扣配置
//   - input.quantity: 购买数量
//   - input.codes: 用户提交的优惠码列表
//   - input.usePoints: 是否使用积分抵扣
//   - input.availablePoints: 用户可用积分
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增下单与预览共用的定价入口，前端仅用于展示、服务端为唯一权威。
export async function resolveCouponQuote(input: CouponQuoteInput): Promise<CouponQuoteOutcome> {
    const quantity = Number.isFinite(input.quantity) && input.quantity > 0 ? Math.floor(input.quantity) : 1
    const unitPriceCents = parseLdcToCents(input.product.price)
    if (unitPriceCents === null || unitPriceCents < 0) {
        return { ok: false, error: 'checkout.invalidPrice' }
    }
    const subtotalCents = unitPriceCents * quantity
    const codes = normalizeCouponCodeList(input.codes)
    const now = input.now ?? Date.now()

    if (!codes.length) {
        const pricing = resolveCheckoutPricing({
            subtotalCents,
            productId: input.product.id,
            userId: input.userId,
            now,
            usePoints: input.usePoints,
            availablePoints: input.availablePoints,
            pointDiscountEnabled: Boolean(input.product.pointDiscountEnabled),
            pointDiscountPercent: Number(input.product.pointDiscountPercent || 0),
            productCouponUsageRestriction: input.product.couponUsageRestriction,
            entries: [],
        })
        if (!pricing.ok) return { ok: false, error: pricing.error }
        return { ok: true, subtotalCents, result: pricing.result, entries: [], missing: [] }
    }

    const { entries, missing } = await loadCouponRuntimeEntries(codes, input.userId)

    if (missing.length > 0 || entries.length === 0) {
        return { ok: false, error: couponFailure('COUPON_NOT_FOUND').error }
    }

    const pricing = resolveCheckoutPricing({
        subtotalCents,
        productId: input.product.id,
        userId: input.userId,
        now,
        usePoints: input.usePoints,
        availablePoints: input.availablePoints,
        pointDiscountEnabled: Boolean(input.product.pointDiscountEnabled),
        pointDiscountPercent: Number(input.product.pointDiscountPercent || 0),
        productCouponUsageRestriction: input.product.couponUsageRestriction,
        entries,
    })

    if (!pricing.ok) return { ok: false, error: pricing.error }

    return { ok: true, subtotalCents, result: pricing.result, entries, missing }
}
