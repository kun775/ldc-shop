function toSafeNumber(value: string | number | null | undefined) {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
}

function formatAmount(value: number) {
    return value.toFixed(2)
}

/**
 * 整数分 → 元。DB 里的定价快照全部以「整数分」存储，展示层统一换算成元。
 */
function centsToAmount(value: string | number | null | undefined) {
    return toSafeNumber(value) / 100
}

function hasValue(value: string | number | null | undefined) {
    return value !== null && value !== undefined && String(value) !== ''
}

export interface OrderPaymentCouponLine {
    couponId: string
    code: string | null
    /** 该张券实际抵扣金额（元，正数） */
    discountAmount: number
}

/**
 * 从 orders.pricing_snapshot 中解析逐张优惠券的抵扣明细。
 *
 * 快照是订单成交时刻的自包含记录，不依赖优惠券主表，因此券被改名或删除
 * 也不会让历史订单的金额发生变化——这正是这里只读快照、不回表 join 的原因。
 * 解析失败一律降级为「无逐张明细」，由调用方退回展示汇总的优惠券优惠行。
 */
export function parseOrderCouponLines(raw: string | null | undefined): OrderPaymentCouponLine[] {
    if (typeof raw !== 'string' || raw.trim() === '') return []

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }

    const rawCoupons = (parsed as { coupons?: unknown } | null)?.coupons
    if (!Array.isArray(rawCoupons)) return []

    const lines: OrderPaymentCouponLine[] = []
    for (const item of rawCoupons) {
        if (!item || typeof item !== 'object') continue
        const coupon = item as { couponId?: unknown; code?: unknown; discountAmountCents?: unknown }
        const discountAmount = centsToAmount(coupon.discountAmountCents as number)
        // 抵扣 0 元的券不占展示行，避免出现「-0.00」的噪声
        if (discountAmount <= 0) continue

        const couponId = typeof coupon.couponId === 'string' ? coupon.couponId.trim() : ''
        const code = typeof coupon.code === 'string' && coupon.code.trim() !== '' ? coupon.code.trim() : null
        if (!couponId && !code) continue

        lines.push({ couponId, code, discountAmount })
    }
    return lines
}

/**
 * 订单支付明细。
 *
 * 口径（2026-09-18 与商家确认）：
 *   商品小计 − 优惠券优惠 − 积分抵扣 = 订单合计（= 网关实付金额 orders.amount）
 * 「订单合计」取实付口径，即买家真实付出的钱，不再回加优惠券与积分。
 */
export interface OrderPaymentBreakdown {
    /** 网关实付金额（元，两位小数字符串），等于 orders.amount */
    ldcAmount: string
    /** 使用的积分数量（1 积分 = ¥1） */
    pointsAmount: number
    /** 积分抵扣金额（元，正数），展示时加负号 */
    pointsDiscountAmount: number
    /** 商品小计（元）；无法可靠推导时为 null */
    subtotalAmount: number | null
    /** 优惠券抵扣合计（元，正数） */
    couponDiscountAmount: number
    /** 是否存在定价快照（优惠券功能上线后下单的订单才有） */
    hasCouponBreakdown: boolean
    /** 逐张优惠券抵扣明细，仅存在定价快照时有值 */
    couponLines: OrderPaymentCouponLine[]
    /** 订单合计（实付口径，两位小数字符串） */
    totalAmount: string
}

export function getOrderPaymentBreakdown(input: {
    amount: string | number | null | undefined
    pointsUsed: string | number | null | undefined
    subtotalAmountCents?: string | number | null
    couponDiscountAmountCents?: string | number | null
    pointsDiscountAmountCents?: string | number | null
    pricingSnapshot?: string | null
}): OrderPaymentBreakdown {
    const ldcAmount = toSafeNumber(input.amount)
    const pointsAmount = Math.max(0, toSafeNumber(input.pointsUsed))

    const hasCouponBreakdown = hasValue(input.subtotalAmountCents)

    const couponDiscountAmount = hasCouponBreakdown ? centsToAmount(input.couponDiscountAmountCents) : 0
    // 老订单（优惠券功能上线前）没有定价快照，退回积分数量：1 积分 = ¥1，两者数值等价
    const pointsDiscountAmount = hasValue(input.pointsDiscountAmountCents)
        ? centsToAmount(input.pointsDiscountAmountCents)
        : pointsAmount

    // 有快照：商品小计以快照为准；
    // 无快照但用过积分：下单时 amount 必然由「订单原价 − 积分抵扣」得出，可安全反推；
    // 无快照且未用积分：不猜测小计，置 null 由展示层隐藏该行。
    let subtotalAmount: number | null = null
    if (hasCouponBreakdown) {
        subtotalAmount = centsToAmount(input.subtotalAmountCents)
    } else if (pointsDiscountAmount > 0) {
        subtotalAmount = ldcAmount + pointsDiscountAmount
    }

    return {
        ldcAmount: formatAmount(ldcAmount),
        pointsAmount,
        pointsDiscountAmount,
        subtotalAmount,
        couponDiscountAmount,
        hasCouponBreakdown,
        couponLines: parseOrderCouponLines(input.pricingSnapshot),
        totalAmount: formatAmount(ldcAmount),
    }
}
