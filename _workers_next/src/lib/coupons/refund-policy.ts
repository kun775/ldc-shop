import type { CouponRefundPolicy } from './types.ts'

const COUPON_REFUND_POLICY_SET = new Set<CouponRefundPolicy>([
    'never',
    'unfulfilled_full_refund',
    'always',
])

export interface CouponRefundUsagePolicy {
    usageId: string
    ruleSnapshot: string | null | undefined
    refundPolicy: string | null | undefined
}

export function resolveCouponRefundPolicy(
    ruleSnapshot: string | null | undefined,
    fallback: string | null | undefined
): CouponRefundPolicy {
    if (ruleSnapshot) {
        try {
            const parsed = JSON.parse(ruleSnapshot) as { refundPolicy?: unknown }
            const snapshotPolicy = String(parsed?.refundPolicy || '') as CouponRefundPolicy
            if (COUPON_REFUND_POLICY_SET.has(snapshotPolicy)) return snapshotPolicy
        } catch {
            // 旧数据或损坏快照退回主表策略。
        }
    }

    const fallbackPolicy = String(fallback || '') as CouponRefundPolicy
    return COUPON_REFUND_POLICY_SET.has(fallbackPolicy)
        ? fallbackPolicy
        : 'unfulfilled_full_refund'
}

export function shouldReverseCouponsOnRefund(input: {
    refundPolicy: string | null | undefined
    fulfilled: boolean
}): boolean {
    const policy = resolveCouponRefundPolicy(null, input.refundPolicy)
    if (policy === 'never') return false
    if (policy === 'always') return true
    return !input.fulfilled
}

export function selectReversibleCouponUsageIds(
    usages: CouponRefundUsagePolicy[],
    fulfilled: boolean
): string[] {
    return usages
        .filter((usage) => shouldReverseCouponsOnRefund({
            refundPolicy: resolveCouponRefundPolicy(usage.ruleSnapshot, usage.refundPolicy),
            fulfilled,
        }))
        .map((usage) => usage.usageId)
        .filter(Boolean)
}
