import { COUPON_CODE_MAX_LENGTH, COUPON_CODE_MIN_LENGTH } from './types.ts'

const COUPON_CODE_ALLOWED_PATTERN = /^[A-Z0-9_-]+$/
const COUPON_CODE_RANDOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// normalizeCouponCode 标准化优惠码（去空格并转大写）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 统一优惠码大小写与空白处理，保证大小写不敏感唯一。
export function normalizeCouponCode(code: string | null | undefined): string {
    return String(code || '').trim().toUpperCase()
}

export function isValidCouponCodeFormat(code: string): boolean {
    if (code.length < COUPON_CODE_MIN_LENGTH || code.length > COUPON_CODE_MAX_LENGTH) {
        return false
    }
    return COUPON_CODE_ALLOWED_PATTERN.test(code)
}

// normalizeCouponCodeList 标准化并去重优惠码列表
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增多券输入的标准化与去重，保持原有顺序。
export function normalizeCouponCodeList(codes: Array<string | null | undefined> | null | undefined): string[] {
    if (!Array.isArray(codes)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of codes) {
        const normalized = normalizeCouponCode(raw)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        result.push(normalized)
    }
    return result
}

/**
 * 按用户提交的优惠码顺序重建数据库返回结果。
 *
 * SQL 在没有 ORDER BY 时不保证返回顺序，而同类型优惠券的应用顺序会影响
 * 满减门槛，因此必须在进入定价层前恢复规范化后的输入顺序。
 */
export function orderCouponEntriesByCode<T>(
    codes: Array<string | null | undefined>,
    entries: T[],
    getCode: (entry: T) => string | null | undefined
): T[] {
    const normalizedCodes = normalizeCouponCodeList(codes)
    const entryByCode = new Map<string, T>()
    for (const entry of entries) {
        const code = normalizeCouponCode(getCode(entry))
        if (code && !entryByCode.has(code)) {
            entryByCode.set(code, entry)
        }
    }
    return normalizedCodes
        .map((code) => entryByCode.get(code))
        .filter((entry): entry is T => entry !== undefined)
}

// generateCouponCode 生成随机优惠码
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增后台创建优惠券时的默认码生成逻辑。
export function generateCouponCode(length: number = 8, prefix: string = ''): string {
    const safeLength = Math.max(COUPON_CODE_MIN_LENGTH, Math.min(24, Math.floor(length) || 8))
    let body = ''
    for (let i = 0; i < safeLength; i += 1) {
        const index = Math.floor(Math.random() * COUPON_CODE_RANDOM_ALPHABET.length)
        body += COUPON_CODE_RANDOM_ALPHABET.charAt(index)
    }
    const normalizedPrefix = normalizeCouponCode(prefix).replace(/[^A-Z0-9_-]/g, '')
    return normalizedPrefix ? `${normalizedPrefix}${body}` : body
}
