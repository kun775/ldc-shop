/**
 * 审计基础设施结构定义（常量 + 幂等 DDL）。
 *
 * 为什么独立成文件：
 *   与 `point-ledger-schema.ts` 同一约定 —— 结构语句集中一处，便于
 *     1. 被 `ensureAuditTables()` 无条件幂等执行；
 *     2. 被漂移探测（`schema-drift.ts` / `queries.ts`）以只读方式校验；
 *     3. 单元测试直接断言语句幂等性与字段覆盖。
 *
 * 两张表的职责边界：
 *   - `audit_events`：**业务事件流**（登录、签到、下单、退款、管理员操作）。
 *     只允许追加；原始事件内容不可修改。
 *   - `platform_error_logs`：**错误聚合**。同一个错误指纹在聚合窗口内重复
 *     发生时只累加 `occurrence_count`，不新增行；处理状态用独立字段更新。
 *
 * 为什么错误日志要带 `fingerprint_bucket`：
 *   仅凭 `fingerprint` 做唯一键，会让「很久以前处理过的同一个错误再次爆发」
 *   被折叠进那条已处理的旧记录里，管理员永远看不到复发。把时间桶纳入唯一键后：
 *     窗口内同错误 → 聚合计数（防写入放大）；
 *     窗口外再发生 → 新记录（复发可见），且不篡改历史行的处理状态。
 */

export const AUDIT_EVENTS_TABLE = 'audit_events'
export const PLATFORM_ERROR_LOGS_TABLE = 'platform_error_logs'

export const AUDIT_EVENTS_CREATE_TABLE_STATEMENT = `
    CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        result TEXT NOT NULL DEFAULT 'success',
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_user_id TEXT,
        actor_username TEXT,
        target_type TEXT,
        target_id TEXT,
        error_id TEXT,
        error_key TEXT,
        source TEXT,
        ip_hash TEXT,
        user_agent TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
`

/**
 * 审计表需要保证存在的列。
 *
 * 注意：`ALTER TABLE ... ADD COLUMN` 不允许加「无默认值的 NOT NULL」列，
 * 因此历史必需列一律带默认值，保证对任意历史结构都能安全补齐。
 */
export const AUDIT_EVENTS_COLUMN_DEFINITIONS = [
    ['event_name', "TEXT NOT NULL DEFAULT ''"],
    ['category', "TEXT NOT NULL DEFAULT ''"],
    ['severity', "TEXT NOT NULL DEFAULT 'info'"],
    ['result', "TEXT NOT NULL DEFAULT 'success'"],
    ['actor_type', "TEXT NOT NULL DEFAULT 'system'"],
    ['actor_user_id', 'TEXT'],
    ['actor_username', 'TEXT'],
    ['target_type', 'TEXT'],
    ['target_id', 'TEXT'],
    ['error_id', 'TEXT'],
    ['error_key', 'TEXT'],
    ['source', 'TEXT'],
    ['ip_hash', 'TEXT'],
    ['user_agent', 'TEXT'],
    ['metadata', 'TEXT'],
    ['created_at', 'INTEGER'],
] as const

/**
 * 查询索引。
 *
 * 覆盖计划要求的筛选维度：时间、事件类型、用户 ID、目标类型/ID、结果、
 * 严重级别、错误 ID。每条索引都以时间结尾，保证服务端分页的稳定排序
 * 不需要额外排序步骤。
 */
export const AUDIT_EVENTS_INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS audit_events_created_idx
        ON audit_events (created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_name_created_idx
        ON audit_events (event_name, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_actor_created_idx
        ON audit_events (actor_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_target_idx
        ON audit_events (target_type, target_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_result_created_idx
        ON audit_events (result, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_severity_created_idx
        ON audit_events (severity, created_at DESC)`,
    // 错误 ID 查询同样以时间锚定：按错误 ID 回捞时几乎总要配合时间范围，
    // 且后台分页的稳定排序依赖每一层索引都能省掉额外排序步骤。
    `CREATE INDEX IF NOT EXISTS audit_events_error_idx
        ON audit_events (error_id, created_at DESC)`,
]

export const AUDIT_EVENTS_INDEX_NAMES = [
    'audit_events_created_idx',
    'audit_events_name_created_idx',
    'audit_events_actor_created_idx',
    'audit_events_target_idx',
    'audit_events_result_created_idx',
    'audit_events_severity_created_idx',
    'audit_events_error_idx',
] as const

export const PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT = `
    CREATE TABLE IF NOT EXISTS platform_error_logs (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        fingerprint_bucket INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'error',
        error_code TEXT,
        message TEXT,
        stack TEXT,
        error_chain TEXT,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_user_id TEXT,
        actor_username TEXT,
        request_method TEXT,
        request_path TEXT,
        ip_hash TEXT,
        user_agent TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        handled_at INTEGER,
        handled_by TEXT,
        handle_note TEXT,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER
    )
`

export const PLATFORM_ERROR_LOGS_COLUMN_DEFINITIONS = [
    ['fingerprint', "TEXT NOT NULL DEFAULT ''"],
    ['fingerprint_bucket', 'INTEGER NOT NULL DEFAULT 0'],
    ['scope', "TEXT NOT NULL DEFAULT ''"],
    ['severity', "TEXT NOT NULL DEFAULT 'error'"],
    ['error_code', 'TEXT'],
    ['message', 'TEXT'],
    ['stack', 'TEXT'],
    ['error_chain', 'TEXT'],
    ['actor_type', "TEXT NOT NULL DEFAULT 'system'"],
    ['actor_user_id', 'TEXT'],
    ['actor_username', 'TEXT'],
    ['request_method', 'TEXT'],
    ['request_path', 'TEXT'],
    ['ip_hash', 'TEXT'],
    ['user_agent', 'TEXT'],
    ['occurrence_count', 'INTEGER NOT NULL DEFAULT 1'],
    ['first_seen_at', 'INTEGER'],
    ['last_seen_at', 'INTEGER'],
    ['status', "TEXT NOT NULL DEFAULT 'open'"],
    ['handled_at', 'INTEGER'],
    ['handled_by', 'TEXT'],
    ['handle_note', 'TEXT'],
    ['created_at', 'INTEGER'],
    ['updated_at', 'INTEGER'],
] as const

export const PLATFORM_ERROR_LOGS_INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS platform_error_logs_created_idx
        ON platform_error_logs (created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS platform_error_logs_severity_idx
        ON platform_error_logs (severity, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS platform_error_logs_status_idx
        ON platform_error_logs (status, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS platform_error_logs_scope_idx
        ON platform_error_logs (scope, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS platform_error_logs_actor_idx
        ON platform_error_logs (actor_user_id, created_at DESC)`,
]

export const PLATFORM_ERROR_LOGS_INDEX_NAMES = [
    'platform_error_logs_created_idx',
    'platform_error_logs_severity_idx',
    'platform_error_logs_status_idx',
    'platform_error_logs_scope_idx',
    'platform_error_logs_actor_idx',
] as const

/**
 * 错误聚合唯一约束。
 *
 * `(fingerprint, fingerprint_bucket)` 复合唯一键让「窗口内聚合、窗口外新增」
 * 可以只用一条 `INSERT ... ON CONFLICT DO UPDATE` 完成，无需「先 SELECT 再
 * UPDATE」——后者在并发下会写出重复行并把计数放大。
 */
export const PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_NAME =
    'platform_error_logs_fingerprint_uq'

export const PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT = `
    CREATE UNIQUE INDEX IF NOT EXISTS platform_error_logs_fingerprint_uq
    ON platform_error_logs (fingerprint, fingerprint_bucket)
`

/**
 * 全部索引语句（含指纹唯一索引）。
 *
 * 唯一索引与普通索引合并进同一个清单是刻意的：结构校验、漂移修复、
 * 单测都只看这一个来源。若把它拆成「另一个列表」，极易出现
 * 「建了唯一索引但校验不查它」或反之的错配 —— 而这类错配不会报错，
 * 只会让缺索引的历史库永远不被修复。
 */
export const PLATFORM_ERROR_LOGS_ALL_INDEX_STATEMENTS: readonly string[] = [
    ...PLATFORM_ERROR_LOGS_INDEX_STATEMENTS,
    PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT,
]

export const PLATFORM_ERROR_LOGS_ALL_INDEX_NAMES = [
    ...PLATFORM_ERROR_LOGS_INDEX_NAMES,
    PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_NAME,
] as const

export const AUDIT_EVENTS_REQUIRED_COLUMNS = [
    'id',
    'event_name',
    'category',
    'severity',
    'result',
    'actor_type',
    'actor_user_id',
    'actor_username',
    'target_type',
    'target_id',
    'error_id',
    'error_key',
    'source',
    'ip_hash',
    'user_agent',
    'metadata',
    'created_at',
] as const

export const PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS = [
    'id',
    'fingerprint',
    'fingerprint_bucket',
    'scope',
    'severity',
    'error_code',
    'message',
    'stack',
    'error_chain',
    'actor_type',
    'actor_user_id',
    'actor_username',
    'request_method',
    'request_path',
    'ip_hash',
    'user_agent',
    'occurrence_count',
    'first_seen_at',
    'last_seen_at',
    'status',
    'handled_at',
    'handled_by',
    'handle_note',
    'created_at',
    'updated_at',
] as const

export interface AuditTableStructureSnapshot {
    auditEventsTableExists: boolean
    auditEventsColumns: readonly string[]
    auditEventsIndexes: readonly string[]
    platformErrorTableExists: boolean
    platformErrorColumns: readonly string[]
    platformErrorIndexes: readonly string[]
}

export interface AuditTableStructureVerdict {
    complete: boolean
    missingColumns: string[]
    missingIndexes: string[]
    missingTables: string[]
}

/**
 * evaluateAuditStructure 依据只读快照判定审计结构是否完整（纯函数）。
 *
 * 保持保守：任何一处缺失都要求修复，绝不做「顺手放过」。
 * 与积分账本判定一致，索引缺失也算不完整 —— 后台按时间分页依赖这些索引，
 * 缺索引会退化成全表扫描。
 */
export function evaluateAuditStructure(
    snapshot: AuditTableStructureSnapshot,
): AuditTableStructureVerdict {
    const missingTables: string[] = []
    const missingColumns: string[] = []
    const missingIndexes: string[] = []

    if (!snapshot.auditEventsTableExists) {
        missingTables.push(AUDIT_EVENTS_TABLE)
        missingColumns.push(...AUDIT_EVENTS_REQUIRED_COLUMNS)
    } else {
        missingColumns.push(
            ...AUDIT_EVENTS_REQUIRED_COLUMNS.filter(
                (column) => !snapshot.auditEventsColumns.includes(column),
            ),
        )
    }

    if (!snapshot.platformErrorTableExists) {
        missingTables.push(PLATFORM_ERROR_LOGS_TABLE)
        missingColumns.push(...PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS)
    } else {
        missingColumns.push(
            ...PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS.filter(
                (column) => !snapshot.platformErrorColumns.includes(column),
            ),
        )
    }

    const auditIndexSet = new Set(snapshot.auditEventsIndexes)
    missingIndexes.push(
        ...AUDIT_EVENTS_INDEX_NAMES.filter((name) => !auditIndexSet.has(name)),
    )

    const errorIndexSet = new Set(snapshot.platformErrorIndexes)
    missingIndexes.push(
        ...PLATFORM_ERROR_LOGS_ALL_INDEX_NAMES.filter((name) => !errorIndexSet.has(name)),
    )

    return {
        complete: missingTables.length === 0
            && missingColumns.length === 0
            && missingIndexes.length === 0,
        missingColumns,
        missingIndexes,
        missingTables,
    }
}
