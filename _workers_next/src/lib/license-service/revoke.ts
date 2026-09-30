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
 *     作废只会白白损失一张库存。所以先问中心真实状态：
 *       · **分配**已 `sold` → 说明交付时 Sell 成功而本地没落上账（响应丢失），
 *         属于「未展示但已 Sell」，按同一策略作废；
 *       · **卡**已 `revoked` → 幂等：直接补记本地终态；
 *       · 分配仍是 `acknowledged`/`allocated` → **保留**，退款批次已把本地预留
 *         释放，它可以被另一笔订单正常卖出。
 *
 *     ⚠️ 判「已售出」只能看**分配状态**（`GET /allocations/{id}` 的 `status`，或
 *     卡状态响应里的 `allocation_status`）。`GET /cards/{id}/status` 的
 *     `data.status` 是**卡运行态**（`revoked`/`disabled`/`expired`/`exhausted`/
 *     `active`），**永不返回 `sold`** —— 用它判已售出等于写了一个恒假条件。
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
import {
    CARD_SERVICE_OPERATION_QUEUE_ORDER_SQL,
    CARD_SERVICE_RETRY_BACKOFF_FILTER_SQL,
    buildOperationFailureClauses,
} from './operation-queue.ts'
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
    /**
     * 需要人工介入。`cards` 是**已经能安全识别出来的那部分**（可能为空）：
     * 它们不能被自动作废，但**必须被隔离** —— 退款会释放本单的本地预留，
     * 不隔离就会被前台当成普通可售卡再卖一次。
     */
    | { kind: 'blocked'; reason: OrderRevokeBlockReason; detail: string; cards?: OrderRevokeCard[] }

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
    /**
     * `getAllocation` 是必需的：判断「中心是否已售出」只能看**分配状态**
     * （`GET /allocations/{id}` 的 `status`），卡状态接口永远不返回 `sold`。
     */
    client: Pick<LicenseServiceClient, 'revoke' | 'getCardStatus' | 'getAllocation'>
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
 * 按订单号读映射（退款路径的第二条线索）。
 *
 * 只依靠订单上的 `card_ids` 是不够的：那一列可能在历史操作里被部分清空，
 * 或者订单本来就来自混合库存。台账里 `order_id` 是映射落地时写下的，
 * 属于「我们自己记的账」，比订单列更可信 —— 两者取并集，才不会漏作废。
 */
export async function listMappingsByOrderId(
    database: CardServiceDatabase,
    orderId: string,
): Promise<RevokeMappingRow[]> {
    const id = (orderId || '').trim()
    if (!id) return []
    return queryMappingRows(
        database,
        `SELECT ${MAPPING_COLUMNS} FROM ${CARD_SERVICE_CARDS_TABLE} WHERE order_id = ?`,
        [id],
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
 * 必须在**清空 `orders.card_ids` 之前**调用 —— 本地卡 ID 是找回远端身份的首选
 * 线索。但只靠它不够：`card_ids` 可能被历史操作部分清空，所以这里同时按
 * `order_id` 反查台账，两者取并集。任一侧多出来的卡都一并纳入作废范围，
 * 否则那张远端卡会永久留在流通里（中心没有归还可售接口）。
 */
export async function loadOrderRevokePlan(
    database: CardServiceDatabase,
    input: { orderId: string; localCardIds: readonly number[] },
): Promise<OrderRevokePlan> {
    const localIds = Array.from(new Set(input.localCardIds.filter((id) => Number.isSafeInteger(id))))

    const [byLocal, byOrder] = await Promise.all([
        listMappingsByLocalCardIds(database, localIds),
        listMappingsByOrderId(database, input.orderId),
    ])
    if (!byLocal.length && !byOrder.length) return { kind: 'none' }

    const byLocalId = new Map(byLocal.map((row) => [row.localCardId, row]))
    const cards: OrderRevokeCard[] = []
    const seen = new Set<number>()

    // `blocked` 也把已经认出来的卡带出去：它们不能被自动作废，但退款方需要拿它们
    // 做本地隔离（见 `OrderRevokePlan` 的注释）。
    const blocked = (reason: OrderRevokeBlockReason, detail: string): OrderRevokePlan => ({
        kind: 'blocked',
        reason,
        detail,
        cards,
    })

    // ⚠️ 遇到问题卡**不能立即返回**：两轮遍历都必须走完，才能把「可确认归属」的卡
    // 全部收进 `cards`。只带出前缀的话，退款方拿不到后面的远端卡 —— 它们既不进作废
    // 待办、也不会被本地隔离，而订单 `card_ids` 一清就再没有追溯线索。
    // 因此这里只记录**首个**阻断原因，遍历结束后统一决定返回形态。
    let blockedReason: OrderRevokeBlockReason | null = null
    let blockedDetail = ''
    const noteBlock = (reason: OrderRevokeBlockReason, detail: string): void => {
        if (blockedReason) return
        blockedReason = reason
        blockedDetail = detail
    }

    // 订单列出的每一张卡都必须能查到映射：缺一张说明这单混了本地库存或映射被
    // 清理过，整单不做自动化处置。
    for (const localCardId of localIds) {
        const row = byLocalId.get(localCardId)
        if (!row) {
            noteBlock('partial_mapping', `local card ${localCardId} has no remote mapping while others do`)
            continue
        }
        const classified = classifyRow(row, input.orderId)
        if (!classified.ok) {
            noteBlock(classified.reason, classified.detail)
            continue
        }
        cards.push(classified.card)
        seen.add(localCardId)
    }

    // 台账里挂在本单、但订单 `card_ids` 已经看不到的卡：仍要作废。
    for (const row of byOrder) {
        if (seen.has(row.localCardId)) continue
        const classified = classifyRow(row, input.orderId)
        if (!classified.ok) {
            noteBlock(classified.reason, classified.detail)
            continue
        }
        cards.push(classified.card)
        seen.add(row.localCardId)
    }

    if (blockedReason) return blocked(blockedReason, blockedDetail)

    if (!cards.some((card) => !card.alreadyRevoked)) return { kind: 'none' }

    const unusable = await allocationIsUnusable(database, cards.map((card) => card.allocationId))
    if (unusable) {
        return blocked('allocation_unusable', `allocation ${unusable} is already terminal locally`)
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
    options: { limit?: number; respectBackoff?: boolean; nowMs?: number } = {},
): Promise<Array<{ operationKey: string; remoteCardId: string; orderId: string; state: string; attempts: number }>> {
    let rows: Array<Record<string, unknown>>
    try {
        const params: unknown[] = [CARD_SERVICE_OPERATION_REVOKE]
        const filters = ["operation = ? AND state IN ('pending', 'failed')"]
        // 定时重放要遵守退避；人工重试传 `respectBackoff: false` 跳过它。
        if (options.respectBackoff) {
            filters.push(CARD_SERVICE_RETRY_BACKOFF_FILTER_SQL)
            params.push(options.nowMs ?? Date.now())
        }
        params.push(Math.max(1, Math.trunc(options.limit ?? 20)))
        rows = await database.query(
            `SELECT operation_key, resource_id, order_id, state, attempts
             FROM ${CARD_SERVICE_OPERATIONS_TABLE}
             WHERE ${filters.join(' ')}
             ${CARD_SERVICE_OPERATION_QUEUE_ORDER_SQL}
             LIMIT ?`,
            params,
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

/**
 * 作废意图先落账：订单卡密马上就要被清空，必须留下可重放的记录。
 *
 * 同一条意图还会**顺手把本地卡隔离**（`is_used = 1`）——作废未确认期间可能跨多次
 * 重放、中心甚至长时间不可达，而退款已经把这单的本地预留释放了；不隔离的话这张卡
 * 会被前台当成普通可售卡再卖一次，后果是**同一张卡卖给两个人**，其中一个必然作废。
 * 隔离由 `buildRevokeRetainStatements` 在「中心确认仍可用」时精确放回。
 */
export function buildRevokeIntentStatements(input: {
    orderId: string
    cards: ReadonlyArray<{ remoteCardId: string; localCardId?: number | null }>
    nowMs: number
}): CardServiceStatement[] {
    const statements: CardServiceStatement[] = []

    for (const card of input.cards) {
        // OR IGNORE：重放时保留既有行（可能已是 done/failed），不要把状态改回 pending。
        statements.push({
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
        })

        if (Number.isSafeInteger(card.localCardId)) {
            statements.push(...buildRevokeQuarantineStatements({
                orderId: input.orderId,
                cards: [card],
                nowMs: input.nowMs,
            }))
        }
    }

    return statements
}

/**
 * 只做本地隔离、不写意图。
 *
 * 用途是「已经作废的卡」：远端已经死了，本地卡同样不该还能卖，但不需要再建待办。
 */
export function buildRevokeQuarantineStatements(input: {
    orderId: string
    cards: ReadonlyArray<{ localCardId?: number | null }>
    nowMs: number
}): CardServiceStatement[] {
    return input.cards
        .filter((card) => Number.isSafeInteger(card.localCardId))
        .map((card) => buildLocalCardQuarantineStatement({
            orderId: input.orderId,
            localCardId: card.localCardId as number,
            nowMs: input.nowMs,
        }))
}

/**
 * 退款原子批次里要一并提交的作废语句（阶段 E 第 2 条的「丢失窗口」修复）。
 *
 * 作废意图必须**和退款结算在同一个 D1 批次里提交**：两步分开的话，进程在中间被
 * 回收（或部署）就会留下「订单已退款、卡密已清空、却没有任何记录说明这些远端卡
 * 需要作废」的状态 —— 中心那几张卡会永久留在流通里，且无从追溯。
 *
 * 未作废的卡写意图 + 隔离；已作废的卡只隔离。
 */
export function buildRefundRevokeStatements(input: {
    orderId: string
    cards: readonly OrderRevokeCard[]
    nowMs: number
}): CardServiceStatement[] {
    const pending = input.cards.filter((card) => !card.alreadyRevoked)
    const revoked = input.cards.filter((card) => card.alreadyRevoked)

    return [
        ...buildRevokeIntentStatements({
            orderId: input.orderId,
            cards: pending,
            nowMs: input.nowMs,
        }),
        ...buildRevokeQuarantineStatements({
            orderId: input.orderId,
            cards: revoked,
            nowMs: input.nowMs,
        }),
    ]
}

/**
 * 把本地卡移出可售池（作废前的隔离）。
 *
 * 三条守卫都很必要：
 *   - `used_at = COALESCE(used_at, ?)`：已交付过的卡保留它真实的交付时间，不改写历史；
 *   - 只动 `reserved_order_id IS NULL OR = 本单`：绝不去抢别的订单的预留；
 *   - 幂等：重复执行只是把同样的行再置一遍 `is_used = 1`。
 */
function buildLocalCardQuarantineStatement(input: {
    orderId: string
    localCardId: number
    nowMs: number
}): CardServiceStatement {
    return {
        sql: `UPDATE cards
            SET is_used = 1, used_at = COALESCE(used_at, ?),
                reserved_order_id = NULL, reserved_at = NULL
            WHERE id = ? AND (reserved_order_id IS NULL OR reserved_order_id = ?)`,
        params: [input.nowMs, input.localCardId, input.orderId],
    }
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
    const key = operationKey(input.remoteCardId, input.orderId)

    if (input.state === 'failed') {
        // 不可重试失败走统一的重试预算（退避 + 尝试上限 → `abandoned`），
        // 因此这里**不用** `nextRetryAtMs`（它只对可重试的 `pending` 有意义）。
        const failure = buildOperationFailureClauses(input.nowMs)
        return [{
            sql: `UPDATE ${CARD_SERVICE_OPERATIONS_TABLE}
                SET state = ${failure.state}, attempts = attempts + 1, next_retry_at = ${failure.nextRetryAt},
                    request_id = ?, last_error_code = ?, updated_at = ?
                WHERE operation_key = ?`,
            params: [input.requestId, input.errorCode, input.nowMs, key],
        }]
    }

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
            key,
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
 * 必须把 `buildRevokeIntentStatements` 的隔离**精确放回**，否则这张卡会永久
 * 从可售池里消失（`is_used` 恒为 1，前台再也看不到它）。
 *
 * 放回条件是**凭台账判定「从未交付」**（`card_service_cards.state = 'acknowledged'`），
 * 而不是凭时间戳：时间戳要跨「退款批次 → 多次重放」传递，任一环节换一个 `now()`
 * 就配对失败。而「是否交付过」恰好是我们唯一需要的事实 —— 交付过的卡（`sold`）
 * 即使走不到这个分支，也不该被放回。
 *
 * 台账置 `done` 而不是删除 —— 面板要能回答「这笔退款为什么没有作废卡」。
 */
export function buildRevokeRetainStatements(input: {
    orderId: string
    remoteCardId: string
    localCardId?: number | null
    nowMs: number
}): CardServiceStatement[] {
    const statements: CardServiceStatement[] = []

    if (Number.isSafeInteger(input.localCardId)) {
        // 归属校验与隔离语句（`buildLocalCardQuarantineStatement`）严格对称：只放回
        // 「没人预留、或预留归属就是本单」的卡。
        //
        // 少了它，一笔**并发重放**的旧执行会清掉另一个订单刚刚做的预留 —— 那张卡
        // 于是在两笔订单之间同时可售，谁先交付谁拿到，另一单必然拿到一张已死的卡。
        statements.push({
            sql: `UPDATE cards
                SET is_used = 0, used_at = NULL, reserved_order_id = NULL, reserved_at = NULL
                WHERE id = ?
                  AND (reserved_order_id IS NULL OR reserved_order_id = ?)
                  AND EXISTS (
                    SELECT 1 FROM ${CARD_SERVICE_CARDS_TABLE}
                     WHERE local_card_id = cards.id
                       AND remote_card_id = ?
                       AND state = 'acknowledged'
                )`,
            params: [input.localCardId, input.orderId, input.remoteCardId],
        })
    }

    statements.push(...buildRevokeOperationStateStatements({
        ...input,
        state: 'done',
        errorCode: null,
        requestId: null,
        nextRetryAtMs: null,
    }))

    return statements
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

/** 不可重试失败：待办置 `failed`（含退避与尝试上限）等人工核查（不是「已完成」）。 */
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
        // 失败分支不使用它（退避由 `buildOperationFailureClauses` 在 SQL 里算）。
        nextRetryAtMs: null,
    })
}

/**
 * 中心凭据缺失时的降级路径。
 *
 * 退款已经把订单上的 `card_key`/`card_ids` 清掉了，所以「谁需要作废」这件事必须
 * 立刻落账 —— 否则等运维把 Key 配上时，已经没有任何本地线索能重建作废范围。
 * 因此这里：意图照常写入，逐卡置 `failed`（错误码写明是配置问题），
 * **绝不算作已完成**，等 Key 配好后由重放入口继续。
 */
export async function failRevokesWithoutClient(
    database: CardServiceDatabase,
    input: { orderId: string; cards: readonly OrderRevokeCard[]; errorCode: string; nowMs?: number },
): Promise<RevokeOutcome> {
    const outcome = emptyRevokeOutcome()
    const pending = input.cards.filter((card) => !card.alreadyRevoked)
    if (!pending.length) return outcome

    const nowMs = input.nowMs ?? Date.now()
    outcome.requested = pending.length

    await database.write(buildRevokeIntentStatements({
        orderId: input.orderId,
        cards: pending,
        nowMs,
    }))

    for (const card of pending) {
        await database.write(buildRevokeFailStatements({
            orderId: input.orderId,
            remoteCardId: card.remoteCardId,
            errorCode: input.errorCode,
            requestId: null,
            nowMs,
        }))
        outcome.failed += 1
    }

    return outcome
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

type RemoteRevokeProbe =
    | { ok: true; cardStatus: string; allocationStatus: string }
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
 * 查中心的**卡状态**与**分配状态** —— 两个字段缺一不可，因为它们的取值域完全不同：
 *
 *   · 卡状态（`GET /cards/{id}/status` 的 `data.status`）是**运行态**：
 *     `revoked` / `disabled` / `expired` / `exhausted` / `active`。
 *     ⚠️ **永远不会是 `sold`** —— 拿它判「中心是否已售出」是恒假条件。
 *     这里只用它识别 `revoked`（幂等补记：首次调用成功但响应丢了）。
 *   · 分配状态（`data.allocation_status`，或 `GET /allocations/{id}` 的 `status`）
 *     才是生命周期：`unallocated`/`allocated`/`acknowledged`/`sold`/`cancelled`/`expired`。
 *     **只有它**能回答「这批卡是否已经卖给了某个订单」。
 *
 * 卡状态响应里通常直接带 `allocation_status`，省一次往返；缺失时再按 `allocationId`
 * 单查分配。**只在调用方真的需要分配状态时才回退**（`needAllocationStatus`）——
 * 409 分支只关心卡是否已 `revoked`，多打一次分配查询毫无意义。
 *
 * 不可用类错误（429/503/超时）交给调用方决定「等下一轮」，查不到等确定性错误按
 * 「未知」处理 —— 未知时**保留**本地映射，绝不默认作废（作废不回库存，误判等于
 * 白丢一张卡）。
 */
async function probeRemoteCardStatus(
    deps: RevokeDeps,
    remoteCardId: string,
    options: { allocationId: string; needAllocationStatus: boolean },
): Promise<RemoteRevokeProbe> {
    let cardStatus = 'unknown'
    let inlineStatus = ''

    try {
        const detail = await runWithRetry(
            () => deps.client.getCardStatus(remoteCardId),
            retryOptions(deps, 'getCardStatus'),
        )
        cardStatus = (detail.status || '').toLowerCase()
        inlineStatus = (detail.allocationStatus || '').toLowerCase()
        // 空 `allocation_status` 不能当作「未售出」——那是字段缺失，必须再单查一次。
        if (inlineStatus || !options.needAllocationStatus) {
            return { ok: true, cardStatus, allocationStatus: inlineStatus }
        }
    } catch (error) {
        const classified = toLicenseServiceError(error, 'getCardStatus')
        if (classified.category === 'unavailable') return { ok: false, error: classified }
        // 卡本身查不到（not_found 等）：分配状态仍值得一问。
        cardStatus = 'unknown'
        if (!options.needAllocationStatus) {
            return { ok: true, cardStatus, allocationStatus: '' }
        }
    }

    if (!options.allocationId) return { ok: true, cardStatus, allocationStatus: 'unknown' }

    try {
        const allocation = await runWithRetry(
            () => deps.client.getAllocation(options.allocationId),
            retryOptions(deps, 'getAllocation'),
        )
        return { ok: true, cardStatus, allocationStatus: (allocation.status || '').toLowerCase() }
    } catch (error) {
        const classified = toLicenseServiceError(error, 'getAllocation')
        if (classified.category === 'unavailable') return { ok: false, error: classified }
        return { ok: true, cardStatus, allocationStatus: 'unknown' }
    }
}

function classifyRevokeFailure(category: LicenseServiceErrorCategory): 'deferred' | 'failed' {
    return category === 'unavailable' ? 'deferred' : 'failed'
}

/**
 * 卡运行态里**唯一**「明确可用」的取值。
 *
 * 注意这是**白名单**：判定「能不能放回可售池」时，必须由中心**明确确认**卡可用。
 * 拿黑名单（只排除几个已知坏状态）会把新增状态、字段缺失、读不到的 `unknown`
 * 一并当成「可用」—— 而那正是「买得下、发不出」的订单来源。
 */
export const USABLE_REMOTE_CARD_STATUS = 'active'

/**
 * 卡运行态里「明确不可用」的取值：中心卖不出去，放回库存只会制造发不出的订单。
 * `revoked` 不在此列 —— 它单独走幂等补记（首次 revoke 其实成功了、只是响应丢了）。
 */
export const DEAD_REMOTE_CARD_STATUSES = ['disabled', 'expired', 'exhausted'] as const

/** 分配状态里「仍归本店持有、且尚未售出」的取值 —— 放回库存的必要条件。 */
export const SHOP_HELD_ALLOCATION_STATUSES = ['allocated', 'acknowledged'] as const

/**
 * 分配状态里「已被中心回收」的取值。
 *
 * 这两个状态下卡密可能已经回到中心的可用池、甚至已被别的 Program 领走。
 * 因此既**不能放回本地库存**（会再卖一次），也**不能凭本单退款去吊销**
 * （吊销可能落在已经不属于本店的卡上）—— 只能交人工核查。
 */
export const DEAD_ALLOCATION_STATUSES = ['expired', 'cancelled'] as const

/**
 * 「未交付映射」（本地 `acknowledged`）在探测中心之后的处置结论。
 *
 *   reclaim  卡已 `revoked`：幂等补记本地终态（首次调用成功、响应丢了）
 *   revoke   必须作废（分配已售给本单 / 卡已明确不可用）
 *   retain   放回可售池（**仅当**卡明确可用 **且** 分配仍归本店持有）
 *   defer    暂时拿不到结论（未知）：保留隔离与待办，等下一轮重放
 *   review   结论明确但不该自动处置（分配已回收 / 状态不认识）：保留隔离，交人工
 */
export type AcknowledgedProbeDisposition =
    | { kind: 'reclaim' }
    | { kind: 'revoke' }
    | { kind: 'retain' }
    | { kind: 'defer'; errorCode: string }
    | { kind: 'review'; errorCode: string }

/**
 * 判定「未交付的远端卡」该怎么处置。
 *
 * 核心是**两道都必须是「明确确认」**：卡确实可用 + 分配确实还在本店手上。
 * 只判一半都会出事：
 *
 *   - 只看分配状态 → `disabled`/`expired`/`exhausted` 的卡会被放回可售池，
 *     顾客买下后 Sell 必然失败（「买了发不出」）；
 *   - 只看卡状态 → 分配已 `expired`/`cancelled` 时，卡密可能已被中心回收或
 *     归了别人，放回库存等于把别人的卡再卖一次。
 *
 * 「不是 sold」**远不等于**「仍可售」—— 分配还有 `expired`/`cancelled` 两个终态，
 * 卡的运行态还有四种非可用取值。所以这里穷举取值域，不认识的一律人工核查。
 */
export function classifyAcknowledgedProbe(input: {
    cardStatus: string
    allocationStatus: string
}): AcknowledgedProbeDisposition {
    const cardStatus = (input.cardStatus || '').toLowerCase()
    const allocationStatus = (input.allocationStatus || '').toLowerCase()

    if (cardStatus === 'revoked') return { kind: 'reclaim' }
    // 未知（查询失败/字段缺失/本地没有 allocationId）**不是**「仍可售」的证据。
    if (!allocationStatus || allocationStatus === 'unknown') {
        return { kind: 'defer', errorCode: 'remote_status_unknown' }
    }
    if (allocationStatus === 'sold') return { kind: 'revoke' }
    if ((DEAD_ALLOCATION_STATUSES as readonly string[]).includes(allocationStatus)) {
        return { kind: 'review', errorCode: 'allocation_unusable' }
    }
    if (!(SHOP_HELD_ALLOCATION_STATUSES as readonly string[]).includes(allocationStatus)) {
        // `unallocated` 或将来新增的取值：不猜。既不放回库存，也不自动吊销。
        return { kind: 'review', errorCode: 'allocation_not_held' }
    }
    // 分配确实还在本店手上，还要卡本身能卖。
    if ((DEAD_REMOTE_CARD_STATUSES as readonly string[]).includes(cardStatus)) {
        return { kind: 'revoke' }
    }
    if (cardStatus !== USABLE_REMOTE_CARD_STATUS) {
        // 读不到卡状态、或取值不在已知域内 —— 同样不是「可售」的证据。
        return { kind: 'review', errorCode: 'card_status_unusable' }
    }
    return { kind: 'retain' }
}

async function revokeOneCard(
    deps: RevokeDeps,
    input: { orderId: string; card: OrderRevokeCard; reason: string },
    outcome: RevokeOutcome,
): Promise<void> {
    const now = resolveNow(deps)
    const { card, orderId, reason } = input

    // 未交付的卡先问中心，再按**明确确认**的事实决定：作废 / 保留库存 / 延后 / 人工复核。
    if (card.state === 'acknowledged') {
        const probe = await probeRemoteCardStatus(deps, card.remoteCardId, {
            allocationId: card.allocationId,
            needAllocationStatus: true,
        })
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
        // 「不是 sold」远不等于「仍可售」：处置口径全部交给纯函数判定，穷举取值域。
        const disposition = classifyAcknowledgedProbe({
            cardStatus: probe.cardStatus,
            allocationStatus: probe.allocationStatus,
        })
        if (disposition.kind === 'reclaim') {
            // 幂等补记：首次 `revoke` 其实成功了，只是响应丢了。
            await deps.database.write(buildRevokeSuccessStatements({ orderId, remoteCardId: card.remoteCardId, nowMs: now() }))
            outcome.revoked += 1
            return
        }
        if (disposition.kind === 'defer') {
            // 暂时拿不到结论：保留隔离与待办，等下一次重放。
            await deps.database.write(buildRevokeDeferStatements({
                orderId,
                remoteCardId: card.remoteCardId,
                errorCode: disposition.errorCode,
                requestId: null,
                nextRetryAtMs: now(),
                nowMs: now(),
            }))
            outcome.deferred += 1
            return
        }
        if (disposition.kind === 'review') {
            // 分配已被中心回收 / 状态不认识：既不放回库存（会再卖一次），也不自动吊销
            // （可能落在已不属于本店的卡上）。待办置 `failed` 进运维面板复核清单。
            await deps.database.write(buildRevokeFailStatements({
                orderId,
                remoteCardId: card.remoteCardId,
                errorCode: disposition.errorCode,
                requestId: null,
                nowMs: now(),
            }))
            outcome.failed += 1
            return
        }
        if (disposition.kind === 'retain') {
            // **明确确认**卡可用（`active`）**且**分配仍归本店持有（`allocated`/`acknowledged`）：
            // 作废只会白丢一张库存。保留映射，本地预留由退款批次释放，它可以被另一笔订单卖出去。
            await deps.database.write(buildRevokeRetainStatements({
                orderId,
                remoteCardId: card.remoteCardId,
                localCardId: card.localCardId,
                nowMs: now(),
            }))
            outcome.retained += 1
            return
        }
        // `disposition.kind === 'revoke'`：分配已 `sold`（交付时 Sell 成功但本地没落上账，
        // 响应丢了 —— 「未展示但已 Sell」），或卡已明确不可用（`disabled`/`expired`/
        // `exhausted`，放回库存只会制造发不出的订单）。两者都必须作废。
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
            // 409 一律不重试：先用单查核实真实状态。卡已 `revoked` 说明首次其实
            // 成功了（响应丢失），补记终态；其余冲突交人工核查。
            const probe = await probeRemoteCardStatus(deps, card.remoteCardId, {
                allocationId: card.allocationId,
                needAllocationStatus: false,
            })
            if (probe.ok && probe.cardStatus === 'revoked') {
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
): Promise<RevokeOutcome & { attempted: number; review: number; orderIds: string[] }> {
    const outcome = { ...emptyRevokeOutcome(), attempted: 0, review: 0, orderIds: [] as string[] }
    const operations = await listPendingRevokeOperations(deps.database, { limit: options.limit ?? 20, respectBackoff: true })

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
        // 真正动过本地卡的订单才需要重算前台库存（作废会隔离本地卡、保留会放回库存）。
        if (!outcome.orderIds.includes(orderId)) outcome.orderIds.push(orderId)
    }

    return outcome
}
