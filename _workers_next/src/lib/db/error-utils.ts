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
