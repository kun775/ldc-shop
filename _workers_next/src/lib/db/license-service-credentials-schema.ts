/** 商品凭据单独迁移（0039），历史 Program 的凭据保留。 */
export const CARD_SERVICE_CREDENTIALS_TABLE = 'card_service_credentials'
export const CARD_SERVICE_CREDENTIALS_DDL_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_CREDENTIALS_TABLE} (
        product_id TEXT NOT NULL,
        program_key TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, program_key)
    )`,
] as const
export const CARD_SERVICE_CREDENTIALS_SCHEMA_PROBES = [
    `SELECT product_id, program_key, encrypted_api_key, created_at, updated_at FROM ${CARD_SERVICE_CREDENTIALS_TABLE} LIMIT 0`,
] as const
