/**
 * 「这次改动影响了哪些商品」的反查 —— 前台库存聚合（`products.stock_count`）
 * 重算的输入。
 *
 * 为什么需要它：`products.stock_count` 由 `queries.ts` 的
 * `recalcProductAggregates*` **唯一**回写，而补货、对账、退款作废都会直接增删改
 * `cards` 行。少了这一步，商品页与列表会继续显示改动前的旧库存 ——
 * 补了货看不见、退款作废后又能超卖。
 *
 * 反查是**多来源并集**，任一路径缺失都要能兜住：
 *   1. `card_service_cards`：按订单号 / 本地卡 ID / 远端卡 ID；
 *   2. `cards`：按本地卡 ID（台账已被清理时仍能定位）；
 *   3. `orders`：按订单号（最兜底的一路，只依赖订单本身）。
 *
 * 任一张表不存在（升级窗口）或列缺失一律**跳过该路**而不是抛错：这是一个
 * 「尽力重算」的辅助步骤，不该让补货/退款因为反查失败而整条回滚。
 */

import { CARD_SERVICE_CARDS_TABLE } from '../db/license-service-schema.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'

/** `IN (...)` 的绑定上限，避免异常数据把一次查询撑爆。 */
const MAX_IN_BINDINGS = 100

export interface AffectedProductQuery {
    /** 已知的商品 ID（例如补货时调用方手里就有）。 */
    productId?: string | null
    orderId?: string | null
    localCardIds?: readonly number[] | null
    remoteCardIds?: readonly string[] | null
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

function normalizeIds(values: readonly unknown[] | null | undefined): string[] {
    const out = new Set<string>()
    for (const value of values ?? []) {
        const text = typeof value === 'number' ? String(value) : normalizeText(value)
        if (text) out.add(text)
        if (out.size >= MAX_IN_BINDINGS) break
    }
    return Array.from(out)
}

function placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ')
}

/** 读一列并吞掉「表/列不存在」这类结构差异；其余错误照抛。 */
async function queryTolerantly(
    database: CardServiceDatabase,
    sql: string,
    params: readonly unknown[],
): Promise<string[]> {
    try {
        const rows = await database.query<{ product_id?: unknown }>(sql, params)
        return rows.map((row) => normalizeText(row.product_id)).filter((id): id is string => Boolean(id))
    } catch (error) {
        if (isMissingTableError(error)) return []
        // 老库缺列（`card_service_cards.product_id` 等）同样是结构差异，
        // 用同一条容错：换一路继续反查。
        const text = `${(error as { message?: unknown } | null)?.message ?? ''}`.toLowerCase()
        if (text.includes('no such column')) return []
        throw error
    }
}

/**
 * 反查本次改动涉及的商品 ID（去重、字典序，便于断言与日志比对）。
 *
 * 返回值可能为空：调用方应当把「空数组」当作「无需重算」，而不是「重算全部」。
 */
export async function resolveAffectedProductIds(
    database: CardServiceDatabase,
    input: AffectedProductQuery,
): Promise<string[]> {
    const productId = normalizeText(input.productId)
    const orderId = normalizeText(input.orderId)
    const localCardIds = normalizeIds(input.localCardIds)
    const remoteCardIds = normalizeIds(input.remoteCardIds)

    const found = new Set<string>()
    if (productId) found.add(productId)

    // 1) 远端映射台账（最权威：它同时记录了订单、本地卡与远端卡）。
    const mappingClauses: string[] = []
    const mappingParams: unknown[] = []
    if (orderId) {
        mappingClauses.push('order_id = ?')
        mappingParams.push(orderId)
    }
    if (localCardIds.length) {
        mappingClauses.push(`local_card_id IN (${placeholders(localCardIds.length)})`)
        mappingParams.push(...localCardIds)
    }
    if (remoteCardIds.length) {
        mappingClauses.push(`remote_card_id IN (${placeholders(remoteCardIds.length)})`)
        mappingParams.push(...remoteCardIds)
    }
    if (mappingClauses.length) {
        for (const id of await queryTolerantly(
            database,
            `SELECT DISTINCT product_id FROM ${CARD_SERVICE_CARDS_TABLE} WHERE ${mappingClauses.join(' OR ')}`,
            mappingParams,
        )) {
            found.add(id)
        }
    }

    // 2) 本地卡表：台账行已被清理（例如人工清账）时仍能定位商品。
    if (localCardIds.length) {
        for (const id of await queryTolerantly(
            database,
            `SELECT DISTINCT product_id FROM cards WHERE id IN (${placeholders(localCardIds.length)})`,
            localCardIds,
        )) {
            found.add(id)
        }
    }

    // 3) 订单兜底：只依赖订单本身，连 `cards` 都被清掉时还有这一路。
    if (orderId) {
        for (const id of await queryTolerantly(
            database,
            'SELECT product_id FROM orders WHERE order_id = ? LIMIT 1',
            [orderId],
        )) {
            found.add(id)
        }
    }

    return Array.from(found).sort()
}
