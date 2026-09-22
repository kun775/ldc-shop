import { randomUUID } from 'crypto'
import { normalizeCouponCode, isValidCouponCodeFormat } from './code.ts'
import { parseLdcToCents } from './money.ts'
import {
    COUPON_DISCOUNT_TYPES,
    COUPON_REFUND_POLICIES,
    COUPON_SCOPES,
    COUPON_STATUSES,
    type CouponDiscountType,
    type CouponRefundPolicy,
    type CouponScope,
    type CouponStatus,
} from './types.ts'
import type { CouponWriteInput } from './repository.ts'

const NAME_MAX_LENGTH = 100
const DESCRIPTION_MAX_LENGTH = 500
const MAX_INT_LIMIT = 1_000_000

export type CouponFormParseResult =
    | { ok: true; value: CouponWriteInput }
    | { ok: false; error: string }

function readString(formData: FormData, key: string): string {
    const value = formData.get(key)
    return typeof value === 'string' ? value.trim() : ''
}

function readOptionalInt(formData: FormData, key: string): number | null {
    const raw = readString(formData, key)
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
}

function readOptionalMs(formData: FormData, key: string): number | null {
    const raw = readString(formData, key)
    if (!raw) return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return Math.floor(parsed)
}

function readProductIds(formData: FormData): string[] {
    const raw = readString(formData, 'productIds')
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
    } catch {
        return []
    }
}

// parseCouponForm 校验并归一化后台优惠券表单
//
// 参数:
//   - formData: 创建或编辑表单
//   - existingId: 编辑时的优惠券 ID，创建时为空
//   - createdBy: 当前管理员 userId
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增边界校验与金额分转换，禁止客户端直接提交计数字段。
export function parseCouponForm(
    formData: FormData,
    options: { existingId?: string | null; createdBy?: string | null } = {}
): CouponFormParseResult {
    const name = readString(formData, 'name')
    if (!name || name.length > NAME_MAX_LENGTH) {
        return { ok: false, error: 'coupon.admin.errors.nameInvalid' }
    }

    const code = normalizeCouponCode(readString(formData, 'code'))
    if (!isValidCouponCodeFormat(code)) {
        return { ok: false, error: 'coupon.admin.errors.codeInvalid' }
    }

    const descriptionRaw = readString(formData, 'description')
    if (descriptionRaw.length > DESCRIPTION_MAX_LENGTH) {
        return { ok: false, error: 'coupon.admin.errors.descriptionTooLong' }
    }

    const discountTypeRaw = readString(formData, 'discountType') as CouponDiscountType
    if (!COUPON_DISCOUNT_TYPES.includes(discountTypeRaw)) {
        return { ok: false, error: 'coupon.admin.errors.typeInvalid' }
    }

    let rateBps: number | null = null
    let discountAmountCents: number | null = null

    if (discountTypeRaw === 'percent') {
        const ratePercent = readOptionalInt(formData, 'ratePercent')
        if (ratePercent === null || ratePercent < 1 || ratePercent > 100) {
            return { ok: false, error: 'coupon.admin.errors.rateInvalid' }
        }
        rateBps = ratePercent * 100
    } else {
        const discountValue = readString(formData, 'discountValue')
        const parsed = parseLdcToCents(discountValue)
        if (parsed === null || parsed <= 0) {
            return { ok: false, error: 'coupon.admin.errors.discountInvalid' }
        }
        discountAmountCents = parsed
    }

    const maxDiscountRaw = readString(formData, 'maxDiscountValue')
    let maxDiscountCents: number | null = null
    if (maxDiscountRaw) {
        const parsed = parseLdcToCents(maxDiscountRaw)
        if (parsed === null || parsed <= 0) {
            return { ok: false, error: 'coupon.admin.errors.maxDiscountInvalid' }
        }
        maxDiscountCents = parsed
    }

    const minSpendRaw = readString(formData, 'minSpendValue')
    let minSpendCents = 0
    if (minSpendRaw) {
        const parsedMinSpend = parseLdcToCents(minSpendRaw)
        if (parsedMinSpend === null || parsedMinSpend < 0) {
            return { ok: false, error: 'coupon.admin.errors.minSpendInvalid' }
        }
        minSpendCents = parsedMinSpend
    }
    if (discountTypeRaw === 'threshold_fixed' && minSpendCents <= 0) {
        return { ok: false, error: 'coupon.admin.errors.minSpendRequired' }
    }

    const scopeRaw = readString(formData, 'scope') as CouponScope
    if (!COUPON_SCOPES.includes(scopeRaw)) {
        return { ok: false, error: 'coupon.admin.errors.scopeInvalid' }
    }
    const productIds = scopeRaw === 'selected' ? readProductIds(formData) : []
    if (scopeRaw === 'selected' && productIds.length === 0) {
        return { ok: false, error: 'coupon.admin.errors.productsRequired' }
    }

    const totalUseLimit = readOptionalInt(formData, 'totalUseLimit')
    if (totalUseLimit !== null && (totalUseLimit < 1 || totalUseLimit > MAX_INT_LIMIT)) {
        return { ok: false, error: 'coupon.admin.errors.totalLimitInvalid' }
    }

    const perUserLimit = readOptionalInt(formData, 'perUserLimit')
    if (perUserLimit !== null && (perUserLimit < 1 || perUserLimit > MAX_INT_LIMIT)) {
        return { ok: false, error: 'coupon.admin.errors.perUserLimitInvalid' }
    }

    if (totalUseLimit !== null && perUserLimit !== null && perUserLimit > totalUseLimit) {
        return { ok: false, error: 'coupon.admin.errors.perUserExceedsTotal' }
    }

    const startsAt = readOptionalMs(formData, 'startsAtMs')
    const endsAt = readOptionalMs(formData, 'endsAtMs')
    if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
        return { ok: false, error: 'coupon.admin.errors.windowInvalid' }
    }

    const refundPolicyRaw = readString(formData, 'refundPolicy') as CouponRefundPolicy
    const refundPolicy = COUPON_REFUND_POLICIES.includes(refundPolicyRaw)
        ? refundPolicyRaw
        : 'unfulfilled_full_refund'

    const statusRaw = readString(formData, 'status') as CouponStatus
    const status = COUPON_STATUSES.includes(statusRaw) ? statusRaw : 'draft'
    if (status === 'active' && discountTypeRaw === 'percent' && !rateBps) {
        return { ok: false, error: 'coupon.admin.errors.rateInvalid' }
    }

    return {
        ok: true,
        value: {
            id: options.existingId || `cpn_${randomUUID()}`,
            code,
            name,
            description: descriptionRaw || null,
            discountType: discountTypeRaw,
            rateBps,
            discountAmountCents,
            minSpendCents,
            maxDiscountCents,
            scope: scopeRaw,
            productIds,
            totalUseLimit,
            perUserLimit,
            stackableWithCoupons: formData.get('stackableWithCoupons') === 'on',
            stackableWithPoints: formData.get('stackableWithPoints') === 'on',
            refundPolicy,
            status,
            startsAt,
            endsAt,
            createdBy: options.createdBy ?? null,
        },
    }
}
