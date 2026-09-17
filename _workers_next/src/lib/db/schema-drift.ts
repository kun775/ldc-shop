/**
 * 数据库结构漂移（schema drift）探测。
 *
 * 背景:
 *   项目用 `settings.schema_version` 作为「迁移已完成」的标记，并用
 *   「标记达标就跳过 DDL」做快速路径。但该标记可能**领先于真实结构**
 *   （历史上被手工置位过：point_ledger_schema_version 曾置为 2 却缺
 *   claim_id / claimed_at 两列），此时缺表/缺列将**永久无法自愈**。
 *
 * 方案:
 *   保留快速路径，但在版本达标时先做一次**廉价只读探测**。
 *   探测语句统一为 `SELECT ... LIMIT 0`：不读取任何行，只要求表与列可解析。
 *   只有确认漂移才重跑增量迁移。
 *
 * 安全约定:
 *   探测遇到**非结构类**错误（瞬时网络错误、限流、超时等）一律按
 *   「无漂移」处理 —— 绝不能让一次偶发失败升级成一次全量迁移。
 */

/**
 * 探测语句必须满足:
 *   - 只读（SELECT）且 LIMIT 0，不产生任何行读取或写入
 *   - 覆盖「当前 schema 版本最新引入的对象」，也就是最可能缺失的部分
 */
export const SCHEMA_DRIFT_PROBES: readonly string[] = [
    // v25：订单定价快照列
    "SELECT subtotal_amount_cents, coupon_discount_amount_cents, points_discount_amount_cents, pricing_snapshot FROM orders LIMIT 0",
    // v25：优惠券四表
    "SELECT 1 FROM coupons LIMIT 0",
    "SELECT 1 FROM coupon_products LIMIT 0",
    "SELECT 1 FROM coupon_usages LIMIT 0",
    "SELECT 1 FROM coupon_user_counters LIMIT 0",
    // v24：履约 Claim 列（历史事故点）
    "SELECT fulfillment_claim_id, fulfillment_claimed_at FROM orders LIMIT 0",
    // v23：手动发货附件表
    "SELECT 1 FROM order_delivery_files LIMIT 0",
]

/**
 * isSchemaDriftError 判断错误是否表示「表或列不存在」
 *
 * 这是漂移探测专用的**严格**判定：只有明确的缺表/缺列错误才返回 true，
 * 其它错误（网络、限流、语法等）一律返回 false。
 */
export function isSchemaDriftError(error: unknown): boolean {
    const text = (
        JSON.stringify(error ?? '') +
        String(error ?? '') +
        ((error as { message?: unknown } | null)?.message ? String((error as { message?: unknown }).message) : '')
    ).toLowerCase()

    if (text.includes('no such table') || text.includes('no such column')) return true
    if (text.includes('column not found') || text.includes('d1_column_notfound')) return true
    if (text.includes('42703') || text.includes('42p01')) return true
    // 只有明确指出是 relation/table/column 时才认作漂移，避免误伤
    if (text.includes('does not exist')) {
        return text.includes('relation') || text.includes('table') || text.includes('column')
    }
    return false
}

/**
 * shouldReRunIncrementalMigration 决定是否重跑增量迁移
 *
 * 参数:
 *   - versionSatisfied: 持久化版本号是否已达到当前版本
 *   - driftDetected: 探测是否发现结构漂移
 *
 * 返回值:
 *   - true 表示需要执行增量迁移（幂等）
 */
export function shouldReRunIncrementalMigration(input: {
    versionSatisfied: boolean
    driftDetected: boolean
}): boolean {
    if (!input.versionSatisfied) return true
    return input.driftDetected
}
