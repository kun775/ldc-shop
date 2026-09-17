function toSafeNumber(value: string | number | null | undefined) {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
}

function formatAmount(value: number) {
    return value.toFixed(2)
}

export function getOrderPaymentBreakdown(input: {
    amount: string | number | null | undefined
    pointsUsed: string | number | null | undefined
    subtotalAmountCents?: string | number | null
    couponDiscountAmountCents?: string | number | null
    pointsDiscountAmountCents?: string | number | null
}) {
    const ldcAmount = toSafeNumber(input.amount)
    const pointsAmount = toSafeNumber(input.pointsUsed)

    const hasCouponSnapshot =
        input.subtotalAmountCents !== null &&
        input.subtotalAmountCents !== undefined &&
        String(input.subtotalAmountCents) !== ''

    if (!hasCouponSnapshot) {
        return {
            ldcAmount: formatAmount(ldcAmount),
            pointsAmount,
            totalAmount: formatAmount(ldcAmount + pointsAmount),
            subtotalAmount: null as number | null,
            couponDiscountAmount: 0,
            pointsDiscountAmount: 0,
            hasCouponBreakdown: false,
        }
    }

    const subtotalAmount = toSafeNumber(input.subtotalAmountCents) / 100
    const couponDiscountAmount = toSafeNumber(input.couponDiscountAmountCents) / 100
    const pointsDiscountAmount = toSafeNumber(input.pointsDiscountAmountCents) / 100

    return {
        ldcAmount: formatAmount(ldcAmount),
        pointsAmount,
        totalAmount: formatAmount(ldcAmount + pointsAmount + couponDiscountAmount + pointsDiscountAmount),
        subtotalAmount,
        couponDiscountAmount,
        pointsDiscountAmount,
        hasCouponBreakdown: true,
    }
}
