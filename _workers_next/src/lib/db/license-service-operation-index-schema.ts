/**
 * 卡密服务待办账本的查找索引（升级项 0040，DDL 单一来源）。
 *
 * 0038 只给 `card_service_operations` 建了 `(state, next_retry_at)`，而丢弃守卫、
 * 删除守卫、交付/作废入队判重都按 `resource_id` 或 `order_id` 查待办 ——
 * 没有索引时每次都是全表扫描，嵌进相关子查询后会把读取量放大成乘积
 * （2026-10-03 D1 每日读取额度耗尽事故的放大器之一）。
 *
 * 只加索引、不动数据，`IF NOT EXISTS` 可安全重复执行。
 */
import { CARD_SERVICE_OPERATIONS_TABLE } from './license-service-schema.ts'

export const CARD_SERVICE_OPERATIONS_RESOURCE_INDEX = 'card_service_operations_resource_idx'
export const CARD_SERVICE_OPERATIONS_ORDER_INDEX = 'card_service_operations_order_idx'

export const CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_OPERATIONS_RESOURCE_INDEX} ON ${CARD_SERVICE_OPERATIONS_TABLE}(resource_id)`,
    `CREATE INDEX IF NOT EXISTS ${CARD_SERVICE_OPERATIONS_ORDER_INDEX} ON ${CARD_SERVICE_OPERATIONS_TABLE}(order_id)`,
]

/** 索引无法用 `SELECT ... LIMIT 0` 探测，`verifyCardServiceOperationIndexStructure` 按名查 sqlite_master。 */
export const CARD_SERVICE_OPERATION_REQUIRED_INDEX_NAMES: readonly string[] = [
    CARD_SERVICE_OPERATIONS_RESOURCE_INDEX,
    CARD_SERVICE_OPERATIONS_ORDER_INDEX,
]
