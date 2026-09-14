export const CHECKOUT_FIELD_TYPES = ["text", "textarea", "select"] as const

export type CheckoutFieldType = (typeof CHECKOUT_FIELD_TYPES)[number]

export type CheckoutFieldConfig = {
    id: string
    label: string
    type: CheckoutFieldType
    placeholder: string
    hint: string
    required: boolean
    maxLength: number
    options: string[]
}

export type CheckoutFieldValue = {
    id: string
    label: string
    type: CheckoutFieldType
    value: string
}

export const CHECKOUT_FIELD_LIMITS = {
    maxFields: 10,
    maxLabelLength: 40,
    maxPlaceholderLength: 80,
    maxHintLength: 200,
    maxOptionLength: 80,
    maxOptions: 20,
    defaultTextMaxLength: 80,
    defaultTextareaMaxLength: 200,
    absoluteMaxLength: 500,
}

const DEFAULT_MAX_LENGTH: Record<CheckoutFieldType, number> = {
    text: CHECKOUT_FIELD_LIMITS.defaultTextMaxLength,
    textarea: CHECKOUT_FIELD_LIMITS.defaultTextareaMaxLength,
    select: CHECKOUT_FIELD_LIMITS.maxOptionLength,
}

function asTrimmedString(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

function createFieldId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID()
    }
    return `field_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export function createEmptyCheckoutField(type: CheckoutFieldType = "text"): CheckoutFieldConfig {
    return {
        id: createFieldId(),
        label: "",
        type,
        placeholder: "",
        hint: "",
        required: true,
        maxLength: DEFAULT_MAX_LENGTH[type],
        options: type === "select" ? [""] : [],
    }
}

function normalizeType(value: unknown): CheckoutFieldType {
    return CHECKOUT_FIELD_TYPES.includes(value as CheckoutFieldType)
        ? (value as CheckoutFieldType)
        : "text"
}

function normalizeMaxLength(type: CheckoutFieldType, value: unknown): number {
    const parsed = Number.parseInt(String(value ?? ""), 10)
    const fallback = DEFAULT_MAX_LENGTH[type]
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.min(parsed, CHECKOUT_FIELD_LIMITS.absoluteMaxLength)
}

function normalizeOptions(value: unknown): string[] {
    const raw = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(/\r?\n|,/)
            : []
    const unique: string[] = []
    for (const item of raw) {
        const option = asTrimmedString(item).slice(0, CHECKOUT_FIELD_LIMITS.maxOptionLength)
        if (!option || unique.includes(option)) continue
        unique.push(option)
        if (unique.length >= CHECKOUT_FIELD_LIMITS.maxOptions) break
    }
    return unique
}

export function parseCheckoutFieldConfigs(raw: unknown): CheckoutFieldConfig[] {
    let parsed: unknown = raw
    if (typeof raw === "string") {
        const text = raw.trim()
        if (!text) return []
        try {
            parsed = JSON.parse(text)
        } catch {
            return []
        }
    }
    if (!Array.isArray(parsed)) return []

    const fields: CheckoutFieldConfig[] = []
    for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const record = item as Record<string, unknown>
        const label = asTrimmedString(record.label).slice(0, CHECKOUT_FIELD_LIMITS.maxLabelLength)
        if (!label) continue
        const type = normalizeType(record.type)
        const options = type === "select" ? normalizeOptions(record.options) : []
        if (type === "select" && options.length === 0) continue
        fields.push({
            id: asTrimmedString(record.id) || createFieldId(),
            label,
            type,
            placeholder: asTrimmedString(record.placeholder).slice(0, CHECKOUT_FIELD_LIMITS.maxPlaceholderLength),
            hint: asTrimmedString(record.hint).slice(0, CHECKOUT_FIELD_LIMITS.maxHintLength),
            required: record.required !== false,
            maxLength: normalizeMaxLength(type, record.maxLength),
            options,
        })
        if (fields.length >= CHECKOUT_FIELD_LIMITS.maxFields) break
    }
    return fields
}

export function serializeCheckoutFieldConfigs(raw: unknown): string | null {
    const valid = parseCheckoutFieldConfigs(raw)
    return valid.length > 0 ? JSON.stringify(valid) : null
}

export function parseCheckoutFieldValues(raw: unknown): CheckoutFieldValue[] {
    let parsed: unknown = raw
    if (typeof raw === "string") {
        const text = raw.trim()
        if (!text) return []
        try {
            parsed = JSON.parse(text)
        } catch {
            return []
        }
    }
    if (!Array.isArray(parsed)) return []

    return parsed
        .map((item) => {
            if (!item || typeof item !== "object") return null
            const record = item as Record<string, unknown>
            const label = asTrimmedString(record.label)
            const value = asTrimmedString(record.value)
            if (!label || !value) return null
            return {
                id: asTrimmedString(record.id) || createFieldId(),
                label,
                type: normalizeType(record.type),
                value,
            } satisfies CheckoutFieldValue
        })
        .filter((item): item is CheckoutFieldValue => !!item)
}

export function serializeCheckoutFieldValues(values: CheckoutFieldValue[]): string | null {
    const valid = parseCheckoutFieldValues(values)
    return valid.length > 0 ? JSON.stringify(valid) : null
}

export function formatCheckoutFieldValues(values: CheckoutFieldValue[]): string {
    return values
        .map((item) => `${item.label}: ${item.value}`)
        .join("\n")
}

export type CheckoutFieldValidationResult =
    | { ok: true; values: CheckoutFieldValue[]; payload: string | null }
    | { ok: false; error: string }

export function validateCheckoutFieldValues(
    configs: CheckoutFieldConfig[],
    submitted: Record<string, string> | undefined,
): CheckoutFieldValidationResult {
    if (!configs.length) {
        return { ok: true, values: [], payload: null }
    }

    const values: CheckoutFieldValue[] = []
    for (const field of configs) {
        const raw = submitted?.[field.id] ?? ""
        const value = asTrimmedString(raw)
        if (field.required && !value) {
            return { ok: false, error: "buy.checkoutFieldsRequired" }
        }
        if (value.length > field.maxLength) {
            return { ok: false, error: "buy.checkoutFieldsTooLong" }
        }
        if (field.type === "select" && value && !field.options.includes(value)) {
            return { ok: false, error: "buy.checkoutFieldsInvalidOption" }
        }
        if (!value) continue
        values.push({
            id: field.id,
            label: field.label,
            type: field.type,
            value,
        })
    }

    return {
        ok: true,
        values,
        payload: serializeCheckoutFieldValues(values),
    }
}
