import type { CouponValidationFailure } from './types.ts'

export type CouponErrorCode =
    | 'COUPON_NOT_FOUND'
    | 'COUPON_NOT_ACTIVE'
    | 'COUPON_NOT_STARTED'
    | 'COUPON_EXPIRED'
    | 'COUPON_EXHAUSTED'
    | 'COUPON_LOGIN_REQUIRED'
    | 'COUPON_USER_LIMIT_REACHED'
    | 'COUPON_PRODUCT_NOT_ELIGIBLE'
    | 'COUPON_MIN_SPEND_NOT_MET'
    | 'COUPON_NOT_STACKABLE'
    | 'COUPON_POINTS_CONFLICT'
    | 'COUPON_RESERVATION_CONFLICT'
    | 'COUPON_SCHEMA_UNAVAILABLE'
    | 'COUPON_INVALID_CODE'
    | 'COUPON_TOO_MANY'
    | 'COUPON_DUPLICATE_CODE'

const COUPON_ERROR_I18N_KEYS: Record<CouponErrorCode, string> = {
    COUPON_NOT_FOUND: 'coupon.errors.notFound',
    COUPON_NOT_ACTIVE: 'coupon.errors.notActive',
    COUPON_NOT_STARTED: 'coupon.errors.notStarted',
    COUPON_EXPIRED: 'coupon.errors.expired',
    COUPON_EXHAUSTED: 'coupon.errors.exhausted',
    COUPON_LOGIN_REQUIRED: 'coupon.errors.loginRequired',
    COUPON_USER_LIMIT_REACHED: 'coupon.errors.userLimitReached',
    COUPON_PRODUCT_NOT_ELIGIBLE: 'coupon.errors.productNotEligible',
    COUPON_MIN_SPEND_NOT_MET: 'coupon.errors.minSpendNotMet',
    COUPON_NOT_STACKABLE: 'coupon.errors.notStackable',
    COUPON_POINTS_CONFLICT: 'coupon.errors.pointsConflict',
    COUPON_RESERVATION_CONFLICT: 'coupon.errors.reservationConflict',
    COUPON_SCHEMA_UNAVAILABLE: 'coupon.errors.unavailable',
    COUPON_INVALID_CODE: 'coupon.errors.invalidCode',
    COUPON_TOO_MANY: 'coupon.errors.tooMany',
    COUPON_DUPLICATE_CODE: 'coupon.errors.duplicateCode',
}

export class CouponError extends Error {
    readonly code: CouponErrorCode

    constructor(code: CouponErrorCode, message?: string) {
        super(message || code)
        this.name = 'CouponError'
        this.code = code
    }

    get i18nKey() {
        return getCouponErrorI18nKey(this.code)
    }
}

export function getCouponErrorI18nKey(code: CouponErrorCode): string {
    return COUPON_ERROR_I18N_KEYS[code] || COUPON_ERROR_I18N_KEYS.COUPON_NOT_ACTIVE
}

export function couponFailure(code: CouponErrorCode): CouponValidationFailure {
    return { ok: false, error: getCouponErrorI18nKey(code) }
}

/**
 * 后台优惠券操作的错误码 → 文案 key 映射。
 *
 * 用于把底层抛出的错误（SQL 唯一约束、D1 结构漂移、驱动内部错误码）
 * 收敛为稳定的 i18n key。映射表未命中的错误一律退化为 `common.error`，
 * 保证任何内部信息（SQL 原文、绑定参数、表结构）都不会经返回值泄漏到前台。
 *
 * 注意：这里刻意**不**收录 `notFound` / `codeTaken` 之类的业务结论 ——
 * 那些由 Action 显式返回，不应从异常文本里反推。
 */
export const COUPON_ADMIN_ERROR_KEY_MAP: Record<string, string> = {
    // —— 结构类：确认是缺表/缺列时给出「功能暂时不可用」而不是通用错误
    'no such table': 'coupon.errors.unavailable',
    'no such view': 'coupon.errors.unavailable',
    no_such_table: 'coupon.errors.unavailable',
    d1_relation_notfound: 'coupon.errors.unavailable',
    'no such column': 'coupon.errors.unavailable',
    'column not found': 'coupon.errors.unavailable',
    d1_column_notfound: 'coupon.errors.unavailable',
    // —— 唯一约束：优惠码被并发占用
    'unique constraint': 'coupon.admin.errors.codeTaken',
    'constraint failed': 'coupon.admin.errors.codeTaken',
    // —— 结算/预占阶段可能冒到后台的业务错误
    COUPON_RESERVATION_CONFLICT: 'coupon.errors.reservationConflict',
    COUPON_SCHEMA_UNAVAILABLE: 'coupon.errors.unavailable',
    COUPON_NOT_FOUND: 'coupon.admin.errors.notFound',
}
