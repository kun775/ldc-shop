import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { createAsyncOnceState, ensureOnce } from '@/lib/runtime/async-once'
import { isEmptySchemaError, isDuplicateColumnError, isDuplicateSchemaObjectError } from '@/lib/db/error-utils'
import {
    AUDIT_EVENTS_COLUMN_DEFINITIONS,
    AUDIT_EVENTS_CREATE_TABLE_STATEMENT,
    AUDIT_EVENTS_INDEX_STATEMENTS,
    AUDIT_EVENTS_TABLE,
    PLATFORM_ERROR_LOGS_COLUMN_DEFINITIONS,
    PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT,
    PLATFORM_ERROR_LOGS_ERROR_ID_COLUMN_DEFINITION,
    PLATFORM_ERROR_LOGS_ERROR_ID_INDEX_STATEMENT,
    PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_NAME,
    PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT,
    PLATFORM_ERROR_LOGS_INDEX_STATEMENTS,
    PLATFORM_ERROR_LOGS_TABLE,
    evaluateAuditBaseStructure,
    evaluateAuditStructure,
    type AuditTableStructureSnapshot,
} from '@/lib/db/audit-schema'
import {
    buildErrorFingerprint,
    buildFingerprintBucket,
    hashIdentifier,
    redactText,
    sanitizeMetadata,
    truncateText,
    AUDIT_ERROR_CHAIN_MAX_LENGTH,
    AUDIT_MESSAGE_MAX_LENGTH,
    AUDIT_STACK_MAX_LENGTH,
    AUDIT_USER_AGENT_MAX_LENGTH,
} from './sanitize'
import {
    resolveAuditEvent,
    type AuditActorType,
    type AuditEventInput,
    type AuditSeverity,
} from './events'

/**
 * 审计写出服务。
 *
 * 三条不可协商的约束（来自开发计划 §八「写入约束」）：
 *
 * 1. **best-effort：审计失败不得影响业务结果。**
 *    所有导出函数都返回 `Promise<void>` 且**永不抛出**。任何异常只写
 *    `console.error`。调用方可以 `await` 也可以不 await，都不会因审计出错
 *    而回滚一次成功的下单或退款。
 *
 * 2. **不递归记录自身错误。**
 *    审计写入失败时若再走一次错误采集，就会形成「写失败 → 记录失败 →
 *    写失败」的无限放大。因此本模块内部的失败路径只输出到 console，
 *    绝不调用 `recordPlatformError`。
 *
 * 3. **不产生额外数据库往返。**
 *    `writeAuditEvent` 做单条 INSERT；`writePlatformError` 做单条
 *    `INSERT ... ON CONFLICT DO UPDATE`（聚合）。没有「先查后写」，
 *    也就没有并发下的重复行与计数放大。
 */

let auditSchemaReady = false
const auditSchemaState = createAsyncOnceState()

/** 递归保护：正在写审计时再次进入审计写入，直接丢弃 */
let auditWriteInFlight = 0
const MAX_AUDIT_WRITE_DEPTH = 3

function rowsFromResult<T>(result: unknown): T[] {
    const value = result as { results?: T[]; rows?: T[] }
    return value?.results || value?.rows || []
}

async function safeAddColumn(table: string, column: string, definition: string) {
    try {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`))
    } catch (error: unknown) {
        if (!isDuplicateColumnError(error)) throw error
    }
}

async function safeRunStatement(statement: string) {
    try {
        await db.run(sql.raw(statement))
    } catch (error: unknown) {
        if (isDuplicateSchemaObjectError(error)) return
        throw error
    }
}

async function ensureSettingsTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
}

async function getSettingValue(key: string): Promise<string | null> {
    await ensureSettingsTable()
    const rows = await db.select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
    return rows[0]?.value ?? null
}

async function setSettingValue(key: string, value: string) {
    await ensureSettingsTable()
    await db.insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
        })
}

/**
 * readAuditStructure 只读探测审计表结构。
 *
 * 全部只读，任何一步失败都原样抛出 —— 由调用方决定是否升级为修复，
 * 这里绝不吞异常（否则「探测失败」会被误判成「结构完整」）。
 */
async function readAuditStructure(): Promise<AuditTableStructureSnapshot> {
    const [
        auditTableResult,
        auditColumnResult,
        auditIndexResult,
        errorTableResult,
        errorColumnResult,
        errorIndexResult,
    ] = await Promise.all([
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = ${AUDIT_EVENTS_TABLE}
            LIMIT 1
        `),
        db.run(sql.raw(`PRAGMA table_info(${AUDIT_EVENTS_TABLE})`)),
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = ${AUDIT_EVENTS_TABLE}
        `),
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = ${PLATFORM_ERROR_LOGS_TABLE}
            LIMIT 1
        `),
        db.run(sql.raw(`PRAGMA table_info(${PLATFORM_ERROR_LOGS_TABLE})`)),
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = ${PLATFORM_ERROR_LOGS_TABLE}
        `),
    ])

    const names = (result: unknown) => rowsFromResult<{ name?: unknown }>(result)
        .map((row) => String(row.name || ''))

    return {
        auditEventsTableExists: names(auditTableResult).length > 0,
        auditEventsColumns: names(auditColumnResult),
        auditEventsIndexes: names(auditIndexResult),
        platformErrorTableExists: names(errorTableResult).length > 0,
        platformErrorColumns: names(errorColumnResult),
        platformErrorIndexes: names(errorIndexResult),
    }
}

/**
 * repairAuditBaseStructure 幂等修复 0030 审计基础结构（无条件 DDL）。
 *
 * 铁律（与积分账本一致）：
 *   - **不**用版本号短路 DDL。结构标记可能领先真实结构，一旦如此，
 *     缺列将永久无法自愈。所有语句都是幂等的。
 *   - 唯一索引必须走独立 `CREATE UNIQUE INDEX IF NOT EXISTS`（不带在
 *     CREATE TABLE 里），这样历史表也能补上约束。
 */
async function repairAuditBaseStructure(): Promise<number> {
    const persistedVersion = await getSettingValue('audit_schema_version')

    // 先探测，再按需修复：探测失败（瞬时网络错误）向上抛出，
    // 不会退化成「无条件重跑一遍 DDL」。
    const snapshot = await readAuditStructure()
    const verdict = evaluateAuditBaseStructure(snapshot)

    if (!snapshot.auditEventsTableExists) {
        await db.run(sql.raw(AUDIT_EVENTS_CREATE_TABLE_STATEMENT))
    }
    for (const [column, definition] of AUDIT_EVENTS_COLUMN_DEFINITIONS) {
        if (!snapshot.auditEventsTableExists || verdict.missingColumns.includes(column)) {
            await safeAddColumn(AUDIT_EVENTS_TABLE, column, definition)
        }
    }
    for (const statement of AUDIT_EVENTS_INDEX_STATEMENTS) {
        await safeRunStatement(statement)
    }

    if (!snapshot.platformErrorTableExists) {
        await db.run(sql.raw(PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT))
    }
    for (const [column, definition] of PLATFORM_ERROR_LOGS_COLUMN_DEFINITIONS) {
        if (!snapshot.platformErrorTableExists || verdict.missingColumns.includes(column)) {
            await safeAddColumn(PLATFORM_ERROR_LOGS_TABLE, column, definition)
        }
    }
    for (const statement of PLATFORM_ERROR_LOGS_INDEX_STATEMENTS) {
        await safeRunStatement(statement)
    }
    await safeRunStatement(PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT)

    if (persistedVersion !== AUDIT_SCHEMA_VERSION) {
        await setSettingValue('audit_schema_version', AUDIT_SCHEMA_VERSION)
    }
    auditSchemaReady = true

    return verdict.complete ? 0 : 1
}

export const AUDIT_SCHEMA_VERSION = '1'

/** 0031：仅补充平台错误与用户可见 errorId 的关联能力。 */
async function repairAuditErrorIdStructure(): Promise<number> {
    const snapshot = await readAuditStructure()
    const verdict = evaluateAuditStructure(snapshot)
    const [column, definition] = PLATFORM_ERROR_LOGS_ERROR_ID_COLUMN_DEFINITION

    if (!snapshot.platformErrorTableExists) {
        throw new Error('AUDIT_BASE_STRUCTURE_NOT_READY')
    }
    if (!snapshot.platformErrorColumns.includes(column)) {
        await safeAddColumn(PLATFORM_ERROR_LOGS_TABLE, column, definition)
    }
    await safeRunStatement(PLATFORM_ERROR_LOGS_ERROR_ID_INDEX_STATEMENT)
    return verdict.complete ? 0 : 1
}

/**
 * ensureAuditTables 确保 0030 审计基础表与索引存在（isolate 级只执行一次）。
 *
 * 仅供管理员手动数据库升级或显式结构修复路径调用；普通页面、后台查询和
 * 审计写入不得调用本函数，避免业务请求隐式执行 DDL。
 *
 * 参数:
 *   - force: 跳过 isolate 级 ready 标记，强制重新探测并修复（漂移路径使用）
 */
export async function ensureAuditTables(options?: { force?: boolean }) {
    if (options?.force) {
        await repairAuditBaseStructure()
        return
    }
    if (auditSchemaReady) return
    await ensureOnce(auditSchemaState, async () => {
        await repairAuditBaseStructure()
    })
}

/**
 * resetAuditSchemaReady 复位 isolate 级结构标记。
 *
 * 用于结构漂移路径：全局快速路径可能已把审计表标记为 ready，
 * 必须先复位，否则 ensureAuditTables 会被短路而无法修复。
 */
export function resetAuditSchemaReady() {
    auditSchemaReady = false
    auditSchemaState.ready = false
    auditSchemaState.pending = null
}

export function isAuditSchemaReady(): boolean {
    return auditSchemaReady
}

/**
 * verifyAuditStructure 只读校验结构完整（不执行任何 DDL）。
 *
 * 供 `detectSchemaDrift` 这类「先探测、后决定是否迁移」的路径使用。
 * 探测失败（网络/限流/超时）不构成「结构缺失」的证据，按完整处理，
 * 避免把一次偶发故障升级为一次全量迁移。
 */
export async function verifyAuditStructure(): Promise<boolean> {
    try {
        const snapshot = await readAuditStructure()
        return evaluateAuditStructure(snapshot).complete
    } catch (error) {
        if (isEmptySchemaError(error)) return true
        console.warn('[Audit] structure verification failed:', error)
        return true
    }
}

/** 只校验 0030 所拥有的基础结构，不把 0031 的列错误归属给旧升级项。 */
export async function verifyAuditBaseStructure(): Promise<boolean> {
    try {
        const snapshot = await readAuditStructure()
        return evaluateAuditBaseStructure(snapshot).complete
    } catch (error) {
        if (isEmptySchemaError(error)) return true
        console.warn('[Audit] base structure verification failed:', error)
        return true
    }
}

/**
 * 后台查询前的只读就绪检查。
 *
 * 普通请求和审计写入都不得执行 DDL；未升级时明确抛出稳定错误码，由后台
 * 展示“请先执行数据库升级”，而不是访问页面时隐式建表。
 */
export async function assertAuditStructureReady(): Promise<void> {
    const snapshot = await readAuditStructure()
    if (!evaluateAuditStructure(snapshot).complete) {
        throw new Error('AUDIT_INFRASTRUCTURE_NOT_READY')
    }
}

/**
 * repairAuditStructureIfNeeded 按探测结果修复 0030 基础结构，完整时零 DDL。
 *
 * 与 ensureAuditTables 的区别：本函数**不依赖 isolate 级 ready 标记**，
 * 用于结构漂移路径下的强制复查。
 */
export async function repairAuditStructureIfNeeded(): Promise<boolean> {
    const repaired = await repairAuditBaseStructure()
    return repaired > 0
}

export async function repairAuditErrorIdStructureIfNeeded(): Promise<boolean> {
    const repaired = await repairAuditErrorIdStructure()
    return repaired > 0
}

function createAuditId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** 审计写入深度守卫：进入时 +1，退出时 -1 */
function enterAuditWrite(): boolean {
    if (auditWriteInFlight >= MAX_AUDIT_WRITE_DEPTH) return false
    auditWriteInFlight += 1
    return true
}

function exitAuditWrite() {
    auditWriteInFlight = Math.max(0, auditWriteInFlight - 1)
}

/** 从任意错误对象提取错误码（不含消息，避免把敏感信息带出来） */
function extractErrorCode(error: unknown): string | null {
    const seen = new Set<object>()
    let current: unknown = error
    for (let depth = 0; current != null && depth < 6; depth += 1) {
        if (typeof current !== 'object' && typeof current !== 'function') break
        const record = current as object
        if (seen.has(record)) break
        seen.add(record)

        for (const field of ['code', 'name'] as const) {
            try {
                const value = (current as Record<string, unknown>)[field]
                if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80)
            } catch {
                // 忽略异常 getter
            }
        }
        try {
            current = (current as { cause?: unknown }).cause
        } catch {
            break
        }
    }
    return null
}

/**
 * buildErrorChain 把错误及其嵌套 cause 串成一行（已脱敏、已截断）。
 *
 * 只取 name/code/message 三个字段：堆栈里可能带路径与变量值，
 * 完整堆栈另有 `stack` 字段单独存储并截断。
 */
function buildErrorChain(error: unknown): string {
    const parts: string[] = []
    const seen = new Set<object>()
    let current: unknown = error

    for (let depth = 0; current != null && depth < 6; depth += 1) {
        if (typeof current === 'string' || typeof current === 'number') {
            parts.push(String(current))
            break
        }
        if (typeof current !== 'object' && typeof current !== 'function') {
            parts.push(String(current))
            break
        }
        const record = current as object
        if (seen.has(record)) break
        seen.add(record)

        for (const field of ['name', 'code', 'message'] as const) {
            try {
                const value = (current as Record<string, unknown>)[field]
                if (typeof value === 'string' || typeof value === 'number') {
                    parts.push(`${field}=${String(value)}`)
                }
            } catch {
                // 忽略异常 getter
            }
        }
        try {
            current = (current as { cause?: unknown }).cause
        } catch {
            break
        }
    }

    return redactText(parts.join(' | '), { maxLength: AUDIT_ERROR_CHAIN_MAX_LENGTH })
}

function extractStack(error: unknown): string | null {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
    try {
        const stack = (error as { stack?: unknown }).stack
        if (typeof stack !== 'string' || !stack.trim()) return null
        return redactText(stack, { maxLength: AUDIT_STACK_MAX_LENGTH })
    } catch {
        return null
    }
}

/**
 * writeAuditEvent 追加一条业务审计事件。
 *
 * **永不抛出**：审计是旁路，任何失败都不得影响业务结果。
 * 调用方通常无需 await —— 但若业务希望「审计失败也不算失败」，
 * 直接 `void writeAuditEvent(...)` 即可。
 */
export async function writeAuditEvent(input: AuditEventInput): Promise<void> {
    if (!enterAuditWrite()) return
    try {
        const resolved = resolveAuditEvent(input)
        if (!resolved.eventName) return

        const metadata = sanitizeMetadata(input.metadata)
        const ipHash = hashIdentifier(input.ip)
        // 邮箱只做哈希校验（不透出明文），不单独落列：`actor_user_id` 才是
        // 稳定的关联键，多存一份邮箱哈希只会造成两个可关联口径不一致。
        if (input.email) hashIdentifier(input.email)

        const now = Date.now()
        await db.run(sql`
            INSERT INTO audit_events (
                id, event_name, category, severity, result, actor_type,
                actor_user_id, actor_username, target_type, target_id,
                error_id, error_key, source, ip_hash, user_agent, metadata, created_at
            ) VALUES (
                ${createAuditId('audit')}, ${resolved.eventName}, ${resolved.category},
                ${resolved.severity}, ${resolved.result}, ${resolved.actorType},
                ${input.actorUserId ? String(input.actorUserId).slice(0, 120) : null},
                ${input.actorUsername ? redactText(input.actorUsername, { maxLength: 120, stripSql: false }) : null},
                ${resolved.targetType},
                ${input.targetId ? String(input.targetId).slice(0, 120) : null},
                ${input.errorId ? String(input.errorId).slice(0, 80) : null},
                ${input.errorKey ? String(input.errorKey).slice(0, 120) : null},
                ${input.source ? String(input.source).slice(0, 120) : null},
                ${ipHash},
                ${input.userAgent ? redactText(input.userAgent, { maxLength: AUDIT_USER_AGENT_MAX_LENGTH, stripSql: false }) : null},
                ${metadata},
                ${now}
            )
        `)
    } catch (error) {
        // 不递归记录：审计自身的失败只输出到 console（见文件头约束 2）
        console.error('[Audit] failed to write audit event', input?.eventName, error)
    } finally {
        exitAuditWrite()
    }
}

export interface PlatformErrorInput {
    scope: string
    error: unknown
    severity?: AuditSeverity
    actorType?: AuditActorType
    actorUserId?: string | null
    actorUsername?: string | null
    method?: string | null
    path?: string | null
    ip?: string | null
    userAgent?: string | null
    errorId?: string | null
    metadata?: unknown
}

/**
 * writePlatformError 记录（或聚合）一条平台错误。
 *
 * 聚合策略：唯一键为 `(fingerprint, fingerprint_bucket)`，
 * 单条 `INSERT ... ON CONFLICT DO UPDATE` 完成：
 *   - 窗口内同指纹 → `occurrence_count + 1`、`last_seen_at` 更新、级别取更高者；
 *   - 窗口外 → 新行，历史行的处理状态不被篡改（复发可见）。
 *
 * **永不抛出**，失败只写 console。
 */
export async function writePlatformError(input: PlatformErrorInput): Promise<void> {
    if (!enterAuditWrite()) return
    try {
        const scope = String(input.scope ?? '').trim().slice(0, 80) || 'unknown'
        const errorCode = extractErrorCode(input.error)
        const rawMessage = input.error && typeof input.error === 'object'
            ? String((input.error as { message?: unknown }).message ?? '')
            : String(input.error ?? '')

        const message = redactText(rawMessage, { maxLength: AUDIT_MESSAGE_MAX_LENGTH })
        const fingerprint = buildErrorFingerprint({ scope, errorCode, message })

        const now = Date.now()
        const bucket = buildFingerprintBucket(now)
        const severity: AuditSeverity = input.severity ?? 'error'
        const ipHash = hashIdentifier(input.ip)

        await db.run(sql`
            INSERT INTO platform_error_logs (
                id, fingerprint, fingerprint_bucket, scope, severity,
                error_id, error_code, message, stack, error_chain,
                actor_type, actor_user_id, actor_username,
                request_method, request_path, ip_hash, user_agent,
                occurrence_count, first_seen_at, last_seen_at,
                status, handled_at, handled_by, handle_note, created_at, updated_at
            ) VALUES (
                ${createAuditId('err')}, ${fingerprint}, ${bucket}, ${scope}, ${severity},
                ${input.errorId ? String(input.errorId).slice(0, 80) : null},
                ${errorCode}, ${message}, ${extractStack(input.error)}, ${buildErrorChain(input.error)},
                ${input.actorType ?? 'system'},
                ${input.actorUserId ? String(input.actorUserId).slice(0, 120) : null},
                ${input.actorUsername ? redactText(input.actorUsername, { maxLength: 120, stripSql: false }) : null},
                ${input.method ? String(input.method).slice(0, 16) : null},
                ${input.path ? redactText(input.path, { maxLength: 300, stripSql: false }) : null},
                ${ipHash},
                ${input.userAgent ? redactText(input.userAgent, { maxLength: AUDIT_USER_AGENT_MAX_LENGTH, stripSql: false }) : null},
                1, ${now}, ${now},
                'open', NULL, NULL, NULL, ${now}, ${now}
            )
            ON CONFLICT(fingerprint, fingerprint_bucket) DO UPDATE SET
                occurrence_count = platform_error_logs.occurrence_count + 1,
                last_seen_at = ${now},
                updated_at = ${now},
                error_id = COALESCE(excluded.error_id, platform_error_logs.error_id),
                message = excluded.message,
                stack = excluded.stack,
                error_chain = excluded.error_chain,
                user_agent = COALESCE(excluded.user_agent, platform_error_logs.user_agent),
                actor_user_id = COALESCE(platform_error_logs.actor_user_id, excluded.actor_user_id),
                actor_username = COALESCE(platform_error_logs.actor_username, excluded.actor_username),
                severity = CASE
                    WHEN platform_error_logs.severity = 'critical' THEN 'critical'
                    WHEN excluded.severity = 'critical' THEN 'critical'
                    WHEN platform_error_logs.severity = 'error' THEN 'error'
                    WHEN excluded.severity = 'error' THEN 'error'
                    WHEN platform_error_logs.severity = 'warning' THEN 'warning'
                    ELSE excluded.severity
                END
        `)
    } catch (error) {
        console.error('[Audit] failed to write platform error log', input?.scope, error)
    } finally {
        exitAuditWrite()
    }
}

/**
 * recordFailure 便捷封装：同时写入业务审计事件与平台错误日志。
 *
 * 用于「业务失败」这一常见组合 —— 失败既要出现在用户操作视图
 * （谁在什么时候失败了），也要出现在平台错误视图（按错误 ID 追踪排查）。
 */
export async function recordFailure(input: AuditEventInput & {
    error: unknown
    scope: string
    method?: string | null
    path?: string | null
}): Promise<void> {
    await Promise.all([
        writeAuditEvent({ ...input, result: 'failure' }),
        writePlatformError({
            scope: input.scope,
            error: input.error,
            actorType: input.actorType,
            actorUserId: input.actorUserId,
            actorUsername: input.actorUsername,
            method: input.method,
            path: input.path,
            ip: input.ip,
            userAgent: input.userAgent,
            errorId: input.errorId,
        }),
    ])
}

/** 仅用于测试清理：重置模块内 isolate 级状态 */
export function __resetAuditModuleStateForTests() {
    auditSchemaReady = false
    auditSchemaState.ready = false
    auditSchemaState.pending = null
    auditWriteInFlight = 0
}

export { AUDIT_EVENTS_TABLE, PLATFORM_ERROR_LOGS_TABLE, PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_NAME }
export { truncateText }
