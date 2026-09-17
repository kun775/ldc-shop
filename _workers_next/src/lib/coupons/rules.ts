import { couponFailure } from './errors.ts'
import { applyRateBps } from './money.ts'
import type {
    CouponRecord,
    CouponRuntimeState,
    CouponValidationResult,
} from './types.ts'

export interface CouponEvaluationInput {
    coupon: CouponRecord
    now: number
    userId: string | null
    productId: string
    subtotalCents: number
    runtime: CouponRuntimeState
}

function isPercentConfigValid(coupon: CouponRecord): boolean {
    return Number.isFinite(coupon.rateBps) && Number(coupon.rateBps) > 0 && Number(coupon.rateBps) <= 10000
}

function isFixedConfigValid(coupon: CouponRecord): boolean {
    return Number.isFinite(coupon.discountAmountCents) && Number(coupon.discountAmountCents) > 0
}

// buildCouponRuleSnapshot 生成优惠券规则快照
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增下单时固化的规则快照，历史订单不随主表变更而漂移。
export function buildCouponRuleSnapshot(coupon: CouponRecord): string {
    const snapshot = {
        v: 1,
        code: coupon.code,
        name: coupon.name,
        discountType: coupon.discountType,
        rateBps: coupon.rateBps,
        discountAmountCents: coupon.discountAmountCents,
        minSpendCents: coupon.minSpendCents,
        maxDiscountCents: coupon.maxDiscountCents,
        scope: coupon.scope,
        productIds: coupon.scope === 'selected' ? coupon.productIds : [],
        stackableWithCoupons: coupon.stackableWithCoupons,
        stackableWithPoints: coupon.stackableWithPoints,
        refundPolicy: coupon.refundPolicy,
    }
    const serialized = JSON.stringify(snapshot)
    return serialized.length > 4000 ? serialized.slice(0, 4000) : serialized
}

export function resolveCouponEligibleAmountCents(input: {
    coupon: CouponRecord
    productId: string
    subtotalCents: number
}): number | null {
    const subtotal = Math.max(0, Math.round(input.subtotalCents))
    if (input.coupon.scope === 'all') return subtotal
    if (!input.coupon.productIds.includes(input.productId)) return null
    return subtotal
}

// evaluateCouponRule 评估单张优惠券在本次结算中的可用性与优惠金额
//
// 参数:
//   - input.coupon: 优惠券规则
//   - input.now: 服务端当前毫秒时间戳
//   - input.userId: 不可篡改的登录用户 ID，未登录为空
//   - input.productId: 本次结算商品 ID
//   - input.subtotalCents: 商品小计（整数分）
//   - input.runtime: 总次数与用户次数的当前占用情况
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增纯函数规则校验与折扣计算，不依赖数据库。
export function evaluateCouponRule(input: CouponEvaluationInput): CouponValidationResult {
    const { coupon, now, userId, productId, subtotalCents, runtime } = input

    if (coupon.status !== 'active') {
        return couponFailure('COUPON_NOT_ACTIVE')
    }

    if (coupon.startsAt !== null && coupon.startsAt !== undefined && now < coupon.startsAt) {
        return couponFailure('COUPON_NOT_STARTED')
    }

    if (coupon.endsAt !== null && coupon.endsAt !== undefined && now > coupon.endsAt) {
        return couponFailure('COUPON_EXPIRED')
    }

    if (coupon.perUserLimit !== null && coupon.perUserLimit !== undefined && !userId) {
        return couponFailure('COUPON_LOGIN_REQUIRED')
    }

    if (coupon.discountType === 'percent' && !isPercentConfigValid(coupon)) {
        return couponFailure('COUPON_NOT_ACTIVE')
    }
    if (coupon.discountType !== 'percent' && !isFixedConfigValid(coupon)) {
        return couponFailure('COUPON_NOT_ACTIVE')
    }

    const usedTotal = Math.max(0, runtime.totalReserved) + Math.max(0, runtime.totalConsumed)
    if (coupon.totalUseLimit !== null && coupon.totalUseLimit !== undefined && usedTotal >= coupon.totalUseLimit) {
        return couponFailure('COUPON_EXHAUSTED')
    }

    if (coupon.perUserLimit !== null && coupon.perUserLimit !== undefined) {
        const usedByUser = Math.max(0, runtime.userReserved) + Math.max(0, runtime.userConsumed)
        if (usedByUser >= coupon.perUserLimit) {
            return couponFailure('COUPON_USER_LIMIT_REACHED')
        }
    }

    const eligibleAmountCents = resolveCouponEligibleAmountCents({
        coupon,
        productId,
        subtotalCents,
    })
    if (eligibleAmountCents === null || eligibleAmountCents <= 0) {
        return couponFailure('COUPON_PRODUCT_NOT_ELIGIBLE')
    }

    const minSpend = Math.max(0, Math.round(coupon.minSpendCents || 0))
    if (eligibleAmountCents < minSpend) {
        return couponFailure('COUPON_MIN_SPEND_NOT_MET')
    }

    let discountAmountCents = 0
    if (coupon.discountType === 'percent') {
        const payableCents = applyRateBps(eligibleAmountCents, Number(coupon.rateBps))
        discountAmountCents = eligibleAmountCents - payableCents
        if (coupon.maxDiscountCents !== null && coupon.maxDiscountCents !== undefined) {
            discountAmountCents = Math.min(discountAmountCents, Math.max(0, coupon.maxDiscountCents))
        }
    } else {
        discountAmountCents = Math.max(0, Math.round(coupon.discountAmountCents || 0))
    }

    discountAmountCents = Math.max(0, Math.min(discountAmountCents, eligibleAmountCents))

    if (discountAmountCents <= 0) {
        return couponFailure('COUPON_NOT_ACTIVE')
    }

    return {
        ok: true,
        eligibleAmountCents,
        discountAmountCents,
        stackableWithPoints: Boolean(coupon.stackableWithPoints),
        ruleSnapshot: buildCouponRuleSnapshot(coupon),
    }
}

// sortCouponsForApplication 计算多券应用顺序
//
// 参数:
//   - items: 待排序的优惠券或包装对象
//   - getDiscountType: 从元素中取出优惠类型的访问器，默认读取顶层 discountType
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 固定额与满减券优先，百分比券后置，同类型保持输入顺序，保证金额可复现。
export function sortCouponsForApplication<T>(
    items: T[],
    getDiscountType: (item: T) => string = (item) => String((item as { discountType?: unknown })?.discountType || '')
): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const aPercent = getDiscountType(a.item) === 'percent' ? 1 : 0
            const bPercent = getDiscountType(b.item) === 'percent' ? 1 : 0
            if (aPercent !== bPercent) return aPercent - bPercent
            return a.index - b.index
        })
        .map((entry) => entry.item)
}

// getCouponStackingConflict 判断多券组合中是否存在不允许叠加的券
//
// 参数:
//   - items: 待校验的优惠券或包装对象
//   - isStackable: 从元素中取出叠加载荷的访问器，默认读取顶层 stackableWithCoupons
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增访问器参数，兼容 { coupon, runtime } 包装结构，避免读到 undefined 误判。
export function getCouponStackingConflict<T>(
    items: T[],
    isStackable: (item: T) => boolean = (item) => Boolean((item as { stackableWithCoupons?: unknown })?.stackableWithCoupons)
): boolean {
    if (items.length <= 1) return false
    return items.some((item) => !isStackable(item))
}
