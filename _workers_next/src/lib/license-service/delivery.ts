/**
 * 交付前的远端 Sell（接入方案阶段 D）。
 *
 * 不变式：**本地对用户展示的每一张远端卡，在中心必须已经 `sold`**。
 * 因此交付被拆成「先 Sell、后本地落库」两段，顺序不可颠倒：
 *
 *   1. `loadOrderRemoteSalePlan`：按订单的本地卡 ID 找出远端映射，判断这批卡
 *      能否交付、要 Sell 哪些批次。纯本地订单直接返回 `none` —— 既不触碰中心，
 *      也不触碰 `card_service_*` 表（升级项 `0038` 未执行时交付必须照常工作）。
 *   2. `executeOrderRemoteSales`：逐 Allocation 调用 Sell。幂等键固定为
 *      `sell:<allocation_id>:<order_id>`，请求体由**持久化映射**按
 *      `remote_card_id` 升序重建 —— 与阶段 C 的 Ack 同一个道理：重试时增删
 *      字段或改动顺序都会撞 `409 idempotency_conflict`。
 *   3. `buildDeliverOrderStatements`：全部 Sell 确认后才执行这**一个**原子批次
 *      （订单 → 本地卡 → 映射 → 台账）。订单行本身是栅栏：后续语句都以「本批次
 *      刚刚把该订单写成 `delivered`」为前置条件，因此 claim 丢失时不会出现
 *      「卡已置已用、订单却没交付」这种半成品。
 *
 * 为什么不能「先本地 delivered 再 Sell」：客户会先拿到一张中心无法核销的卡，
 * 事后无论怎么补偿，明文都已经出去了。Sell 只能消费 `acknowledged` 的批次
 * （`allocation.CanSell`），因此遇到 `allocated` 必须回到阶段 C 的补货/对账路径，
 * 绝不能在这里「顺手 Sell 一下」。
 *
 * 多张卡的 Sell 没有跨 Allocation 原子性：部分成功时保持不展示、保留原预留，
 * 由支付回调重试或 `listPendingSellOperations` 驱动的重放按**原订单**推进，
 * 不会把卡挪给别的订单。
 */

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
} from '../db/license-service-schema.ts'
import type { LicenseServiceClient } from './client.ts'
import { isMissingTableError, type CardServiceDatabase, type CardServiceStatement } from './db-port.ts'
import { toLicenseServiceError, type LicenseServiceError, type LicenseServiceErrorCategory } from './errors.ts'
import { buildSellIdempotencyKey } from './idempotency.ts'
import { runWithRetry, type RetryPolicy, type RunWithRetryOptions } from './retry.ts'
import { CARD_SERVICE_OPERATION_SELL } from './restock.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 无法（暂时或不）交付的原因。
 *
 * 前六项在计划阶段判定（本地账本/映射自身矛盾），后四项在调用中心之后判定。
 * 区分它们是为了让运维一眼看出「要回去补 Ack」还是「要人工核查」：
 * `allocation_not_acknowledged` 是**流程**问题，其余多数是**数据/权限**问题。
 */
export type OrderSaleBlockReason =
    /** 暂时不可交付（429/503/超时/网络）：**可以**原键重试，与其余项不同。 */
    | 'deferred'
    /** 订单的卡里既有远端映射卡又有普通本地卡：混合库存不允许交付。 */
    | 'mixed_inventory'
    /** 某个 Allocation 的卡没有整批归属于本单（Sell 要求整批同时售出）。 */
    | 'allocation_incomplete'
    /** 中心台账缺失，拿不到原 `external_ref`，构造不出与首次一致的 Sell 请求。 */
    | 'ledger_missing'
    /** 某个 Allocation 已在中心被售出给**另一笔**订单。 */
    | 'sold_to_another_order'
    /** 映射状态不是 `acknowledged`/`sold`（例如已作废），不能 Sell。 */
    | 'mapping_unusable'
    /** 前序 Ack 未完成：必须回到补货/对账路径，不能直接 Sell。 */
    | 'allocation_not_acknowledged'
    /** 中心侧已 `expired`/`cancelled`：卡密可能已回池，转人工补偿。 */
    | 'allocation_unusable'
    /** 中心返回 409 且真实状态无法归入以上任何一类。 */
    | 'conflict'
    /** 鉴权/Scope 不足（含 Program 未放行）：停止自动重试，转运维。 */
    | 'auth_error'
    /** 本地配置缺失（例如中心 Key 未配置）。 */
    | 'config_error'
    /** 其它不可重试的中心拒绝。 */
    | 'service_error'

export interface OrderRemoteSaleGroup {
    allocationId: string
    /**
     * 与 Allocate 时**完全一致**的 `external_ref`。
     *
     * 不能省略重发：服务的幂等记录绑定「path + 规范化请求体 hash」，
     * 首次带、重试不带就是 `409 idempotency_conflict`。
     */
    externalRef: string
    /** 该 Allocation 的**全部**远端卡 ID，按 `remote_card_id` 升序（确定性）。 */
    remoteCardIds: string[]
    /** 与 `remoteCardIds` 同序的本地卡 ID。 */
    localCardIds: number[]
    /** 中心已确认该批次售出（本单或本单的幂等重放）：无需再调 Sell。 */
    alreadySold: boolean
}

export type OrderRemoteSalePlan =
    /** 纯本地订单：没有任何远端映射，走既有本地交付。 */
    | { kind: 'none' }
    | { kind: 'remote'; groups: OrderRemoteSaleGroup[] }
    | { kind: 'blocked'; reason: OrderSaleBlockReason; allocationId: string | null; detail: string }

export type OrderSaleExecution =
    /** 全部批次已确认售出，可以进入本地交付批次。 */
    | { status: 'confirmed' }
    /** 暂时不可用（429/503/超时/网络）：保留预留，原键重试。 */
    | { status: 'deferred'; error: LicenseServiceError }
    /** 不可交付：转人工/补偿，不得展示明文。 */
    | {
        status: 'blocked'
        reason: OrderSaleBlockReason
        allocationId: string
        errorCode: string
        category: LicenseServiceErrorCategory | null
        error: LicenseServiceError | null
    }

/** 交付阶段抛出的错误：区分「可以重试」与「必须人工核查」。 */
export class OrderSaleError extends Error {
    readonly reason: OrderSaleBlockReason
    readonly allocationId: string | null
    readonly retryable: boolean
    readonly errorCode: string | null

    constructor(init: {
        reason: OrderSaleBlockReason
        allocationId?: string | null
        retryable?: boolean
        errorCode?: string | null
        detail?: string | null
    }) {
        super(`order sale ${init.reason}${init.allocationId ? ` (${init.allocationId})` : ''}${init.detail ? `: ${init.detail}` : ''}`)
        this.name = 'OrderSaleError'
        this.reason = init.reason
        this.allocationId = init.allocationId ?? null
        this.retryable = init.retryable === true
        this.errorCode = init.errorCode ?? null
    }
}

export interface OrderSaleDeps {
    client: Pick<LicenseServiceClient, 'sell' | 'getAllocation'>
    database: CardServiceDatabase
    now?: () => number
    policy?: Partial<RetryPolicy>
    sleep?: RunWithRetryOptions['sleep']
    random?: RunWithRetryOptions['random']
    onRetry?: RunWithRetryOptions['onRetry']
}

/**
 * 把「计划阶段就判定不可交付」折算成可抛出的错误。
 *
 * 调用方（履约路径）只需一个「抛出去 → 订单回落到 `paid` → 由回调/对账重试」
 * 的统一动作，不该在业务代码里再写一遍 switch。
 */
export function mapOrderSalePlanFailure(
    plan: Extract<OrderRemoteSalePlan, { kind: 'blocked' }>,
): OrderSaleError {
    return new OrderSaleError({
        reason: plan.reason,
        allocationId: plan.allocationId,
        // 计划阶段的判定来自本地持久化状态，重跑一次不会变；只有外部人工修正
        // 账本后才可能通过，因此不标记为可重试（避免回调被反复打）。
        retryable: false,
        detail: plan.detail,
    })
}

/** 把执行结论折算成可抛出的错误；`confirmed` 没有对应错误。 */
export function mapOrderSaleFailure(
    outcome: Exclude<OrderSaleExecution, { status: 'confirmed' }>,
): OrderSaleError {
    return new OrderSaleError({
        reason: outcome.status === 'deferred' ? 'deferred' : outcome.reason,
        allocationId: outcome.status === 'deferred' ? null : outcome.allocationId,
        retryable: outcome.status === 'deferred',
        errorCode: outcome.status === 'deferred' ? outcome.error.code : outcome.errorCode,
        detail: outcome.status === 'deferred'
            ? outcome.error.message
            : outcome.error?.message ?? null,
    })
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface OrderRemoteCardRow {
    localCardId: number
    remoteCardId: string
    allocationId: string
    state: string
    orderId: string
}

const MAPPING_COLUMNS = 'local_card_id, remote_card_id, allocation_id, state, order_id'

function toIntegerOrNull(value: unknown): number | null {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function toStringOrEmpty(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function toMappingRow(raw: Record<string, unknown>): OrderRemoteCardRow | null {
    const localCardId = toIntegerOrNull(raw.local_card_id)
    const allocationId = toStringOrEmpty(raw.allocation_id)
    const remoteCardId = toStringOrEmpty(raw.remote_card_id)
    if (localCardId === null || !allocationId || !remoteCardId) return null
    return {
        localCardId,
        remoteCardId,
        allocationId,
        state: toStringOrEmpty(raw.state),
        orderId: toStringOrEmpty(raw.order_id),
    }
}

function placeholders(count: number) {
    return Array.from({ length: count }, () => '?').join(', ')
}

/**
 * 读取这些本地卡对应的远端映射。
 *
 * `card_service_cards` 不存在（升级项未执行）时返回空数组：那种情况下不可能
 * 存在远端库存，交付流程按纯本地订单处理，不能因为读一张不存在的表而 500。
 */
export async function listOrderRemoteCardRows(
    database: CardServiceDatabase,
    localCardIds: readonly number[],
): Promise<OrderRemoteCardRow[]> {
    const ids = Array.from(new Set(localCardIds.filter((id) => Number.isSafeInteger(id))))
    if (!ids.length) return []

    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT ${MAPPING_COLUMNS} FROM ${CARD_SERVICE_CARDS_TABLE}
             WHERE local_card_id IN (${placeholders(ids.length)})
             ORDER BY allocation_id ASC, remote_card_id ASC`,
            ids,
        )
    } catch (error) {
        if (isMissingTableError(error)) return []
        throw error
    }

    return rows.map(toMappingRow).filter((row): row is OrderRemoteCardRow => row !== null)
}

interface AllocationLedgerRow {
    allocationId: string
    externalRef: string
    state: string
}

async function loadAllocationLedgers(
    database: CardServiceDatabase,
    allocationIds: readonly string[],
): Promise<Map<string, AllocationLedgerRow>> {
    const result = new Map<string, AllocationLedgerRow>()
    if (!allocationIds.length) return result

    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT allocation_id, external_ref, state FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}
             WHERE allocation_id IN (${placeholders(allocationIds.length)})`,
            allocationIds,
        )
    } catch (error) {
        if (isMissingTableError(error)) return result
        throw error
    }

    for (const raw of rows) {
        const allocationId = toStringOrEmpty(raw.allocation_id)
        if (!allocationId) continue
        result.set(allocationId, {
            allocationId,
            externalRef: toStringOrEmpty(raw.external_ref),
            state: toStringOrEmpty(raw.state),
        })
    }
    return result
}

/**
 * 判断订单要交付的这批本地卡能否走远端交付。
 *
 * 判定刻意严格：**任何矛盾都不能「尽力而为」地交付**。例如让一个只属于本单
 * 一半卡的 Allocation 通过，就会把另一半卡白送给中心（Sell 是整批语义）。
 */
export async function loadOrderRemoteSalePlan(
    database: CardServiceDatabase,
    input: { orderId: string; localCardIds: readonly number[] },
): Promise<OrderRemoteSalePlan> {
    const wanted = Array.from(new Set(input.localCardIds.filter((id) => Number.isSafeInteger(id))))
    if (!wanted.length) return { kind: 'none' }

    const rows = await listOrderRemoteCardRows(database, wanted)
    if (!rows.length) return { kind: 'none' }

    // 有映射的卡数少于要交付的卡数 ⇒ 既含远端卡又含普通本地卡。
    // 混合库存的「全有或全无」补偿规则没有定义，阶段 D 一律拒绝交付。
    if (rows.length !== wanted.length) {
        return {
            kind: 'blocked',
            reason: 'mixed_inventory',
            allocationId: null,
            detail: `${rows.length} of ${wanted.length} reserved cards are mapped to the card service`,
        }
    }

    const allocationIds = Array.from(new Set(rows.map((row) => row.allocationId)))
    const ledgers = await loadAllocationLedgers(database, allocationIds)

    const allRowsRaw = await database.query(
        `SELECT ${MAPPING_COLUMNS} FROM ${CARD_SERVICE_CARDS_TABLE}
         WHERE allocation_id IN (${placeholders(allocationIds.length)})
         ORDER BY allocation_id ASC, remote_card_id ASC`,
        allocationIds,
    )
    const allRows = allRowsRaw
        .map(toMappingRow)
        .filter((row): row is OrderRemoteCardRow => row !== null)

    const groups: OrderRemoteSaleGroup[] = []
    for (const allocationId of allocationIds) {
        const orderRows = rows.filter((row) => row.allocationId === allocationId)
        const allocationRows = allRows.filter((row) => row.allocationId === allocationId)

        const ledger = ledgers.get(allocationId)
        if (!ledger) {
            return {
                kind: 'blocked',
                reason: 'ledger_missing',
                allocationId,
                detail: 'allocation ledger row is missing',
            }
        }

        // Sell 是整批语义：该批次只要有卡不属于本单，就不能 Sell。
        if (allocationRows.length !== orderRows.length) {
            return {
                kind: 'blocked',
                reason: 'allocation_incomplete',
                allocationId,
                detail: `order holds ${orderRows.length} of ${allocationRows.length} cards in this allocation`,
            }
        }

        for (const row of allocationRows) {
            if (row.state === 'sold') {
                if (row.orderId && row.orderId !== input.orderId) {
                    return {
                        kind: 'blocked',
                        reason: 'sold_to_another_order',
                        allocationId,
                        detail: `remote card ${row.remoteCardId} was sold to order ${row.orderId}`,
                    }
                }
                continue
            }
            if (row.state === 'acknowledged') {
                // `order_id` 只在交付批次里与 `state='sold'` 同时写入。可售行带着
                // 订单号说明账本被外部改过，宁可拒绝交付也不要让一张有归属争议的
                // 卡进入交付。
                if (row.orderId) {
                    return {
                        kind: 'blocked',
                        reason: 'mapping_unusable',
                        allocationId,
                        detail: `remote card ${row.remoteCardId} is sellable but bound to order ${row.orderId}`,
                    }
                }
                continue
            }
            return {
                kind: 'blocked',
                reason: 'mapping_unusable',
                allocationId,
                detail: `mapping state is ${row.state || 'unknown'}`,
            }
        }

        if (ledger.state === 'allocated') {
            return {
                kind: 'blocked',
                reason: 'allocation_not_acknowledged',
                allocationId,
                detail: 'allocation is still allocated; the Ack step was never confirmed',
            }
        }
        if (ledger.state !== 'acknowledged' && ledger.state !== 'sold') {
            return {
                kind: 'blocked',
                reason: 'allocation_unusable',
                allocationId,
                detail: `allocation state is ${ledger.state || 'unknown'}`,
            }
        }

        groups.push({
            allocationId,
            externalRef: ledger.externalRef,
            remoteCardIds: allocationRows.map((row) => row.remoteCardId),
            localCardIds: allocationRows.map((row) => row.localCardId).sort((a, b) => a - b),
            alreadySold: allocationRows.every((row) => row.state === 'sold'),
        })
    }

    return { kind: 'remote', groups }
}

/** 列出待重放的 Sell 操作所属订单（供交付补偿入口使用）。 */
export async function listPendingSellOperations(
    database: CardServiceDatabase,
    options: { limit?: number } = {},
): Promise<Array<{ operationKey: string; allocationId: string; orderId: string | null; state: string; attempts: number }>> {
    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT operation_key, resource_id, order_id, state, attempts
             FROM ${CARD_SERVICE_OPERATIONS_TABLE}
             WHERE operation = ? AND state IN ('pending', 'failed')
             ORDER BY COALESCE(next_retry_at, 0) ASC, created_at ASC
             LIMIT ?`,
            [CARD_SERVICE_OPERATION_SELL, Math.max(1, Math.trunc(options.limit ?? 20))],
        )
    } catch (error) {
        if (isMissingTableError(error)) return []
        throw error
    }

    return rows
        .map((row) => ({
            operationKey: toStringOrEmpty(row.operation_key),
            allocationId: toStringOrEmpty(row.resource_id),
            orderId: toStringOrEmpty(row.order_id) || null,
            state: toStringOrEmpty(row.state),
            attempts: toIntegerOrNull(row.attempts) ?? 0,
        }))
        .filter((row) => row.operationKey && row.orderId)
}

// ---------------------------------------------------------------------------
// 语句构造
// ---------------------------------------------------------------------------

/**
 * 「订单刚刚在本批次里被写成 delivered」这一前置条件。
 *
 * 用它把批次内的后续语句钉在订单交付之上：claim 丢失（订单行没被更新）时，
 * 后面的本地卡/映射/台账更新全部落空，整批等价于没执行。
 */
const DELIVERED_FENCE = `EXISTS (SELECT 1 FROM orders WHERE order_id = ? AND status = 'delivered' AND delivered_at = ?)`

/** Sell 意图先落账：任何一次中心调用失败都必须留下可重放的记录。 */
export function buildSellIntentStatements(input: {
    orderId: string
    groups: ReadonlyArray<{ allocationId: string }>
    nowMs: number
}): CardServiceStatement[] {
    return input.groups.map((group) => ({
        // OR IGNORE：重放时保留既有行（可能已是 done/failed），不要把状态改回 pending。
        sql: `INSERT OR IGNORE INTO ${CARD_SERVICE_OPERATIONS_TABLE}
            (operation_key, operation, resource_id, order_id, state, attempts,
             next_retry_at, request_id, last_error_code, created_at, updated_at)
            VALUES (?, '${CARD_SERVICE_OPERATION_SELL}', ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
        params: [
            buildSellIdempotencyKey(group.allocationId, input.orderId),
            group.allocationId,
            input.orderId,
            input.nowMs,
            input.nowMs,
        ],
    }))
}

function buildSellOperationStateStatements(input: {
    orderId: string
    allocationId: string
    state: 'pending' | 'failed'
    errorCode: string
    requestId: string | null
    nextRetryAtMs: number | null
    nowMs: number
}): CardServiceStatement[] {
    return [{
        sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
            SET state = ?, attempts = attempts + 1, next_retry_at = ?,
                request_id = ?, last_error_code = ?, updated_at = ?
            WHERE operation_key = ?`,
        params: [
            input.state,
            input.nextRetryAtMs,
            input.requestId,
            input.errorCode,
            input.nowMs,
            buildSellIdempotencyKey(input.allocationId, input.orderId),
        ],
    }]
}

/** 可重试失败：保持待办可被重放，并记录下次重试时间。 */
export function buildSellDeferStatements(input: {
    orderId: string
    allocationId: string
    errorCode: string
    requestId: string | null
    nextRetryAtMs: number
    nowMs: number
}): CardServiceStatement[] {
    return buildSellOperationStateStatements({
        ...input,
        state: 'pending',
        nextRetryAtMs: input.nextRetryAtMs,
    })
}

/** 不可重试失败：待办置 `failed`，等待人工核查（不是「已完成」）。 */
export function buildSellFailStatements(input: {
    orderId: string
    allocationId: string
    errorCode: string
    requestId: string | null
    nowMs: number
}): CardServiceStatement[] {
    return buildSellOperationStateStatements({
        ...input,
        state: 'failed',
        nextRetryAtMs: null,
    })
}

export interface DeliverOrderStatementsInput {
    orderId: string
    claimId: string
    tradeNo: string
    /** 交付的明文，多张用 `\n` 连接。 */
    cardKey: string
    localCardIds: readonly number[]
    deliveryNote: string | null
    nowMs: number
    /**
     * 需要一并标记 `sold` 的远端批次（含 `alreadySold` 的）。
     * 为空数组时**不会引用任何 `card_service_*` 表** —— 升级项未执行时纯本地
     * 交付必须照常工作。
     */
    remoteGroups?: ReadonlyArray<{ allocationId: string; localCardIds: readonly number[] }>
}

/**
 * 交付批次：订单、本地卡、远端映射、操作台账一次性写入。
 *
 * 语句顺序即安全边界，不要调整：
 *   ① 订单行带全部前置条件（claim、本地卡仍在预留、映射状态可售），
 *      不满足就 0 行受影响；
 *   ② 之后的每条语句都带 `DELIVERED_FENCE`，因此只有 ① 真的生效才会写入。
 * 由于 D1 的 batch 是「整批提交、任一条失败全批回滚」，不存在中间态。
 */
export function buildDeliverOrderStatements(input: DeliverOrderStatementsInput): CardServiceStatement[] {
    const cardIds = input.localCardIds.map((id) => Math.trunc(id))
    const cardIdsValue = cardIds.join(',')
    const remoteGroups = input.remoteGroups ?? []

    const orderConditions = [
        `order_id = ?`,
        `status = 'processing'`,
        `fulfillment_claim_id = ?`,
        `(SELECT COUNT(*) FROM cards
           WHERE id IN (${placeholders(cardIds.length)})
             AND reserved_order_id = ?
             AND (is_used = 0 OR is_used IS NULL)) = ?`,
    ]
    const orderParams: unknown[] = [input.orderId, input.claimId]
    orderParams.push(...cardIds, input.orderId, cardIds.length)

    for (const group of remoteGroups) {
        const groupIds = group.localCardIds.map((id) => Math.trunc(id))
        orderConditions.push(
            `(SELECT COUNT(*) FROM ${CARD_SERVICE_CARDS_TABLE}
               WHERE allocation_id = ?
                 AND local_card_id IN (${placeholders(groupIds.length)})
                 AND ((state = 'acknowledged' AND order_id IS NULL)
                      OR (state = 'sold' AND order_id = ?))) = ?`,
        )
        orderParams.push(group.allocationId, ...groupIds, input.orderId, groupIds.length)
    }

    const statements: CardServiceStatement[] = [
        {
            sql: `UPDATE orders
                SET status = 'delivered',
                    paid_at = ?,
                    delivered_at = ?,
                    trade_no = ?,
                    card_key = ?,
                    card_ids = ?,
                    delivery_note = ?,
                    current_payment_id = NULL,
                    fulfillment_claim_id = NULL,
                    fulfillment_claimed_at = NULL
                WHERE ${orderConditions.join('\n                  AND ')}`,
            params: [
                input.nowMs,
                input.nowMs,
                input.tradeNo,
                input.cardKey,
                cardIdsValue,
                input.deliveryNote,
                ...orderParams,
            ],
        },
        {
            sql: `UPDATE cards
                SET is_used = 1, used_at = ?, reserved_order_id = NULL, reserved_at = NULL
                WHERE id IN (${placeholders(cardIds.length)})
                  AND reserved_order_id = ?
                  AND (is_used = 0 OR is_used IS NULL)
                  AND ${DELIVERED_FENCE}`,
            params: [input.nowMs, ...cardIds, input.orderId, input.orderId, input.nowMs],
        },
    ]

    for (const group of remoteGroups) {
        const groupIds = group.localCardIds.map((id) => Math.trunc(id))
        statements.push(
            {
                sql: `UPDATE ${CARD_SERVICE_CARDS_TABLE}
                    SET state = 'sold', order_id = ?, sold_at = ?, updated_at = ?
                    WHERE allocation_id = ?
                      AND local_card_id IN (${placeholders(groupIds.length)})
                      AND state = 'acknowledged'
                      AND ${DELIVERED_FENCE}`,
                params: [input.orderId, input.nowMs, input.nowMs, group.allocationId, ...groupIds, input.orderId, input.nowMs],
            },
            {
                sql: `UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE}
                    SET state = 'sold', sold_at = ?, last_error_code = NULL, updated_at = ?
                    WHERE allocation_id = ?
                      AND state = 'acknowledged'
                      AND ${DELIVERED_FENCE}`,
                params: [input.nowMs, input.nowMs, group.allocationId, input.orderId, input.nowMs],
            },
            {
                sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                    SET state = 'done', attempts = attempts + 1, next_retry_at = NULL,
                        request_id = NULL, last_error_code = NULL, updated_at = ?
                    WHERE operation_key = ?
                      AND ${DELIVERED_FENCE}`,
                params: [input.nowMs, buildSellIdempotencyKey(group.allocationId, input.orderId), input.orderId, input.nowMs],
            },
        )
    }

    return statements
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function resolveNow(deps: OrderSaleDeps) {
    return deps.now ?? (() => Date.now())
}

function retryOptions(deps: OrderSaleDeps): RunWithRetryOptions {
    return {
        operation: 'sell',
        policy: deps.policy,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        onRetry: deps.onRetry,
    }
}

function blockedFromError(
    error: LicenseServiceError,
    allocationId: string,
    fallbackReason: OrderSaleBlockReason,
): OrderSaleExecution {
    return {
        status: 'blocked',
        reason: fallbackReason,
        allocationId,
        errorCode: error.code,
        category: error.category,
        error,
    }
}

/**
 * 逐批次调用 Sell。串行执行：一旦某批次失败就立即停手并记录，不继续推进后续
 * 批次 —— 交付是「全有或全无」，多卖一批只会扩大需要补偿的范围。
 */
export async function executeOrderRemoteSales(
    deps: OrderSaleDeps,
    input: { orderId: string; groups: readonly OrderRemoteSaleGroup[] },
): Promise<OrderSaleExecution> {
    const pending = input.groups.filter((group) => !group.alreadySold)
    if (!pending.length) return { status: 'confirmed' }

    const now = resolveNow(deps)
    await deps.database.write(buildSellIntentStatements({
        orderId: input.orderId,
        groups: pending,
        nowMs: now(),
    }))

    for (const group of pending) {
        try {
            await runWithRetry(
                () => deps.client.sell({
                    allocationId: group.allocationId,
                    cardIds: group.remoteCardIds,
                    ...(group.externalRef ? { externalRef: group.externalRef } : {}),
                    idempotencyKey: buildSellIdempotencyKey(group.allocationId, input.orderId),
                }),
                retryOptions(deps),
            )
        } catch (error) {
            const classified = toLicenseServiceError(error, 'sell')

            if (classified.category === 'conflict') {
                // 409 一律不重试（`retry.ts` 已保证）。用**查询接口**核对真实状态：
                // 重放响应会原样返回首次结果，只有单查能反映分配的真实现状。
                const probe = await probeRemoteAllocationStatus(deps, group.allocationId)
                if (!probe.ok) {
                    const deferred = probe.error
                    await deps.database.write(buildSellDeferStatements({
                        orderId: input.orderId,
                        allocationId: group.allocationId,
                        errorCode: deferred.code,
                        requestId: deferred.requestId,
                        nextRetryAtMs: now() + (deferred.retryAfterMs ?? 0),
                        nowMs: now(),
                    }))
                    return { status: 'deferred', error: deferred }
                }

                const remoteStatus = probe.status
                if (remoteStatus === 'sold') {
                    // 响应丢失后的原键重放被拒（例如幂等记录已过期），但远端确实
                    // 已为本单售出：按方案 §4 继续本单交付，不再向另一订单分配。
                    continue
                }

                const reason: OrderSaleBlockReason = remoteStatus === 'allocated'
                    ? 'allocation_not_acknowledged'
                    : remoteStatus === 'expired' || remoteStatus === 'cancelled'
                        ? 'allocation_unusable'
                        : 'conflict'

                await deps.database.write(buildSellFailStatements({
                    orderId: input.orderId,
                    allocationId: group.allocationId,
                    errorCode: classified.code,
                    requestId: classified.requestId,
                    nowMs: now(),
                }))
                return blockedFromError(classified, group.allocationId, reason)
            }

            if (classified.category === 'unavailable') {
                await deps.database.write(buildSellDeferStatements({
                    orderId: input.orderId,
                    allocationId: group.allocationId,
                    errorCode: classified.code,
                    requestId: classified.requestId,
                    nextRetryAtMs: now() + (classified.retryAfterMs ?? 0),
                    nowMs: now(),
                }))
                return { status: 'deferred', error: classified }
            }

            await deps.database.write(buildSellFailStatements({
                orderId: input.orderId,
                allocationId: group.allocationId,
                errorCode: classified.code,
                requestId: classified.requestId,
                nowMs: now(),
            }))

            const reason: OrderSaleBlockReason = classified.category === 'auth'
                ? 'auth_error'
                : classified.category === 'config'
                    ? 'config_error'
                    : classified.category === 'expired'
                        ? 'allocation_unusable'
                        : 'service_error'
            return blockedFromError(classified, group.allocationId, reason)
        }
    }

    return { status: 'confirmed' }
}

type RemoteStatusProbe =
    | { ok: true; status: string }
    | { ok: false; error: LicenseServiceError }

async function probeRemoteAllocationStatus(
    deps: OrderSaleDeps,
    allocationId: string,
): Promise<RemoteStatusProbe> {
    try {
        const detail = await runWithRetry(
            () => deps.client.getAllocation(allocationId),
            { ...retryOptions(deps), operation: 'getAllocation' },
        )
        return { ok: true, status: detail.status }
    } catch (error) {
        const classified = toLicenseServiceError(error, 'getAllocation')
        if (classified.category === 'unavailable') return { ok: false, error: classified }
        // 查不到（not_found）等确定性失败：无法确认远端状态，按 409 处理。
        return { ok: true, status: 'unknown' }
    }
}
