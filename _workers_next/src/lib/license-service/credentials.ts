/** 商品 Key 只在服务端解密，使用登录 Secret 派生独立密钥，不进入 settings。 */
import { CARD_SERVICE_CREDENTIALS_TABLE } from '../db/license-service-credentials-schema.ts'
import { isMissingTableError, type CardServiceDatabase, type CardServiceStatement } from './db-port.ts'
import { normalizeLicenseServiceBaseUrl, LICENSE_SERVICE_ENV_BASE_URL } from './config.ts'
import { LicenseServiceError } from './errors.ts'

export function credentialEncryptionSecret(env: Record<string, string | undefined>): string {
    return env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim() || env.OAUTH_CLIENT_SECRET?.trim() || ''
}
function configError(): never { throw new LicenseServiceError({ code: 'config_error' }) }

async function encryptionKey(env: Record<string, string | undefined>): Promise<CryptoKey> {
    const secret = credentialEncryptionSecret(env)
    if (!secret) return configError()
    const encoder = new TextEncoder()
    const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('ldc-shop:card-service:v1'),
        info: encoder.encode('product-api-key'),
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const identity = (productId: string, programKey: string) => new TextEncoder().encode(JSON.stringify([productId, programKey]))
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

export async function encryptProductApiKey(apiKey: string, productId: string, programKey: string,
    env: Record<string, string | undefined> = process.env): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: identity(productId, programKey) },
        await encryptionKey(env), new TextEncoder().encode(apiKey))
    return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`
}

/** 身份被调换、密文损坏或 Secret 不匹配时只返回脱敏的配置错误。 */
export async function decryptProductApiKey(value: string, productId: string, programKey: string,
    env: Record<string, string | undefined> = process.env): Promise<string> {
    try {
        const [version, iv, ciphertext, extra] = value.split('.')
        if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) return configError()
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: identity(productId, programKey) },
            await encryptionKey(env), decode(ciphertext))
        return new TextDecoder().decode(decrypted).trim() || configError()
    } catch { return configError() }
}

/** 面板仅获取身份集合，密文和明文均不返回浏览器。 */
export async function listProductCredentialIdentities(database: CardServiceDatabase): Promise<{
    ready: boolean; identities: Array<{ product_id: string; program_key: string }>
}> {
    try {
        return { ready: true, identities: await database.query(`SELECT product_id, program_key FROM ${CARD_SERVICE_CREDENTIALS_TABLE}`) }
    } catch (error) {
        if (isMissingTableError(error)) return { ready: false, identities: [] }
        throw error
    }
}

export async function loadEncryptedProductApiKey(database: CardServiceDatabase, productId: string, programKey: string): Promise<string | null> {
    try {
        const rows = await database.query<{ encrypted_api_key: string }>(
            `SELECT encrypted_api_key FROM ${CARD_SERVICE_CREDENTIALS_TABLE} WHERE product_id = ? AND program_key = ? LIMIT 1`, [productId, programKey])
        return rows[0]?.encrypted_api_key || null
    } catch (error) {
        if (isMissingTableError(error)) return null
        throw error
    }
}

export function buildSaveCredentialStatement(productId: string, programKey: string, encryptedApiKey: string, nowMs: number): CardServiceStatement {
    return {
        sql: `INSERT INTO ${CARD_SERVICE_CREDENTIALS_TABLE} (product_id, program_key, encrypted_api_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(product_id, program_key) DO UPDATE SET
            encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at`,
        params: [productId, programKey, encryptedApiKey, nowMs, nowMs],
    }
}

export function describeProductLicenseServiceConfig(env: Record<string, string | undefined> = process.env) {
    const base = normalizeLicenseServiceBaseUrl(env[LICENSE_SERVICE_ENV_BASE_URL])
    const encryptionReady = Boolean(credentialEncryptionSecret(env))
    return {
        configured: base.ok && encryptionReady, baseUrl: base.ok ? base.baseUrl : null, encryptionReady,
        missing: [...(base.ok ? [] : ['base_url']), ...(encryptionReady ? [] : ['encryption_secret'])],
    }
}
export type ProductLicenseServiceConfigStatus = ReturnType<typeof describeProductLicenseServiceConfig>
