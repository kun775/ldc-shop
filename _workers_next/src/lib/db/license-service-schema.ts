/**
 * 通用卡密服务（license-key-service）远端库存账本的结构定义（DDL 常量）。
 *
 * 与 `rate-limit-schema.ts` / `point-ledger-schema.ts` 同构：DDL 抽成常量，
 * 让「注册升级项 0038 的执行体」与「请求路径 ensure」共用**同一份**建表语句，
 * 避免两处各写一份后互相漂移。
 *
 * 设计约束（对应接入方案 `outputs/license-key-service-integration-plan-2026-09-29.md`）：
 *   1. **不加外键**。本地 `cards` 与 `orders` 存在管理端删除/清理路径（例如
 *      `deleteCards`、订单物理删除），外键会把这些路径变成级联删除或约束冲突；
 *      「已售卡与远端映射不可随订单删除而丢失」改由应用层守卫保证。
 *   2. `external_ref` 全局唯一：中心的 `card_allocations` 有
 *      `UNIQUE(tenant_id, client_id, external_ref)` 且**不因 cancelled/expired 释放**，
 *      本地用同一唯一索引把「同一补货任务不会重复领卡」钉在数据库层。
 *   3. 明文卡密在 Ack 之前只落在**不可售暂存表**（`card_service_staged_cards`），
 *      Ack 成功后才搬到 `cards` 参与售卖，因此现有库存查询无需改动。
 */

export const CARD_SERVICE_ALLOCATIONS_TABLE = 'card_service_allocations'
export const CARD_SERVICE_STAGED_CARDS_TABLE = 'card_service_staged_cards'
export const CARD_SERVICE_CARDS_TABLE = 'card_service_cards'
export const CARD_SERVICE_OPERATIONS_TABLE = 'card_service_operations'
export const CARD_SERVICE_PRODUCT_CONFIG_TABLE = 'card_service_product_configs'

export const CARD_SERVICE_EXTERNAL_REF_INDEX = 'card_service_allocations_external_ref_uq'
export const CARD_SERVICE_STAGED_ALLOCATION_INDEX = 'card_service_staged_cards_allocation_idx'
export const CARD_SERVICE_CARDS_REMOTE_INDEX = 'card_service_cards_remote_uq'
export const CARD_SERVICE_CARDS_ORDER_INDEX = 'card_service_cards_order_idx'
export const CARD_SERVICE_CARDS_ALLOCATION_INDEX = 'card_service_cards_allocation_idx'
export const CARD_SERVICE_OPERATIONS_STATE_INDEX = 'card_service_operations_state_idx'

/**
 * 商品供应模式（**只增不改语义**）。
 *
 *   local            本地已有卡密即唯一来源，不联网取卡（默认，保持既有行为）
 *   legacy_get       沿用旧的「单次 GET 取一张」接口（`cards_api_*` 配置）
 *   license_service  走通用卡密服务的 allocations 领卡（本模块负责）
 *
 * 之所以显式列出而不是靠「有配置就是 license_service」推断：供应模式决定
 * 履约路径，必须在数据库层可读、可审计，不能隐式派生。
 */
export const CARD_SERVICE_SUPPLY_MODES = ['local', 'legacy_get', 'license_service'] as const
export type CardServiceSupplyMode = (typeof CARD_SERVICE_SUPPLY_MODES)[number]

/** 无配置行时的兜底供应模式（既有商品行为不变）。 */
export const CARD_SERVICE_DEFAULT_SUPPLY_MODE: CardServiceSupplyMode = 'local'

export function isCardServiceSupplyMode(value: unknown): value is CardServiceSupplyMode {
    return typeof value === 'string'
        && (CARD_SERVICE_SUPPLY_MODES as readonly string[]).includes(value)
}

/**
 * 补货任务台账。
 *
 * state：
 *   allocated    已领到卡但尚未 Ack（本地副本不可售）
 *   acknowledged 已 Ack，卡已进入本地可售库存
 *   sold         该批次已被订单买走（整批，Sell 要求完整卡集）
 *   expired      中心 Ack 窗口已过且卡密已被回收 —— **本地副本必须作废**
 *   cancelled    本地入库失败且尚未展示时主动取消
 *   abandoned    本地主动放弃（超窗/异常），不再重试该 allocation
 */
export const CARD_SERVICE_ALLOCATION_STATES = [
    'allocated',
    'acknowledged',
    'sold',
    'expired',
    'cancelled',
    'abandoned',
] as const
export type CardServiceAllocationState = (typeof CARD_SERVICE_ALLOCATION_STATES)[number]

export const CARD_SERVICE_ALLOCATIONS_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_ALLOCATIONS_TABLE} (
    allocation_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    program_key TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    state TEXT NOT NULL,
    request_key TEXT NOT NULL,
    ack_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    acked_at INTEGER,
    sold_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`

export const CARD_SERVICE_ALLOCATIONS_CREATE_INDEX_STATEMENTS: readonly string[] = [
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CARD_SERVICE_EXTERNAL_REF_INDEX} ON ${CARD_SERVICE_ALLOCATIONS_TABLE}(external_ref)`,
]

/**
 * 已领到、尚未 Ack 的卡密暂存表（不可售）。
 *
 * 这张表是「先入库再裸调用 Ack」这一反模式的替代品：卡密先落在这里，
 * Ack 成功后才搬进 `cards`，并发下单不可能买到尚未确认的卡。
 */
export const CARD_SERVICE_STAGED_CARDS_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_STAGED_CARDS_TABLE} (
    remote_card_id TEXT PRIMARY KEY,
    allocation_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    card_key TEXT NOT NULL,
    masked_key TEXT,
    created_at INTEGER NOT NULL
)`

export const CARD_SERVICE_STAGED_CARDS_CREATE_INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_STAGED_ALLOCATION_INDEX} ON ${CARD_SERVICE_STAGED_CARDS_TABLE}(allocation_id)`,
]

/**
 * 本地卡 ↔ 远端卡的唯一映射。
 *
 * `local_card_id` 直接复用 `cards.id`（Ack 时插入本地卡后回填），
 * `remote_card_id` 来自中心，两者都不可复用。订单侧只记 `order_id`，
 * 因此订单行被清理后映射仍然完整，作废与对账不受影响。
 */
export const CARD_SERVICE_CARDS_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_CARDS_TABLE} (
    local_card_id INTEGER PRIMARY KEY,
    remote_card_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    order_id TEXT,
    state TEXT NOT NULL,
    sold_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`

export const CARD_SERVICE_CARDS_CREATE_INDEX_STATEMENTS: readonly string[] = [
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CARD_SERVICE_CARDS_REMOTE_INDEX} ON ${CARD_SERVICE_CARDS_TABLE}(remote_card_id)`,
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_CARDS_ORDER_INDEX} ON ${CARD_SERVICE_CARDS_TABLE}(order_id)`,
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_CARDS_ALLOCATION_INDEX} ON ${CARD_SERVICE_CARDS_TABLE}(allocation_id)`,
]

/**
 * 待重试操作账本（Ack / Sell / Revoke）。
 *
 * 跨服务调用没有分布式事务，任何一次失败都必须留下**可重放的意图**：
 * 定时对账扫描本表把未完成操作重放，而不是让订单静默卡住。
 */
export const CARD_SERVICE_OPERATIONS_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_OPERATIONS_TABLE} (
    operation_key TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    order_id TEXT,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    request_id TEXT,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`

export const CARD_SERVICE_OPERATIONS_CREATE_INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_OPERATIONS_STATE_INDEX} ON ${CARD_SERVICE_OPERATIONS_TABLE}(state, next_retry_at)`,
]

/**
 * 商品 → 供应模式 / Program 的映射（服务端管理）。
 *
 * 刻意不把 `supply_mode`、`program_key` 加到 `products` 上：
 *   - `products` 是管理端商品表单与数据导出的直接载体，加列会让「供应来源」
 *     跟着商品一起被编辑/导出，而这一项应当只在受控的服务端映射里维护；
 *   - 没有配置行的商品走 `CARD_SERVICE_DEFAULT_SUPPLY_MODE` 兜底，
 *     因此既有商品无需任何数据回填。
 *
 * `program_key` 不是密钥，故可明文存库；商品 Key 由 0039 独立加密保存。
 * `target_stock` 供阶段 C/E 的补货调度读取，本阶段只建列不使用。
 */
export const CARD_SERVICE_PRODUCT_CONFIG_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} (
    product_id TEXT PRIMARY KEY,
    supply_mode TEXT NOT NULL DEFAULT 'local',
    program_key TEXT,
    target_stock INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`

export const CARD_SERVICE_DDL_STATEMENTS: readonly string[] = [
    CARD_SERVICE_ALLOCATIONS_CREATE_TABLE_STATEMENT,
    ...CARD_SERVICE_ALLOCATIONS_CREATE_INDEX_STATEMENTS,
    CARD_SERVICE_STAGED_CARDS_CREATE_TABLE_STATEMENT,
    ...CARD_SERVICE_STAGED_CARDS_CREATE_INDEX_STATEMENTS,
    CARD_SERVICE_CARDS_CREATE_TABLE_STATEMENT,
    ...CARD_SERVICE_CARDS_CREATE_INDEX_STATEMENTS,
    CARD_SERVICE_OPERATIONS_CREATE_TABLE_STATEMENT,
    ...CARD_SERVICE_OPERATIONS_CREATE_INDEX_STATEMENTS,
    CARD_SERVICE_PRODUCT_CONFIG_CREATE_TABLE_STATEMENT,
]

/**
 * 结构探测语句。
 *
 * 统一为 `SELECT ... LIMIT 0`：只要求表与列可解析，不读取任何行。
 * 唯一索引无法用 SELECT 探测（缺索引不会让查询报错），因此
 * `verifyCardServiceStructure`（`queries.ts`）另外按名查 `sqlite_master`。
 */
export const CARD_SERVICE_SCHEMA_DRIFT_PROBES: readonly string[] = [
    `SELECT allocation_id, product_id, program_key, external_ref, quantity, state, request_key, ack_key, expires_at, acked_at, sold_at, last_error_code, created_at, updated_at FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} LIMIT 0`,
    `SELECT remote_card_id, allocation_id, product_id, card_key, masked_key, created_at FROM ${CARD_SERVICE_STAGED_CARDS_TABLE} LIMIT 0`,
    `SELECT local_card_id, remote_card_id, allocation_id, product_id, order_id, state, sold_at, revoked_at, created_at, updated_at FROM ${CARD_SERVICE_CARDS_TABLE} LIMIT 0`,
    `SELECT operation_key, operation, resource_id, order_id, state, attempts, next_retry_at, request_id, last_error_code, created_at, updated_at FROM ${CARD_SERVICE_OPERATIONS_TABLE} LIMIT 0`,
    `SELECT product_id, supply_mode, program_key, target_stock, created_at, updated_at FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} LIMIT 0`,
]

/** 需要按名校验存在性的唯一索引（索引无法用 SELECT LIMIT 0 探测）。 */
export const CARD_SERVICE_REQUIRED_INDEX_NAMES: readonly string[] = [
    CARD_SERVICE_EXTERNAL_REF_INDEX,
    CARD_SERVICE_CARDS_REMOTE_INDEX,
]
