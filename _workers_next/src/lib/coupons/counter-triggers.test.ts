import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const mod = await import(new URL('./counter-triggers.ts', import.meta.url).href)
const {
    COUPON_COUNTER_RECONCILIATION_STATEMENTS,
    COUPON_USAGE_TRIGGER_STATEMENTS,
} = mod

function createDatabase() {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE coupons (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            starts_at INTEGER,
            ends_at INTEGER,
            total_use_limit INTEGER,
            per_user_limit INTEGER,
            reserved_count INTEGER NOT NULL DEFAULT 0,
            consumed_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER
        );
        CREATE TABLE coupon_usages (
            id TEXT PRIMARY KEY,
            coupon_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            user_id TEXT,
            status TEXT NOT NULL,
            reserved_at INTEGER,
            consumed_at INTEGER,
            released_at INTEGER,
            reversed_at INTEGER,
            created_at INTEGER
        );
        CREATE TABLE coupon_user_counters (
            coupon_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            reserved_count INTEGER NOT NULL DEFAULT 0,
            consumed_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER,
            PRIMARY KEY (coupon_id, user_id)
        );
    `)
    for (const statement of COUPON_USAGE_TRIGGER_STATEMENTS) {
        database.exec(statement)
    }
    return database
}

function readCounts(database, userId = 'user-1') {
    const couponRow = database.prepare(`
        SELECT reserved_count AS reservedCount, consumed_count AS consumedCount
        FROM coupons WHERE id = 'coupon-1'
    `).get()
    const userRow = database.prepare(`
        SELECT reserved_count AS reservedCount, consumed_count AS consumedCount
        FROM coupon_user_counters WHERE coupon_id = 'coupon-1' AND user_id = ?
    `).get(userId)
    const coupon = couponRow ? { ...couponRow } : undefined
    const user = userRow ? { ...userRow } : undefined
    return { coupon, user }
}

test('coupon usage triggers keep ledger and counters atomic', () => {
    const database = createDatabase()
    database.prepare(`
        INSERT INTO coupons (
            id, status, total_use_limit, per_user_limit, reserved_count, consumed_count
        ) VALUES ('coupon-1', 'active', 2, 1, 0, 0)
    `).run()

    const insertUsage = database.prepare(`
        INSERT INTO coupon_usages (
            id, coupon_id, order_id, user_id, status, reserved_at, created_at
        ) VALUES (?, 'coupon-1', ?, ?, 'reserved', 1000, 1000)
    `)
    insertUsage.run('usage-1', 'order-1', 'user-1')
    assert.deepEqual(readCounts(database), {
        coupon: { reservedCount: 1, consumedCount: 0 },
        user: { reservedCount: 1, consumedCount: 0 },
    })

    assert.throws(
        () => insertUsage.run('usage-2', 'order-2', 'user-1'),
        /coupon_user_limit_reached/
    )
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM coupon_usages').get().count, 1)
    assert.deepEqual(readCounts(database).coupon, { reservedCount: 1, consumedCount: 0 })

    assert.throws(
        () => insertUsage.run('usage-1', 'order-3', 'user-2'),
        /unique constraint failed/i
    )
    assert.deepEqual(readCounts(database, 'user-2'), {
        coupon: { reservedCount: 1, consumedCount: 0 },
        user: undefined,
    })

    database.prepare(`
        UPDATE coupon_usages
        SET status = 'consumed', consumed_at = 2000
        WHERE id = 'usage-1'
    `).run()
    assert.deepEqual(readCounts(database), {
        coupon: { reservedCount: 0, consumedCount: 1 },
        user: { reservedCount: 0, consumedCount: 1 },
    })

    assert.throws(
        () => database.prepare(`UPDATE coupon_usages SET status = 'released' WHERE id = 'usage-1'`).run(),
        /invalid_coupon_usage_transition/
    )
    assert.deepEqual(readCounts(database).coupon, { reservedCount: 0, consumedCount: 1 })

    database.prepare(`
        UPDATE coupon_usages
        SET status = 'reversed', reversed_at = 3000
        WHERE id = 'usage-1'
    `).run()
    assert.deepEqual(readCounts(database), {
        coupon: { reservedCount: 0, consumedCount: 0 },
        user: { reservedCount: 0, consumedCount: 0 },
    })
})

test('coupon counter reconciliation repairs leaked totals from the ledger', () => {
    const database = createDatabase()
    database.prepare(`
        INSERT INTO coupons (
            id, status, total_use_limit, per_user_limit, reserved_count, consumed_count
        ) VALUES ('coupon-1', 'active', 10, 10, 0, 0)
    `).run()
    database.prepare(`
        INSERT INTO coupon_usages (
            id, coupon_id, order_id, user_id, status, reserved_at, created_at
        ) VALUES ('usage-1', 'coupon-1', 'order-1', 'user-1', 'reserved', 1000, 1000)
    `).run()
    database.exec(`
        UPDATE coupons SET reserved_count = 9, consumed_count = 8 WHERE id = 'coupon-1';
        UPDATE coupon_user_counters
        SET reserved_count = 7, consumed_count = 6
        WHERE coupon_id = 'coupon-1' AND user_id = 'user-1';
    `)

    for (const statement of COUPON_COUNTER_RECONCILIATION_STATEMENTS) {
        database.exec(statement)
    }

    assert.deepEqual(readCounts(database), {
        coupon: { reservedCount: 1, consumedCount: 0 },
        user: { reservedCount: 1, consumedCount: 0 },
    })
})
