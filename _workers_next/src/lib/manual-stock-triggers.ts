export const MANUAL_STOCK_TRIGGER_NAMES = [
    'manual_stock_validate_order_insert',
    'manual_stock_decrement_order_insert',
    'manual_stock_validate_order_reactivation',
    'manual_stock_decrement_order_reactivation',
    'manual_stock_restore_order_status',
    'manual_stock_restore_order_delete',
] as const

export const MANUAL_STOCK_TRIGGER_STATEMENTS: readonly string[] = [
    `CREATE TRIGGER IF NOT EXISTS manual_stock_validate_order_insert
        BEFORE INSERT ON orders
        WHEN COALESCE(NEW.manual_stock_quantity, 0) > 0
          AND COALESCE(NEW.status, 'pending') NOT IN ('cancelled', 'failed', 'refunded')
        BEGIN
            SELECT CASE WHEN COALESCE(NEW.quantity, 0) <> NEW.manual_stock_quantity
                THEN RAISE(ABORT, 'manual_stock_invalid_quantity') END;
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM products p
                WHERE p.id = NEW.product_id
                  AND COALESCE(p.fulfillment_mode, 'auto') = 'manual'
            ) THEN RAISE(ABORT, 'manual_stock_invalid_product') END;
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM products p
                WHERE p.id = NEW.product_id
                  AND COALESCE(p.manual_stock_count, 0) >= NEW.manual_stock_quantity
            ) THEN RAISE(ABORT, 'manual_stock_insufficient') END;
        END`,
    `CREATE TRIGGER IF NOT EXISTS manual_stock_decrement_order_insert
        AFTER INSERT ON orders
        WHEN COALESCE(NEW.manual_stock_quantity, 0) > 0
          AND COALESCE(NEW.status, 'pending') NOT IN ('cancelled', 'failed', 'refunded')
        BEGIN
            UPDATE products
            SET manual_stock_count = COALESCE(manual_stock_count, 0) - NEW.manual_stock_quantity,
                stock_count = COALESCE(manual_stock_count, 0) - NEW.manual_stock_quantity,
                locked_count = 0
            WHERE id = NEW.product_id;
        END`,
    `CREATE TRIGGER IF NOT EXISTS manual_stock_validate_order_reactivation
        BEFORE UPDATE OF status ON orders
        WHEN COALESCE(OLD.manual_stock_quantity, 0) > 0
          AND COALESCE(OLD.status, 'pending') IN ('cancelled', 'failed', 'refunded')
          AND COALESCE(NEW.status, 'pending') NOT IN ('cancelled', 'failed', 'refunded')
        BEGIN
            SELECT CASE WHEN COALESCE(NEW.quantity, 0) <> NEW.manual_stock_quantity
                THEN RAISE(ABORT, 'manual_stock_invalid_quantity') END;
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM products p
                WHERE p.id = NEW.product_id
                  AND COALESCE(p.fulfillment_mode, 'auto') = 'manual'
            ) THEN RAISE(ABORT, 'manual_stock_invalid_product') END;
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1 FROM products p
                WHERE p.id = NEW.product_id
                  AND COALESCE(p.manual_stock_count, 0) >= NEW.manual_stock_quantity
            ) THEN RAISE(ABORT, 'manual_stock_insufficient') END;
        END`,
    `CREATE TRIGGER IF NOT EXISTS manual_stock_decrement_order_reactivation
        AFTER UPDATE OF status ON orders
        WHEN COALESCE(OLD.manual_stock_quantity, 0) > 0
          AND COALESCE(OLD.status, 'pending') IN ('cancelled', 'failed', 'refunded')
          AND COALESCE(NEW.status, 'pending') NOT IN ('cancelled', 'failed', 'refunded')
        BEGIN
            UPDATE products
            SET manual_stock_count = COALESCE(manual_stock_count, 0) - NEW.manual_stock_quantity,
                stock_count = COALESCE(manual_stock_count, 0) - NEW.manual_stock_quantity,
                locked_count = 0
            WHERE id = NEW.product_id;
        END`,
    `CREATE TRIGGER IF NOT EXISTS manual_stock_restore_order_status
        AFTER UPDATE OF status ON orders
        WHEN COALESCE(OLD.manual_stock_quantity, 0) > 0
          AND COALESCE(OLD.status, 'pending') NOT IN ('cancelled', 'failed', 'refunded')
          AND NEW.status IN ('cancelled', 'failed', 'refunded')
        BEGIN
            UPDATE products
            SET manual_stock_count = COALESCE(manual_stock_count, 0) + OLD.manual_stock_quantity,
                stock_count = COALESCE(manual_stock_count, 0) + OLD.manual_stock_quantity,
                locked_count = 0
            WHERE id = OLD.product_id;
        END`,
    `CREATE TRIGGER IF NOT EXISTS manual_stock_restore_order_delete
        AFTER DELETE ON orders
        WHEN COALESCE(OLD.manual_stock_quantity, 0) > 0
          AND COALESCE(OLD.status, 'pending') IN ('pending', 'processing', 'paid')
        BEGIN
            UPDATE products
            SET manual_stock_count = COALESCE(manual_stock_count, 0) + OLD.manual_stock_quantity,
                stock_count = COALESCE(manual_stock_count, 0) + OLD.manual_stock_quantity,
                locked_count = 0
            WHERE id = OLD.product_id;
        END`,
]
