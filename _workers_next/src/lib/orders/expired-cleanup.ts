/**
 * 超时订单清理的可测试核心。
 *
 * `queries.ts` 的 `cancelExpiredOrders` 依赖 Drizzle 与 `@/` 别名，
 * `node --test` 加载不了。候选选择与单笔收尾放在这里，由它调用。
 */

export const EXPIRED_ORDER_CLEANUP_LIMIT = 20
const CLEANUP_PARAMETER_CHUNK = 90

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
    listReservedCancelled(input: { limit: number; productId: string | null; userId: string | null; orderId: string | null }): Promise<ExpiredOrderCandidate[]>
    /** 只有仍为 pending 的更新返回 true。已取消的恢复项不走这里。 */
    cancelIfPending(orderId: string): Promise<boolean>
    returnPoints(order: ExpiredOrderCandidate): Promise<void>
    releaseCoupons(orderId: string): Promise<number>
    releaseCards(orderIds: readonly string[]): Promise<void>
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

export async function settleExpiredCleanupBatch(
    store: ExpiredCleanupStore,
    candidates: readonly ExpiredOrderCandidate[],
): Promise<string[]> {
    const settled: ExpiredOrderCandidate[] = []
    for (const candidate of candidates) {
        if (!candidate.orderId) continue
        if (candidate.status !== 'cancelled') {
            const cancelled = await store.cancelIfPending(candidate.orderId)
            if (!cancelled) continue
        }
        if (candidate.userId && candidate.pointsUsed && candidate.pointsUsed > 0) {
            await store.returnPoints(candidate)
        }
        await store.releaseCoupons(candidate.orderId)
        settled.push(candidate)
    }
    const orderIds = settled.map((row) => row.orderId).filter(Boolean)
    if (orderIds.length) await store.releaseCards(orderIds)
    return orderIds
}
