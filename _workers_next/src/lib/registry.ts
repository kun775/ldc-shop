import { getSetting, setSetting } from "@/lib/db/queries"
import { buildShopFaviconUrl, resolveEffectiveShopLogo } from "@/lib/shop-logo"
import { APP_VERSION } from "@/lib/version"
import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"

export const REGISTRY_APP_ID = "ldc-shop"
const REGISTRY_PAGE_SIZE = 500
const REGISTRY_MAX_PAGES = 25

const DEFAULT_REGISTRY_URL = "https://ldcnavi.chatgptuk.workers.dev"

export function getRegistryBaseUrl(): string {
    const raw = process.env.NEXT_PUBLIC_REGISTRY_URL || process.env.REGISTRY_URL || DEFAULT_REGISTRY_URL
    return raw.replace(/\/+$/, "")
}

export function isRegistryEnabled(): boolean {
    return !!getRegistryBaseUrl()
}

export function normalizeOrigin(input: string): string {
    const url = new URL(input)
    if (url.protocol !== "https:") {
        throw new Error("Only https URLs are allowed")
    }
    return url.origin
}

export async function ensureRegistryInstanceId(): Promise<string> {
    let instanceId = await getSetting("registry_instance_id")
    if (!instanceId) {
        const randomId = globalThis.crypto?.randomUUID?.()
        instanceId = randomId || `ldc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
        await setSetting("registry_instance_id", instanceId)
    }
    return instanceId
}

export async function getRegistryMetadata(origin: string) {
    const [name, description, logo, logoSource, logoUpdatedAt, instanceId, verifyToken] = await Promise.all([
        getSetting("shop_name"),
        getSetting("shop_description"),
        getSetting("shop_logo"),
        getSetting("shop_logo_source"),
        getSetting("shop_logo_updated_at"),
        ensureRegistryInstanceId(),
        getSetting("registry_challenge_token"),
    ])
    const resolvedLogo = resolveEffectiveShopLogo(logo, logoSource).effectiveLogo
    const registryLogo = resolvedLogo.startsWith("data:")
        ? buildShopFaviconUrl(origin, logoUpdatedAt)
        : resolvedLogo || buildShopFaviconUrl(origin, logoUpdatedAt)

    return {
        app: REGISTRY_APP_ID,
        version: APP_VERSION,
        name: (name || "LDC Shop").trim(),
        description: (description || "").trim(),
        logo: registryLogo,
        url: origin,
        instanceId,
        verifyToken: (verifyToken || "").trim(),
        updatedAt: Date.now(),
    }
}

export interface RegistryShop {
    name: string
    url: string
    logo?: string | null
    description?: string | null
    updated_at?: number
}

function getRegistryShopKey(item: RegistryShop): string {
    return String(item.url || "").trim().toLowerCase()
}

export async function fetchRegistryShops() {
    const baseUrl = getRegistryBaseUrl()
    if (!baseUrl) {
        return { items: [] as RegistryShop[], error: "registry_not_configured" }
    }

    const items: RegistryShop[] = []
    const seen = new Set<string>()
    let offset = 0

    for (let page = 0; page < REGISTRY_MAX_PAGES; page += 1) {
        const params = new URLSearchParams({
            limit: String(REGISTRY_PAGE_SIZE),
            offset: String(offset),
        })
        const res = await fetchWithTimeout(`${baseUrl}/shops?${params.toString()}`, {
            next: { revalidate: 300 },
        }, 8_000)

        if (!res.ok) {
            return { items, error: `registry_error_${res.status}` }
        }

        const data = await res.json()
        const pageItems = Array.isArray(data?.items) ? (data.items as RegistryShop[]) : []
        let newItemCount = 0

        for (const item of pageItems) {
            const key = getRegistryShopKey(item)
            if (!key || seen.has(key)) continue
            seen.add(key)
            items.push(item)
            newItemCount += 1
        }

        const nextOffset = typeof data?.nextOffset === "number" ? data.nextOffset : null
        if (nextOffset !== null && nextOffset > offset) {
            offset = nextOffset
            continue
        }

        if (data?.hasMore && pageItems.length > 0) {
            offset += pageItems.length
            continue
        }

        if (pageItems.length < REGISTRY_PAGE_SIZE || newItemCount === 0) {
            break
        }

        offset += pageItems.length
    }

    return { items, error: null }
}
