type ErrorRecord = {
    cause?: unknown
    code?: unknown
    message?: unknown
    name?: unknown
}

function readErrorField(error: object, field: keyof ErrorRecord): unknown {
    try {
        return (error as ErrorRecord)[field]
    } catch {
        return undefined
    }
}

/** Collect readable text from an error and its nested causes. */
export function collectErrorText(error: unknown): string {
    const parts: string[] = []
    const seen = new Set<object>()
    let current: unknown = error

    for (let depth = 0; current != null && depth < 8; depth += 1) {
        if (typeof current === 'string' || typeof current === 'number') {
            parts.push(String(current))
            break
        }

        if (typeof current !== 'object' && typeof current !== 'function') {
            parts.push(String(current))
            break
        }

        const record = current as object
        if (seen.has(record)) break
        seen.add(record)

        for (const field of ['name', 'code', 'message'] as const) {
            const value = readErrorField(record, field)
            if (typeof value === 'string' || typeof value === 'number') {
                parts.push(String(value))
            }
        }

        try {
            parts.push(String(current))
        } catch {
            // Ignore custom toString failures and continue with the nested cause.
        }

        current = readErrorField(record, 'cause')
    }

    return parts.join(' ')
}

export function isDuplicateColumnError(error: unknown): boolean {
    const text = collectErrorText(error).toLowerCase()
    return text.includes('duplicate column')
        || (text.includes('column') && text.includes('already exists'))
}

/**
 * isUniqueConstraintError 判断「唯一约束冲突」错误。
 *
 * 用于把「并发下同一订单被重复评价」这类**预期内的竞态失败**，
 * 转换成与预检相同的业务结果（`review.alreadyReviewed`），
 * 而不是当成未知异常抛出、给用户一个 500 体验。
 *
 * 注意：必须同时覆盖 D1 与 SQLite 的两种措辞：
 *   - SQLite: `UNIQUE constraint failed: reviews.order_id`
 *   - D1 包装后: `D1_ERROR: UNIQUE constraint failed: ...`
 */
export function isUniqueConstraintError(error: unknown): boolean {
    const text = collectErrorText(error).toLowerCase()
    if (text.includes('unique constraint')) return true
    return text.includes('constraint failed') && text.includes('unique')
}

/**
 * isDuplicateSchemaObjectError 判断「对象已存在」类错误。
 *
 * 用于幂等 DDL（CREATE INDEX/TRIGGER IF NOT EXISTS 之外的兜底场景）：
 * D1 在部分并发路径下会对同名对象返回 already exists，这属于预期内的
 * 幂等冲突，不应向上抛出中断整个结构修复；其它错误必须原样抛出。
 */
export function isDuplicateSchemaObjectError(error: unknown): boolean {
    const text = collectErrorText(error).toLowerCase()
    return text.includes('already exists')
        || text.includes('duplicate')
        || (text.includes('unique constraint') && text.includes('sqlite_master'))
}

/**
 * isEmptySchemaError 判断错误是否为空结构错误（无可用信息）
 *
 * 用于区分「探测本身失败但无判定依据」与「明确的缺结构」，
 * 前者一律不得升级为结构修复动作。
 */
export function isEmptySchemaError(error: unknown): boolean {
    return collectErrorText(error).trim().length === 0
}
