/**
 * 补货适配器与持久化确认（接入方案阶段 C）。
 *
 * 目标闭环：`Allocate → 不可售暂存 → Ack → 搬进 cards`，全程只有一个方向
 * 允许出现「半成品」——**永远不能出现「已可售但中心未确认」的卡**。
 *
 * 因此流程被拆成三段，每段都有明确的失败代价：
 *
 *   1. `Allocate`（无本地写入）
 *      失败就什么都没有，返回错误即可，重试由下一轮补货重新生成任务。
 *      Worker 在响应途中挂掉会让这笔 Allocation 悬在中心，30 分钟后由中心的
 *      `card-worker` 回收；本地没有副本，不存在脏数据。
 *   2. 原子批次 A：写分配台账 + 卡密进 `card_service_staged_cards`（**不可售**）
 *      + 写 `ack` 待办。此后即使进程被杀，重启后也能凭台账重放。
 *   3. `Ack` 成功后，原子批次 B 才把卡搬进 `cards` 并建立远端映射。
 *      批次 B 带 `WHERE EXISTS(staged)` 守卫，重复执行不会插入第二张卡。
 *
 * 超窗（`409 allocation_expired`）是硬约束而非可选项：中心已把卡密放回可分配池，
 * 本地暂存必须**删除**（不是标记），并换新 `task_id` 重新补货 —— `external_ref`
 * 在中心终身唯一，复用旧值只会拿到 `409 allocation_conflict`。
 *
 * 幂等键与请求体的稳定性由「Ack 体一律从持久化记录按确定顺序重建」保证：
 * 首次尝试与任意次重放的 `received_card_ids` 顺序、`external_ref` 完全一致，
 * 不会因为内存里的响应顺序不同而撞上 `409 idempotency_conflict`。
 */

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
    CARD_SERVICE_STAGED_CARDS_TABLE,
} from '../db/license-service-schema.ts'
import type { LicenseServiceClient } from './client.ts'
import { LicenseServiceError, toLicenseServiceError, type LicenseServiceErrorCategory } from './errors.ts'
import {
    buildAckIdempotencyKey,
    buildAllocateIdempotencyKey,
    buildRestockExternalRef,
    buildRestockTaskId,
} from './idempotency.ts'
import type { CardServiceDatabase, CardServiceStatement } from './db-port.ts'
import { loadCardServiceProductConfig, loadProductSupplyGuard } from './product-config.ts'
import {
    CARD_SERVICE_OPERATION_QUEUE_ORDER_SQL,
    CARD_SERVICE_RETRY_BACKOFF_FILTER_SQL,
    buildOperationFailureClauses,
} from './operation-queue.ts'
import { runWithRetry, type RetryPolicy, type RunWithRetryOptions } from './retry.ts'

/** `card_service_operations.state` 取值。 */
export const CARD_SERVICE_OPERATION_STATES = ['pending', 'done', 'failed', 'abandoned'] as const
export type CardServiceOperationState = (typeof CARD_SERVICE_OPERATION_STATES)[number]

export const CARD_SERVICE_OPERATION_ACK = 'ack'
export const CARD_SERVICE_OPERATION_SELL = 'sell'
export const CARD_SERVICE_OPERATION_REVOKE = 'revoke'
export const CARD_SERVICE_OPERATION_NAMES = [
    CARD_SERVICE_OPERATION_ACK,
    CARD_SERVICE_OPERATION_SELL,
    CARD_SERVICE_OPERATION_REVOKE,
] as const

/**
 * Ack 重试的安全边界：剩余窗口小于该值时不再重试，直接放弃本地副本。
 *
 * 依据：单次 Ack 调用的重试总预算（`retry.ts` 默认 10s）必须显著小于剩余窗口，
 * 否则会出现「重试刚发出去、窗口就过了」的必输局，既浪费配额也让中心多做一次
 * 回收。60s 给的是两次完整重试预算还有余量。
 */
export const ACK_RETRY_SAFETY_MARGIN_MS = 60_000

export interface RestockDeps {
    client: LicenseServiceClient
    database: CardServiceDatabase
    now?: () => number
    randomUUID?: () => string
    policy?: Partial<RetryPolicy>
    sleep?: RunWithRetryOptions['sleep']
    random?: RunWithRetryOptions['random']
    onRetry?: RunWithRetryOptions['onRetry']
}

/**
 * 冻结的补货意图。
 *
 * 一旦生成就不再变化：`external_ref` 与两个幂等键都从它派生，任何「重试时
 * 顺手改个字段」的写法都会撞 `409 idempotency_conflict`。任务作废后必须换新
 * 意图（新 `task_id`），不能复用。
 */
export interface RestockIntent {
    taskId: string
    productId: string
    programKey: string
    quantity: number
    reason: string
    externalRef: string
    allocateIdempotencyKey: string
    ackIdempotencyKey: string
}

export function createRestockIntent(input: {
    productId: string
    programKey: string
    quantity: number
    reason: string
    taskId?: string
}): RestockIntent {
    const taskId = input.taskId ?? buildRestockTaskId()
    return Object.freeze({
        taskId,
        productId: input.productId,
        programKey: input.programKey,
        quantity: input.quantity,
        reason: input.reason,
        externalRef: buildRestockExternalRef(taskId),
        allocateIdempotencyKey: buildAllocateIdempotencyKey(taskId),
        ackIdempotencyKey: buildAckIdempotencyKey(taskId),
    })
}

export interface CardServiceAllocationRow {
    allocationId: string
    productId: string
    programKey: string
    externalRef: string
    quantity: number
    state: string
    requestKey: string
    ackKey: string
    expiresAtMs: number
    ackedAtMs: number | null
}

export type RestockSkipReason =
    /** 没有配置行，或配置表尚未建立（阶段 B 的 0038 未执行）：该商品未接入。 */
    | 'not_configured'
    | 'supply_mode_not_license_service'
    | 'program_key_missing'
    /**
     * 商品已被删除，但供应配置行还在（历史遗留、或「先删商品再删配置」的时序）。
     * 从这里继续领卡会 Allocate / Ack 出一批**永远物化不了**的远端卡（本地
     * `cards` 外键失败），而且会持续消耗中心库存。
     */
    | 'product_not_found'
    /**
     * 共享卡商品：它的交付方式是「把一张本地卡明文当交付引用发出去」，**绕过 Sell**。
     * 让它从中心领卡等于「卡领出来、明文发出去、中心永远显示未售出」。
     */
    | 'shared_product'

export type RestockResult =
    | {
        status: 'restocked'
        taskId: string
        allocationId: string
        remoteCardIds: string[]
        localCardIds: number[]
        expiresAtMs: number
    }
    | { status: 'skipped'; reason: RestockSkipReason }
    /**
     * 已领卡但尚未确认/尚未搬进可售库存，本地保留暂存与待办，稍后重放。
     * `nextRetryAtMs` 为 `null` 表示由调用方自行决定节奏（例如放进队列）。
     */
    | {
        status: 'deferred'
        taskId: string
        allocationId: string
        errorCode: string
        category: LicenseServiceErrorCategory
        nextRetryAtMs: number | null
    }
    /**
     * 中心 Ack 窗口已过：卡密已回池，本地副本已作废。
     * `requiresNewTask` 恒为 `true` —— 必须换新 `task_id` 才能再领。
     */
    | {
        status: 'expired'
        taskId: string
        allocationId: string
        errorCode: string
        requiresNewTask: true
    }
    | {
        status: 'failed'
        taskId: string | null
        allocationId: string | null
        errorCode: string
        category: LicenseServiceErrorCategory
        message: string
    }

export type AckAndMaterializeOutcome =
    | {
        status: 'acknowledged'
        allocationId: string
        remoteCardIds: string[]
        localCardIds: number[]
        /**
         * 物化批次已提交，但随后读取本地卡 ID 失败。卡已经在可售池，
         * 调用方仍应按成功记账；ID 列表为空只表示这一次没读回来。
         */
        readbackFailed?: boolean
        error?: LicenseServiceError
    }
    | { status: 'expired'; allocationId: string; errorCode: string }
    | { status: 'deferred'; allocationId: string; error: LicenseServiceError }
    | { status: 'failed'; allocationId: string; error: LicenseServiceError; keepStaged: true }

function resolveNow(deps: RestockDeps) {
    return deps.now ?? (() => Date.now())
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function toStringOrEmpty(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function toIntegerOrNull(value: unknown): number | null {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

const ALLOCATION_COLUMNS = 'allocation_id, product_id, program_key, external_ref, quantity, state, request_key, ack_key, expires_at, acked_at'

function toAllocationRow(raw: Record<string, unknown>): CardServiceAllocationRow | null {
    const allocationId = toStringOrEmpty(raw.allocation_id)
    if (!allocationId) return null
    return {
        allocationId,
        productId: toStringOrEmpty(raw.product_id),
        programKey: toStringOrEmpty(raw.program_key),
        externalRef: toStringOrEmpty(raw.external_ref),
        quantity: toIntegerOrNull(raw.quantity) ?? 0,
        state: toStringOrEmpty(raw.state),
        requestKey: toStringOrEmpty(raw.request_key),
        ackKey: toStringOrEmpty(raw.ack_key),
        expiresAtMs: toIntegerOrNull(raw.expires_at) ?? 0,
        ackedAtMs: toIntegerOrNull(raw.acked_at),
    }
}

export async function loadCardServiceAllocation(
    database: CardServiceDatabase,
    allocationId: string,
): Promise<CardServiceAllocationRow | null> {
    const rows = await database.query(
        `SELECT ${ALLOCATION_COLUMNS} FROM ${CARD_SERVICE_ALLOCATIONS_TABLE} WHERE allocation_id = ? LIMIT 1`,
        [allocationId],
    )
    return rows.length ? toAllocationRow(rows[0]) : null
}

/**
 * 读取某笔分配下**按确定顺序**排列的远端卡 ID。
 *
 * 顺序必须是确定性的：服务端用「path + 规范化请求体 hash」绑定幂等键，
 * 若首次 Ack 与重试用不同顺序提交同一批卡，就会被判成 `idempotency_conflict`。
 */
export async function listStagedCardIds(
    database: CardServiceDatabase,
    allocationId: string,
): Promise<string[]> {
    const rows = await database.query(
        `SELECT remote_card_id FROM ${CARD_SERVICE_STAGED_CARDS_TABLE} WHERE allocation_id = ? ORDER BY remote_card_id ASC`,
        [allocationId],
    )
    return rows.map((row) => toStringOrEmpty(row.remote_card_id)).filter(Boolean)
}

export async function listLocalCardIds(
    database: CardServiceDatabase,
    allocationId: string,
): Promise<number[]> {
    const rows = await database.query(
        `SELECT local_card_id FROM ${CARD_SERVICE_CARDS_TABLE} WHERE allocation_id = ? ORDER BY local_card_id ASC`,
        [allocationId],
    )
    return rows.map((row) => toIntegerOrNull(row.local_card_id)).filter((id): id is number => id !== null)
}

/** 列出超过 Ack 窗口仍未确认的分配（本地记录 `expires_at` 才能做这件事）。 */
export async function listStaleAllocatedAllocations(
    database: CardServiceDatabase,
    options: { deadLineMs: number; limit?: number; excludeAllocationIds?: readonly string[] },
): Promise<CardServiceAllocationRow[]> {
    const excluded = new Set((options.excludeAllocationIds ?? []).filter(Boolean))
    const limit = Math.max(1, Math.trunc(options.limit ?? 20))
    // 不把排除列表拼进 IN：单条语句绑定参数上限是 100，而本段上限本身只有几十。
    // 多取「上限 + 已排除」行，再在内存里丢掉本轮已经查过的 allocation。
    const rows = await database.query(
        `SELECT ${ALLOCATION_COLUMNS} FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}
         WHERE state = 'allocated' AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT ?`,
        [options.deadLineMs, limit + excluded.size],
    )
    const collected: CardServiceAllocationRow[] = []
    for (const row of rows.map(toAllocationRow)) {
        if (!row || excluded.has(row.allocationId) || collected.length >= limit) continue
        collected.push(row)
    }
    return collected
}

export interface PendingOperationRow {
    operationKey: string
    operation: string
    resourceId: string
    orderId: string | null
    state: string
    attempts: number
}

/** 列出待重放的操作（`pending` / `failed`），对账时按写入顺序推进。 */
export async function listPendingCardServiceOperations(
    database: CardServiceDatabase,
    options: { operation?: string; limit?: number; respectBackoff?: boolean; nowMs?: number } = {},
): Promise<PendingOperationRow[]> {
    const statements: string[] = [
        `SELECT operation_key, operation, resource_id, order_id, state, attempts
         FROM ${CARD_SERVICE_OPERATIONS_TABLE}
         WHERE state IN ('pending', 'failed')`,
    ]
    const params: unknown[] = []
    if (options.operation) {
        statements.push('AND operation = ?')
        params.push(options.operation)
    }
    // 定时重放要遵守退避；人工重试（面板「重试」）传 `respectBackoff: false` 跳过它。
    if (options.respectBackoff) {
        statements.push(CARD_SERVICE_RETRY_BACKOFF_FILTER_SQL)
        params.push(options.nowMs ?? Date.now())
    }
    // 排序片段与 sell / revoke 两处共用：死信（`failed`）必须排在 `pending` 之后，
    // 否则它会恒定占据队首、把 LIMIT 吃光（见 `operation-queue.ts`）。
    statements.push(`${CARD_SERVICE_OPERATION_QUEUE_ORDER_SQL} LIMIT ?`)
    params.push(Math.max(1, Math.trunc(options.limit ?? 20)))

    const rows = await database.query(statements.join(' '), params)
    return rows.map((row) => ({
        operationKey: toStringOrEmpty(row.operation_key),
        operation: toStringOrEmpty(row.operation),
        resourceId: toStringOrEmpty(row.resource_id),
        orderId: toStringOrEmpty(row.order_id) || null,
        state: toStringOrEmpty(row.state),
        attempts: toIntegerOrNull(row.attempts) ?? 0,
    })).filter((row) => row.operationKey)
}

// ---------------------------------------------------------------------------
// 语句构造：集中在一处，保证「台账 / 暂存 / 映射 / 待办」四张表写法一致
// ---------------------------------------------------------------------------

export function buildInsertAllocationStatements(
    intent: RestockIntent,
    allocation: { allocationId: string; expiresAtMs: number },
    nowMs: number,
): CardServiceStatement[] {
    return [{
        // 唯一索引 card_service_allocations_external_ref_uq 会把「同一任务重复
        // 领卡」钉在数据库层：任何重入都会以约束失败告终，而不是悄悄领两批。
        sql: `INSERT INTO ${CARD_SERVICE_ALLOCATIONS_TABLE}
            (allocation_id, product_id, program_key, external_ref, quantity, state,
             request_key, ack_key, expires_at, acked_at, sold_at, last_error_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'allocated', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        params: [
            allocation.allocationId,
            intent.productId,
            intent.programKey,
            intent.externalRef,
            intent.quantity,
            intent.allocateIdempotencyKey,
            intent.ackIdempotencyKey,
            allocation.expiresAtMs,
            nowMs,
            nowMs,
        ],
    }]
}

export function buildInsertStagedCardStatements(
    intent: RestockIntent,
    allocationId: string,
    cards: ReadonlyArray<{ id: string; key: string; maskedKey: string | null }>,
    nowMs: number,
): CardServiceStatement[] {
    return cards.map((card) => ({
        sql: `INSERT INTO ${CARD_SERVICE_STAGED_CARDS_TABLE}
            (remote_card_id, allocation_id, product_id, card_key, masked_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        params: [card.id, allocationId, intent.productId, card.key, card.maskedKey, nowMs],
    }))
}

export function buildInsertAckOperationStatement(input: {
    operationKey: string
    allocationId: string
    nowMs: number
}): CardServiceStatement {
    return {
        sql: `INSERT INTO ${CARD_SERVICE_OPERATIONS_TABLE}
            (operation_key, operation, resource_id, order_id, state, attempts,
             next_retry_at, request_id, last_error_code, created_at, updated_at)
            VALUES (?, '${CARD_SERVICE_OPERATION_ACK}', ?, NULL, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
        params: [input.operationKey, input.allocationId, input.nowMs, input.nowMs],
    }
}

/**
 * 物化批次：把已确认的暂存卡搬进可售 `cards` 并建立远端映射。
 *
 * 两条 `INSERT` 都从暂存表取行，因此整批重复执行天然幂等：暂存在批次末尾被
 * 删除，第二次执行两边都插不进任何东西，不会出现「重放后多出一张卡」。
 *
 * **必须先建映射、再按映射插卡**，不能反过来。原因是要把新卡 ID 写进同一
 * 批次的映射行，而 D1 批次内没有可跨语句引用的自增结果；只能显式分配 ID。
 * 而 `(SELECT MAX(id) FROM cards)` 是**非相关子查询**，一条 `INSERT ... SELECT`
 * 里只会求值一次 —— 若先插 `cards`、再用 `MAX(id)` 回填映射，多张卡会被赋成
 * 同一个 ID 而撞主键（单张时看不出问题，正是「只补一张」的默认路径掩盖了它）。
 * 因此顺序是：映射侧用 `MAX(id) + ROW_NUMBER()` 一次算完整段连续 ID，
 * 卡侧再按这份映射把 `id` 显式写进 `cards`。
 *
 * ID 的计算与插入同处一个 D1 batch 事务，不存在「先在 JavaScript 里读出
 * MAX、事务外等待、再插卡」的窗口，其他普通写入不能在该写事务内部插队。
 * 真实约束错误、历史脏数据或存储异常仍会使整批回滚；那种失败保留暂存与
 * 原 Ack 待办，由对账用原 allocation / ack key 重放，不换新任务、不新领卡。
 */
export function buildMaterializeStatements(input: {
    allocationId: string
    productId: string
    ackOperationKey: string
    nowMs: number
}): CardServiceStatement[] {
    const { allocationId, productId, ackOperationKey, nowMs } = input
    return [
        {
            sql: `INSERT INTO ${CARD_SERVICE_CARDS_TABLE}
                (local_card_id, remote_card_id, allocation_id, product_id, order_id, state,
                 sold_at, revoked_at, created_at, updated_at)
                SELECT (SELECT COALESCE(MAX(id), 0) FROM cards)
                       + ROW_NUMBER() OVER (ORDER BY remote_card_id ASC),
                       remote_card_id, allocation_id, ?, NULL, 'acknowledged', NULL, NULL, ?, ?
                FROM ${CARD_SERVICE_STAGED_CARDS_TABLE}
                WHERE allocation_id = ?
                ORDER BY remote_card_id ASC`,
            params: [productId, nowMs, nowMs, allocationId],
        },
        {
            sql: `INSERT INTO cards (id, product_id, card_key, is_used, created_at)
                SELECT mapping.local_card_id, mapping.product_id, staged.card_key, 0, ?
                FROM ${CARD_SERVICE_CARDS_TABLE} mapping
                JOIN ${CARD_SERVICE_STAGED_CARDS_TABLE} staged
                  ON staged.remote_card_id = mapping.remote_card_id
                WHERE mapping.allocation_id = ?
                ORDER BY mapping.local_card_id ASC`,
            params: [nowMs, allocationId],
        },
        {
            sql: `DELETE FROM ${CARD_SERVICE_STAGED_CARDS_TABLE} WHERE allocation_id = ?`,
            params: [allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE}
                SET state = 'acknowledged', acked_at = ?, last_error_code = NULL, updated_at = ?
                WHERE allocation_id = ? AND COALESCE(last_error_code, '') <> 'manually_discarded'`,
            params: [nowMs, nowMs, allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                SET state = 'done', attempts = attempts + 1, next_retry_at = NULL,
                    request_id = NULL, last_error_code = NULL, updated_at = ?
                WHERE operation_key = ?`,
            params: [nowMs, ackOperationKey],
        },
    ]
}

/** 超窗作废：删除不可售暂存、标记分配终态、放弃 Ack 待办。 */
export function buildDiscardAllocationStatements(input: {
    allocationId: string
    ackOperationKey: string
    errorCode: string
    nowMs: number
    /** `expired`（超窗被回收）或 `cancelled`（远程已取消/不存在）。 */
    state?: 'expired' | 'cancelled'
}): CardServiceStatement[] {
    const { allocationId, ackOperationKey, errorCode, nowMs } = input
    const state = input.state ?? 'expired'
    return [
        {
            sql: `DELETE FROM ${CARD_SERVICE_STAGED_CARDS_TABLE} WHERE allocation_id = ?`,
            params: [allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE}
                SET state = ?, last_error_code = ?, updated_at = ?
                WHERE allocation_id = ? AND COALESCE(last_error_code, '') <> 'manually_discarded'`,
            params: [state, errorCode, nowMs, allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                SET state = 'abandoned', attempts = attempts + 1, next_retry_at = NULL,
                    last_error_code = ?, updated_at = ?
                WHERE operation_key = ?`,
            params: [errorCode, nowMs, ackOperationKey],
        },
    ]
}

/**
 * 可重试失败：保留暂存与待办，记录下次重试时间。
 *
 * `nextRetryAtMs` 省略时按操作队列的指数退避计算（与不可重试失败共用
 * `attempts` 口径）。显式传入仍优先，供远端 `Retry-After` 使用。
 */
export function buildDeferAckStatements(input: {
    allocationId: string
    ackOperationKey: string
    errorCode: string
    requestId: string | null
    nextRetryAtMs?: number | null
    nowMs: number
}): CardServiceStatement[] {
    const failure = buildOperationFailureClauses(input.nowMs)
    const nextRetryAt = input.nextRetryAtMs == null ? failure.nextRetryAt : '?'
    const params: unknown[] = []
    if (input.nextRetryAtMs != null) params.push(input.nextRetryAtMs)
    params.push(input.requestId, input.errorCode, input.nowMs, input.ackOperationKey)
    return [
        {
            sql: `UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE}
                SET last_error_code = ?, updated_at = ?
                WHERE allocation_id = ? AND COALESCE(last_error_code, '') <> 'manually_discarded'`,
            params: [input.errorCode, input.nowMs, input.allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                SET state = 'pending', attempts = attempts + 1, next_retry_at = ${nextRetryAt},
                    request_id = ?, last_error_code = ?, updated_at = ?
                WHERE operation_key = ?`,
            params,
        },
    ]
}

/**
 * 不可重试、又不属于超窗的失败：标记待办为 `failed`，**保留暂存**。
 *
 * 刻意不删暂存：远程此刻可能仍持有这批卡（例如响应丢失、Ack 被判
 * `allocation_conflict` 而真实状态其实是 `acknowledged`）。删除等于把库存
 * 白送给中心，必须由对账用 `GET /allocations/{id}` 核实真实状态后再决定。
 */
export function buildFailAckStatements(input: {
    allocationId: string
    ackOperationKey: string
    errorCode: string
    requestId: string | null
    nowMs: number
}): CardServiceStatement[] {
    const failure = buildOperationFailureClauses(input.nowMs)
    return [
        {
            sql: `UPDATE ${CARD_SERVICE_ALLOCATIONS_TABLE}
                SET last_error_code = ?, updated_at = ?
                WHERE allocation_id = ? AND COALESCE(last_error_code, '') <> 'manually_discarded'`,
            params: [input.errorCode, input.nowMs, input.allocationId],
        },
        {
            sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                SET state = ${failure.state}, attempts = attempts + 1, next_retry_at = ${failure.nextRetryAt},
                    request_id = ?, last_error_code = ?, updated_at = ?
                WHERE operation_key = ?`,
            params: [input.requestId, input.errorCode, input.nowMs, input.ackOperationKey],
        },
    ]
}

// ---------------------------------------------------------------------------
// 确认与物化（补货与对账共用）
// ---------------------------------------------------------------------------

function retryOptions(deps: RestockDeps, operation: string): RunWithRetryOptions {
    return {
        operation,
        policy: deps.policy,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        onRetry: deps.onRetry,
    }
}

/**
 * 对已知分配执行 `Ack → 物化`。补货主流程与对账重放都走这里，
 * 保证两条路径的请求体、幂等键与本地写入完全一致。
 */
export async function ackAndMaterializeAllocation(
    deps: RestockDeps,
    row: CardServiceAllocationRow,
): Promise<AckAndMaterializeOutcome> {
    const now = resolveNow(deps)
    const remoteCardIds = await listStagedCardIds(deps.database, row.allocationId)

    if (remoteCardIds.length === 0) {
        // 已经物化过（批次 B 成功），或暂存丢失。前者是幂等重放，直接返回现状。
        const existing = await listLocalCardIds(deps.database, row.allocationId)
        if (existing.length > 0) {
            return { status: 'acknowledged', allocationId: row.allocationId, remoteCardIds: [], localCardIds: existing }
        }
        return {
            status: 'failed',
            allocationId: row.allocationId,
            error: new LicenseServiceError({
                code: 'invalid_response',
                operation: 'ack',
                cause: 'staged_cards_missing',
            }),
            keepStaged: true,
        }
    }

    try {
        await runWithRetry(
            () => deps.client.ack({
                allocationId: row.allocationId,
                receivedCardIds: remoteCardIds,
                // external_ref 原样沿用：与 Allocate 时不一致会被判 409。
                ...(row.externalRef ? { externalRef: row.externalRef } : {}),
                idempotencyKey: row.ackKey,
            }),
            retryOptions(deps, 'ack'),
        )
    } catch (error) {
        const classified = toLicenseServiceError(error, 'ack')
        const nowMs = now()

        if (classified.category === 'expired') {
            // 硬约束：中心已把卡密放回可分配池，本地副本必须删除并换新任务。
            await deps.database.write(buildDiscardAllocationStatements({
                allocationId: row.allocationId,
                ackOperationKey: row.ackKey,
                errorCode: classified.code,
                nowMs,
            }))
            return { status: 'expired', allocationId: row.allocationId, errorCode: classified.code }
        }

        if (classified.category === 'unavailable') {
            const nextRetryAtMs = nowMs + (classified.retryAfterMs ?? 0)
            await deps.database.write(buildDeferAckStatements({
                allocationId: row.allocationId,
                ackOperationKey: row.ackKey,
                errorCode: classified.code,
                requestId: classified.requestId,
                nextRetryAtMs,
                nowMs,
            }))
            return { status: 'deferred', allocationId: row.allocationId, error: classified }
        }

        await deps.database.write(buildFailAckStatements({
            allocationId: row.allocationId,
            ackOperationKey: row.ackKey,
            errorCode: classified.code,
            requestId: classified.requestId,
            nowMs,
        }))
        return { status: 'failed', allocationId: row.allocationId, error: classified, keepStaged: true }
    }

    const nowMs = now()
    let results: Awaited<ReturnType<CardServiceDatabase['write']>>
    try {
        results = await deps.database.write(buildMaterializeStatements({
            allocationId: row.allocationId,
            productId: row.productId,
            ackOperationKey: row.ackKey,
            nowMs,
        }))
    } catch (error) {
        // 远端 Ack 已经成功。本地整批回滚后暂存仍在，必须按原 allocation 与
        // 原 ack key 留下可重放意图，不能抛出、不能新 Allocate、也不能把存储
        // 错误当成超窗去删暂存。
        const classified = classifyMaterializeFailure(error)
        const recorded = await recordMaterializeFailure(deps, row, classified, nowMs)
        if (!recorded) {
            return {
                status: 'failed',
                allocationId: row.allocationId,
                error: infrastructureFailure(classified),
                keepStaged: true,
            }
        }
        return { status: 'failed', allocationId: row.allocationId, error: classified, keepStaged: true }
    }
    // 远端响应晚于手动丢弃时，写回被终态守卫挡住，不能报告已补货。
    if (!results[3]?.changes) {
        return { status: 'expired', allocationId: row.allocationId, errorCode: 'allocation_cancelled' }
    }

    let localCardIds: number[]
    try {
        localCardIds = await listLocalCardIds(deps.database, row.allocationId)
    } catch (error) {
        // 物化批次已经提交。读失败只能按真实状态恢复：卡已在可售池，
        // 不能再报失败去重放 Ack（重放会发现暂存已空，误判 staged_cards_missing）。
        const classified = classifyMaterializeFailure(error)
        return {
            status: 'acknowledged',
            allocationId: row.allocationId,
            remoteCardIds,
            localCardIds: [],
            readbackFailed: true,
            error: classified,
        }
    }

    return {
        status: 'acknowledged',
        allocationId: row.allocationId,
        remoteCardIds,
        localCardIds,
    }
}

/**
 * 本地物化失败的处置码。
 *
 * 约束类（主键/外键/唯一索引）是数据问题，继续用同一批卡重试不会自愈，
 * 交给既有尝试上限后进入复核；存储不可用则按退避重放。两者都保留暂存。
 */
function classifyMaterializeFailure(error: unknown): LicenseServiceError {
    if (error instanceof LicenseServiceError) return error
    const text = `${(error as { message?: string } | null)?.message ?? ''}`.toLowerCase()
    const permanent = text.includes('constraint')
        || text.includes('foreign key')
        || text.includes('unique')
        || text.includes('not null')
        || text.includes('datatype mismatch')
    return new LicenseServiceError({
        code: 'invalid_response',
        operation: 'materialize',
        retryable: !permanent,
        cause: permanent ? 'local_materialize_constraint' : 'local_materialize_unavailable',
    })
}

function infrastructureFailure(cause: LicenseServiceError): LicenseServiceError {
    return new LicenseServiceError({
        code: 'invalid_response',
        operation: 'materialize',
        retryable: true,
        cause: `materialize_failure_unrecorded:${cause.causeMessage ?? cause.code}`,
    })
}

/**
 * 物化失败后的落账。写失败说明库本身不可写：不得伪报「错误已保存」，
 * 调用方只报告基础设施失败，恢复仍靠批次 A 留下的暂存与原 Ack 待办。
 */
async function recordMaterializeFailure(
    deps: RestockDeps,
    row: CardServiceAllocationRow,
    error: LicenseServiceError,
    nowMs: number,
): Promise<boolean> {
    try {
        if (error.retryable) {
            await deps.database.write(buildDeferAckStatements({
                allocationId: row.allocationId,
                ackOperationKey: row.ackKey,
                errorCode: error.causeMessage ?? error.code,
                requestId: error.requestId,
                // 无 Retry-After 时走队列退避；有则尊重远端给出的等待。
                ...(error.retryAfterMs == null ? {} : { nextRetryAtMs: nowMs + error.retryAfterMs }),
                nowMs,
            }))
        } else {
            await deps.database.write(buildFailAckStatements({
                allocationId: row.allocationId,
                ackOperationKey: row.ackKey,
                errorCode: error.causeMessage ?? error.code,
                requestId: error.requestId,
                nowMs,
            }))
        }
        return true
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// 补货主流程
// ---------------------------------------------------------------------------

export interface RestockOptions {
    productId: string
    /** 首期建议恒为 1：Sell 要求整批卡同时售出，一单多卡会绑死订单与批次。 */
    quantity?: number
    /** 触发来源，写入 Allocate 的 `metadata.source`，便于中心侧排障。 */
    reason?: string
}

export async function restockProductCards(
    deps: RestockDeps,
    options: RestockOptions,
): Promise<RestockResult> {
    const quantity = Math.max(1, Math.trunc(options.quantity ?? 1))

    // 读取配置本身不会抛「表不存在」——`loadCardServiceProductConfig` 会把它
    // 折算成「未接入」。因此这里只需按配置分流，无需再兜数据库错误。
    const config = await loadCardServiceProductConfig(deps.database, options.productId)
    if (!config.configured) {
        return { status: 'skipped', reason: 'not_configured' }
    }
    if (config.supplyMode !== 'license_service') {
        return { status: 'skipped', reason: 'supply_mode_not_license_service' }
    }
    if (!config.programKey) {
        return { status: 'skipped', reason: 'program_key_missing' }
    }

    // 兜底闸门：就算配置行是历史遗留（或在准入校验上线前就写下了），共享商品
    // 也绝不允许从这里领卡 —— 它的交付路径绕过 Sell，领出来就是一张对不上账的卡。
    //
    // ⚠️ `exists` 与 `isShared` 必须**都**看：商品删除后供应配置行仍在，低水位扫描
    // 会继续对着一个不存在的商品 Allocate / Ack（物化时本地 `cards` 外键失败），
    // 而中心那几张卡已经扣掉库存，只会越积越多。
    const product = await loadProductSupplyGuard(deps.database, options.productId)
    if (!product.exists) {
        return { status: 'skipped', reason: 'product_not_found' }
    }
    if (product.isShared) {
        return { status: 'skipped', reason: 'shared_product' }
    }

    const intent = createRestockIntent({
        productId: options.productId,
        programKey: config.programKey,
        quantity,
        reason: options.reason ?? 'restock',
        ...(deps.randomUUID ? { taskId: buildRestockTaskId(deps.randomUUID) } : {}),
    })

    const now = resolveNow(deps)

    // 1) Allocate：本地零写入，失败即返回。
    let allocation
    try {
        allocation = await runWithRetry(
            () => deps.client.allocate({
                productId: intent.productId,
                programKey: intent.programKey,
                quantity: intent.quantity,
                externalRef: intent.externalRef,
                metadata: { source: intent.reason },
                idempotencyKey: intent.allocateIdempotencyKey,
            }),
            retryOptions(deps, 'allocate'),
        )
    } catch (error) {
        const classified = toLicenseServiceError(error, 'allocate')
        return {
            status: 'failed',
            taskId: intent.taskId,
            allocationId: null,
            errorCode: classified.code,
            category: classified.category,
            message: classified.message,
        }
    }

    // 2) 原子批次 A：台账 + 不可售暂存 + Ack 待办。
    const batchANow = now()
    await deps.database.write([
        ...buildInsertAllocationStatements(intent, {
            allocationId: allocation.allocationId,
            expiresAtMs: allocation.expiresAtMs,
        }, batchANow),
        ...buildInsertStagedCardStatements(intent, allocation.allocationId, allocation.cards, batchANow),
        buildInsertAckOperationStatement({
            operationKey: intent.ackIdempotencyKey,
            allocationId: allocation.allocationId,
            nowMs: batchANow,
        }),
    ])

    const row: CardServiceAllocationRow = {
        allocationId: allocation.allocationId,
        productId: intent.productId,
        // 用请求侧的受控 Program，而不是响应文本：响应里的 program_key 只能
        // 用来「发现不一致」，不能作为归属依据。
        programKey: intent.programKey,
        externalRef: intent.externalRef,
        quantity: allocation.quantity,
        state: 'allocated',
        requestKey: intent.allocateIdempotencyKey,
        ackKey: intent.ackIdempotencyKey,
        expiresAtMs: allocation.expiresAtMs,
        ackedAtMs: null,
    }

    // 3) 确认 + 物化。
    const outcome = await ackAndMaterializeAllocation(deps, row)
    if (outcome.status === 'acknowledged') {
        return {
            status: 'restocked',
            taskId: intent.taskId,
            allocationId: outcome.allocationId,
            remoteCardIds: outcome.remoteCardIds,
            localCardIds: outcome.localCardIds,
            expiresAtMs: allocation.expiresAtMs,
        }
    }
    if (outcome.status === 'expired') {
        return {
            status: 'expired',
            taskId: intent.taskId,
            allocationId: outcome.allocationId,
            errorCode: outcome.errorCode,
            requiresNewTask: true,
        }
    }
    if (outcome.status === 'deferred') {
        return {
            status: 'deferred',
            taskId: intent.taskId,
            allocationId: outcome.allocationId,
            errorCode: outcome.error.code,
            category: outcome.error.category,
            nextRetryAtMs: outcome.error.retryAfterMs === null ? null : now() + outcome.error.retryAfterMs,
        }
    }
    return {
        status: 'failed',
        taskId: intent.taskId,
        allocationId: outcome.allocationId,
        errorCode: outcome.error.code,
        category: outcome.error.category,
        // causeMessage 是脱敏后的处置原因（如「失败未能落账」）；Error.message
        // 只有码和操作名，调用方据此分不清是哪一种本地失败。
        message: outcome.error.causeMessage ?? outcome.error.message,
    }
}
