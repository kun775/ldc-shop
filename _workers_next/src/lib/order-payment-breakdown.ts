function toSafeNumber(value: string | number | null | undefined) {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
}

export function getOrderPaymentBreakdown(input: {
    amount: string | number | null | undefined
    pointsUsed: string | number | null | undefined
}) {
    const ldcAmount = toSafeNumber(input.amount)
    const pointsAmount = toSafeNumber(input.pointsUsed)

    return {
        ldcAmount,
        pointsAmount,
        totalAmount: ldcAmount + pointsAmount
    }
}
