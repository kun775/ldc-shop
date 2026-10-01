/** 商品 Program 与加密 Key 原子保存；空 Key 仅复用同商品、同 Program 的已有凭据。 */
import { CARD_SERVICE_CREDENTIALS_TABLE } from '../db/license-service-credentials-schema.ts'
import type { CardServiceSupplyMode } from '../db/license-service-schema.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'
import { credentialEncryptionSecret, encryptProductApiKey, loadEncryptedProductApiKey } from './credentials.ts'
import { saveCardServiceProductConfig, type CardServiceConfigSaveResult } from './product-config.ts'

export async function saveCardServiceProductConnection(database: CardServiceDatabase, config: {
    productId: string
    supplyMode: CardServiceSupplyMode
    programKey: string | null
    targetStock: number | null
    apiKey?: string
}, env: Record<string, string | undefined> = process.env, nowMs = Date.now()): Promise<CardServiceConfigSaveResult> {
    let encryptedApiKey: string | undefined
    if (config.supplyMode === 'license_service') {
        if (!credentialEncryptionSecret(env)) return { ok: false, reason: 'encryption_secret_missing' }
        try {
            await database.query(`SELECT product_id FROM ${CARD_SERVICE_CREDENTIALS_TABLE} LIMIT 0`)
        } catch (error) {
            if (isMissingTableError(error)) return { ok: false, reason: 'credential_storage_not_ready' }
            throw error
        }
        const apiKey = (config.apiKey || '').trim()
        if (apiKey && !/^[\x21-\x7E]{1,4096}$/.test(apiKey)) return { ok: false, reason: 'invalid_api_key' }
        if (!config.programKey) return { ok: false, reason: 'api_key_required' }
        if (apiKey) {
            encryptedApiKey = await encryptProductApiKey(apiKey, config.productId, config.programKey, env)
        } else if (!await loadEncryptedProductApiKey(database, config.productId, config.programKey)) {
            return { ok: false, reason: 'api_key_required' }
        }
    }
    return saveCardServiceProductConfig(database, {
        productId: config.productId, supplyMode: config.supplyMode,
        programKey: config.programKey, targetStock: config.targetStock, encryptedApiKey,
    }, nowMs)
}
