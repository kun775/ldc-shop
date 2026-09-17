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
