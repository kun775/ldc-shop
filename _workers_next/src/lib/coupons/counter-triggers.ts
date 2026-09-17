export const COUPON_USAGE_TRIGGER_NAMES = [
    'coupon_usages_validate_reserved_insert',
    'coupon_usages_increment_reserved_counts',
    'coupon_usages_validate_status_transition',
    'coupon_usages_apply_status_counts',
] as const

export const COUPON_USAGE_TRIGGER_STATEMENTS: readonly string[] = [
    `CREATE TRIGGER IF NOT EXISTS coupon_usages_validate_reserved_insert
        BEFORE INSERT ON coupon_usages
        WHEN NEW.status = 'reserved'
        BEGIN
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1
                FROM coupons c
                WHERE c.id = NEW.coupon_id
                  AND c.status = 'active'
                  AND (c.starts_at IS NULL OR c.starts_at <= COALESCE(NEW.reserved_at, NEW.created_at, unixepoch() * 1000))
                  AND (c.ends_at IS NULL OR c.ends_at >= COALESCE(NEW.reserved_at, NEW.created_at, unixepoch() * 1000))
                  AND (c.total_use_limit IS NULL OR (c.reserved_count + c.consumed_count) < c.total_use_limit)
            ) THEN RAISE(ABORT, 'coupon_reservation_conflict') END;

            SELECT CASE WHEN EXISTS (
                SELECT 1 FROM coupons c
                WHERE c.id = NEW.coupon_id
                  AND c.per_user_limit IS NOT NULL
                  AND NEW.user_id IS NULL
            ) THEN RAISE(ABORT, 'coupon_login_required') END;

            SELECT CASE WHEN EXISTS (
                SELECT 1
                FROM coupons c
                WHERE c.id = NEW.coupon_id
                  AND c.per_user_limit IS NOT NULL
                  AND NEW.user_id IS NOT NULL
                  AND COALESCE((
                      SELECT uc.reserved_count + uc.consumed_count
                      FROM coupon_user_counters uc
                      WHERE uc.coupon_id = NEW.coupon_id AND uc.user_id = NEW.user_id
                  ), 0) >= c.per_user_limit
            ) THEN RAISE(ABORT, 'coupon_user_limit_reached') END;
        END`,
    `CREATE TRIGGER IF NOT EXISTS coupon_usages_increment_reserved_counts
        AFTER INSERT ON coupon_usages
        WHEN NEW.status = 'reserved'
        BEGIN
            UPDATE coupons
            SET reserved_count = reserved_count + 1,
                updated_at = COALESCE(NEW.reserved_at, NEW.created_at, unixepoch() * 1000)
            WHERE id = NEW.coupon_id;

            INSERT INTO coupon_user_counters (
                coupon_id, user_id, reserved_count, consumed_count, updated_at
            )
            SELECT
                NEW.coupon_id,
                NEW.user_id,
                1,
                0,
                COALESCE(NEW.reserved_at, NEW.created_at, unixepoch() * 1000)
            WHERE NEW.user_id IS NOT NULL
            ON CONFLICT(coupon_id, user_id) DO UPDATE SET
                reserved_count = reserved_count + 1,
                updated_at = excluded.updated_at;
        END`,
    `CREATE TRIGGER IF NOT EXISTS coupon_usages_validate_status_transition
        BEFORE UPDATE OF status ON coupon_usages
        WHEN OLD.status <> NEW.status
          AND NOT (
              (OLD.status = 'reserved' AND NEW.status IN ('consumed', 'released'))
              OR (OLD.status = 'consumed' AND NEW.status = 'reversed')
          )
        BEGIN
            SELECT RAISE(ABORT, 'invalid_coupon_usage_transition');
        END`,
    `CREATE TRIGGER IF NOT EXISTS coupon_usages_apply_status_counts
        AFTER UPDATE OF status ON coupon_usages
        WHEN OLD.status <> NEW.status
        BEGIN
            UPDATE coupons
            SET reserved_count = CASE
                    WHEN OLD.status = 'reserved' AND NEW.status IN ('consumed', 'released')
                    THEN CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END
                    ELSE reserved_count
                END,
                consumed_count = CASE
                    WHEN OLD.status = 'reserved' AND NEW.status = 'consumed' THEN consumed_count + 1
                    WHEN OLD.status = 'consumed' AND NEW.status = 'reversed'
                    THEN CASE WHEN consumed_count > 0 THEN consumed_count - 1 ELSE 0 END
                    ELSE consumed_count
                END,
                updated_at = COALESCE(NEW.reversed_at, NEW.released_at, NEW.consumed_at, unixepoch() * 1000)
            WHERE id = OLD.coupon_id;

            UPDATE coupon_user_counters
            SET reserved_count = CASE
                    WHEN OLD.status = 'reserved' AND NEW.status IN ('consumed', 'released')
                    THEN CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END
                    ELSE reserved_count
                END,
                consumed_count = CASE
                    WHEN OLD.status = 'reserved' AND NEW.status = 'consumed' THEN consumed_count + 1
                    WHEN OLD.status = 'consumed' AND NEW.status = 'reversed'
                    THEN CASE WHEN consumed_count > 0 THEN consumed_count - 1 ELSE 0 END
                    ELSE consumed_count
                END,
                updated_at = COALESCE(NEW.reversed_at, NEW.released_at, NEW.consumed_at, unixepoch() * 1000)
            WHERE coupon_id = OLD.coupon_id AND user_id = OLD.user_id;
        END`,
]

export const COUPON_COUNTER_RECONCILIATION_STATEMENTS: readonly string[] = [
    `UPDATE coupons
        SET reserved_count = (
                SELECT COUNT(*) FROM coupon_usages u
                WHERE u.coupon_id = coupons.id AND u.status = 'reserved'
            ),
            consumed_count = (
                SELECT COUNT(*) FROM coupon_usages u
                WHERE u.coupon_id = coupons.id AND u.status = 'consumed'
            )`,
    `UPDATE coupon_user_counters SET reserved_count = 0, consumed_count = 0`,
    `INSERT INTO coupon_user_counters (
            coupon_id, user_id, reserved_count, consumed_count, updated_at
        )
        SELECT
            coupon_id,
            user_id,
            SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'consumed' THEN 1 ELSE 0 END),
            unixepoch() * 1000
        FROM coupon_usages
        WHERE user_id IS NOT NULL
        GROUP BY coupon_id, user_id
        ON CONFLICT(coupon_id, user_id) DO UPDATE SET
            reserved_count = excluded.reserved_count,
            consumed_count = excluded.consumed_count,
            updated_at = excluded.updated_at`,
]
