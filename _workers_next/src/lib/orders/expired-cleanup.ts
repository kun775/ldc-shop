/**
 * 超时订单清理的可测试核心。
 *
 * `queries.ts` 的 `cancelExpiredOrders` 依赖 Drizzle 与 `@/` 别名，
 * `node --test` 加载不了。候选选择、恢复条件 SQL 与逐单收尾都放在这里，
 * 生产路径只负责把 D1 适配成 `ExpiredCleanupStore`。
 *
 * 「收尾」= 取消订单之后的三步：返积分、释放优惠券预占、释放押卡。
 * 三步不在一个原子批次里（返积分走积分账本的 claim/finalize），任何一步
 * 失败都会留下「已取消但没收尾完」的订单。恢复条件
 * （`EXPIRED_CLEANUP_RECOVERY_CONDITION_SQL`）必须能把这三种残留都重新找出来，
 * 否则它们就永久卡住。
 */

export const EXPIRED_ORDER_CLEANUP_LIMIT = 20
const CLEANUP_PARAMETER_CHUNK = 90

/**
 * 积分恢复只看最近这么久创建的已取消订单。
 *
 * 押卡与券预占的恢复不限时（驱动集合本身很小：只有仍被押的卡、仍为
 * reserved 的券）；积分恢复要对每笔已取消订单查两次账本，不加时间窗
 * 就会让每分钟一次的 cron 随历史订单线性变慢。超出窗口仍未返还的，
 * 属于连续一周返积分都失败，需要人工处理。
 */
export const EXPIRED_CLEANUP_POINT_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface ExpiredOrderCandidate {
    orderId: string
    productId: string | null
    userId: string | null
    username: string | null
    email: string | null
    pointsUsed: number | null
    status: string
}

export interface ExpiredCleanupStore {
    listPending(input: { deadlineMs: number; limit: number; productId: string | null; userId: string | null; orderId: string | null }): Promise<ExpiredOrderCandidate[]>
    /** 已取消、但押卡 / 券预占 / 积分返还仍有残留的订单。 */
    listReservedCancelled(input: { limit: number; productId: string | null; userId: string | null; orderId: string | null }): Promise<ExpiredOrderCandidate[]>
    /** 只有仍为 pending 的更新返回 true。已取消的恢复项不走这里。 */
    cancelIfPending(orderId: string): Promise<boolean>
    /**
     * 该订单是否真的扣过积分、且尚未返还。
     *
     * 只认 checkout 写入的扣减流水：历史回填同样写 `order_deduction:<id>`，
     * 但那批订单当年的返还已由 `legacy_balance_init` 吸收，再返一次就是重复入账。
     */
    shouldReturnPoints(order: ExpiredOrderCandidate): Promise<boolean>
    returnPoints(order: ExpiredOrderCandidate): Promise<void>
    releaseCoupons(orderId: string): Promise<number>
    releaseCards(orderIds: readonly string[]): Promise<void>
}

export type ExpiredCleanupStep = 'cancel' | 'points' | 'coupons' | 'cards'

export interface ExpiredCleanupFailure {
    orderId: string
    step: ExpiredCleanupStep
    error: unknown
}

export interface ExpiredCleanupResult {
    /** 本轮完成收尾（状态、积分、券都已处理）的订单。 */
    settled: ExpiredOrderCandidate[]
    /** 本轮失败的订单与步骤。失败单不释放押卡，留给下一轮恢复。 */
    failed: ExpiredCleanupFailure[]
    releasedCouponUsages: number
}

export function clampExpiredCleanupLimit(raw: number | undefined): number {
    const parsed = raw == null ? EXPIRED_ORDER_CLEANUP_LIMIT : raw
    if (!Number.isFinite(parsed)) return EXPIRED_ORDER_CLEANUP_LIMIT
    return Math.max(1, Math.min(100, Math.trunc(parsed)))
}

export function chunkCleanupIds(ids: readonly string[], size = CLEANUP_PARAMETER_CHUNK): string[][] {
    const chunks: string[][] = []
    for (let offset = 0; offset < ids.length; offset += size) chunks.push(ids.slice(offset, offset + size))
    return chunks
}

/**
 * 「已取消但收尾未完成」的判定条件，作用于外层 `orders` 表（不带别名）。
 *
 * 三路任一成立即需要恢复：
 *   1. 仍有**未使用**的卡押在该订单上（已使用的卡不释放，否则会永远命中）；
 *   2. 仍有 `reserved` 的优惠券预占；
 *   3. 时间窗内、checkout 扣过积分（`metadata` 非空）且没有已完成的返还。
 *
 * 写成 `order_id IN (A UNION B UNION C)` 而不是三个 OR：OR 会让外层把所有
 * 已取消订单逐行判一遍；UNION 让三路各自走索引（`cards_reserved_order_idx`、
 * `orders_status_created_at_idx`），只产出真正有残留的少量订单号。
 *
 * 只有一个整数参数（时间窗起点），直接内联，避免与 Drizzle 的参数顺序耦合。
 */
export function buildExpiredCleanupRecoveryConditionSql(nowMs: number): string {
    const windowStart = Math.max(0, Math.trunc(nowMs - EXPIRED_CLEANUP_POINT_RECOVERY_WINDOW_MS))
    return `orders.order_id IN (
        SELECT reserved_order_id FROM cards
        WHERE reserved_order_id IS NOT NULL AND (is_used = 0 OR is_used IS NULL)
        UNION
        SELECT order_id FROM coupon_usages WHERE status = 'reserved'
        UNION
        SELECT o.order_id FROM orders o
        WHERE o.status = 'cancelled' AND o.created_at >= ${windowStart}
          AND o.points_used > 0 AND o.user_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM user_point_ledger d
              WHERE d.business_key = 'order_deduction:' || o.order_id
                AND d.status = 'completed' AND d.metadata IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1 FROM user_point_ledger r
              WHERE r.business_key = 'refund_return:' || o.order_id AND r.status = 'completed'
          )
    )`
}

/** 旧库缺 `coupon_usages` / `user_point_ledger` 时的退化条件：只恢复押卡。 */
export const EXPIRED_CLEANUP_CARDS_ONLY_RECOVERY_CONDITION_SQL = `orders.order_id IN (
    SELECT reserved_order_id FROM cards
    WHERE reserved_order_id IS NOT NULL AND (is_used = 0 OR is_used IS NULL)
)`

/** 返积分判定用到的两个账本键：checkout 扣减与返还。 */
export function refundablePointsParams(orderId: string): [string, string] {
    return [`order_deduction:${orderId}`, `refund_return:${orderId}`]
}

export async function selectExpiredCleanupCandidates(
    store: Pick<ExpiredCleanupStore, 'listPending' | 'listReservedCancelled'>,
    input: { deadlineMs: number; limit?: number; productId?: string | null; userId?: string | null; orderId?: string | null },
): Promise<ExpiredOrderCandidate[]> {
    const limit = clampExpiredCleanupLimit(input.limit)
    const scope = {
        productId: input.productId ?? null,
        userId: input.userId ?? null,
        orderId: input.orderId ?? null,
    }
    const pending = await store.listPending({ deadlineMs: input.deadlineMs, limit, ...scope })
    if (pending.length >= limit) return pending.slice(0, limit)
    const recovery = await store.listReservedCancelled({ limit: limit - pending.length, ...scope })
    return [...pending, ...recovery]
}

/**
 * 逐单收尾。**一单失败不影响其余订单**：
 *   - 失败单记入 `failed`，不释放它的押卡（押卡在，下一轮恢复条件必然命中）；
 *   - 其余订单照常完成，押卡在循环外按 90 个一块批量释放。
 */
export async function settleExpiredCleanupBatch(
    store: ExpiredCleanupStore,
    candidates: readonly ExpiredOrderCandidate[],
): Promise<ExpiredCleanupResult> {
    const result: ExpiredCleanupResult = { settled: [], failed: [], releasedCouponUsages: 0 }
    for (const candidate of candidates) {
        if (!candidate.orderId) continue
        let step: ExpiredCleanupStep = 'cancel'
        try {
            if (candidate.status !== 'cancelled') {
                const cancelled = await store.cancelIfPending(candidate.orderId)
                // 被支付回调抢先改走的订单不归本流程收尾。
                if (!cancelled) continue
            }
            step = 'points'
            if (candidate.userId && candidate.pointsUsed && candidate.pointsUsed > 0
                && await store.shouldReturnPoints(candidate)) {
                await store.returnPoints(candidate)
            }
            step = 'coupons'
            result.releasedCouponUsages += await store.releaseCoupons(candidate.orderId)
            result.settled.push(candidate)
        } catch (error) {
            result.failed.push({ orderId: candidate.orderId, step, error })
        }
    }

    const orderIds = result.settled.map((row) => row.orderId)
    if (orderIds.length) {
        try {
            await store.releaseCards(orderIds)
        } catch (error) {
            // 订单状态、积分、券都已处理；押卡还在，下一轮恢复条件会再找回来。
            for (const orderId of orderIds) result.failed.push({ orderId, step: 'cards', error })
        }
    }
    return result
}
