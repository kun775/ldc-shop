/**
 * 删除与清理路径的保护规则（接入方案阶段 E 第 1 条）。
 *
 * 背景很具体：`card_service_cards` 是**唯一**记录「本地卡 → 远端 card_id +
 * Allocation」的地方，而中心在 Ack 之后**没有归还可售的接口**。因此一旦这条映射
 * 被物理删除：
 *
 *   - 那张卡再也无法被作废（退款时找不到远端身份，只能永久留在流通里）；
 *   - 对账再也解释不清「这笔钱对应的卡去哪了」。
 *
 * 所以凡是会物理删除本地卡或订单的既有路径（`deleteCards`、卡片过期清理、
 * 订单删除），都必须先问一句「这些卡/这笔订单还有远端映射吗」。本模块把这一句
 * 抽成可单测的纯读查询 —— 三条路径共用同一份判定，不各写一遍。
 *
 * 注意区分两种「删除」：
 *   - 删**卡**：有映射就跳过（映射要随卡一起留证），由管理端提示改走停售/隔离；
 *   - 删**订单**：有映射就拒绝（订单行是退款/对账的追溯起点），由管理端提示
 *     先处理远端卡。删除是管理端显式动作，拒绝比静默留下孤儿映射更安全。
 */

import { CARD_SERVICE_ALLOCATIONS_TABLE, CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_OPERATIONS_TABLE } from '../db/license-service-schema.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'

function placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ')
}

function normalizeIds(cardIds: readonly number[]): number[] {
    return Array.from(new Set(cardIds.filter((id) => Number.isSafeInteger(id) && id > 0)))
}

/**
 * 在这些本地卡里，找出**仍持有远端映射**的那些 ID。
 *
 * 已 `revoked` 的映射同样算「持有」：作废是终态记录，删掉它等于把「这张卡已经
 * 不能再卖了」这条事实一起删掉，后续对账会把它误判成可用库存。
 */
export async function listProtectedLocalCardIds(
    database: CardServiceDatabase,
    cardIds: readonly number[],
): Promise<number[]> {
    const ids = normalizeIds(cardIds)
    if (!ids.length) return []

    try {
        const rows = await database.query<{ local_card_id?: unknown }>(
            `SELECT local_card_id FROM ${CARD_SERVICE_CARDS_TABLE}
             WHERE local_card_id IN (${placeholders(ids.length)})`,
            ids,
        )
        return rows
            .map((row) => Number(row.local_card_id))
            .filter((id) => Number.isSafeInteger(id) && id > 0)
    } catch (error) {
        // 0038 未执行：不存在任何映射，全部可删（保持既有行为）。
        if (isMissingTableError(error)) return []
        throw error
    }
}

/**
 * 把一批待删卡分成「可删」与「有远端映射被保护」两部分。
 *
 * 返回两个数组而不是一个布尔，是因为调用方（管理端）需要告诉管理员
 * 「跳过了几张、为什么」——静默少删会让管理员以为删除成功了。
 */
export async function partitionDeletableLocalCardIds(
    database: CardServiceDatabase,
    cardIds: readonly number[],
): Promise<{ deletable: number[]; protectedIds: number[] }> {
    const ids = normalizeIds(cardIds)
    if (!ids.length) return { deletable: [], protectedIds: [] }

    const protectedIds = await listProtectedLocalCardIds(database, ids)
    const protectedSet = new Set(protectedIds)
    return {
        deletable: ids.filter((id) => !protectedSet.has(id)),
        protectedIds,
    }
}

/**
 * 这笔订单是否仍持有未作废的远端映射。
 *
 * 用于拒绝物理删除订单：订单行是退款、作废与对账的追溯起点，映射本身虽然独立
 * 存表，已作废且无待办时可以删除订单；其余映射丢掉订单会让「这笔映射属于哪笔业务」只能靠人工比对。
 */
export async function orderHasRemoteMappings(
    database: CardServiceDatabase,
    orderId: string,
): Promise<boolean> {
    const id = (orderId || '').trim()
    if (!id) return false

    try {
        const rows = await database.query<{ local_card_id?: unknown }>(
            `SELECT local_card_id FROM ${CARD_SERVICE_CARDS_TABLE} WHERE order_id = ? AND COALESCE(state, '') <> 'revoked' LIMIT 1`,
            [id],
        )
        return rows.length > 0
    } catch (error) {
        if (isMissingTableError(error)) return false
        throw error
    }
}

/**
 * 这笔订单是否还有**未了结的中心待办**（`sell` / `revoke` 的 `pending` / `failed`）。
 *
 * 为什么必须与 `orderHasRemoteMappings` 一起查 —— 两者覆盖的时间窗不同：
 *
 *   - **Sell 之前**：意图行已经落进 `card_service_operations`，但
 *     `card_service_cards` 里那几行还是 `acknowledged`，且 `sold` 这步未必
 *     已经被本地确认。此时「映射查询」查得到行，但**真正说明「中心可能已经
 *     把卡卖掉了」的是这条 `sell` 待办**。
 *   - **退款之后**：订单上的 `card_key` / `card_ids` 已被清空，映射也可能在
 *     清理中消失，只剩 `revoke` 待办是「中心那边还留着一张已售出的卡」的
 *     唯一痕迹。
 *
 * 任一窗口里删掉订单，退款与对账都会失去追溯起点。`done` / `abandoned` 是终态，
 * 不拦（否则历史订单永远删不掉）。
 */
export async function orderHasPendingCardServiceOperations(
    database: CardServiceDatabase,
    orderId: string,
): Promise<boolean> {
    const id = (orderId || '').trim()
    if (!id) return false

    try {
        // 取值与 `restock.ts` 的 `CARD_SERVICE_OPERATION_STATES` 一致：
        // `pending` / `failed` 都还会被定时任务重放，`done` / `abandoned` 不会。
        const rows = await database.query<{ hit?: unknown }>(
            `SELECT 1 AS hit FROM ${CARD_SERVICE_OPERATIONS_TABLE}
              WHERE order_id = ? AND state IN ('pending', 'failed') LIMIT 1`,
            [id],
        )
        return rows.length > 0
    } catch (error) {
        if (isMissingTableError(error)) return false
        throw error
    }
}

/**
 * 订单删除的**总闸门**：只要还留有远端映射、或还有未了结的中心待办，就不许删。
 *
 * 两路取「或」而不是取「与」：任何一路命中都意味着这笔订单背后还有中心的账没结。
 * 单独查映射会漏掉 Sell 未确认的窗口，单独查待办会漏掉已确认的映射。
 */
export async function orderHasUnsettledCardServiceLedger(
    database: CardServiceDatabase,
    orderId: string,
): Promise<boolean> {
    if (await orderHasRemoteMappings(database, orderId)) return true
    return orderHasPendingCardServiceOperations(database, orderId)
}

/**
 * 这个商品是否还有**未结清的中心台账**（映射 ∪ 待办）。
 *
 * 用于**商品删除**守卫。商品删除会级联带走本地 `cards`，进而删掉
 * `card_service_cards` 里的映射行 —— 中心那几张卡从此失去本地归属，退款时再也
 * 无法作废。而且供应配置行不随商品删除消失，低水位扫描会继续对着一个不存在的
 * 商品 Allocate / Ack（物化时本地外键失败），持续消耗中心库存。
 *
 * 口径与「供应模式切离」的互斥判定（`countUnsettledRemoteMappings`）保持一致：
 * 仍归中心管理的 `acknowledged`、已由中心售出的 `sold`，以及还会被重放的
 * `pending` / `failed` 待办。已 `revoked` 的映射不拦 —— 远端卡已是死卡。
 */
export async function productHasUnsettledCardServiceLedger(
    database: CardServiceDatabase,
    productId: string,
): Promise<boolean> {
    const id = (productId || '').trim()
    if (!id) return false

    try {
        const rows = await database.query<{ hit?: unknown }>(
            `SELECT 1 AS hit FROM ${CARD_SERVICE_CARDS_TABLE}
              WHERE product_id = ? AND state IN ('acknowledged', 'sold') LIMIT 1`,
            [id],
        )
        if (rows.length > 0) return true
    } catch (error) {
        if (isMissingTableError(error)) return false
        const text = `${(error as { message?: unknown } | null)?.message ?? ''}`.toLowerCase()
        if (text.includes('no such column')) return false
        throw error
    }

    // 待办表没有 `product_id` 列，按资源归属反查：`sell` / `ack` 待办的
    // `resource_id` 是 allocation id，`revoke` 待办的是远端 card id。
    try {
        const rows = await database.query<{ hit?: unknown }>(
            `SELECT 1 AS hit FROM ${CARD_SERVICE_OPERATIONS_TABLE}
              WHERE state IN ('pending', 'failed')
                AND (resource_id IN (SELECT allocation_id FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} WHERE product_id = ?)
                     OR resource_id IN (SELECT remote_card_id FROM ${CARD_SERVICE_CARDS_TABLE} WHERE product_id = ?))
              LIMIT 1`,
            [id, id],
        )
        return rows.length > 0
    } catch (error) {
        if (isMissingTableError(error)) return false
        const text = `${(error as { message?: unknown } | null)?.message ?? ''}`.toLowerCase()
        if (text.includes('no such column')) return false
        throw error
    }
}
