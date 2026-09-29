import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
    CARD_SERVICE_ALLOCATION_STATES,
    CARD_SERVICE_DDL_STATEMENTS,
    CARD_SERVICE_DEFAULT_SUPPLY_MODE,
    CARD_SERVICE_REQUIRED_INDEX_NAMES,
    CARD_SERVICE_SCHEMA_DRIFT_PROBES,
    CARD_SERVICE_SUPPLY_MODES,
    isCardServiceSupplyMode,
} from './license-service-schema.ts'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

function createDatabase() {
    const database = new DatabaseSync(':memory:')
    for (const statement of CARD_SERVICE_DDL_STATEMENTS) {
        database.exec(statement)
    }
    return database
}

function tableNames(database: ReturnType<typeof createDatabase>) {
    return (database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>)
        .map((row) => row.name)
}

function indexNames(database: ReturnType<typeof createDatabase>) {
    return (database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>)
        .map((row) => row.name)
}

test('远端账本 DDL 在真实 SQLite 上可执行且建出全部对象', () => {
    const database = createDatabase()
    try {
        const tables = tableNames(database)
        for (const required of [
            'card_service_allocations',
            'card_service_staged_cards',
            'card_service_cards',
            'card_service_operations',
            'card_service_product_configs',
        ]) {
            assert.ok(tables.includes(required), `missing table: ${required}`)
        }

        const indexes = indexNames(database)
        for (const required of CARD_SERVICE_REQUIRED_INDEX_NAMES) {
            assert.ok(indexes.includes(required), `missing unique index: ${required}`)
        }
    } finally {
        database.close()
    }
})

test('远端账本 DDL 可重复执行（升级执行体与首次初始化共用同一份语句）', () => {
    const database = new DatabaseSync(':memory:')
    try {
        for (let round = 0; round < 3; round += 1) {
            for (const statement of CARD_SERVICE_DDL_STATEMENTS) {
                database.exec(statement)
            }
        }
        assert.equal(tableNames(database).length, 5)
    } finally {
        database.close()
    }
})

test('external_ref 唯一索引真的拦截重复补货任务（不能只靠应用层去重）', () => {
    const database = createDatabase()
    try {
        const insert = database.prepare(`
            INSERT INTO card_service_allocations (
                allocation_id, product_id, program_key, external_ref, quantity, state,
                request_key, ack_key, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const values = (allocationId: string, externalRef: string) => [
            allocationId, 'prod-1', 'prog-1', externalRef, 1, 'allocated',
            `restock:${allocationId}:allocate`, `restock:${allocationId}:ack`, 1, 1, 1,
        ]

        insert.run(...values('alloc-1', 'ldc-shop:restock:task-1'))
        assert.throws(
            () => insert.run(...values('alloc-2', 'ldc-shop:restock:task-1')),
            /UNIQUE constraint failed|constraint/i,
            'the same external_ref must never be re-stocked under a new allocation_id',
        )
    } finally {
        database.close()
    }
})

test('remote_card_id 唯一索引拦截同一张远端卡被映射到两个本地卡位', () => {
    const database = createDatabase()
    try {
        const insert = database.prepare(`
            INSERT INTO card_service_cards (
                local_card_id, remote_card_id, allocation_id, product_id, state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        insert.run(1, 'remote-1', 'alloc-1', 'prod-1', 'acknowledged', 1, 1)
        assert.throws(
            () => insert.run(2, 'remote-1', 'alloc-1', 'prod-1', 'acknowledged', 1, 1),
            /UNIQUE constraint failed|constraint/i,
            'one remote card must map to exactly one local card row',
        )
    } finally {
        database.close()
    }
})

test('每条漂移探测语句都能解析真实建出的表（列名与 DDL 不漂移）', () => {
    const database = createDatabase()
    try {
        for (const probe of CARD_SERVICE_SCHEMA_DRIFT_PROBES) {
            assert.ok(probe.toLowerCase().trim().endsWith('limit 0'))
            // 探测语句若与建表语句的列名不一致，这里会因 no such column 抛错。
            database.prepare(probe).all()
        }
    } finally {
        database.close()
    }
})

test('allocations 台账同时保留本地 expires_at 与 request/ack 幂等键（N3 依赖本地落库）', () => {
    const database = createDatabase()
    try {
        const columns = (database
            .prepare('PRAGMA table_info(card_service_allocations)')
            .all() as Array<{ name: string }>)
            .map((row) => row.name)

        for (const required of ['expires_at', 'request_key', 'ack_key', 'external_ref', 'state', 'program_key']) {
            assert.ok(columns.includes(required), `missing column: ${required}`)
        }
        // 中心列表接口不返回 expires_at，本地必须自己记；这一列不能是可空的。
        const expiresAt = (database
            .prepare('PRAGMA table_info(card_service_allocations)')
            .all() as Array<{ name: string; notnull: number }>)
            .find((row) => row.name === 'expires_at')
        assert.equal(expiresAt?.notnull, 1)
    } finally {
        database.close()
    }
})

test('远端账本不引入任何外键（本地卡/订单可被清理，映射不能跟着丢失）', () => {
    const database = createDatabase()
    try {
        for (const table of [
            'card_service_allocations',
            'card_service_staged_cards',
            'card_service_cards',
            'card_service_operations',
            'card_service_product_configs',
        ]) {
            const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
            assert.equal(foreignKeys.length, 0, `${table} must not declare foreign keys`)
        }
    } finally {
        database.close()
    }
})

test('供应模式枚举与兜底值保持一致', () => {
    assert.deepEqual([...CARD_SERVICE_SUPPLY_MODES], ['local', 'legacy_get', 'license_service'])
    assert.equal(CARD_SERVICE_DEFAULT_SUPPLY_MODE, 'local')
    for (const mode of CARD_SERVICE_SUPPLY_MODES) {
        assert.equal(isCardServiceSupplyMode(mode), true)
    }
    for (const invalid of ['', 'get', 'LICENSE_SERVICE', null, undefined, 42, {}]) {
        assert.equal(isCardServiceSupplyMode(invalid), false)
    }
    // 分配状态枚举必须覆盖超窗终态与本地放弃态，否则超窗分支无处落库。
    for (const state of ['allocated', 'acknowledged', 'sold', 'expired', 'cancelled', 'abandoned']) {
        assert.ok((CARD_SERVICE_ALLOCATION_STATES as readonly string[]).includes(state))
    }
})
