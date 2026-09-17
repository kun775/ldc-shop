import { collectErrorText } from "./error-utils.ts"

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
    "SELECT compare_at_price, purchase_warning, is_shared, visibility_level, point_discount_enabled, point_discount_percent, manual_stock_count, stock_count, locked_count, sold_count, rating, review_count, variant_group_id, variant_label, purchase_questions, product_images, checkout_fields, fulfillment_mode FROM products LIMIT 0",
    "SELECT points_used, current_payment_id, payee, card_ids, checkout_field_values, fulfillment_mode, manual_stock_quantity, delivery_note, fulfillment_claim_id, fulfillment_claimed_at, subtotal_amount_cents, coupon_discount_amount_cents, points_discount_amount_cents, pricing_snapshot FROM orders LIMIT 0",
    "SELECT reserved_order_id, reserved_at, expires_at FROM cards LIMIT 0",
    "SELECT nickname, email, points, is_blocked, desktop_notifications_enabled, last_checkin_at, consecutive_days FROM login_users LIMIT 0",
    "SELECT review_id, user_id, username, comment, created_at FROM review_replies LIMIT 0",
    "SELECT title, description, user_id, username, created_at FROM wishlist_items LIMIT 0",
    "SELECT item_id, user_id, created_at FROM wishlist_votes LIMIT 0",
    "SELECT file_name, content_type, size, storage, object_key, content, created_at FROM order_delivery_files LIMIT 0",
    "SELECT code, name, description, discount_type, rate_bps, discount_amount_cents, min_spend_cents, max_discount_cents, scope, total_use_limit, per_user_limit, reserved_count, consumed_count, stackable_with_coupons, stackable_with_points, refund_policy, status, starts_at, ends_at, created_by, created_at, updated_at FROM coupons LIMIT 0",
    "SELECT coupon_id, product_id, created_at FROM coupon_products LIMIT 0",
    "SELECT coupon_id, order_id, user_id, username, status, sequence, reservation_id, reservation_expires_at, coupon_code_snapshot, rule_snapshot, eligible_amount_cents, discount_amount_cents, reserved_at, consumed_at, released_at, reversed_at, reason, created_at FROM coupon_usages LIMIT 0",
    "SELECT coupon_id, user_id, reserved_count, consumed_count, updated_at FROM coupon_user_counters LIMIT 0",
]

/**
 * isSchemaDriftError 判断错误是否表示「表或列不存在」
 *
 * 这是漂移探测专用的**严格**判定：只有明确的缺表/缺列错误才返回 true，
 * 其它错误（网络、限流、语法等）一律返回 false。
 */
export function isSchemaDriftError(error: unknown): boolean {
    const text = collectErrorText(error).toLowerCase()

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
