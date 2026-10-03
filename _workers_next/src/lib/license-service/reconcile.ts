/**
 * 对账与待办重放（接入方案阶段 C 第 4、5 条）。
 *
 * 跨服务没有分布式事务，唯一能保证「不静默卡住」的手段是：任何一次失败都
 * 在本地留下可重放的意图，再由定时任务按**中心的真实状态**推进。
 *
 * 本模块有一条贯穿始终的规则：
 *
 *   **对账口径以查询接口为准，不以重放响应为准。**
 *
 * 原因是 `docs/API.md` §5.1 与实现都表明：幂等重放会「原样返回首次响应，
 * 不追随 Allocation 的后续状态变化」。因此一笔已 `expired` 的分配用原键重放
 * 仍会拿回 `status=allocated` 与重建的明文卡密，而那批卡可能早已被重新分配给
 * 别人。`reconcile` 因此先 `GET /allocations/{id}` 拿到真实状态，再决定是
 * 继续 Ack、物化，还是就地作废。
 *
 * 主动放弃的边界同样重要：剩余窗口小于 `ACK_RETRY_SAFETY_MARGIN_MS` 时不再
 * 重试 Ack，直接作废本地副本 —— 否则就是「重试刚发出去、窗口就过了」的必输局，
 * 白占中心配额，还要多跑一次回收。
 */

import { toLicenseServiceError } from './errors.ts'
import { runWithRetry, type RunWithRetryOptions } from './retry.ts'
import {
    ACK_RETRY_SAFETY_MARGIN_MS,
    CARD_SERVICE_OPERATION_ACK,
    ackAndMaterializeAllocation,
    buildDiscardAllocationStatements,
    listPendingCardServiceOperations,
    listStaleAllocatedAllocations,
    loadCardServiceAllocation,
    type CardServiceAllocationRow,
    type RestockDeps,
} from './restock.ts'

export const RECONCILE_DEFAULT_LIMIT = 10

/** 单笔分配的对账结论。 */
export type ReconcileOutcome =
    /** 中心已确认，本地卡已进入可售库存。 */
    | 'acknowledged'
    /** 中心窗口已过或已被回收：本地副本已作废，需要换新任务。 */
    | 'expired'
    /** 中心显示已取消或查不到该分配：本地副本已作废。 */
    | 'cancelled'
    /** 暂时不可用，留待下一轮。 */
    | 'deferred'
    /** 不可重试的失败：暂存保留，需人工核查。 */
    | 'failed'
    /** 远程状态与本地预期不符（例如已 `sold`）：暂停处置，需人工核查。 */
    | 'requires_review'
    /** 本地已是终态，无需处理。 */
    | 'skipped'

export interface ReconcileSummary {
    checked: number
    acknowledged: number
    expired: number
    cancelled: number
    deferred: number
    failed: number
    requiresReview: number
    skipped: number
    /**
     * 本轮**真正把新卡搬进本地卡池**的商品（去重）。
     *
     * 与 `ReplenishSummary.changedProductIds` 同义：`products.stock_count` 只在
     * `recalcProductAggregates*` 里回写，重放 Ack 之后必须由装配层重算，
     * 否则「对账补齐了库存、商品页仍然显示 0」。
     */
    changedProductIds: string[]
}

export function emptyReconcileSummary(): ReconcileSummary {
    return {
        checked: 0,
        acknowledged: 0,
        expired: 0,
        cancelled: 0,
        deferred: 0,
        failed: 0,
        requiresReview: 0,
        skipped: 0,
        changedProductIds: [],
    }
}

function tally(summary: ReconcileSummary, outcome: ReconcileOutcome, productId: string) {
    summary.checked += 1
    switch (outcome) {
        case 'acknowledged':
            summary.acknowledged += 1
            if (productId && !summary.changedProductIds.includes(productId)) summary.changedProductIds.push(productId)
            break
        case 'expired': summary.expired += 1; break
        case 'cancelled': summary.cancelled += 1; break
        case 'deferred': summary.deferred += 1; break
        case 'failed': summary.failed += 1; break
        case 'requires_review': summary.requiresReview += 1; break
        case 'skipped': summary.skipped += 1; break
    }
}

function reconcileRetryOptions(deps: RestockDeps, operation: string): RunWithRetryOptions {
    return {
        operation,
        policy: deps.policy,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        onRetry: deps.onRetry,
    }
}

function resolveNow(deps: RestockDeps) {
    return deps.now ?? (() => Date.now())
}

/** 本地作废：删除不可售暂存并标记终态。 */
async function discardAllocation(
    deps: RestockDeps,
    row: CardServiceAllocationRow,
    errorCode: string,
    state: 'expired' | 'cancelled',
) {
    await deps.database.write(buildDiscardAllocationStatements({
        allocationId: row.allocationId,
        ackOperationKey: row.ackKey,
        errorCode,
        nowMs: resolveNow(deps)(),
        state,
    }))
}

/**
 * 按中心的真实状态推进一笔本地仍为 `allocated` 的分配。
 *
 * 只有本地台账状态为 `allocated`（尚未确认）时才会调用它 —— 已经物化过的
 * 分配不该被这里二次处理，否则等于绕过 `restock` 的幂等边界。
 */
export async function resolveAllocationWithRemoteState(
    deps: RestockDeps,
    row: CardServiceAllocationRow,
): Promise<ReconcileOutcome> {
    let remoteStatus: string
    try {
        const detail = await runWithRetry(
            () => deps.client.getAllocation(row.allocationId),
            reconcileRetryOptions(deps, 'getAllocation'),
        )
        remoteStatus = detail.status
    } catch (error) {
        const classified = toLicenseServiceError(error, 'getAllocation')

        if (classified.category === 'unavailable') return 'deferred'

        // 查不到该分配（例如 Key 换了 Client、或中心已清理）：本地副本已无法
        // 通过 Ack 转正，就地作废并留痕，等待人工核查。
        if (classified.code === 'not_found') {
            await discardAllocation(deps, row, 'not_found', 'cancelled')
            return 'cancelled'
        }

        // 其余不可重试错误（鉴权、权限、契约）保持暂存不动：远程可能仍持有
        // 这批卡，删掉就是把库存白送出去。
        return 'failed'
    }

    switch (remoteStatus) {
        case 'allocated': {
            const remaining = row.expiresAtMs - resolveNow(deps)()
            if (remaining <= ACK_RETRY_SAFETY_MARGIN_MS) {
                // 窗口不足以再走一轮重试，主动放弃，由调用方换新任务。
                await discardAllocation(deps, row, 'allocation_expired', 'expired')
                return 'expired'
            }
            return outcomeOfAck(await ackAndMaterializeAllocation(deps, row))
        }

        case 'acknowledged':
            // Ack 幂等：重复提交返回首次结果，因此直接走同一条确认+物化路径。
            return outcomeOfAck(await ackAndMaterializeAllocation(deps, row))

        case 'expired':
            await discardAllocation(deps, row, 'allocation_expired', 'expired')
            return 'expired'

        case 'cancelled':
            await discardAllocation(deps, row, 'allocation_cancelled', 'cancelled')
            return 'cancelled'

        default:
            // `sold` 或未来新增的枚举：本地没有对应订单，不能凭空物化成可售卡
            // （`sold` 需要 `cards:sell` + 订单号，属阶段 D）。保留暂存并交人工。
            return 'requires_review'
    }
}

function outcomeOfAck(outcome: Awaited<ReturnType<typeof ackAndMaterializeAllocation>>): ReconcileOutcome {
    switch (outcome.status) {
        case 'acknowledged': return 'acknowledged'
        case 'expired': return 'expired'
        case 'deferred': return 'deferred'
        case 'failed': return 'failed'
    }
}

/**
 * 重放待办的 Ack（含上次因 429/503/超时被挂起的，以及被标记 `failed` 的）。
 *
 * 先用 `GET /allocations/{id}` 核对真实状态，再决定动作 —— 这正是 N2 要求的
 * 「重放结果入可售库存前必须核对」。
 */
export async function reconcilePendingAckOperations(
    deps: RestockDeps,
    options: { limit?: number } = {},
): Promise<ReconcileSummary & { seenAllocationIds: string[] }> {
    const summary = emptyReconcileSummary()
    const seenAllocationIds: string[] = []
    const operations = await listPendingCardServiceOperations(deps.database, {
        operation: CARD_SERVICE_OPERATION_ACK,
        limit: options.limit ?? RECONCILE_DEFAULT_LIMIT,
        // 自动对账必须遵守退避：没到期的待办这一轮跳过，否则每分钟一次的调度
        // 会把 attempts 迅速烧光（12 次上限约 12 分钟耗尽），操作提前死信。
        respectBackoff: true,
    })

    for (const operation of operations) {
        try {
            const row = await loadCardServiceAllocation(deps.database, operation.resourceId)
            if (operation.resourceId) seenAllocationIds.push(operation.resourceId)
            if (!row) {
                // 台账缺失（例如已被人工清理）：待办永远无法推进，计入需人工核查。
                summary.checked += 1
                summary.requiresReview += 1
                continue
            }
            if (row.state !== 'allocated') {
                tally(summary, 'skipped', row.productId)
                continue
            }
            tally(summary, await resolveAllocationWithRemoteState(deps, row), row.productId)
        } catch {
            // 单条待办（含物化落账本身失败）不能中断本轮已确认的成功项。
            summary.checked += 1
            summary.failed += 1
        }
    }

    return { ...summary, seenAllocationIds }
}

/**
 * 清理超过 Ack 窗口仍未确认的分配。
 *
 * 这里不做「先重试 Ack 再放弃」——超过 `expires_at` 后中心的 `card-worker`
 * 已经（或必然）回收了卡密，任何 Ack 都会拿到 `409 allocation_expired`。
 * 仍要查一次远程状态，是为了覆盖「本地时钟或网络导致误判、远程其实仍持有」的
 * 情况，避免把确认成功的库存当垃圾删掉。
 */
export async function abandonStaleAllocations(
    deps: RestockDeps,
    options: { limit?: number; excludeAllocationIds?: ReadonlySet<string> } = {},
): Promise<ReconcileSummary> {
    const summary = emptyReconcileSummary()
    const nowMs = resolveNow(deps)()
    const limit = Math.max(1, Math.trunc(options.limit ?? RECONCILE_DEFAULT_LIMIT))
    const rows = await listStaleAllocatedAllocations(deps.database, {
        deadLineMs: nowMs,
        limit,
        excludeAllocationIds: options.excludeAllocationIds ? Array.from(options.excludeAllocationIds) : [],
    })

    for (const row of rows) {
        if (summary.checked >= limit) break
        try {
            tally(summary, await resolveAllocationWithRemoteState(deps, row), row.productId)
        } catch {
            summary.checked += 1
            summary.failed += 1
        }
    }

    return summary
}

function mergeReconcileSummary(pending: ReconcileSummary, stale: ReconcileSummary): ReconcileSummary {
    const changedProductIds: string[] = []
    for (const productId of [...pending.changedProductIds, ...stale.changedProductIds]) {
        if (!changedProductIds.includes(productId)) changedProductIds.push(productId)
    }
    return {
        checked: pending.checked + stale.checked,
        acknowledged: pending.acknowledged + stale.acknowledged,
        expired: pending.expired + stale.expired,
        cancelled: pending.cancelled + stale.cancelled,
        deferred: pending.deferred + stale.deferred,
        failed: pending.failed + stale.failed,
        requiresReview: pending.requiresReview + stale.requiresReview,
        skipped: pending.skipped + stale.skipped,
        changedProductIds,
    }
}

/**
 * 对账入口：先推进待办，再清理过期分配。供定时任务调用。
 *
 * 两段共享同一个条目上限，并且第二段排除第一段已经查过的 allocation。
 * 否则 limit=1 时，一笔「待办里有、又已超窗」的分配会在同一轮被 GET 两次。
 */
export async function reconcileCardServiceState(
    deps: RestockDeps,
    options: { limit?: number } = {},
): Promise<ReconcileSummary> {
    const limit = Math.max(1, Math.trunc(options.limit ?? RECONCILE_DEFAULT_LIMIT))
    const pending = await reconcilePendingAckOperations(deps, { limit })
    const remaining = limit - pending.checked
    if (remaining <= 0) {
        const { seenAllocationIds: _seen, ...summary } = pending
        return summary
    }

    const stale = await abandonStaleAllocations(deps, {
        limit: remaining,
        excludeAllocationIds: new Set(pending.seenAllocationIds),
    })

    return mergeReconcileSummary(pending, stale)
}
