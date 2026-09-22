import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const mergeModule = await import(new URL('./user-merge.ts', import.meta.url).href)
const { buildLoginUserMergeStatements } = mergeModule

function createDatabase() {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE login_users (
            user_id TEXT PRIMARY KEY,
            username TEXT,
            nickname TEXT,
            email TEXT,
            points INTEGER,
            is_blocked INTEGER,
            desktop_notifications_enabled INTEGER,
            created_at INTEGER,
            last_login_at INTEGER
        );
        CREATE TABLE orders (user_id TEXT, username TEXT);
        CREATE TABLE reviews (user_id TEXT, username TEXT);
        CREATE TABLE review_replies (user_id TEXT, username TEXT);
        CREATE TABLE refund_requests (user_id TEXT, username TEXT);
        CREATE TABLE daily_checkins_v2 (user_id TEXT);
        CREATE TABLE user_notifications (user_id TEXT);
        CREATE TABLE user_messages (user_id TEXT, username TEXT);
        CREATE TABLE broadcast_reads (message_id INTEGER, user_id TEXT, UNIQUE(message_id, user_id));
        CREATE TABLE wishlist_votes (item_id INTEGER, user_id TEXT, UNIQUE(item_id, user_id));
        CREATE TABLE wishlist_items (user_id TEXT, username TEXT);
        CREATE TABLE admin_messages (target_type TEXT, target_value TEXT);
        CREATE TABLE user_point_ledger (user_id TEXT, business_key TEXT);
        CREATE TABLE coupon_usages (user_id TEXT, username TEXT);
        CREATE TABLE coupon_user_counters (
            coupon_id TEXT,
            user_id TEXT,
            reserved_count INTEGER,
            consumed_count INTEGER,
            updated_at INTEGER,
            PRIMARY KEY (coupon_id, user_id)
        );
    `)
    return database
}

function executeAtomically(database: any, statements: Array<{ query: string; bindings?: unknown[] }>) {
    database.exec('BEGIN')
    try {
        for (const statement of statements) {
            database.prepare(statement.query).run(...(statement.bindings || []))
        }
        database.exec('COMMIT')
    } catch (error) {
        database.exec('ROLLBACK')
        throw error
    }
}

function sourceUser() {
    return {
        userId: '123',
        username: 'gh_old-name',
        nickname: 'Legacy',
        email: 'legacy@example.com',
        points: 7,
        isBlocked: true,
        desktopNotificationsEnabled: true,
        createdAt: 100,
        lastLoginAt: 400,
    }
}

test('login user merge moves references and deletes the source atomically', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO login_users VALUES ('123', 'gh_old-name', 'Legacy', 'legacy@example.com', 7, 1, 1, 100, 400);
        INSERT INTO login_users VALUES ('github:123', 'gh_current', NULL, 'current@example.com', 5, 0, 0, 200, 300);
        INSERT INTO orders VALUES ('123', 'legacy');
        INSERT INTO broadcast_reads VALUES (1, '123'), (1, 'github:123');
        INSERT INTO wishlist_votes VALUES (2, '123'), (2, 'github:123');
        INSERT INTO user_point_ledger VALUES ('123', 'duplicate'), ('github:123', 'duplicate'), ('123', 'source-only');
        INSERT INTO coupon_user_counters VALUES ('coupon-1', '123', 2, 3, 200);
        INSERT INTO coupon_user_counters VALUES ('coupon-1', 'github:123', 1, 4, 300);
    `)

    executeAtomically(database, buildLoginUserMergeStatements({
        source: sourceUser(),
        targetUserId: 'github:123',
        username: 'gh_current',
    }))

    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM login_users WHERE user_id = '123'`).get().count, 0)
    const target = database.prepare(`SELECT * FROM login_users WHERE user_id = 'github:123'`).get()
    assert.equal(target.points, 12)
    assert.equal(target.email, 'current@example.com')
    assert.equal(target.nickname, 'Legacy')
    assert.equal(target.is_blocked, 1)
    assert.equal(target.created_at, 100)
    assert.equal(target.last_login_at, 400)

    const migratedOrder = database.prepare(`SELECT user_id, username FROM orders`).get()
    assert.equal(migratedOrder.user_id, 'github:123')
    assert.equal(migratedOrder.username, 'gh_current')
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM broadcast_reads`).get().count, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM wishlist_votes`).get().count, 1)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM user_point_ledger WHERE user_id = 'github:123'`).get().count, 2)

    const counter = database.prepare(`SELECT * FROM coupon_user_counters WHERE user_id = 'github:123'`).get()
    assert.equal(counter.reserved_count, 3)
    assert.equal(counter.consumed_count, 7)
    assert.equal(counter.updated_at, 300)
})

test('login user merge rolls every write back when one child table update fails', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO login_users VALUES ('123', 'gh_old-name', 'Legacy', 'legacy@example.com', 7, 0, 0, 100, 400);
        INSERT INTO login_users VALUES ('github:123', 'gh_current', NULL, NULL, 5, 0, 0, 200, 300);
        INSERT INTO orders VALUES ('123', 'legacy');
        DROP TABLE coupon_usages;
    `)

    assert.throws(() => executeAtomically(database, buildLoginUserMergeStatements({
        source: sourceUser(),
        targetUserId: 'github:123',
        username: 'gh_current',
    })), /coupon_usages/)

    assert.equal(database.prepare(`SELECT points FROM login_users WHERE user_id = 'github:123'`).get().points, 5)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM login_users WHERE user_id = '123'`).get().count, 1)
    assert.equal(database.prepare(`SELECT user_id FROM orders`).get().user_id, '123')
})
