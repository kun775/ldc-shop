export const LOGIN_USERS_CREATE_TABLE_STATEMENT = `
    CREATE TABLE IF NOT EXISTS login_users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        nickname TEXT,
        email TEXT,
        points INTEGER DEFAULT 0 NOT NULL,
        is_blocked INTEGER DEFAULT 0,
        desktop_notifications_enabled INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        last_login_at INTEGER DEFAULT (unixepoch() * 1000),
        last_checkin_at INTEGER,
        consecutive_days INTEGER DEFAULT 0
    )
`

export const LOGIN_USERS_COLUMN_DEFINITIONS = [
    ['username', 'TEXT'],
    ['nickname', 'TEXT'],
    ['email', 'TEXT'],
    ['points', 'INTEGER DEFAULT 0 NOT NULL'],
    ['is_blocked', 'INTEGER DEFAULT 0'],
    ['desktop_notifications_enabled', 'INTEGER DEFAULT 0'],
    ['created_at', 'INTEGER'],
    ['last_login_at', 'INTEGER'],
    ['last_checkin_at', 'INTEGER'],
    ['consecutive_days', 'INTEGER DEFAULT 0'],
] as const
