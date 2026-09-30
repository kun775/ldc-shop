import { db } from "@/lib/db"
import { cards, settings } from "@/lib/db/schema"
import { setSetting } from "@/lib/db/queries"
import { createD1CardServiceDatabase } from "@/lib/license-service/database"
import { loadCardServiceProductConfig } from "@/lib/license-service/product-config"
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

/**
 * 旧 GET 入口的准入结论。
 *
 *   allow  可以走这条历史入口：**没有配置行**（从未接入，保持既有行为）
 *          或**显式**声明 `supply_mode = 'legacy_get'`
 *   skip   明确不该走（显式 `local` / `license_service`）：不是故障，
 *          调用方按「本条路径不适用」处理，只记 info
 *   error  配置读不出来：**必须停**，绝不能让旧入口在状态不明时继续取卡
 */
type LegacyGetGate =
    | { kind: 'allow' }
    | { kind: 'skip'; error: string }
    | { kind: 'error'; error: string }

/**
 * 决定「这个商品还能不能走旧 GET 取卡」。
 *
 * 只有三种情况放行：**没有配置行**（历史兼容，从未接入过中心）或显式
 * `legacy_get`。显式 `local` **不放行** —— `local` 的契约就是「只用本地库存」，
 * 只要 `cards_api_enabled` 还是 `true` 就联网取卡等于违约。
 *
 * ⚠️ 读取异常**绝不能**折算成 `allow`：那时商品的供应模式是**未知**的，
 * 继续取卡会插入一批没有任何远端映射的卡 —— 若该商品其实是 `license_service`
 * 供应，混合库存会直接阻断多卡订单交付。缺表兼容已由
 * `loadCardServiceProductConfig` 内部处理（返回 `configured: false`），
 * 因此走到 `catch` 的都是**真实读取异常**，必须报错停手。
 */
async function evaluateLegacyGetGate(productId: string): Promise<LegacyGetGate> {
    let supplyMode: string
    let configured: boolean
    try {
        const config = await loadCardServiceProductConfig(createD1CardServiceDatabase(), productId)
        supplyMode = config.supplyMode
        configured = config.configured
    } catch (error) {
        console.error(`[Card API] supply config unreadable for product ${productId}:`, error)
        return { kind: 'error', error: 'api_supply_config_unreadable' }
    }

    if (!configured) return { kind: 'allow' }
    if (supplyMode === 'license_service') return { kind: 'skip', error: 'api_card_service_supplied' }
    if (supplyMode === 'local') return { kind: 'skip', error: 'api_local_supply_mode' }
    // 只剩显式 `legacy_get`：它就是为这条旧接口准备的。
    return { kind: 'allow' }
}

export async function pullOneCardFromApi(productId: string): Promise<{
    ok: boolean
    skipped?: boolean
    error?: string
    cardKey?: string
}> {
    // 供应模式分流**必须在读取旧 GET 配置之前**：这条路径取到的卡没有任何远端
    // 映射，中心那边永远显示「未售出」；混进同一个商品后，多卡订单还会因
    // `mixed_inventory` 阻断交付。中心供应的补货由 `restockProductCards` 负责。
    const gate = await evaluateLegacyGetGate(productId)
    if (gate.kind === 'skip') return { ok: false, skipped: true, error: gate.error }
    if (gate.kind === 'error') return { ok: false, error: gate.error }

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
