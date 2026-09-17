import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const mod = await import(new URL('./login-users-schema.ts', import.meta.url).href)
const { LOGIN_USERS_CREATE_TABLE_STATEMENT, LOGIN_USERS_COLUMN_DEFINITIONS } = mod

test('login_users schema definition repairs a current-version partial table', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO settings (key, value) VALUES ('schema_version', '27');
        CREATE TABLE login_users (
            user_id TEXT PRIMARY KEY,
            username TEXT,
            points INTEGER DEFAULT 0 NOT NULL,
            created_at INTEGER,
            last_login_at INTEGER
        );
    `)

    database.exec(LOGIN_USERS_CREATE_TABLE_STATEMENT)
    for (const [column, definition] of LOGIN_USERS_COLUMN_DEFINITIONS) {
        try {
            database.exec(`ALTER TABLE login_users ADD COLUMN ${column} ${definition}`)
        } catch (error) {
            if (!String(error).toLowerCase().includes('duplicate column')) throw error
        }
    }

    const columns = database.prepare('PRAGMA table_info(login_users)').all()
    const names = new Set(columns.map((column: { name: string }) => column.name))
    for (const required of [
        'username',
        'nickname',
        'email',
        'points',
        'is_blocked',
        'desktop_notifications_enabled',
        'created_at',
        'last_login_at',
        'last_checkin_at',
        'consecutive_days',
    ]) {
        assert.ok(names.has(required), `missing login_users column: ${required}`)
    }
})
