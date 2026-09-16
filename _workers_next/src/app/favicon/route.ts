import { NextResponse } from "next/server"
import { getSetting } from "@/lib/db/queries"
import { buildDefaultLogoSvg } from "@/lib/default-logo"
import { resolveEffectiveShopLogo } from "@/lib/shop-logo"

const MAX_DATA_URL_LENGTH = 1_000_000

let cached: {
  url: string
  body: ArrayBuffer | string
  contentType: string
  expiresAt: number
} | null = null

function withCacheHeaders(body: ArrayBuffer | string, contentType: string) {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function renderGeneratedLogo(seed: string, cacheKey: string) {
  const now = Date.now()
  if (cached && cached.url === cacheKey && cached.expiresAt > now) {
    return withCacheHeaders(cached.body, cached.contentType)
  }

  const body = buildDefaultLogoSvg(seed)
  cached = {
    url: cacheKey,
    body,
    contentType: "image/svg+xml",
    expiresAt: now + 6 * 60 * 60 * 1000,
  }
  return withCacheHeaders(body, "image/svg+xml")
}

function decodeImageDataUrl(value: string) {
  if (value.length > MAX_DATA_URL_LENGTH) return null
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif|x-icon));base64,([a-z0-9+/=\s]+)$/i)
  if (!match) return null

  try {
    const bytes = Uint8Array.from(atob(match[2].replace(/\s/g, "")), (character) => character.charCodeAt(0))
    if (!bytes.byteLength || bytes.byteLength > 750_000) return null
    return { body: bytes.buffer, contentType: match[1].toLowerCase() }
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  let target = ""
  let logoUpdatedAt: string | null = null
  let shopName = ""
  let instanceId = ""
  try {
    const [logo, logoSource, updatedAt, name, registryInstanceId] = await Promise.all([
      getSetting("shop_logo"),
      getSetting("shop_logo_source"),
      getSetting("shop_logo_updated_at"),
      getSetting("shop_name"),
      getSetting("registry_instance_id"),
    ])
    target = resolveEffectiveShopLogo(logo, logoSource).effectiveLogo
    logoUpdatedAt = updatedAt
    shopName = (name || "").trim()
    instanceId = (registryInstanceId || "").trim()
  } catch {
    // Best effort: fall back to the deterministic generated logo.
  }

  const requestHost = new URL(request.url).host
  const generatedSeed = [instanceId, shopName, requestHost].filter(Boolean).join("|") || "ldc-shop"
  const generatedKey = `generated:${generatedSeed}`
  const decoded = target.startsWith("data:") ? decodeImageDataUrl(target) : null

  // Redirect remote custom logos so the browser fetches them directly. This preserves the
  // administrator-selected favicon without turning the Worker into a server-side fetch proxy.
  if (/^https?:\/\//i.test(target)) {
    try {
      const remoteLogo = new URL(target)
      return NextResponse.redirect(remoteLogo, {
        status: 307,
        headers: {
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=300",
          "X-Content-Type-Options": "nosniff",
        },
      })
    } catch {
      return renderGeneratedLogo(generatedSeed, generatedKey)
    }
  }

  if (!decoded) {
    return renderGeneratedLogo(generatedSeed, generatedKey)
  }

  const cacheKey = `data:${logoUpdatedAt || ""}:${target.length}`
  const now = Date.now()
  if (cached && cached.url === cacheKey && cached.expiresAt > now) {
    return withCacheHeaders(cached.body, cached.contentType)
  }

  cached = {
    url: cacheKey,
    body: decoded.body,
    contentType: decoded.contentType,
    expiresAt: now + 6 * 60 * 60 * 1000,
  }
  return withCacheHeaders(decoded.body, decoded.contentType)
}
