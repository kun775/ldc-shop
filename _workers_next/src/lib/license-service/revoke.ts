/**
 * 退款后的远端作废（接入方案阶段 E 第 2 条）。
 *
 * 退款会清空订单上的 `card_key` / `card_ids`，所以**作废所需的一切必须在清空前
 * 就落到独立台账上**：本地卡 ID、远端 card_id、Allocation、原订单号都在
 * `card_service_cards` 里，作废意图则在 `card_service_operations` 里。订单行被
 * 清空甚至删除之后，作废重放依然能凭这两张表推进 —— 这正是「已售卡和远端映射
 * 不可随订单物理删除而丢失」的落点。
 *
 * 作废范围刻意分两类，因为它们的代价完全不同：
 *
 *   - 映射已是 `sold`（用户已拿到明文，或交付批次已提交）：**必须作废**。
 *     中心不提供「归还可售」接口，作废后这张卡就永久退出流通（N4），代价是
 *     可接受的 —— 钱已经退给用户了。
 *   - 映射仍是 `acknowledged`（本地从未交付过）：这张卡**仍然归商城管理**，
 *     作废只会白白损失一张库存。所以先 `GET /cards/{id}` 查真实状态：
 *       · 中心显示 `sold` → 说明交付时 Sell 成功而本地没落上账（响应丢失），
 *         属于「未展示但已 Sell」，按同一策略作废；
 *       · 中心显示 `revoked` → 幂等：直接补记本地终态；
 *       · 中心仍可用/已分配 → **保留**，退款批次已把本地预留释放，它可以被
 *         另一笔订单正常卖出。
 *
 * 与交付路径一致的另外两条：
 *   - 作废**没有**本地原子批次可依赖（订单已退款），因此逐卡独立推进、逐卡落账，
 *     一张失败不影响其余；
 *   - 中心超时/5xx 一律**不得**说成「已经完成」：待办保持 `pending` 等下一轮，
 *     不可重试的错误置 `failed`，两者都会出现在运维面板的复核清单里。
 */

import {
    CARD_SERVICE_ALLOCATIONS_TABLE,
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_OPERATIONS_TABLE,
} from '../db/license-service-schema.ts'
import type { LicenseServiceClient } from './client.ts'
import { isMissingTableError, type CardServiceDatabase, type CardServiceStatement } from './db-port.ts'
import { toLicenseServiceError, type LicenseServiceError, type LicenseServiceErrorCategory } from './errors.ts'
import { buildRevokeIdempotencyKey } from './idempotency.ts'
import { runWithRetry, type RetryPolicy, type RunWithRetryOptions } from './retry.ts'
import { CARD_SERVICE_OPERATION_REVOKE } from './restock.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 作废阶段判定出的「无法自动处置」的原因（都要求人工介入）。 */
export type OrderRevokeBlockReason =
    /** 订单的本地卡只有一部分能查到远端映射：混合库存或映射被清理，无法整单作废。 */
    | 'partial_mapping'
    /** 映射挂在别的订单上：账本被外部改过，不能凭本单退款去作废他人的卡。 */
    | 'external_mismatch'
    /** 映射状态不是 `acknowledged`/`sold`（例如未知状态），需人工核查。 */
    | 'mapping_unusable'
    /** 台账里的 Allocation 已 `expired`/`cancelled`：卡密可能已回池，转人工。 */
    | 'allocation_unusable'

/** 待处置的一张远端卡。 */
export interface OrderRevokeCard {
    localCardId: number
    remoteCardId: string
    allocationId: string
    /** 本地映射状态：`acknowledged`（未交付）或 `sold`（已交付）。 */
    state: string
    /** 本地已记录作废：无需再调中心。 */
    alreadyRevoked: boolean
}

export type OrderRevokePlan =
    /** 纯本地订单：没有远端映射，退款流程照旧，不触碰中心。 */
    | { kind: 'none' }
    | { kind: 'revoke'; cards: OrderRevokeCard[] }
    | { kind: 'blocked'; reason: OrderRevokeBlockReason; detail: string }

/** 作废执行结论。`requested` 只统计真正需要调中心或补记的卡。 */
export interface RevokeOutcome {
    requested: number
    /** 已确认作废（含幂等补记）。 */
    revoked: number
    /** 中心显示仍可用：**保留**为本店库存，不作废。 */
    retained: number
    /** 暂时不可用（429/503/超时/网络）：待办保持 `pending`，下一轮重放。 */
    deferred: number
    /** 不可重试的失败：待办置 `failed`，需人工核查。 */
    failed: number
}

export interface RevokeDeps {
    client: Pick<LicenseServiceClient, 'revoke' | 'getCardStatus'>
    database: CardServiceDatabase
    now?: () => number
    policy?: Partial<RetryPolicy>
    sleep?: RunWithRetryOptions['sleep']
    random?: RunWithRetryOptions['random']
    onRetry?: RunWithRetryOptions['onRetry']
}

export function emptyRevokeOutcome(): RevokeOutcome {
    return { requested: 0, revoked: 0, retained: 0, deferred: 0, failed: 0 }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

interface RevokeMappingRow {
    localCardId: number
    remoteCardId: string
    allocationId: string
    state: string
    orderId: string | null
}

const MAPPING_COLUMNS = 'local_card_id, remote_card_id, allocation_id, state, order_id'

function toIntegerOrNull(value: unknown): number | null {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function toStringOrEmpty(value: unknown) {
    return typeof value === 'string' ? value : ''
}

function toMappingRow(raw: Record<string, unknown>): RevokeMappingRow | null {
    const localCardId = toIntegerOrNull(raw.local_card_id)
    const remoteCardId = toStringOrEmpty(raw.remote_card_id)
    const allocationId = toStringOrEmpty(raw.allocation_id)
    if (localCardId === null || !remoteCardId || !allocationId) return null
    return {
        localCardId,
        remoteCardId,
        allocationId,
        state: toStringOrEmpty(raw.state),
        orderId: toStringOrEmpty(raw.order_id) || null,
    }
}

function placeholders(count: number) {
    return Array.from({ length: count }, () => '?').join(', ')
}

async function queryMappingRows(
    database: CardServiceDatabase,
    sql: string,
    params: readonly unknown[],
): Promise<RevokeMappingRow[]> {
    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(sql, params)
    } catch (error) {
        // 升级项 0038 未执行：不存在任何远端映射，退款按纯本地订单处理。
        if (isMissingTableError(error)) return []
        throw error
    }
    return rows.map(toMappingRow).filter((row): row is RevokeMappingRow => row !== null)
}

/** 按本地卡 ID 读映射（退款路径：订单上还留着 `card_ids`）。 */
export async function listMappingsByLocalCardIds(
    database: CardServiceDatabase,
    localCardIds: readonly number[],
): Promise<RevokeMappingRow[]> {
    const ids = Array.from(new Set(localCardIds.filter((id) => Number.isSafeInteger(id))))
    if (!ids.length) return []
    return queryMappingRows(
        database,
        `SELECT ${MAPPING_COLUMNS} FROM ${CARD_SERVICE_CARDS_TABLE} WHERE local_card_id IN (${placeholders(ids.length)})`,
        ids,
    )
}

/** 按远端 card_id 读映射（重放路径：只信台账里记下的远端身份）。 */
export async function listMappingsByRemoteCardIds(
    database: CardServiceDatabase,
    remoteCardIds: readonly string[],
): Promise<RevokeMappingRow[]> {
    const ids = Array.from(new Set(remoteCardIds.map((id) => id.trim()).filter(Boolean)))
    if (!ids.length) return []
    return queryMappingRows(
        database,
        `SELECT ${MAPPING_COLUMNS} FROM ${CARD_SERVICE_CARDS_TABLE} WHERE remote_card_id IN (${placeholders(ids.length)})`,
        ids,
    )
}

/**
 * 台账里该 Allocation 是否已不可用（`expired`/`cancelled`/`abandoned`）。
 *
 * 查不到台账时返回 `false`：不能因为少一行台账就把作废判成「不可能完成」，
 * 中心那边仍会给出真实答案。
 */
async function allocationIsUnusable(database: CardServiceDatabase, allocationIds: readonly string[]): Promise<string | null> {
    const ids = Array.from(new Set(allocationIds.filter(Boolean)))
    if (!ids.length) return null
    try {
        const rows = await database.query<{ allocation_id?: unknown }>(
            `SELECT allocation_id FROM ${CARD_SERVICE_ALLOCATIONS_TABLE}
             WHERE state IN ('expired', 'cancelled', 'abandoned')
               AND allocation_id IN (${placeholders(ids.length)})`,
            ids,
        )
        return rows.length ? toStringOrEmpty(rows[0].allocation_id) || 'unknown' : null
    } catch (error) {
        if (isMissingTableError(error)) return null
        throw error
    }
}

function classifyRow(
    row: RevokeMappingRow,
    orderId: string,
): { ok: true; card: OrderRevokeCard } | { ok: false; reason: OrderRevokeBlockReason; detail: string } {
    if (row.state === 'revoked') {
        return { ok: true, card: { ...toCard(row), alreadyRevoked: true } }
    }
    if (row.state === 'acknowledged' || row.state === 'sold') {
        if (row.state === 'sold' && row.orderId && row.orderId !== orderId) {
            return {
                ok: false,
                reason: 'external_mismatch',
                detail: `remote card ${row.remoteCardId} is sold to ${row.orderId}`,
            }
        }
        return { ok: true, card: toCard(row) }
    }
    return {
        ok: false,
        reason: 'mapping_unusable',
        detail: `remote card ${row.remoteCardId} has state ${row.state || 'unknown'}`,
    }
}

function toCard(row: RevokeMappingRow): OrderRevokeCard {
    return {
        localCardId: row.localCardId,
        remoteCardId: row.remoteCardId,
        allocationId: row.allocationId,
        state: row.state,
        alreadyRevoked: false,
    }
}

/**
 * 退款前判定：这张订单有哪些远端卡需要作废。
 *
 * 必须在**清空 `orders.card_ids` 之前**调用 —— 本地卡 ID 是找回远端身份的唯一线索
 * （除非走 `order_id` 反查，但未交付订单的映射 `order_id` 还是空的）。
 */
export async function loadOrderRevokePlan(
    database: CardServiceDatabase,
    input: { orderId: string; localCardIds: readonly number[] },
): Promise<OrderRevokePlan> {
    const localIds = Array.from(new Set(input.localCardIds.filter((id) => Number.isSafeInteger(id))))
    if (!localIds.length) return { kind: 'none' }

    const rows = await listMappingsByLocalCardIds(database, localIds)
    if (!rows.length) return { kind: 'none' }

    const byLocalId = new Map(rows.map((row) => [row.localCardId, row]))
    const cards: OrderRevokeCard[] = []
    for (const localCardId of localIds) {
        const row = byLocalId.get(localCardId)
        if (!row) {
            return {
                kind: 'blocked',
                reason: 'partial_mapping',
                detail: `local card ${localCardId} has no remote mapping while others do`,
            }
        }
        const classified = classifyRow(row, input.orderId)
        if (!classified.ok) {
            return { kind: 'blocked', reason: classified.reason, detail: classified.detail }
        }
        cards.push(classified.card)
    }

    if (!cards.some((card) => !card.alreadyRevoked)) return { kind: 'none' }

    const unusable = await allocationIsUnusable(database, cards.map((card) => card.allocationId))
    if (unusable) {
        return {
            kind: 'blocked',
            reason: 'allocation_unusable',
            detail: `allocation ${unusable} is already terminal locally`,
        }
    }

    return { kind: 'revoke', cards }
}

/**
 * 重放前判定：按台账里记下的远端卡重新构造作废范围。
 *
 * 订单行此时可能已经被清空或删除，所以这里**只**依据远端身份；查不到映射的行
 * 计入人工复核，不猜、不新建。
 */
export async function loadRevokePlanForRemoteCards(
    database: CardServiceDatabase,
    input: { orderId: string; remoteCardIds: readonly string[] },
): Promise<OrderRevokePlan> {
    const remoteIds = Array.from(new Set(input.remoteCardIds.map((id) => id.trim()).filter(Boolean)))
    if (!remoteIds.length) return { kind: 'none' }

    const rows = await listMappingsByRemoteCardIds(database, remoteIds)
    if (!rows.length) {
        return {
            kind: 'blocked',
            reason: 'partial_mapping',
            detail: 'no remote mapping found for the recorded card ids',
        }
    }

    const byRemoteId = new Map(rows.map((row) => [row.remoteCardId, row]))
    const cards: OrderRevokeCard[] = []
    for (const remoteCardId of remoteIds) {
        const row = byRemoteId.get(remoteCardId)
        if (!row) {
            return {
                kind: 'blocked',
                reason: 'partial_mapping',
                detail: `remote card ${remoteCardId} has no local mapping`,
            }
        }
        const classified = classifyRow(row, input.orderId)
        if (!classified.ok) {
            return { kind: 'blocked', reason: classified.reason, detail: classified.detail }
        }
        cards.push(classified.card)
    }

    if (!cards.some((card) => !card.alreadyRevoked)) return { kind: 'none' }
    return { kind: 'revoke', cards }
}

/** 列出待重放的作废操作（供定时任务与运维面板使用）。 */
export async function listPendingRevokeOperations(
    database: CardServiceDatabase,
    options: { limit?: number } = {},
): Promise<Array<{ operationKey: string; remoteCardId: string; orderId: string; state: string; attempts: number }>> {
    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT operation_key, resource_id, order_id, state, attempts
             FROM ${CARD_SERVICE_OPERATIONS_TABLE}
             WHERE operation = ? AND state IN ('pending', 'failed')
             ORDER BY COALESCE(next_retry_at, 0) ASC, created_at ASC
             LIMIT ?`,
            [CARD_SERVICE_OPERATION_REVOKE, Math.max(1, Math.trunc(options.limit ?? 20))],
        )
    } catch (error) {
        if (isMissingTableError(error)) return []
        throw error
    }

    return rows
        .map((row) => ({
            operationKey: toStringOrEmpty(row.operation_key),
            remoteCardId: toStringOrEmpty(row.resource_id),
            orderId: toStringOrEmpty(row.order_id),
            state: toStringOrEmpty(row.state),
            attempts: toIntegerOrNull(row.attempts) ?? 0,
        }))
        .filter((row) => row.operationKey && row.remoteCardId && row.orderId)
}

// ---------------------------------------------------------------------------
// 语句构造
// ---------------------------------------------------------------------------

function operationKey(remoteCardId: string, orderId: string) {
    return buildRevokeIdempotencyKey(remoteCardId, orderId)
}

/** 作废意图先落账：订单卡密马上就要被清空，必须留下可重放的记录。 */
export function buildRevokeIntentStatements(input: {
    orderId: string
    cards: ReadonlyArray<{ remoteCardId: string }>
    nowMs: number
}): CardServiceStatement[] {
    return input.cards.map((card) => ({
        // OR IGNORE：重放时保留既有行（可能已是 done/failed），不要把状态改回 pending。
        sql: `INSERT OR IGNORE INTO ${CARD_SERVICE_OPERATIONS_TABLE}
            (operation_key, operation, resource_id, order_id, state, attempts,
             next_retry_at, request_id, last_error_code, created_at, updated_at)
            VALUES (?, '${CARD_SERVICE_OPERATION_REVOKE}', ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
        params: [
            operationKey(card.remoteCardId, input.orderId),
            card.remoteCardId,
            input.orderId,
            input.nowMs,
            input.nowMs,
        ],
    }))
}

function buildRevokeOperationStateStatements(input: {
    orderId: string
    remoteCardId: string
    state: 'done' | 'pending' | 'failed'
    errorCode: string | null
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
            operationKey(input.remoteCardId, input.orderId),
        ],
    }]
}

/**
 * 作废确认：映射转 `revoked` + 台账转 `done`。
 *
 * 映射update 只允许从 `acknowledged`/`sold` 出发，避免把已作废的行「复活」，
 * 也避免把后来被人工改成其它状态的账本覆盖掉。
 */
export function buildRevokeSuccessStatements(input: {
    orderId: string
    remoteCardId: string
    nowMs: number
}): CardServiceStatement[] {
    return [
        {
            sql: `UPDATE ${CARD_SERVICE_CARDS_TABLE}
                SET state = 'revoked', revoked_at = ?, updated_at = ?
                WHERE remote_card_id = ? AND state IN ('acknowledged', 'sold')`,
            params: [input.nowMs, input.nowMs, input.remoteCardId],
        },
        ...buildRevokeOperationStateStatements({
            ...input,
            state: 'done',
            errorCode: null,
            requestId: null,
            nextRetryAtMs: null,
        }),
    ]
}

/**
 * 保留库存：中心显示该卡仍可用，本店留作库存。
 *
 * 台账置 `done` 而不是删除 —— 面板要能回答「这笔退款为什么没有作废卡」。
 */
export function buildRevokeRetainStatements(input: {
    orderId: string
    remoteCardId: string
    nowMs: number
}): CardServiceStatement[] {
    return buildRevokeOperationStateStatements({
        ...input,
        state: 'done',
        errorCode: null,
        requestId: null,
        nextRetryAtMs: null,
    })
}

/** 可重试失败：保持待办可被重放，并记录下次重试时间。 */
export function buildRevokeDeferStatements(input: {
    orderId: string
    remoteCardId: string
    errorCode: string
    requestId: string | null
    nextRetryAtMs: number
    nowMs: number
}): CardServiceStatement[] {
    return buildRevokeOperationStateStatements({ ...input, state: 'pending' })
}

/** 不可重试失败：待办置 `failed` 等人工核查（不是「已完成」）。 */
export function buildRevokeFailStatements(input: {
    orderId: string
    remoteCardId: string
    errorCode: string
    requestId: string | null
    nowMs: number
}): CardServiceStatement[] {
    return buildRevokeOperationStateStatements({
        ...input,
        state: 'failed',
        nextRetryAtMs: null,
    })
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

type CardStatusProbe =
    | { ok: true; status: string }
    | { ok: false; error: LicenseServiceError }

function resolveNow(deps: RevokeDeps) {
    return deps.now ?? (() => Date.now())
}

function retryOptions(deps: RevokeDeps, operation: string): RunWithRetryOptions {
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
 * 查中心的卡状态。
 *
 * 不可用类错误（429/503/超时）交给调用方决定「等下一轮」，查不到等确定性错误
 * 按「未知」处理 —— 未知时**保留**本地映射，绝不默认作废（作废不回库存，误判
 * 等于白丢一张卡）。
 */
async function probeRemoteCardStatus(deps: RevokeDeps, remoteCardId: string): Promise<CardStatusProbe> {
    try {
        const detail = await runWithRetry(
            () => deps.client.getCardStatus(remoteCardId),
            retryOptions(deps, 'getCardStatus'),
        )
        return { ok: true, status: (detail.status || '').toLowerCase() }
    } catch (error) {
        const classified = toLicenseServiceError(error, 'getCardStatus')
        if (classified.category === 'unavailable') return { ok: false, error: classified }
        return { ok: true, status: 'unknown' }
    }
}

function classifyRevokeFailure(category: LicenseServiceErrorCategory): 'deferred' | 'failed' {
    return category === 'unavailable' ? 'deferred' : 'failed'
}

async function revokeOneCard(
    deps: RevokeDeps,
    input: { orderId: string; card: OrderRevokeCard; reason: string },
    outcome: RevokeOutcome,
): Promise<void> {
    const now = resolveNow(deps)
    const { card, orderId, reason } = input

    // 未交付的卡先问中心：只有中心确实已售出（或已作废）才作废，否则留作库存。
    if (card.state === 'acknowledged') {
        const probe = await probeRemoteCardStatus(deps, card.remoteCardId)
        if (!probe.ok) {
            const error = probe.error
            await deps.database.write(buildRevokeDeferStatements({
                orderId,
                remoteCardId: card.remoteCardId,
                errorCode: error.code,
                requestId: error.requestId,
                nextRetryAtMs: now() + (error.retryAfterMs ?? 0),
                nowMs: now(),
            }))
            outcome.deferred += 1
            return
        }
        if (probe.status === 'revoked') {
            await deps.database.write(buildRevokeSuccessStatements({ orderId, remoteCardId: card.remoteCardId, nowMs: now() }))
            outcome.revoked += 1
            return
        }
        if (probe.status !== 'sold') {
            // 仍可用 / 仍分配给我们：不作废，保留为库存（本地预留由退款批次释放）。
            await deps.database.write(buildRevokeRetainStatements({ orderId, remoteCardId: card.remoteCardId, nowMs: now() }))
            outcome.retained += 1
            return
        }
    }

    try {
        await runWithRetry(
            () => deps.client.revoke(card.remoteCardId, {
                reason,
                idempotencyKey: operationKey(card.remoteCardId, orderId),
            }),
            retryOptions(deps, 'revoke'),
        )
        await deps.database.write(buildRevokeSuccessStatements({ orderId, remoteCardId: card.remoteCardId, nowMs: now() }))
        outcome.revoked += 1
    } catch (error) {
        const classified = toLicenseServiceError(error, 'revoke')

        if (classified.category === 'conflict') {
            // 409 一律不重试：先用单查核实真实状态。已 `revoked` 说明首次其实
            // 成功了（响应丢失），补记终态；`sold` 之外的冲突交人工核查。
            const probe = await probeRemoteCardStatus(deps, card.remoteCardId)
            if (probe.ok && probe.status === 'revoked') {
                await deps.database.write(buildRevokeSuccessStatements({ orderId, remoteCardId: card.remoteCardId, nowMs: now() }))
                outcome.revoked += 1
                return
            }
            if (!probe.ok) {
                const probeError = probe.error
                await deps.database.write(buildRevokeDeferStatements({
                    orderId,
                    remoteCardId: card.remoteCardId,
                    errorCode: probeError.code,
                    requestId: probeError.requestId,
                    nextRetryAtMs: now() + (probeError.retryAfterMs ?? 0),
                    nowMs: now(),
                }))
                outcome.deferred += 1
                return
            }
        }

        if (classifyRevokeFailure(classified.category) === 'deferred') {
            await deps.database.write(buildRevokeDeferStatements({
                orderId,
                remoteCardId: card.remoteCardId,
                errorCode: classified.code,
                requestId: classified.requestId,
                nextRetryAtMs: now() + (classified.retryAfterMs ?? 0),
                nowMs: now(),
            }))
            outcome.deferred += 1
            return
        }

        await deps.database.write(buildRevokeFailStatements({
            orderId,
            remoteCardId: card.remoteCardId,
            errorCode: classified.code,
            requestId: classified.requestId,
            nowMs: now(),
        }))
        outcome.failed += 1
    }
}

/**
 * 逐卡作废。串行执行、逐卡落账：一张卡失败不影响其余卡，也不会让整笔退款被说成
 * 「已完成作废」。调用方拿到的是**分类计数**，必须按 `deferred`/`failed` 提示管理员。
 */
export async function executeOrderRevokes(
    deps: RevokeDeps,
    input: { orderId: string; cards: readonly OrderRevokeCard[]; reason: string },
): Promise<RevokeOutcome> {
    const outcome = emptyRevokeOutcome()
    const pending = input.cards.filter((card) => !card.alreadyRevoked)
    if (!pending.length) return outcome

    outcome.requested = pending.length
    await deps.database.write(buildRevokeIntentStatements({
        orderId: input.orderId,
        cards: pending,
        nowMs: resolveNow(deps)(),
    }))

    for (const card of pending) {
        await revokeOneCard(deps, { orderId: input.orderId, card, reason: input.reason }, outcome)
    }

    return outcome
}

/**
 * 待办重放：把 `pending`/`failed` 的作废操作按原键再走一遍。
 *
 * 依据台账里的 `order_id` + 远端 card_id 分组重建计划；查不到映射的操作计入
 * 复核计数，不做任何猜测性动作。供定时任务与运维面板调用。
 */
export async function revokePendingCardServiceOperations(
    deps: RevokeDeps,
    options: { limit?: number; reason?: string } = {},
): Promise<RevokeOutcome & { attempted: number; review: number }> {
    const outcome = { ...emptyRevokeOutcome(), attempted: 0, review: 0 }
    const operations = await listPendingRevokeOperations(deps.database, { limit: options.limit ?? 20 })

    const byOrder = new Map<string, string[]>()
    for (const operation of operations) {
        const list = byOrder.get(operation.orderId) ?? []
        list.push(operation.remoteCardId)
        byOrder.set(operation.orderId, list)
    }

    for (const [orderId, remoteCardIds] of byOrder) {
        outcome.attempted += remoteCardIds.length
        const plan = await loadRevokePlanForRemoteCards(deps.database, { orderId, remoteCardIds })
        if (plan.kind === 'none') continue
        if (plan.kind === 'blocked') {
            // 判定不通过就停手：把原因写进日志由面板呈现，绝不猜着作废。
            console.error(`[Revoke] Order ${orderId} revoke replay blocked: reason=${plan.reason} detail=${plan.detail}`)
            outcome.review += remoteCardIds.length
            continue
        }
        const result = await executeOrderRevokes(deps, {
            orderId,
            cards: plan.cards,
            reason: options.reason ?? `ldc-shop:refund-replay:${orderId}`,
        })
        outcome.revoked += result.revoked
        outcome.retained += result.retained
        outcome.deferred += result.deferred
        outcome.failed += result.failed
    }

    return outcome
}
