/**
 * 积分账本结构定义（常量 + 幂等 DDL）。
 *
 * 为什么单独成文件：
 *   积分余额**完全依赖** `user_point_ledger_apply_balance` 触发器做「账本完成
 *   → 余额增加」的迁移。历史事故里 `point_ledger_schema_version` 被手工置为
 *   2、但真实表缺 claim_id / claimed_at，且旧实现用「版本达标即 return」短路
 *   DDL，导致缺列永久无法自愈。
 *   把结构与语句集中在此，便于：
 *     1. 无条件幂等执行（不依赖版本号，只依赖本轮结构探测结果）；
 *     2. 被漂移探测（`schema-drift.ts` / `queries.ts`）以只读方式校验；
 *     3. 单元测试直接断言语句的幂等性与覆盖字段。
 */

export const USER_POINT_LEDGER_TABLE = 'user_point_ledger'

export const USER_POINT_LEDGER_CREATE_TABLE_STATEMENT = `
    CREATE TABLE IF NOT EXISTS user_point_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER,
        business_key TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        reason TEXT NOT NULL,
        operator_user_id TEXT,
        operator_username TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        claim_id TEXT,
        claimed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
`

/**
 * 需要保证存在的列。
 *
 * 注意：`ALTER TABLE ... ADD COLUMN` 不允许加「无默认值的 NOT NULL」列，
 * 因此这里给历史必需列都带上默认值，保证对任意历史结构都能安全补齐。
 */
export const USER_POINT_LEDGER_COLUMN_DEFINITIONS = [
    ['event_type', "TEXT NOT NULL DEFAULT ''"],
    ['delta', 'INTEGER NOT NULL DEFAULT 0'],
    ['balance_after', 'INTEGER'],
    ['business_key', "TEXT NOT NULL DEFAULT ''"],
    ['source_type', "TEXT NOT NULL DEFAULT ''"],
    ['source_id', 'TEXT'],
    ['reason', "TEXT NOT NULL DEFAULT ''"],
    ['operator_user_id', 'TEXT'],
    ['operator_username', 'TEXT'],
    ['metadata', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'completed'"],
    ['claim_id', 'TEXT'],
    ['claimed_at', 'INTEGER'],
    ['created_at', 'INTEGER'],
] as const

export const USER_POINT_LEDGER_INDEX_STATEMENTS: readonly string[] = [
    `CREATE UNIQUE INDEX IF NOT EXISTS user_point_ledger_business_key_uq
        ON user_point_ledger (business_key)`,
    `CREATE INDEX IF NOT EXISTS user_point_ledger_user_created_idx
        ON user_point_ledger (user_id, created_at DESC, id DESC)`,
]

export const USER_POINT_LEDGER_INDEX_NAMES = [
    'user_point_ledger_business_key_uq',
    'user_point_ledger_user_created_idx',
] as const

/** `login_users` 上积分余额相关索引（余额查询与签到日期判断） */
export const LOGIN_USERS_POINT_INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS login_users_points_idx
        ON login_users (points DESC, user_id)`,
    `CREATE INDEX IF NOT EXISTS login_users_last_checkin_idx
        ON login_users (last_checkin_at)`,
]

export const LOGIN_USERS_POINT_INDEX_NAMES = [
    'login_users_points_idx',
    'login_users_last_checkin_idx',
] as const

export const USER_POINT_LEDGER_BALANCE_TRIGGER_NAME = 'user_point_ledger_apply_balance'

/**
 * 余额触发器：账本从 pending 迁移到 completed 时同步余额。
 *
 * 关键约束：
 *   - 用条件 UPDATE + `changes() = 0` 判定余额不足，并把该列写操作**原子地**
 *     与余额变更绑定。`points + delta >= 0` 不成立时 UPDATE 影响 0 行，
 *     直接 RAISE(ABORT, 'POINT_BALANCE_NEGATIVE') 回滚整个迁移，
 *     因此不会出现「账本已 completed 但余额没变」的部分写入。
 *   - **必须用 `COALESCE(points, 0)`**：历史 `login_users.points` 可能为
 *     NULL，此时 `NULL + delta >= 0` 求值为 NULL 而非 true，条件 UPDATE
 *     会静默命中 0 行并被误报成「余额不足」，使该用户的所有积分调整
 *     永久失败且错误原因完全误导。COALESCE 同时把 NULL 余额归零。
 *   - 必须把整段 `CREATE TRIGGER` 作为**单条 prepared statement**执行。
 *     D1 的 `exec()` 面向 SQL 脚本，会按分号拆分；触发器体本身也包含分号，
 *     因此会在 `END` 之前得到不完整 SQL。`db.run(sql.raw(...))` 会通过
 *     `prepare(...).run()` 把整段定义交给 SQLite，已在本地 D1 实际验证。
 *   - 余额不足使用「带 WHERE 的 RAISE」表达，避免额外嵌套块：
 *     `SELECT RAISE(ABORT, 'POINT_BALANCE_NEGATIVE') WHERE changes() = 0;`
 *     条件不成立时不产生任何行，也就不需要 CASE 块。
 */
export const USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT = `
    CREATE TRIGGER IF NOT EXISTS user_point_ledger_apply_balance
    AFTER UPDATE OF status ON user_point_ledger
    WHEN OLD.status = 'pending' AND NEW.status = 'completed'
    BEGIN
        UPDATE login_users
        SET points = COALESCE(points, 0) + NEW.delta
        WHERE user_id = NEW.user_id
          AND COALESCE(points, 0) + NEW.delta >= 0;
        SELECT RAISE(ABORT, 'POINT_BALANCE_NEGATIVE') WHERE changes() = 0;
    END;
`

/**
 * 数据规范化语句：把历史 NULL 余额归零。
 *
 * 必须在触发器重建之后、任何积分写入之前执行，否则：
 *   - 若先执行规范化，则失败回滚后余额仍是 NULL（下次仍会被修复）；
 *   - 若永远不执行，则 NULL 余额用户每次调整都报「余额不足」。
 * 属于幂等 UPDATE，无 NULL 行时影响 0 行。
 */
export const LOGIN_USERS_POINT_NORMALIZE_STATEMENTS: readonly string[] = [
    `UPDATE login_users SET points = 0 WHERE points IS NULL`,
]

/** 触发器中使用的余额不足错误码，必须与业务错误映射保持一致 */
export const POINT_BALANCE_NEGATIVE_ERROR_CODE = 'POINT_BALANCE_NEGATIVE'

/**
 * 触发器「正确性指纹」。
 *
 * 只校验触发器**存在**是不够的：早期版本的触发器体存在两类缺陷 ——
 *   1. 缺少 `changes() = 0` 余额守卫 → 余额不足时变更静默丢失；
 *   2. 直接读 `points` 而非 `COALESCE(points, 0)` → 余额为 NULL 的用户
 *      `NULL + delta >= 0` 求值为 NULL，条件 UPDATE 命中 0 行并被误报为
 *      「余额不足」，该用户所有积分调整永久失败。
 * 因此必须同时校验这两个标记，任一缺失即判定需要重建。
 */
export const USER_POINT_LEDGER_TRIGGER_REQUIRED_MARKERS = [
    POINT_BALANCE_NEGATIVE_ERROR_CODE,
    'COALESCE(points, 0)',
] as const

export const USER_POINT_LEDGER_REQUIRED_COLUMNS = [
    'id',
    'user_id',
    'event_type',
    'delta',
    'balance_after',
    'business_key',
    'source_type',
    'source_id',
    'reason',
    'operator_user_id',
    'operator_username',
    'metadata',
    'status',
    'claim_id',
    'claimed_at',
    'created_at',
] as const

export interface PointLedgerStructureSnapshot {
    /** 表是否存在 */
    tableExists: boolean
    /** `PRAGMA table_info` 返回的列名 */
    columns: readonly string[]
    /** `sqlite_master` 中属于该表的索引名 */
    indexes: readonly string[]
    /** `sqlite_master` 中余额触发器的定义体，不存在则为 null */
    triggerSql: string | null
}

export interface PointLedgerStructureVerdict {
    /** 结构是否完整且可用（无需任何 DDL） */
    complete: boolean
    missingColumns: string[]
    missingIndexes: string[]
    /** 触发器不存在，或存在但缺少余额守卫（需要 DROP + CREATE 重建） */
    triggerNeedsRebuild: boolean
}

/**
 * evaluatePointLedgerStructure 依据只读快照判定结构是否完整。
 *
 * 这是**纯函数**：不访问数据库，便于单元测试覆盖各种历史缺结构组合。
 * 判定保持保守 —— 任何一处缺失都要求修复，绝不做「顺手放过」。
 */
export function evaluatePointLedgerStructure(
    snapshot: PointLedgerStructureSnapshot,
): PointLedgerStructureVerdict {
    const missingColumns = snapshot.tableExists
        ? USER_POINT_LEDGER_REQUIRED_COLUMNS.filter(
            (column) => !snapshot.columns.includes(column),
        )
        : [...USER_POINT_LEDGER_REQUIRED_COLUMNS]

    const indexSet = new Set(snapshot.indexes)
    const missingIndexes = USER_POINT_LEDGER_INDEX_NAMES.filter((name) => !indexSet.has(name))

    const triggerSql = snapshot.triggerSql ?? ''
    // sqlite_master 会原样保存定义体，大小写可能与写入时一致，但也可能被
    // 规范化；统一大写比较，避免因大小写差异产生永久漂移。
    const normalizedTriggerSql = triggerSql.toUpperCase()
    const triggerNeedsRebuild = !snapshot.tableExists
        || triggerSql.length === 0
        || USER_POINT_LEDGER_TRIGGER_REQUIRED_MARKERS.some(
            (marker) => !normalizedTriggerSql.includes(marker.toUpperCase()),
        )

    return {
        complete: snapshot.tableExists
            && missingColumns.length === 0
            && missingIndexes.length === 0
            && !triggerNeedsRebuild,
        missingColumns,
        missingIndexes,
        triggerNeedsRebuild,
    }
}
