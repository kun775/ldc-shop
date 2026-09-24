/**
 * 限流计数表的结构定义（DDL 常量）。
 *
 * 与 `point-ledger-schema.ts` / `login-users-schema.ts` 同构：把 DDL 抽成常量，
 * 让「全新库初始化」「注册升级项」「请求路径 ensure」三条路径共用**同一份**
 * 建表语句，避免三处各写一份后互相漂移。
 */

export const RATE_LIMIT_TABLE_NAME = 'rate_limit_counters'

/** 过期清理用的索引名；结构校验（verifyRateLimitStructure）按名判定 */
export const RATE_LIMIT_EXPIRES_INDEX_NAME = 'rate_limit_counters_expires_idx'

/**
 * 计数表结构说明:
 *   - 主键 (bucket, subject, window_start) 是限流的核心：
 *     UPSERT 的 `ON CONFLICT(bucket, subject, window_start)` 直接命中该主键索引，
 *     因此「查 + 加」被压成单条原子语句，天然免疫 check-then-write 竞态。
 *   - expires_at 用于批量清理历史窗口（按索引删除，不扫全表）。
 */
export const RATE_LIMIT_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket TEXT NOT NULL,
    subject TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (bucket, subject, window_start)
)`

export const RATE_LIMIT_CREATE_INDEX_STATEMENT =
    `CREATE INDEX IF NOT EXISTS ${RATE_LIMIT_EXPIRES_INDEX_NAME} ON rate_limit_counters(expires_at)`

export const RATE_LIMIT_DDL_STATEMENTS: readonly string[] = [
    RATE_LIMIT_CREATE_TABLE_STATEMENT,
    RATE_LIMIT_CREATE_INDEX_STATEMENT,
]
