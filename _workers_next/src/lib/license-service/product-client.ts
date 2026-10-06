/** 按商品 / 历史分配的 Program 路由凭据，绝不回退到全局 API Key。 */
import { createLicenseServiceClient, type LicenseServiceClient, type LicenseServiceClientOptions } from './client.ts'
import { resolveLicenseServiceConfig, LICENSE_SERVICE_ENV_API_KEY } from './config.ts'
import { decryptProductApiKey, loadEncryptedProductApiKey } from './credentials.ts'
import { CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE } from '../db/license-service-schema.ts'
import type { CardServiceDatabase } from './db-port.ts'
import { LicenseServiceError } from './errors.ts'

export function createProductLicenseServiceClient(database: CardServiceDatabase,
    env: Record<string, string | undefined> = process.env,
    factory: (options: LicenseServiceClientOptions) => LicenseServiceClient = createLicenseServiceClient): LicenseServiceClient {
    const clients = new Map<string, Promise<LicenseServiceClient>>()
    const fail = (): never => { throw new LicenseServiceError({ code: 'config_error' }) }

    function forProduct(productId: string, programKey: string): Promise<LicenseServiceClient> {
        if (!productId || !programKey) return Promise.reject(new LicenseServiceError({ code: 'config_error' }))
        const identity = JSON.stringify([productId, programKey])
        let client = clients.get(identity)
        if (!client) {
            client = (async () => {
                const encrypted = await loadEncryptedProductApiKey(database, productId, programKey)
                if (!encrypted) return fail()
                const apiKey = await decryptProductApiKey(encrypted, productId, programKey, env)
                const resolved = resolveLicenseServiceConfig({ ...env, [LICENSE_SERVICE_ENV_API_KEY]: apiKey })
                if (!resolved.ok) return fail()
                return factory(resolved.config)
            })()
            clients.set(identity, client)
        }
        return client
    }
    async function forAllocation(allocationId: string): Promise<LicenseServiceClient> {
        const rows = await database.query<{ product_id: string; program_key: string }>(
            `SELECT product_id, program_key FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} WHERE allocation_id = ? LIMIT 1`, [allocationId])
        return rows[0] ? forProduct(rows[0].product_id, rows[0].program_key) : fail()
    }
    async function forCard(cardId: string): Promise<LicenseServiceClient> {
        const rows = await database.query<{ allocation_id: string }>(
            `SELECT allocation_id FROM ${CARD_SERVICE_CARDS_TABLE} WHERE remote_card_id = ? LIMIT 1`, [cardId])
        return rows[0] ? forAllocation(rows[0].allocation_id) : fail()
    }
    return {
        baseUrl: env.LICENSE_SERVICE_BASE_URL || '',
        async allocate(input) { return (await forProduct(input.productId || '', input.programKey)).allocate(input) },
        async allocateBatch(input) { return (await forProduct(input.productId || '', input.programKey)).allocateBatch(input) },
        async ack(input) { return (await forAllocation(input.allocationId)).ack(input) },
        async sell(input) { return (await forAllocation(input.allocationId)).sell(input) },
        async cancel(input) { return (await forAllocation(input.allocationId)).cancel(input) },
        async getAllocation(id) { return (await forAllocation(id)).getAllocation(id) },
        async getCardStatus(id) { return (await forCard(id)).getCardStatus(id) },
        async revoke(id, input) { return (await forCard(id)).revoke(id, input) },
        // 全局列表没有单一凭据归属，对账逐条查询本地分配。
        async listAllocations() { return fail() },
    }
}
