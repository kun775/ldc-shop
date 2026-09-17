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

// 回归守护：线上事故的根因是触发器体内出现嵌套 `CASE ... END`。
// D1 的 `exec()` 按语句边界切分 SQL，无法识别嵌套块，会把内层 `END` 当作
// 触发器体结束，于是建出一条不完整的 CREATE TRIGGER（或直接返回
// `incomplete input: SQLITE_ERROR`），触发器永远建不出来。
// 后果不是「积分少加一次」，而是：
//   verifyPointLedgerStructure() 恒 false → detectSchemaDrift() 恒 true
//   → 三个升级项在每个请求上重跑并失败（约 34s）→ 首页/后台被拖到 30s+。
// 因此余额不足必须用「带 WHERE 的 RAISE」表达，禁止再退回 CASE 形式。
test('the balance trigger must not use a nested CASE block', () => {
    const sqlUpper = USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.toUpperCase()
    assert.ok(
        !/\bCASE\b/.test(sqlUpper),
        'a nested CASE ... END breaks the D1 exec() statement splitter and the trigger is never created',
    )
    assert.ok(
        /SELECT\s+RAISE\(ABORT,\s*'POINT_BALANCE_NEGATIVE'\)\s+WHERE\s+CHANGES\(\)\s*=\s*0/.test(sqlUpper),
        'the insufficient-balance guard must be expressed as a WHERE-guarded RAISE',
    )
})

// 回归守护：触发器体的 `END` 必须只有一个（即没有嵌套块），
// 这是「D1 exec() 能正确切分」的必要条件。
test('the balance trigger body has exactly one END terminator', () => {
    const matches = USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT.match(/\bEND\b/gi) || []
    assert.equal(
        matches.length, 1,
        `expected exactly one END (no nested blocks), found ${matches.length}`,
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
