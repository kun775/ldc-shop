import type { AtomicD1Statement } from './index'

export interface LoginUserMergeSource {
    userId: string
    username?: string | null
    nickname?: string | null
    email?: string | null
    points?: number | null
    isBlocked?: boolean | null
    desktopNotificationsEnabled?: boolean | null
    createdAt?: Date | number | string | null
    lastLoginAt?: Date | number | string | null
}

function timestampValue(value: Date | number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.getTime()
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function usernameUpdateStatement(
    table: string,
    targetUserId: string,
    username: string | null,
): AtomicD1Statement {
    return {
        query: `UPDATE ${table}
            SET username = ?
            WHERE user_id = ?
              AND ? IS NOT NULL
              AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')`,
        bindings: [username, targetUserId, username],
    }
}

/**
 * Build one all-or-nothing account merge. The caller must execute the returned
 * statements with runAtomicD1Batch so a failed child-table update cannot delete
 * the source login row or apply its point balance twice on retry.
 */
export function buildLoginUserMergeStatements(input: {
    source: LoginUserMergeSource
    targetUserId: string
    username?: string | null
}): AtomicD1Statement[] {
    const { source, targetUserId } = input
    const sourceUserId = source.userId
    if (!sourceUserId || !targetUserId || sourceUserId === targetUserId) return []

    const normalizedUsername = input.username?.trim().toLowerCase() || null
    const sourceCreatedAt = timestampValue(source.createdAt)
    const sourceLastLoginAt = timestampValue(source.lastLoginAt)
    const sourceUsername = source.username?.trim().toLowerCase() || null

    const statements: AtomicD1Statement[] = [
        {
            query: `INSERT OR IGNORE INTO login_users (
                user_id, points, is_blocked, desktop_notifications_enabled
            ) VALUES (?, 0, 0, 0)`,
            bindings: [targetUserId],
        },
        {
            query: `UPDATE login_users
                SET username = COALESCE(?, NULLIF(username, ''), ?),
                    nickname = COALESCE(NULLIF(nickname, ''), ?),
                    email = COALESCE(NULLIF(email, ''), ?),
                    points = COALESCE(points, 0) + ?,
                    is_blocked = CASE WHEN COALESCE(is_blocked, 0) <> 0 OR ? <> 0 THEN 1 ELSE 0 END,
                    desktop_notifications_enabled = CASE
                        WHEN COALESCE(desktop_notifications_enabled, 0) <> 0 OR ? <> 0 THEN 1 ELSE 0
                    END,
                    created_at = CASE
                        WHEN created_at IS NULL THEN ?
                        WHEN ? IS NULL THEN created_at
                        ELSE MIN(created_at, ?)
                    END,
                    last_login_at = CASE
                        WHEN last_login_at IS NULL THEN ?
                        WHEN ? IS NULL THEN last_login_at
                        ELSE MAX(last_login_at, ?)
                    END
                WHERE user_id = ?`,
            bindings: [
                normalizedUsername,
                sourceUsername,
                source.nickname || null,
                source.email || null,
                Number(source.points || 0),
                source.isBlocked ? 1 : 0,
                source.desktopNotificationsEnabled ? 1 : 0,
                sourceCreatedAt,
                sourceCreatedAt,
                sourceCreatedAt,
                sourceLastLoginAt,
                sourceLastLoginAt,
                sourceLastLoginAt,
                targetUserId,
            ],
        },
        {
            query: `DELETE FROM broadcast_reads
                WHERE user_id = ?
                  AND EXISTS (
                    SELECT 1 FROM broadcast_reads existing
                    WHERE existing.message_id = broadcast_reads.message_id
                      AND existing.user_id = ?
                  )`,
            bindings: [sourceUserId, targetUserId],
        },
        {
            query: `DELETE FROM wishlist_votes
                WHERE user_id = ?
                  AND EXISTS (
                    SELECT 1 FROM wishlist_votes existing
                    WHERE existing.item_id = wishlist_votes.item_id
                      AND existing.user_id = ?
                  )`,
            bindings: [sourceUserId, targetUserId],
        },
        {
            query: `DELETE FROM user_point_ledger
                WHERE user_id = ?
                  AND business_key IN (
                    SELECT business_key FROM user_point_ledger WHERE user_id = ?
                  )`,
            bindings: [sourceUserId, targetUserId],
        },
        {
            query: `INSERT INTO coupon_user_counters (
                    coupon_id, user_id, reserved_count, consumed_count, updated_at
                )
                SELECT coupon_id, ?, reserved_count, consumed_count, updated_at
                FROM coupon_user_counters
                WHERE user_id = ?
                ON CONFLICT(coupon_id, user_id) DO UPDATE SET
                    reserved_count = coupon_user_counters.reserved_count + excluded.reserved_count,
                    consumed_count = coupon_user_counters.consumed_count + excluded.consumed_count,
                    updated_at = MAX(
                        COALESCE(coupon_user_counters.updated_at, 0),
                        COALESCE(excluded.updated_at, 0)
                    )`,
            bindings: [targetUserId, sourceUserId],
        },
        {
            query: `DELETE FROM coupon_user_counters WHERE user_id = ?`,
            bindings: [sourceUserId],
        },
    ]

    for (const table of [
        'orders',
        'reviews',
        'review_replies',
        'refund_requests',
        'daily_checkins_v2',
        'user_notifications',
        'user_messages',
        'broadcast_reads',
        'wishlist_votes',
        'wishlist_items',
        'coupon_usages',
        'user_point_ledger',
    ]) {
        statements.push({
            query: `UPDATE ${table} SET user_id = ? WHERE user_id = ?`,
            bindings: [targetUserId, sourceUserId],
        })
    }

    statements.push({
        query: `UPDATE admin_messages
            SET target_value = ?
            WHERE target_type = 'userId' AND target_value = ?`,
        bindings: [targetUserId, sourceUserId],
    })

    for (const table of ['orders', 'reviews', 'review_replies', 'refund_requests', 'user_messages', 'wishlist_items', 'coupon_usages']) {
        statements.push(usernameUpdateStatement(table, targetUserId, normalizedUsername))
    }

    statements.push({
        query: `DELETE FROM login_users WHERE user_id = ?`,
        bindings: [sourceUserId],
    })

    return statements
}
