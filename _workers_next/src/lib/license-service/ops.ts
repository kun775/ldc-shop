/**
 * 卡密服务运维总览与一致性口径（接入方案阶段 E 第 3、4 条）。
 *
 * 本模块**只读**、**不联网**：所有数字都从本地账本算出来，因此管理端页面与
 * 健康检查可以随时调用它，既不消耗中心配额，也不会因为中心不可用而整页失败。
 *
 * 有一条边界必须写清楚，否则面板会给出误导性的绿灯：
 *
 *   - 本地就能判定的漂移（映射与订单/本地卡不一致、越窗残留、孤立映射）在这里算；
 *   - **远端**侧的状态口径（例如「远端 `sold` 而本地未交付」的远端一半）只有对账
 *     任务能确认，属 `reconcile.ts` 的职责。这里的 `soldWithoutDeliveredOrder`
 *     只是「本地映射已售出但订单不是 delivered」的痕迹，用于指出线索，
 *     不等价于远端结论。
 *
 * 未执行 0038 时这几张表不存在，全部入口返回 `enabled: false` 的空快照而不是抛错 ——
 * 代码先上线、管理员后点升级是既定部署顺序，面板不该在那段时间整页报错。
 */

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_ALLOCATION_STATES,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
    CARD_SERVICE_PRODUCT_CONFIG_TABLE,
    CARD_SERVICE_STAGED_CARDS_TABLE,
    type CardServiceAllocationState,
    type CardServiceSupplyMode,
} from '../db/license-service-schema.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'
import {
    CARD_SERVICE_OPERATION_ACK,
    CARD_SERVICE_OPERATION_REVOKE,
    CARD_SERVICE_OPERATION_SELL,
} from './restock.ts'

/** 本地业务表名：漂移口径要 join 它们，硬编码一处便于与 `queries.ts` 对照。 */
const LOCAL_CARDS_TABLE = 'cards'
const LOCAL_ORDERS_TABLE = 'orders'
const LOCAL_PRODUCTS_TABLE = 'products'

/** 「临近 Ack 超窗」的缺省阈值。中心默认窗口 30 分钟，5 分钟是可见的止损点。 */
export const CARD_SERVICE_EXPIRING_SOON_DEFAULT_MS = 5 * 60_000

/** 复核清单缺省条数。 */
export const CARD_SERVICE_REVIEW_DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface CardServiceOperationTally {
    pending: number
    failed: number
    abandoned: number
    done: number
    total: number
}

export interface CardServiceOperationSummary {
    ack: CardServiceOperationTally
    sell: CardServiceOperationTally
    revoke: CardServiceOperationTally
}

export type CardServiceAllocationCounts = Record<CardServiceAllocationState, number>

export interface CardServiceCardCounts {
    /** 已 Ack、尚未 `sold`：本地可售的远端卡（正常库存）。 */
    acknowledged: number
    sold: number
    revoked: number
    /** 账本里出现了预期外的状态：需人工核查。 */
    other: number
    total: number
}

/**
 * 一致性口径。
 *
 * 字段前的「应为 0」是上线阻断条件的一部分（方案 §4 阻断条件 1、4），
 * 面板必须把它们与普通计数区分呈现。
 */
export interface CardServiceDrift {
    /** 已 Ack 未 Sell 的远端卡数。**不是异常**，正常情况下应等于远端库存。 */
    sellableRemoteCards: number
    /** 映射已 `sold` 但订单不是 `delivered`：原子交付批次被破坏的痕迹，应为 0。 */
    soldWithoutDeliveredOrder: number
    /** 订单已 `delivered` 但映射不是 `sold`/`revoked`：应为 0。 */
    deliveredWithoutRemoteSold: number
    /** Allocation 已是终态（`expired`/`cancelled`）而映射仍可售：越窗残留，应为 0。 */
    expiredWithSellableCards: number
    /** 映射指向不存在的本地卡：映射被清理或卡被物理删除，需人工核查。 */
    orphanMappings: number
    /** 不可售暂存卡所属 Allocation 已不在 `allocated`：超窗残留，需清理。 */
    stagedWithoutActiveAllocation: number
}

/** 临近（或已超）Ack 窗口的分配。 */
export interface ExpiringAllocationRow {
    allocationId: string
    productId: string
    programKey: string
    state: string
    quantity: number
    expiresAtMs: number
    /** 负数表示已经超窗，仍停在 `allocated` 说明对账尚未清理。 */
    remainingMs: number
    ackedAtMs: number | null
}

export interface PendingOperationDetail {
    operationKey: string
    operation: string
    resourceId: string
    orderId: string | null
    state: string
    attempts: number
    nextRetryAtMs: number | null
    lastErrorCode: string | null
    requestId: string | null
}

export interface OrphanMappingRow {
    localCardId: number
    remoteCardId: string
    allocationId: string
    productId: string
    orderId: string | null
    state: string
}

export interface CardServiceReviewQueue {
    enabled: boolean
    /** 不可重试失败的操作（含作废、Sell、Ack）。 */
    failedOperations: PendingOperationDetail[]
    /** 超窗仍停在 `allocated` 的分配：本地副本必须被清理或转人工。 */
    staleAllocations: ExpiringAllocationRow[]
    /** 指向不存在本地卡的映射。 */
    orphanMappings: OrphanMappingRow[]
    /** 是否因为条数上限而截断。 */
    truncated: boolean
}

export interface CardServiceOverview {
    enabled: boolean
    checkedAtMs: number
    operations: CardServiceOperationSummary
    allocations: CardServiceAllocationCounts
    cards: CardServiceCardCounts
    stagedCards: number
    /** 临近 Ack 超窗（含已超窗）的分配，按剩余时间升序。 */
    expiring: ExpiringAllocationRow[]
    /** 已超窗但仍停在 `allocated` 的分配。 */
    overdue: ExpiringAllocationRow[]
    drift: CardServiceDrift
    /** 需人工处置的项数（失败操作 + 超窗分配 + 漂移）。 */
    reviewCount: number
}

export interface CardServiceProductStatus {
    productId: string
    productName: string | null
    /** 与商城已售口径一致：已付款和已交付订单的商品数量。 */
    soldCount: number
    supplyMode: CardServiceSupplyMode
    programKey: string | null
    targetStock: number | null
    /** 本地可售卡（未使用、未预留）。 */
    localSellableCards: number
    /** 已 Ack 未 Sell 的远端卡。 */
    remoteSellableCards: number
    /** 在途分配（`allocated`，尚未 Ack）。 */
    inFlightAllocations: number
    pendingAck: number
    /** 待处理或失败的销售同步任务数；已完成任务不计入。 */
    pendingSell: number
    pendingRevoke: number
    /** 目标库存 > 0 而本地可售 + 远端可售合计为 0：补货已耗尽。 */
    stockExhausted: boolean
}

export interface CardServiceOverviewOptions {
    now?: number
    expiringSoonMs?: number
    limit?: number
}

// ---------------------------------------------------------------------------
// 空快照
// ---------------------------------------------------------------------------

function emptyTally(): CardServiceOperationTally {
    return { pending: 0, failed: 0, abandoned: 0, done: 0, total: 0 }
}

export function emptyCardServiceOperationSummary(): CardServiceOperationSummary {
    return { ack: emptyTally(), sell: emptyTally(), revoke: emptyTally() }
}

export function emptyCardServiceAllocationCounts(): CardServiceAllocationCounts {
    return {
        allocated: 0,
        acknowledged: 0,
        sold: 0,
        expired: 0,
        cancelled: 0,
        abandoned: 0,
    }
}

export function emptyCardServiceCardCounts(): CardServiceCardCounts {
    return { acknowledged: 0, sold: 0, revoked: 0, other: 0, total: 0 }
}

export function emptyCardServiceDrift(): CardServiceDrift {
    return {
        sellableRemoteCards: 0,
        soldWithoutDeliveredOrder: 0,
        deliveredWithoutRemoteSold: 0,
        expiredWithSellableCards: 0,
        orphanMappings: 0,
        stagedWithoutActiveAllocation: 0,
    }
}

export function emptyCardServiceOverview(nowMs = Date.now()): CardServiceOverview {
    return {
        enabled: false,
        checkedAtMs: nowMs,
        operations: emptyCardServiceOperationSummary(),
        allocations: emptyCardServiceAllocationCounts(),
        cards: emptyCardServiceCardCounts(),
        stagedCards: 0,
        expiring: [],
        overdue: [],
        drift: emptyCardServiceDrift(),
        reviewCount: 0,
    }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toInteger(value: unknown): number {
    const parsed = typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
}

function toIntegerOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function toStringOrEmpty(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function toStringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length ? value : null
}

function resolveNow(options: { now?: number }): number {
    return Number.isFinite(options.now) ? (options.now as number) : Date.now()
}

// ---------------------------------------------------------------------------
// SQL 片段
// ---------------------------------------------------------------------------

/**
 * 用一条 SELECT 的六个计数子查询读取漂移口径，保留同一读快照。
 * 避免 UNION ALL 拼接触发 D1 的复合 SELECT 项数限制。
 */
const DRIFT_SQL = `
SELECT
    (SELECT COUNT(*) FROM ${CARD_SERVICE_CARDS_TABLE} WHERE state = 'acknowledged') AS sellableRemoteCards,
    (SELECT COUNT(*)
        FROM ${CARD_SERVICE_CARDS_TABLE} m
        LEFT JOIN ${LOCAL_ORDERS_TABLE} o ON o.order_id = m.order_id
        WHERE m.state = 'sold' AND (o.order_id IS NULL OR o.status <> 'delivered')) AS soldWithoutDeliveredOrder,
    (SELECT COUNT(*)
        FROM ${CARD_SERVICE_CARDS_TABLE} m
        JOIN ${LOCAL_ORDERS_TABLE} o ON o.order_id = m.order_id
        WHERE o.status = 'delivered' AND m.state NOT IN ('sold', 'revoked')) AS deliveredWithoutRemoteSold,
    (SELECT COUNT(*)
        FROM ${CARD_SERVICE_CARDS_TABLE} m
        JOIN ${CARD_SERVICE_ALLOCATIONS_TABLE} a ON a.allocation_id = m.allocation_id
        WHERE a.state IN ('expired', 'cancelled') AND m.state = 'acknowledged') AS expiredWithSellableCards,
    (SELECT COUNT(*)
        FROM ${CARD_SERVICE_CARDS_TABLE} m
        LEFT JOIN ${LOCAL_CARDS_TABLE} c ON c.id = m.local_card_id
        WHERE c.id IS NULL) AS orphanMappings,
    (SELECT COUNT(*)
        FROM ${CARD_SERVICE_STAGED_CARDS_TABLE} s
        LEFT JOIN ${CARD_SERVICE_ALLOCATIONS_TABLE} a ON a.allocation_id = s.allocation_id
        WHERE a.allocation_id IS NULL OR a.state <> 'allocated') AS stagedWithoutActiveAllocation
`

const EXPIRING_SELECT = `
SELECT allocation_id, product_id, program_key, state, quantity, expires_at, acked_at
    FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}
    WHERE state = 'allocated' AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?`

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

/** 读一次运维总览。表不存在（0038 未执行）时返回 `enabled: false` 的空快照。 */
export async function loadCardServiceOverview(
    database: CardServiceDatabase,
    options: CardServiceOverviewOptions = {},
): Promise<CardServiceOverview> {
    const nowMs = resolveNow(options)
    const expiringSoonMs = Number.isFinite(options.expiringSoonMs)
        ? Math.max(0, options.expiringSoonMs as number)
        : CARD_SERVICE_EXPIRING_SOON_DEFAULT_MS
    const limit = Math.max(1, Math.trunc(options.limit ?? CARD_SERVICE_REVIEW_DEFAULT_LIMIT))

    const overview = emptyCardServiceOverview(nowMs)
    try {
        overview.enabled = true

        const [operationRows, allocationRows, cardRows, stagedRows, driftRows] = await Promise.all([
            database.query<Record<string, unknown>>(
                `SELECT operation, state, COUNT(*) AS total
                    FROM ${CARD_SERVICE_OPERATIONS_TABLE}
                    GROUP BY operation, state`,
            ),
            database.query<Record<string, unknown>>(
                `SELECT state, COUNT(*) AS total FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} GROUP BY state`,
            ),
            database.query<Record<string, unknown>>(
                `SELECT state, COUNT(*) AS total FROM ${CARD_SERVICE_CARDS_TABLE} GROUP BY state`,
            ),
            database.query<Record<string, unknown>>(
                `SELECT COUNT(*) AS total FROM ${CARD_SERVICE_STAGED_CARDS_TABLE}`,
            ),
            database.query<Record<string, unknown>>(DRIFT_SQL),
        ])

        for (const row of operationRows) {
            const tally = tallyForOperation(overview.operations, toStringOrEmpty(row.operation))
            if (!tally) continue
            const count = toInteger(row.total)
            const state = toStringOrEmpty(row.state)
            tally.total += count
            if (state === 'pending') tally.pending += count
            else if (state === 'failed') tally.failed += count
            else if (state === 'abandoned') tally.abandoned += count
            else if (state === 'done') tally.done += count
        }

        for (const row of allocationRows) {
            const state = toStringOrEmpty(row.state) as CardServiceAllocationState
            if ((CARD_SERVICE_ALLOCATION_STATES as readonly string[]).includes(state)) {
                overview.allocations[state] = toInteger(row.total)
            }
        }

        for (const row of cardRows) {
            const count = toInteger(row.total)
            overview.cards.total += count
            const state = toStringOrEmpty(row.state)
            if (state === 'acknowledged') overview.cards.acknowledged += count
            else if (state === 'sold') overview.cards.sold += count
            else if (state === 'revoked') overview.cards.revoked += count
            else overview.cards.other += count
        }

        overview.stagedCards = toInteger(stagedRows[0]?.total)

        const expiring = await database.query<Record<string, unknown>>(EXPIRING_SELECT, [
            nowMs + expiringSoonMs,
            limit,
        ])
        overview.expiring = expiring.map((row) => mapExpiringRow(row, nowMs))
        overview.overdue = overview.expiring.filter((row) => row.remainingMs <= 0)

        const drift = driftRows[0]
        for (const metric of Object.keys(overview.drift) as Array<keyof CardServiceDrift>) {
            overview.drift[metric] = toInteger(drift?.[metric])
        }

        overview.reviewCount = countReviewItems(overview)
    } catch (error) {
        if (isMissingTableError(error)) return emptyCardServiceOverview(nowMs)
        throw error
    }

    return overview
}

function tallyForOperation(
    summary: CardServiceOperationSummary,
    operation: string,
): CardServiceOperationTally | null {
    if (operation === CARD_SERVICE_OPERATION_ACK) return summary.ack
    if (operation === CARD_SERVICE_OPERATION_SELL) return summary.sell
    if (operation === CARD_SERVICE_OPERATION_REVOKE) return summary.revoke
    return null
}

function mapExpiringRow(row: Record<string, unknown>, nowMs: number): ExpiringAllocationRow {
    const expiresAtMs = toInteger(row.expires_at)
    return {
        allocationId: toStringOrEmpty(row.allocation_id),
        productId: toStringOrEmpty(row.product_id),
        programKey: toStringOrEmpty(row.program_key),
        state: toStringOrEmpty(row.state),
        quantity: toInteger(row.quantity),
        expiresAtMs,
        remainingMs: expiresAtMs - nowMs,
        ackedAtMs: toIntegerOrNull(row.acked_at),
    }
}

/**
 * 需人工处置的项数。
 *
 * `sellableRemoteCards` 刻意不计入：那是**正常在售库存**，把它算成待办会让面板
 * 永远亮红灯，运维就再也看不见真正的异常了。
 */
function countReviewItems(overview: CardServiceOverview): number {
    const { ack, sell, revoke } = overview.operations
    const { drift } = overview
    return ack.failed + ack.abandoned
        + sell.failed + sell.abandoned
        + revoke.failed + revoke.abandoned
        + overview.overdue.length
        + drift.soldWithoutDeliveredOrder
        + drift.deliveredWithoutRemoteSold
        + drift.expiredWithSellableCards
        + drift.orphanMappings
        + drift.stagedWithoutActiveAllocation
}

// ---------------------------------------------------------------------------
// 复核清单
// ---------------------------------------------------------------------------

/** 需要人工看的明细：失败操作、超窗分配、孤立映射。 */
export async function listCardServiceReviewQueue(
    database: CardServiceDatabase,
    options: { now?: number; limit?: number } = {},
): Promise<CardServiceReviewQueue> {
    const nowMs = resolveNow(options)
    const limit = Math.max(1, Math.trunc(options.limit ?? CARD_SERVICE_REVIEW_DEFAULT_LIMIT))
    const empty: CardServiceReviewQueue = {
        enabled: false,
        failedOperations: [],
        staleAllocations: [],
        orphanMappings: [],
        truncated: false,
    }

    try {
        const [operationRows, allocationRows, mappingRows] = await Promise.all([
            database.query<Record<string, unknown>>(
                `SELECT operation_key, operation, resource_id, order_id, state, attempts,
                        next_retry_at, last_error_code, request_id
                    FROM ${CARD_SERVICE_OPERATIONS_TABLE}
                    WHERE state IN ('failed', 'abandoned')
                    ORDER BY updated_at ASC
                    LIMIT ?`,
                [limit],
            ),
            database.query<Record<string, unknown>>(
                `SELECT allocation_id, product_id, program_key, state, quantity, expires_at, acked_at
                    FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}
                    WHERE state = 'allocated' AND expires_at <= ?
                    ORDER BY expires_at ASC
                    LIMIT ?`,
                [nowMs, limit],
            ),
            database.query<Record<string, unknown>>(
                `SELECT m.local_card_id, m.remote_card_id, m.allocation_id, m.product_id,
                        m.order_id, m.state
                    FROM ${CARD_SERVICE_CARDS_TABLE} m
                    LEFT JOIN ${LOCAL_CARDS_TABLE} c ON c.id = m.local_card_id
                    WHERE c.id IS NULL
                    ORDER BY m.updated_at ASC
                    LIMIT ?`,
                [limit],
            ),
        ])

        return {
            enabled: true,
            failedOperations: operationRows.map((row) => ({
                operationKey: toStringOrEmpty(row.operation_key),
                operation: toStringOrEmpty(row.operation),
                resourceId: toStringOrEmpty(row.resource_id),
                orderId: toStringOrNull(row.order_id),
                state: toStringOrEmpty(row.state),
                attempts: toInteger(row.attempts),
                nextRetryAtMs: toIntegerOrNull(row.next_retry_at),
                lastErrorCode: toStringOrNull(row.last_error_code),
                requestId: toStringOrNull(row.request_id),
            })),
            staleAllocations: allocationRows.map((row) => mapExpiringRow(row, nowMs)),
            orphanMappings: mappingRows.map((row) => ({
                localCardId: toInteger(row.local_card_id),
                remoteCardId: toStringOrEmpty(row.remote_card_id),
                allocationId: toStringOrEmpty(row.allocation_id),
                productId: toStringOrEmpty(row.product_id),
                orderId: toStringOrNull(row.order_id),
                state: toStringOrEmpty(row.state),
            })),
            truncated: operationRows.length >= limit
                || allocationRows.length >= limit
                || mappingRows.length >= limit,
        }
    } catch (error) {
        if (isMissingTableError(error)) return empty
        throw error
    }
}

// ---------------------------------------------------------------------------
// 商品维度
// ---------------------------------------------------------------------------

/**
 * 已接入中心的商品逐行状态（Program 映射、目标库存、待办与耗尽告警）。
 *
 * 只列 `supply_mode = 'license_service'` 的配置行：`local` / `legacy_get` 商品的
 * 库存看现有商品页即可，把它们混进来只会让这页变成长列表。
 */
export async function listCardServiceProductStatus(
    database: CardServiceDatabase,
    options: { limit?: number } = {},
): Promise<CardServiceProductStatus[]> {
    const limit = Math.max(1, Math.trunc(options.limit ?? 200))
    try {
        const rows = await database.query<Record<string, unknown>>(
            `SELECT pc.product_id, p.name AS product_name, pc.supply_mode, pc.program_key, pc.target_stock,
                    (SELECT COALESCE(SUM(o.quantity), 0) FROM ${LOCAL_ORDERS_TABLE} o
                        WHERE o.product_id = pc.product_id
                          AND o.status IN ('paid', 'delivered')) AS sold_count,
                    (SELECT COUNT(*) FROM ${LOCAL_CARDS_TABLE} c
                        WHERE c.product_id = pc.product_id
                          AND (c.is_used = 0 OR c.is_used IS NULL)
                          AND c.reserved_order_id IS NULL) AS local_sellable,
                    (SELECT COUNT(*) FROM ${CARD_SERVICE_CARDS_TABLE} m
                        WHERE m.product_id = pc.product_id AND m.state = 'acknowledged') AS remote_sellable,
                    (SELECT COUNT(*) FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} a
                        WHERE a.product_id = pc.product_id AND a.state = 'allocated') AS in_flight,
                    (SELECT COUNT(*) FROM ${CARD_SERVICE_OPERATIONS_TABLE} o
                        JOIN ${CARD_SERVICE_ALLOCATIONS_TABLE} a ON a.allocation_id = o.resource_id
                        WHERE o.operation = '${CARD_SERVICE_OPERATION_ACK}'
                          AND o.state IN ('pending', 'failed')
                          AND a.product_id = pc.product_id) AS pending_ack,
                    (SELECT COUNT(*) FROM ${CARD_SERVICE_OPERATIONS_TABLE} o
                        JOIN ${CARD_SERVICE_ALLOCATIONS_TABLE} a ON a.allocation_id = o.resource_id
                        WHERE o.operation = '${CARD_SERVICE_OPERATION_SELL}'
                          AND o.state IN ('pending', 'failed')
                          AND a.product_id = pc.product_id) AS pending_sell,
                    (SELECT COUNT(*) FROM ${CARD_SERVICE_OPERATIONS_TABLE} o
                        JOIN ${CARD_SERVICE_CARDS_TABLE} m ON m.remote_card_id = o.resource_id
                        WHERE o.operation = '${CARD_SERVICE_OPERATION_REVOKE}'
                          AND o.state IN ('pending', 'failed')
                          AND m.product_id = pc.product_id) AS pending_revoke
                FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} pc
                LEFT JOIN ${LOCAL_PRODUCTS_TABLE} p ON p.id = pc.product_id
                WHERE pc.supply_mode = 'license_service'
                ORDER BY pc.product_id ASC
                LIMIT ?`,
            [limit],
        )

        return rows.map((row) => {
            const targetStock = toIntegerOrNull(row.target_stock)
            const localSellableCards = toInteger(row.local_sellable)
            const remoteSellableCards = toInteger(row.remote_sellable)
            return {
                productId: toStringOrEmpty(row.product_id),
                productName: toStringOrNull(row.product_name),
                soldCount: toInteger(row.sold_count),
                supplyMode: toStringOrEmpty(row.supply_mode) as CardServiceSupplyMode,
                programKey: toStringOrNull(row.program_key),
                targetStock,
                localSellableCards,
                remoteSellableCards,
                inFlightAllocations: toInteger(row.in_flight),
                pendingAck: toInteger(row.pending_ack),
                pendingSell: toInteger(row.pending_sell),
                pendingRevoke: toInteger(row.pending_revoke),
                stockExhausted: Boolean(targetStock && targetStock > 0)
                    && localSellableCards + remoteSellableCards === 0,
            }
        })
    } catch (error) {
        if (isMissingTableError(error)) return []
        throw error
    }
}
