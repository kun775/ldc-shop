import { db } from "@/lib/db"
import { cards, settings } from "@/lib/db/schema"
import { setSetting } from "@/lib/db/queries"
import { inArray } from "drizzle-orm"
import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"

export interface ProductCardApiConfig {
    enabled: boolean
    url: string
    token: string
}

function keyOf(productId: string, field: "enabled" | "url" | "token") {
    return `cards_api_${field}_${productId}`
}

function resolveApiUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim()
    if (!trimmed) return ""
    return new URL(trimmed).toString()
}

function extractCardKey(payload: any): string {
    if (!payload) return ""
    if (typeof payload === "string") return payload.trim()

    if (Array.isArray(payload)) {
        for (const item of payload) {
            const value = extractCardKey(item)
            if (value) return value
        }
        return ""
    }

    if (typeof payload === "object") {
        const directKeys = ["cardKey", "card", "key", "code"]
        for (const k of directKeys) {
            const v = payload?.[k]
            if (typeof v === "string" && v.trim()) return v.trim()
        }

        const nestedKeys = ["data", "result", "item"]
        for (const k of nestedKeys) {
            const value = extractCardKey(payload?.[k])
            if (value) return value
        }
    }

    return ""
}

function isUniqueConstraintError(error: any) {
    const text = `${error?.message || ""}${JSON.stringify(error || {})}`.toLowerCase()
    return text.includes("unique") || text.includes("constraint failed")
}

async function getSettingsUncached(keys: string[]): Promise<Record<string, string>> {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(inArray(settings.key, keys))

        const map: Record<string, string> = {}
        for (const row of rows) {
            map[row.key] = row.value || ""
        }
        return map
    } catch (error: any) {
        const text = `${error?.message || ""}${JSON.stringify(error || {})}`.toLowerCase()
        if (text.includes("no such table") && text.includes("settings")) {
            return {}
        }
        throw error
    }
}

export async function getProductCardApiConfig(productId: string): Promise<ProductCardApiConfig> {
    const enabledKey = keyOf(productId, "enabled")
    const urlKey = keyOf(productId, "url")
    const tokenKey = keyOf(productId, "token")
    const values = await getSettingsUncached([enabledKey, urlKey, tokenKey])

    return {
        enabled: values[enabledKey] === "true",
        url: (values[urlKey] || "").trim(),
        token: (values[tokenKey] || "").trim(),
    }
}

export async function saveProductCardApiConfig(productId: string, config: ProductCardApiConfig) {
    const url = config.url.trim()
    const token = config.token.trim()
    const enabled = !!config.enabled

    await Promise.all([
        setSetting(keyOf(productId, "enabled"), enabled ? "true" : "false"),
        setSetting(keyOf(productId, "url"), url),
        setSetting(keyOf(productId, "token"), token),
    ])
}

export async function pullOneCardFromApi(productId: string): Promise<{
    ok: boolean
    skipped?: boolean
    error?: string
    cardKey?: string
}> {
    const config = await getProductCardApiConfig(productId)
    if (!config.enabled) {
        return { ok: false, skipped: true, error: "api_disabled" }
    }
    if (!config.url) {
        return { ok: false, error: "api_url_missing" }
    }

    let requestUrl = ""
    try {
        requestUrl = resolveApiUrl(config.url)
    } catch {
        return { ok: false, error: "api_url_invalid" }
    }

    const headers: Record<string, string> = {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    }
    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`
    }

    const response = await fetchWithTimeout(requestUrl, {
        method: "GET",
        headers,
        cache: "no-store",
    }, 8_000)

    if (!response.ok) {
        return { ok: false, error: `api_request_failed_${response.status}` }
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase()

    let payload: any
    if (contentType.includes("application/json")) {
        payload = await response.json()
    } else {
        payload = await response.text()
    }

    const cardKey = extractCardKey(payload)
    if (!cardKey) {
        return { ok: false, error: "api_card_missing" }
    }

    try {
        await db.insert(cards).values({
            productId,
            cardKey,
        })
    } catch (error: any) {
        if (isUniqueConstraintError(error)) {
            return { ok: false, error: "api_card_duplicate" }
        }
        return { ok: false, error: error?.message || "api_insert_failed" }
    }

    return { ok: true, cardKey }
}
