/**
 * 新订单的卡密预留（非共享的自动发卡商品）。
 *
 * 只依赖 `CardServiceDatabase` 端口，`node --test` 可以用真实 SQLite 覆盖；
 * D1 实现由调用方注入。约束：
 *
 * - 空闲卡用一条 `UPDATE … RETURNING` 批量领取，查询次数不随购买数量增长
 *   （D1 每次调用的查询数有上限，Free 只有 50 次）。
 * - 库存计数与领取共用同一组可售条件，避免「计数有货、实际领不到」。
 * - 任何一步失败（包括数量不足）都按订单号释放本次已领取的卡再抛出：
 *   此时订单行尚未写入，过期订单清理找不到这些预留，不释放就会白占库存
 *   直到预留 TTL 过期。
 */
import type { CardServiceDatabase } from '../license-service/db-port.ts'

export interface ReservedCard {
    id: number
    key: string
}

/** 与 checkout 既有错误约定一致，上层据此返回 `buy.stockLocked`。 */
export const STOCK_LOCKED_ERROR = 'stock_locked'

const UNUSED_CONDITION = '(is_used = 0 OR is_used IS NULL)'
const NOT_EXPIRED_CONDITION = '(expires_at IS NULL OR expires_at > ?)'

/** 可预留库存：未使用、未过期，且没有预留或预留已超过 TTL（可被回收）。 */
export async function countReservableCards(
    database: CardServiceDatabase,
    input: { productId: string; nowMs: number; reservationTtlMs: number },
): Promise<number> {
    const rows = await database.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM cards
         WHERE product_id = ?
           AND ${UNUSED_CONDITION}
           AND (reserved_at IS NULL OR reserved_at < ?)
           AND ${NOT_EXPIRED_CONDITION}`,
        [input.productId, input.nowMs - input.reservationTtlMs, input.nowMs],
    )
    return Number(rows[0]?.count || 0)
}

/** 一条语句领取至多 `quantity` 张空闲卡；单条语句在 D1 中原子执行，并发订单不会领到同一张卡。 */
export async function claimFreeCards(
    database: CardServiceDatabase,
    input: { orderId: string; productId: string; quantity: number; nowMs: number },
): Promise<ReservedCard[]> {
    if (input.quantity <= 0) return []
    const rows = await database.query<{ id: unknown; card_key: unknown }>(
        `UPDATE cards
         SET reserved_order_id = ?, reserved_at = ?
         WHERE id IN (
             SELECT id FROM cards
             WHERE product_id = ?
               AND ${UNUSED_CONDITION}
               AND reserved_at IS NULL
               AND ${NOT_EXPIRED_CONDITION}
             ORDER BY id
             LIMIT ?
         )
         RETURNING id, card_key`,
        [input.orderId, input.nowMs, input.productId, input.nowMs, input.quantity],
    )
    return rows
        .map((row) => ({ id: Number(row.id), key: String(row.card_key ?? '') }))
        .sort((a, b) => a.id - b.id)
}

/** 释放该订单持有、尚未使用的全部预留；走 `cards_reserved_order_idx`。 */
export async function releaseOrderReservations(
    database: CardServiceDatabase,
    input: { orderId: string; productId: string },
): Promise<number> {
    const [result] = await database.write([{
        sql: `UPDATE cards
              SET reserved_order_id = NULL, reserved_at = NULL
              WHERE reserved_order_id = ?
                AND product_id = ?
                AND ${UNUSED_CONDITION}`,
        params: [input.orderId, input.productId],
    }])
    return result?.changes ?? 0
}

/**
 * 为新订单预留 `quantity` 张卡：先批量领取空闲卡，不足部分逐张调用
 * `reclaimExpiredCard` 回收过期预留（需要查询支付网关，留给调用方实现）。
 *
 * 全有或全无：领不满即抛 `stock_locked`，并释放本次已领取的卡。
 */
export async function reserveCardsForNewOrder(
    database: CardServiceDatabase,
    input: {
        orderId: string
        productId: string
        quantity: number
        nowMs: number
        reclaimExpiredCard: () => Promise<ReservedCard | null>
    },
): Promise<ReservedCard[]> {
    const reserved: ReservedCard[] = []
    try {
        reserved.push(...await claimFreeCards(database, input))
        const reservedIds = new Set(reserved.map((card) => card.id))

        while (reserved.length < input.quantity) {
            const card = await input.reclaimExpiredCard()
            // 回收到的必然是他人过期的预留；重复 ID 说明数据异常，按领不到处理以免死循环。
            if (!card || reservedIds.has(card.id)) throw new Error(STOCK_LOCKED_ERROR)
            reservedIds.add(card.id)
            reserved.push(card)
        }
        return reserved
    } catch (error) {
        try {
            await releaseOrderReservations(database, input)
        } catch (releaseError) {
            console.error(`[Checkout] Failed to release reservations for order ${input.orderId}:`, releaseError)
        }
        throw error
    }
}
