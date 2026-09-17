/**
 * 面向客户端的错误脱敏工具。
 *
 * Server Action 的「返回值」不会像 throw 那样被 Next.js 自动脱敏，
 * 因此任何把 error.message 直接放进返回值的地方都会把数据库结构、
 * SQL 原文和绑定参数暴露给前台（例如：
 * `Failed query: insert into "user_point_ledger" (...) params: 10785,...`）。
 *
 * 约定：
 *   - 内部错误一律不返回原文，只返回稳定的 i18n key 或通用文案，
 *     并在服务端用 errorId 记录完整堆栈，便于排查与用户反馈对账。
 *   - 只有明确属于业务语义的短消息才允许透传。
 */

const INTERNAL_ERROR_PATTERNS: RegExp[] = [
    /failed query/i,
    /\bparams\s*:/i,
    /\binsert\s+into\b/i,
    /\bdelete\s+from\b/i,
    /\bupdate\b[\s\S]*?\bset\b/i,
    /\bselect\b[\s\S]*?\bfrom\b/i,
    /on\s+conflict/i,
    /returning\s+"/i,
    /no such (table|column|index)/i,
    /sqlite_/i,
    /d1_error/i,
    /\bd1\b/i,
    /constraint failed/i,
    /unique constraint/i,
    /duplicate column/i,
    /foreign key constraint/i,
    /syntax error/i,
    /drizzle/i,
    /\bbinding\b/i,
    /relation .* does not exist/i,
]

/** 明显的代码内部错误码（全大写下划线），不应直接展示给用户 */
const INTERNAL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{6,}$/

const MAX_CLIENT_MESSAGE_LENGTH = 160
const CLIENT_I18N_KEY_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/

/**
 * createErrorId 生成用于日志对账的短错误 ID
 */
export function createErrorId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * isInternalErrorMessage 判断消息是否包含数据库/驱动内部信息
 */
export function isInternalErrorMessage(message: string | null | undefined): boolean {
    const text = String(message || '').trim()
    if (!text) return true
    if (text.length > MAX_CLIENT_MESSAGE_LENGTH) return true
    if (INTERNAL_CODE_PATTERN.test(text)) return true
    return INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * sanitizeClientErrorMessage 把内部错误替换为安全文案
 *
 * 参数:
 *   - message: 原始错误消息
 *   - fallback: 兜底的安全文案
 *
 * 返回值:
 *   - 可安全展示给用户的文案
 */
export function sanitizeClientErrorMessage(
    message: string | null | undefined,
    fallback: string
): string {
    const text = String(message || '').trim()
    if (!text) return fallback
    if (isInternalErrorMessage(text)) return fallback
    return text
}

/**
 * resolveClientActionErrorKey 只接受稳定的 i18n key。
 * React/Next 生产错误和服务端原始消息一律退化为通用错误。
 */
export function resolveClientActionErrorKey(
    error: unknown,
    fallbackKey: string = 'common.error'
): string {
    const raw = String((error as { message?: unknown })?.message ?? '').trim()
    if (!raw || raw.length > MAX_CLIENT_MESSAGE_LENGTH) return fallbackKey
    return CLIENT_I18N_KEY_PATTERN.test(raw) ? raw : fallbackKey
}

/**
 * logServerError 在服务端记录完整错误并返回 errorId
 *
 * 参数:
 *   - scope: 业务范围标识，例如 "checkin"
 *   - error: 原始错误对象
 *   - errorId: 可选，复用已生成的 ID
 */
export function logServerError(
    scope: string,
    error: unknown,
    errorId?: string,
    options?: { persist?: boolean },
): string {
    const id = errorId || createErrorId()
    console.error(`[${scope}] errorId=${id}`, error)
    if (options?.persist !== false) {
        void Promise.all([
            import('@/lib/audit/service'),
            import('@/lib/audit/request-context'),
        ]).then(async ([audit, requestContext]) => {
            const context = await requestContext.getAuditRequestContext()
            await audit.writePlatformError({
                scope,
                error,
                errorId: id,
                method: context.method,
                path: context.path,
                ip: context.ip,
                userAgent: context.userAgent,
            })
        }).catch((persistError) => {
            // 不能调用 logServerError，否则平台日志故障会递归放大。
            console.error('[Audit] failed to persist server error', scope, persistError)
        })
    }
    return id
}

/**
 * resolveClientErrorKey 按业务错误码映射为稳定的 i18n key
 *
 * 参数:
 *   - error: 原始错误对象
 *   - mapping: 错误码到 i18n key 的映射表
 *   - fallbackKey: 未命中时的兜底 key
 *
 * 说明:
 *   - 只有命中 mapping 的错误码才会被透出，其余一律走 fallbackKey，
 *     避免任何未知的内部错误文案泄漏到前台。
 */
export function resolveClientErrorKey(
    error: unknown,
    mapping: Record<string, string>,
    fallbackKey: string
): string {
    const seen = new Set<object>()
    let current: unknown = error

    for (let depth = 0; current != null && depth < 8; depth += 1) {
        const candidates: unknown[] = []

        if (typeof current === 'object' || typeof current === 'function') {
            const record = current as object
            if (seen.has(record)) break
            seen.add(record)

            for (const field of ['code', 'message'] as const) {
                try {
                    candidates.push((current as { code?: unknown; message?: unknown })[field])
                } catch {
                    // 忽略异常 getter，继续检查嵌套 cause。
                }
            }
        } else {
            candidates.push(current)
        }

        for (const candidate of candidates) {
            const raw = String(candidate ?? '').trim()
            if (!raw) continue
            if (Object.prototype.hasOwnProperty.call(mapping, raw)) {
                return mapping[raw]
            }

            for (const [code, key] of Object.entries(mapping)) {
                const index = raw.indexOf(code)
                if (index < 0) continue

                const before = index > 0 ? raw[index - 1] : ''
                const after = index + code.length < raw.length ? raw[index + code.length] : ''
                const isCodeChar = (char: string) => /[A-Za-z0-9_]/.test(char)
                if (!isCodeChar(before) && !isCodeChar(after)) {
                    return key
                }
            }
        }

        if (typeof current !== 'object' && typeof current !== 'function') break
        try {
            current = (current as { cause?: unknown }).cause
        } catch {
            break
        }
    }

    return fallbackKey
}
