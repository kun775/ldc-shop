import { db } from '@/lib/db'
import { and, gte, lte, sql, type SQL } from 'drizzle-orm'
import { assertAuditStructureReady } from './service'
import {
    AUDIT_CATEGORIES,
    AUDIT_EVENT_NAMES,
    AUDIT_RESULTS,
    AUDIT_SEVERITIES,
    type AuditCategory,
    type AuditResult,
    type AuditSeverity,
} from './events'

/**
 * 审计读取层。
 *
 * 三条约束：
 *   1. **服务端分页 + 稳定排序**：排序键固定为 `(created_at DESC, id DESC)`。
 *      只按时间排序时，同一毫秒内的多条记录顺序在 D1 上并不保证稳定，
 *      翻页会出现重复或漏项；加上唯一列 id 后排序完全确定。
 *   2. **只读**：本模块不修改任何审计原始字段。平台错误的处理状态
 *      通过独立字段更新（见 `markPlatformErrorHandled`）。
 *   3. **白名单筛选**：筛选值先对照枚举校验，非法值直接忽略而不是
 *      拼进 SQL —— 避免任意字符串进入查询条件。
 *
 * 所有 SELECT 都显式列出列名（不用 `SELECT *`），这样历史库即使有
 * 未知列也不会把无关数据带进前台。
 */

export const AUDIT_PAGE_SIZE_DEFAULT = 20
export const AUDIT_PAGE_SIZE_MAX = 100

/** 时间筛选上限：查询区间超过该跨度时收敛，避免全表扫描 */
export const AUDIT_MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000

export interface AuditEventRecord {
    id: string
    eventName: string
    category: string
    severity: string
    result: string
    actorType: string
    actorUserId: string | null
    actorUsername: string | null
    targetType: string | null
    targetId: string | null
    errorId: string | null
    errorKey: string | null
    source: string | null
    metadata: string | null
    createdAt: number | null
}

export interface PlatformErrorRecord {
    id: string
    errorId: string | null
    fingerprint: string
    scope: string
    severity: string
    errorCode: string | null
    message: string | null
    stack: string | null
    errorChain: string | null
    actorType: string
    actorUserId: string | null
    actorUsername: string | null
    requestMethod: string | null
    requestPath: string | null
    userAgent: string | null
    occurrenceCount: number
    firstSeenAt: number | null
    lastSeenAt: number | null
    status: string
    handledAt: number | null
    handledBy: string | null
    handleNote: string | null
    createdAt: number | null
}

export interface AuditEventFilters {
    page?: number
    pageSize?: number
    /** 事件名（精确匹配，需在目录内） */
    eventName?: string
    category?: string
    result?: string
    severity?: string
    actorUserId?: string
    targetId?: string
    /** 目标 ID / 用户 ID / 错误 ID 的模糊搜索 */
    query?: string
    errorId?: string
    /** 起始时间（含） */
    from?: number
    /** 结束时间（含） */
    to?: number
}

export interface PlatformErrorFilters {
    page?: number
    pageSize?: number
    scope?: string
    severity?: string
    status?: string
    actorUserId?: string
    errorId?: string
    query?: string
    from?: number
    to?: number
}

export interface PagedResult<T> {
    items: T[]
    total: number
    page: number
    pageSize: number
}

function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
    const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(num) || num <= 0) return fallback
    return Math.min(Math.trunc(num), max)
}

function normalizeText(value: unknown, maxLength = 120): string {
    return String(value ?? '').trim().slice(0, maxLength)
}

function inEnum<T extends string>(value: string, allowed: readonly T[]): T | null {
    return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * LIKE 通配符转义。
 *
 * 用户输入的 `%` 或 `_` 若不转义，会让「搜索 card_k」匹配到「cardXk」，
 * 属于难以察觉的筛选错误。SQLite 下用 ESCAPE 子句显式声明转义字符。
 */
function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function buildTimeRange(from?: number, to?: number): { start: number | null; end: number | null } {
    let start = Number.isFinite(from) && (from as number) > 0 ? Math.trunc(from as number) : null
    let end = Number.isFinite(to) && (to as number) > 0 ? Math.trunc(to as number) : null
    if (start !== null && end !== null && start > end) {
        const swap = start
        start = end
        end = swap
    }
    // 收敛超长区间：区间过宽等于让 D1 扫全表，宁可给一个有限窗口
    if (start !== null && end !== null && end - start > AUDIT_MAX_RANGE_MS) {
        start = end - AUDIT_MAX_RANGE_MS
    }
    return { start, end }
}

function buildAuditEventConditions(filters: AuditEventFilters): SQL[] {
    const conditions: SQL[] = []

    const eventName = inEnum(normalizeText(filters.eventName), AUDIT_EVENT_NAMES as readonly string[])
    if (eventName) {
        conditions.push(sql`event_name = ${eventName}`)
    }

    const category = inEnum(normalizeText(filters.category), AUDIT_CATEGORIES)
    if (category) {
        conditions.push(sql`category = ${category}`)
    }

    const result = inEnum(normalizeText(filters.result), AUDIT_RESULTS)
    if (result) {
        conditions.push(sql`result = ${result}`)
    }

    const severity = inEnum(normalizeText(filters.severity), AUDIT_SEVERITIES)
    if (severity) {
        conditions.push(sql`severity = ${severity}`)
    }

    const actorUserId = normalizeText(filters.actorUserId)
    if (actorUserId) {
        conditions.push(sql`actor_user_id = ${actorUserId}`)
    }

    const targetId = normalizeText(filters.targetId)
    if (targetId) {
        conditions.push(sql`target_id = ${targetId}`)
    }

    const errorId = normalizeText(filters.errorId, 80)
    if (errorId) {
        conditions.push(sql`error_id = ${errorId}`)
    }

    const query = normalizeText(filters.query)
    if (query) {
        const pattern = `%${escapeLikePattern(query)}%`
        conditions.push(sql`(
            target_id LIKE ${pattern} ESCAPE '\\'
            OR actor_user_id LIKE ${pattern} ESCAPE '\\'
            OR error_id LIKE ${pattern} ESCAPE '\\'
            OR COALESCE(actor_username, '') LIKE ${pattern} ESCAPE '\\'
        )`)
    }

    const { start, end } = buildTimeRange(filters.from, filters.to)
    if (start !== null) conditions.push(gte(sql`created_at`, start))
    if (end !== null) conditions.push(lte(sql`created_at`, end))

    return conditions
}

function buildPlatformErrorConditions(filters: PlatformErrorFilters): SQL[] {
    const conditions: SQL[] = []

    const scope = normalizeText(filters.scope, 80)
    if (scope) {
        conditions.push(sql`scope = ${scope}`)
    }

    const severity = inEnum(normalizeText(filters.severity), AUDIT_SEVERITIES)
    if (severity) {
        conditions.push(sql`severity = ${severity}`)
    }

    const status = inEnum(normalizeText(filters.status), ['open', 'handled'] as const)
    if (status) {
        conditions.push(sql`status = ${status}`)
    }

    const actorUserId = normalizeText(filters.actorUserId)
    if (actorUserId) {
        conditions.push(sql`actor_user_id = ${actorUserId}`)
    }

    // 错误 ID 支持用户可见 errorId、平台记录 id 与指纹三种口径。
    const errorId = normalizeText(filters.errorId, 80)
    if (errorId) {
        const pattern = `%${escapeLikePattern(errorId)}%`
        conditions.push(sql`(
            COALESCE(error_id, '') LIKE ${pattern} ESCAPE '\\'
            OR id LIKE ${pattern} ESCAPE '\\'
            OR fingerprint LIKE ${pattern} ESCAPE '\\'
        )`)
    }

    const query = normalizeText(filters.query)
    if (query) {
        const pattern = `%${escapeLikePattern(query)}%`
        conditions.push(sql`(
            COALESCE(message, '') LIKE ${pattern} ESCAPE '\\'
            OR COALESCE(error_code, '') LIKE ${pattern} ESCAPE '\\'
            OR COALESCE(request_path, '') LIKE ${pattern} ESCAPE '\\'
            OR scope LIKE ${pattern} ESCAPE '\\'
        )`)
    }

    const { start, end } = buildTimeRange(filters.from, filters.to)
    if (start !== null) conditions.push(gte(sql`last_seen_at`, start))
    if (end !== null) conditions.push(lte(sql`last_seen_at`, end))

    return conditions
}

function whereClause(conditions: SQL[]): SQL | undefined {
    if (conditions.length === 0) return undefined
    if (conditions.length === 1) return conditions[0]
    return and(...conditions)
}

function rowsFromResult<T>(result: unknown): T[] {
    const value = result as { results?: T[]; rows?: T[] }
    return value?.results || value?.rows || []
}

/**
 * readAuditEvents 查询用户操作审计事件（服务端分页）。
 */
export async function readAuditEvents(
    filters: AuditEventFilters = {},
): Promise<PagedResult<AuditEventRecord>> {
    await assertAuditStructureReady()

    const requestedPage = normalizePositiveInt(filters.page, 1, 100000)
    const pageSize = normalizePositiveInt(filters.pageSize, AUDIT_PAGE_SIZE_DEFAULT, AUDIT_PAGE_SIZE_MAX)
    const where = whereClause(buildAuditEventConditions(filters))

    const countResult = await db.run(sql`
        SELECT COUNT(*) AS total FROM audit_events
        ${where ? sql`WHERE ${where}` : sql``}
    `)
    const total = Number(rowsFromResult<{ total?: unknown }>(countResult)[0]?.total || 0)
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)))

    if (total === 0) {
        return { items: [], total: 0, page, pageSize }
    }

    const offset = (page - 1) * pageSize
    const rowsResult = await db.run(sql`
        SELECT
            id,
            event_name AS eventName,
            category,
            severity,
            result,
            actor_type AS actorType,
            actor_user_id AS actorUserId,
            actor_username AS actorUsername,
            target_type AS targetType,
            target_id AS targetId,
            error_id AS errorId,
            error_key AS errorKey,
            source,
            metadata,
            created_at AS createdAt
        FROM audit_events
        ${where ? sql`WHERE ${where}` : sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageSize} OFFSET ${offset}
    `)

    return {
        items: rowsFromResult<AuditEventRecord>(rowsResult),
        total,
        page,
        pageSize,
    }
}

/**
 * readAuditEvent 按 id 读取单条审计事件（详情页用）。
 */
export async function readAuditEvent(id: string): Promise<AuditEventRecord | null> {
    const normalized = normalizeText(id, 120)
    if (!normalized) return null
    await assertAuditStructureReady()

    const result = await db.run(sql`
        SELECT
            id,
            event_name AS eventName,
            category,
            severity,
            result,
            actor_type AS actorType,
            actor_user_id AS actorUserId,
            actor_username AS actorUsername,
            target_type AS targetType,
            target_id AS targetId,
            error_id AS errorId,
            error_key AS errorKey,
            source,
            metadata,
            created_at AS createdAt
        FROM audit_events
        WHERE id = ${normalized}
        LIMIT 1
    `)
    return rowsFromResult<AuditEventRecord>(result)[0] ?? null
}

/**
 * readPlatformErrors 查询平台错误日志（服务端分页）。
 *
 * 默认按「最近发生」排序，因为管理员关心的是还在持续发生的错误，
 * 而不是最早出现的那条。
 */
export async function readPlatformErrors(
    filters: PlatformErrorFilters = {},
): Promise<PagedResult<PlatformErrorRecord>> {
    await assertAuditStructureReady()

    const requestedPage = normalizePositiveInt(filters.page, 1, 100000)
    const pageSize = normalizePositiveInt(filters.pageSize, AUDIT_PAGE_SIZE_DEFAULT, AUDIT_PAGE_SIZE_MAX)
    const where = whereClause(buildPlatformErrorConditions(filters))

    const countResult = await db.run(sql`
        SELECT COUNT(*) AS total FROM platform_error_logs
        ${where ? sql`WHERE ${where}` : sql``}
    `)
    const total = Number(rowsFromResult<{ total?: unknown }>(countResult)[0]?.total || 0)
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)))

    if (total === 0) {
        return { items: [], total: 0, page, pageSize }
    }

    const offset = (page - 1) * pageSize
    const rowsResult = await db.run(sql`
        SELECT
            id,
            error_id AS errorId,
            fingerprint,
            scope,
            severity,
            error_code AS errorCode,
            message,
            stack,
            error_chain AS errorChain,
            actor_type AS actorType,
            actor_user_id AS actorUserId,
            actor_username AS actorUsername,
            request_method AS requestMethod,
            request_path AS requestPath,
            user_agent AS userAgent,
            occurrence_count AS occurrenceCount,
            first_seen_at AS firstSeenAt,
            last_seen_at AS lastSeenAt,
            status,
            handled_at AS handledAt,
            handled_by AS handledBy,
            handle_note AS handleNote,
            created_at AS createdAt
        FROM platform_error_logs
        ${where ? sql`WHERE ${where}` : sql``}
        ORDER BY last_seen_at DESC, id DESC
        LIMIT ${pageSize} OFFSET ${offset}
    `)

    return {
        items: rowsFromResult<PlatformErrorRecord>(rowsResult),
        total,
        page,
        pageSize,
    }
}

/**
 * readPlatformError 按 id 读取单条错误日志（详情用）。
 */
export async function readPlatformError(id: string): Promise<PlatformErrorRecord | null> {
    const normalized = normalizeText(id, 120)
    if (!normalized) return null
    await assertAuditStructureReady()

    const result = await db.run(sql`
        SELECT
            id,
            error_id AS errorId,
            fingerprint,
            scope,
            severity,
            error_code AS errorCode,
            message,
            stack,
            error_chain AS errorChain,
            actor_type AS actorType,
            actor_user_id AS actorUserId,
            actor_username AS actorUsername,
            request_method AS requestMethod,
            request_path AS requestPath,
            user_agent AS userAgent,
            occurrence_count AS occurrenceCount,
            first_seen_at AS firstSeenAt,
            last_seen_at AS lastSeenAt,
            status,
            handled_at AS handledAt,
            handled_by AS handledBy,
            handle_note AS handleNote,
            created_at AS createdAt
        FROM platform_error_logs
        WHERE id = ${normalized}
        LIMIT 1
    `)
    return rowsFromResult<PlatformErrorRecord>(result)[0] ?? null
}

export interface AuditSummary {
    eventTotal: number
    eventFailures: number
    openErrors: number
    errorTotal: number
}

/**
 * readAuditSummary 读取概览计数（后台顶部指标用）。
 *
 * 三条 COUNT 一律带索引列条件，避免全表扫描。
 */
export async function readAuditSummary(nowMs: number = Date.now()): Promise<AuditSummary> {
    await assertAuditStructureReady()
    const dayAgo = nowMs - 24 * 60 * 60 * 1000

    const [eventResult, failureResult, openErrorResult, errorTotalResult] = await Promise.all([
        db.run(sql`SELECT COUNT(*) AS total FROM audit_events WHERE created_at >= ${dayAgo}`),
        db.run(sql`SELECT COUNT(*) AS total FROM audit_events WHERE result = 'failure' AND created_at >= ${dayAgo}`),
        db.run(sql`SELECT COUNT(*) AS total FROM platform_error_logs WHERE status = 'open'`),
        db.run(sql`SELECT COUNT(*) AS total FROM platform_error_logs`),
    ])

    const pick = (result: unknown) => Number(rowsFromResult<{ total?: unknown }>(result)[0]?.total || 0)

    return {
        eventTotal: pick(eventResult),
        eventFailures: pick(failureResult),
        openErrors: pick(openErrorResult),
        errorTotal: pick(errorTotalResult),
    }
}

export interface AuditFilterOption {
    value: string
    count: number
}

/**
 * readAuditEventNameOptions 读取实际出现过的事件名与条数。
 *
 * 不直接用静态目录：静态目录会让筛选下拉里出现「从未发生」的选项，
 * 也没法按发生频次排序。取实际值 + 兜底常量，两者合并。
 */
export async function readAuditEventNameOptions(): Promise<string[]> {
    await assertAuditStructureReady()
    const result = await db.run(sql`
        SELECT event_name AS name, COUNT(*) AS total
        FROM audit_events
        GROUP BY event_name
        ORDER BY total DESC
        LIMIT 50
    `)
    const seen = rowsFromResult<{ name?: unknown }>(result)
        .map((row) => String(row.name || '').trim())
        .filter(Boolean)
    const merged = new Set<string>(seen)
    for (const name of AUDIT_EVENT_NAMES) merged.add(name)
    return [...merged]
}

/**
 * markPlatformErrorHandled 更新错误处理状态。
 *
 * 只更新 status/handled_at/handled_by/handle_note/updated_at 五个字段，
 * 原始错误内容（指纹、消息、堆栈、上下文）**不可修改** —— 符合计划
 * 要求的「审计记录只允许追加」。
 *
 * 已处理的记录再次提交时更新说明与处理人（便于补充结论），但不回写
 * 原始字段。返回受影响行数，0 表示记录不存在。
 */
export async function markPlatformErrorHandled(input: {
    id: string
    handledBy: string
    note?: string | null
    nowMs?: number
}): Promise<number> {
    const id = normalizeText(input.id, 120)
    if (!id) return 0
    await assertAuditStructureReady()

    const now = input.nowMs ?? Date.now()
    const note = input.note ? normalizeText(input.note, 1000) : null

    const result = await db.run(sql`
        UPDATE platform_error_logs
        SET
            status = 'handled',
            handled_at = ${now},
            handled_by = ${normalizeText(input.handledBy, 120) || 'unknown'},
            handle_note = ${note},
            updated_at = ${now}
        WHERE id = ${id}
    `)

    const meta = (result as { meta?: { changes?: unknown } } | undefined)?.meta
    return Number(meta?.changes ?? 0)
}

/**
 * reopenPlatformError 把已处理的错误重新标记为未处理。
 *
 * 为什么需要：「标记已处理」是人工判断，判断错了必须能撤回，
 * 否则错误会被永久埋掉。处理说明保留（它是历史判断的记录）。
 */
export async function reopenPlatformError(input: {
    id: string
    handledBy: string
    nowMs?: number
}): Promise<number> {
    const id = normalizeText(input.id, 120)
    if (!id) return 0
    await assertAuditStructureReady()

    const now = input.nowMs ?? Date.now()
    const result = await db.run(sql`
        UPDATE platform_error_logs
        SET
            status = 'open',
            handled_at = NULL,
            handled_by = ${normalizeText(input.handledBy, 120) || 'unknown'},
            updated_at = ${now}
        WHERE id = ${id}
    `)
    const meta = (result as { meta?: { changes?: unknown } } | undefined)?.meta
    return Number(meta?.changes ?? 0)
}

export { AUDIT_CATEGORIES, AUDIT_RESULTS, AUDIT_SEVERITIES, AUDIT_EVENT_NAMES }
export type { AuditCategory, AuditResult, AuditSeverity }
