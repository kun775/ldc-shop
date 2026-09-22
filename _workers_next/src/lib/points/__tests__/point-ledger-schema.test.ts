import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const mod = await import(new URL('../../db/point-ledger-schema.ts', import.meta.url).href)
const {
    evaluatePointLedgerStructure,
    USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT,
    USER_POINT_LEDGER_COLUMN_DEFINITIONS,
    USER_POINT_LEDGER_CREATE_TABLE_STATEMENT,
    USER_POINT_LEDGER_REBUILD_STATEMENTS,
    USER_POINT_LEDGER_INDEX_NAMES,
    USER_POINT_LEDGER_REQUIRED_COLUMNS,
    USER_POINT_LEDGER_TRIGGER_REQUIRED_MARKERS,
    LOGIN_USERS_POINT_NORMALIZE_STATEMENTS,
} = mod

const FULL_COLUMNS = [...USER_POINT_LEDGER_REQUIRED_COLUMNS]
const FULL_INDEXES = [...USER_POINT_LEDGER_INDEX_NAMES]

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        tableExists: true,
        columns: FULL_COLUMNS,
        indexes: FULL_INDEXES,
        triggerSql: `CREATE TRIGGER user_point_ledger_apply_balance ... COALESCE(points, 0) ... POINT_BALANCE_NEGATIVE`,
        ...overrides,
    }
}

test('a fully provisioned ledger is reported complete', () => {
    const verdict = evaluatePointLedgerStructure(snapshot())
    assert.equal(verdict.complete, true)
    assert.deepEqual(verdict.missingColumns, [])
    assert.deepEqual(verdict.missingIndexes, [])
    assert.equal(verdict.triggerNeedsRebuild, false)
})

test('a missing table reports every column as missing', () => {
    const verdict = evaluatePointLedgerStructure(snapshot({ tableExists: false, columns: [] }))
    assert.equal(verdict.complete, false)
    assert.equal(verdict.missingColumns.length, USER_POINT_LEDGER_REQUIRED_COLUMNS.length)
    assert.equal(verdict.triggerNeedsRebuild, true)
})

test('the historical claim_id / claimed_at gap is detected', () => {
    // 这正是生产事故的形态：版本号领先，但两列不存在。
    const columns = FULL_COLUMNS.filter((c: string) => c !== 'claim_id' && c !== 'claimed_at')
    const verdict = evaluatePointLedgerStructure(snapshot({ columns }))
    assert.equal(verdict.complete, false)
    assert.deepEqual(verdict.missingColumns, ['claim_id', 'claimed_at'])
})

test('a missing index is detected', () => {
    const indexes = FULL_INDEXES.filter((name: string) => name !== USER_POINT_LEDGER_INDEX_NAMES[0])
    const verdict = evaluatePointLedgerStructure(snapshot({ indexes }))
    assert.equal(verdict.complete, false)
    assert.deepEqual(verdict.missingIndexes, [USER_POINT_LEDGER_INDEX_NAMES[0]])
})

test('a legacy trigger without the balance guard is rebuilt', () => {
    // 老触发器只做 UPDATE，不含 changes() 守卫 → 余额不足会静默丢失变更。
    const verdict = evaluatePointLedgerStructure(snapshot({
        triggerSql: 'CREATE TRIGGER user_point_ledger_apply_balance AFTER UPDATE OF status ON user_point_ledger BEGIN UPDATE login_users SET points = points + NEW.delta WHERE user_id = NEW.user_id; END',
    }))
    assert.equal(verdict.complete, false)
    assert.equal(verdict.triggerNeedsRebuild, true)
})

test('a trigger that ignores NULL balances is rebuilt', () => {
    // 第二类历史缺陷：直接读 points。NULL 余额时 `NULL + delta >= 0` 为 NULL，
    // 条件 UPDATE 命中 0 行并被误报为「余额不足」。
    const verdict = evaluatePointLedgerStructure(snapshot({
        triggerSql: "CREATE TRIGGER user_point_ledger_apply_balance AFTER UPDATE OF status ON user_point_ledger BEGIN UPDATE login_users SET points = points + NEW.delta WHERE user_id = NEW.user_id AND points + NEW.delta >= 0; SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'POINT_BALANCE_NEGATIVE') END; END",
    }))
    assert.equal(verdict.complete, false)
    assert.equal(verdict.triggerNeedsRebuild, true)
})

test('a missing trigger is rebuilt', () => {
    const verdict = evaluatePointLedgerStructure(snapshot({ triggerSql: null }))
    assert.equal(verdict.complete, false)
    assert.equal(verdict.triggerNeedsRebuild, true)
})

test('trigger marker matching is case-insensitive', () => {
    // sqlite_master 保存的定义体大小写可能与写入时不同，
    // 否则会造成「永远认为触发器需要重建」的永久漂移。
    const verdict = evaluatePointLedgerStructure(snapshot({
        triggerSql: 'CREATE TRIGGER x AFTER UPDATE ON y BEGIN SELECT coalesce(points, 0) FROM z; SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, \'point_balance_negative\') END; END',
    }))
    assert.equal(verdict.triggerNeedsRebuild, false)
})

test('the current trigger statement carries both required markers', () => {
    const upper = USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.toUpperCase()
    for (const marker of USER_POINT_LEDGER_TRIGGER_REQUIRED_MARKERS) {
        assert.ok(
            upper.includes(marker.toUpperCase()),
            `balance trigger must contain ${marker}`,
        )
    }
    assert.ok(
        USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.includes('CREATE TRIGGER IF NOT EXISTS'),
        'trigger creation must be idempotent',
    )
    assert.ok(
        USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.includes('COALESCE(points, 0) + NEW.delta >= 0'),
        'the guard must compare the coalesced balance, not the raw column',
    )
})

// 回归守护：余额不足使用单层 WHERE 守卫，避免恢复为更复杂的嵌套块。
test('the balance trigger must not use a nested CASE block', () => {
    const sqlUpper = USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.toUpperCase()
    assert.ok(
        !/\bCASE\b/.test(sqlUpper),
        'the balance trigger should keep a single-level guard',
    )
    assert.ok(
        /SELECT\s+RAISE\(ABORT,\s*'POINT_BALANCE_NEGATIVE'\)\s+WHERE\s+CHANGES\(\)\s*=\s*0/.test(sqlUpper),
        'the insufficient-balance guard must be expressed as a WHERE-guarded RAISE',
    )
})

test('the balance trigger parses and applies balance changes atomically', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE login_users (
            user_id TEXT PRIMARY KEY,
            points INTEGER
        );
        CREATE TABLE user_point_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            delta INTEGER NOT NULL,
            status TEXT NOT NULL
        );
        INSERT INTO login_users (user_id, points) VALUES ('user-1', 0);
    `)
    database.exec(USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT)

    database.exec(`
        INSERT INTO user_point_ledger (user_id, delta, status)
        VALUES ('user-1', 5, 'pending');
        UPDATE user_point_ledger SET status = 'completed' WHERE id = 1;
    `)
    assert.equal(database.prepare(`SELECT points FROM login_users WHERE user_id = 'user-1'`).get().points, 5)

    database.exec(`
        INSERT INTO user_point_ledger (user_id, delta, status)
        VALUES ('user-1', -10, 'pending');
    `)
    assert.throws(
        () => database.exec(`UPDATE user_point_ledger SET status = 'completed' WHERE id = 2`),
        /POINT_BALANCE_NEGATIVE/,
    )
    assert.equal(database.prepare(`SELECT points FROM login_users WHERE user_id = 'user-1'`).get().points, 5)
    assert.equal(database.prepare(`SELECT status FROM user_point_ledger WHERE id = 2`).get().status, 'pending')
})

test('point ledger rebuild removes the cascading user foreign key without losing rows', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE login_users (user_id TEXT PRIMARY KEY);
        CREATE TABLE user_point_ledger (
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
            created_at INTEGER
        );
        INSERT INTO login_users (user_id) VALUES ('legacy-user');
        INSERT INTO user_point_ledger (
            user_id, event_type, delta, business_key, source_type, reason
        ) VALUES ('legacy-user', 'checkin_reward', 5, 'checkin:legacy-user', 'checkin', 'history');
    `)

    for (const statement of USER_POINT_LEDGER_REBUILD_STATEMENTS) {
        database.exec(statement)
    }
    database.exec(`DELETE FROM login_users WHERE user_id = 'legacy-user'`)

    const row = database.prepare(`SELECT user_id, delta FROM user_point_ledger WHERE business_key = 'checkin:legacy-user'`).get()
    assert.equal(row.user_id, 'legacy-user')
    assert.equal(row.delta, 5)
    assert.equal(database.prepare(`PRAGMA foreign_key_list(user_point_ledger)`).all().length, 0)
})

test('point ledger rebuild can recover a legacy interruption after the original table was dropped', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE login_users (user_id TEXT PRIMARY KEY);
        CREATE TABLE user_point_ledger (
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
            created_at INTEGER
        );
        INSERT INTO login_users VALUES ('legacy-user');
        INSERT INTO user_point_ledger (
            user_id, event_type, delta, business_key, source_type, reason
        ) VALUES ('legacy-user', 'checkin_reward', 5, 'recover-me', 'checkin', 'history');
    `)

    for (const statement of USER_POINT_LEDGER_REBUILD_STATEMENTS.slice(0, 3)) {
        database.exec(statement)
    }
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user_point_ledger'`).get().count, 0)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM user_point_ledger_nocascade`).get().count, 1)

    database.exec(USER_POINT_LEDGER_REBUILD_STATEMENTS[3])
    assert.equal(database.prepare(`SELECT business_key FROM user_point_ledger`).get().business_key, 'recover-me')
    assert.equal(database.prepare(`PRAGMA foreign_key_list(user_point_ledger)`).all().length, 0)
})

test('point ledger rebuild transaction keeps the original table when a statement fails', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE login_users (user_id TEXT PRIMARY KEY);
        CREATE TABLE user_point_ledger (
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
            created_at INTEGER
        );
        INSERT INTO login_users VALUES ('legacy-user');
        INSERT INTO user_point_ledger (
            user_id, event_type, delta, business_key, source_type, reason
        ) VALUES ('legacy-user', 'checkin_reward', 5, 'rollback-me', 'checkin', 'history');
    `)

    database.exec('BEGIN')
    assert.throws(() => {
        for (const statement of USER_POINT_LEDGER_REBUILD_STATEMENTS) database.exec(statement)
        database.exec('SELECT missing_column FROM user_point_ledger')
    }, /missing_column/)
    database.exec('ROLLBACK')

    assert.equal(database.prepare(`SELECT business_key FROM user_point_ledger`).get().business_key, 'rollback-me')
    assert.equal(database.prepare(`PRAGMA foreign_key_list(user_point_ledger)`).all().length, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user_point_ledger_nocascade'`).get().count, 0)
})

test('every DDL statement is idempotent', () => {
    assert.ok(USER_POINT_LEDGER_CREATE_TABLE_STATEMENT.includes('CREATE TABLE IF NOT EXISTS'))
    for (const name of USER_POINT_LEDGER_INDEX_NAMES) {
        assert.ok(name.startsWith('user_point_ledger_'), `unexpected index name: ${name}`)
    }
    // 列定义必须给出默认值：ALTER TABLE 不允许新增「无默认值的 NOT NULL」列，
    // 否则对历史空表补齐时会直接失败。
    for (const [column, definition] of USER_POINT_LEDGER_COLUMN_DEFINITIONS) {
        if (definition.includes('NOT NULL')) {
            assert.ok(
                definition.includes('DEFAULT'),
                `${column} is NOT NULL and must declare a DEFAULT`,
            )
        }
    }
})

test('NULL balance normalisation is idempotent and scoped to NULL rows', () => {
    assert.ok(LOGIN_USERS_POINT_NORMALIZE_STATEMENTS.length > 0)
    for (const statement of LOGIN_USERS_POINT_NORMALIZE_STATEMENTS) {
        const normalized = statement.toLowerCase()
        assert.ok(normalized.includes('points is null'), `must scope to NULL rows: ${statement}`)
        assert.ok(!normalized.includes('where 1'), 'must not rewrite every row')
    }
})

test('required legacy columns stay covered by the schema snapshot', () => {
    // 这些列历史上造成过 no such column 事故，必须始终在必需列清单内。
    for (const column of ['claim_id', 'claimed_at', 'balance_after', 'status', 'business_key']) {
        assert.ok(
            USER_POINT_LEDGER_REQUIRED_COLUMNS.includes(column),
            `required columns must include ${column}`,
        )
    }
})
