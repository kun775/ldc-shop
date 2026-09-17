import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const mod = await import(new URL('./manual-stock-triggers.ts', import.meta.url).href)
const { MANUAL_STOCK_TRIGGER_STATEMENTS } = mod

function createDatabase() {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            fulfillment_mode TEXT NOT NULL DEFAULT 'auto',
            manual_stock_count INTEGER NOT NULL DEFAULT 0,
            stock_count INTEGER NOT NULL DEFAULT 0,
            locked_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE orders (
            order_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1,
            manual_stock_quantity INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
        );
    `)
    for (const statement of MANUAL_STOCK_TRIGGER_STATEMENTS) database.exec(statement)
    return database
}

function readStock(database: { prepare: (query: string) => { get: () => object } }) {
    return database.prepare(`
        SELECT manual_stock_count AS manualStockCount, stock_count AS stockCount
        FROM products WHERE id = 'manual-1'
    `).get()
}

test('manual stock is reserved atomically and restored once on cancellation', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 3, 3)
    `)
    database.exec(`
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-1', 'manual-1', 2, 2, 'pending')
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 1, stockCount: 1 })

    assert.throws(() => database.exec(`
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-2', 'manual-1', 2, 2, 'pending')
    `), /manual_stock_insufficient/)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 1, stockCount: 1 })

    database.exec(`UPDATE orders SET status = 'cancelled' WHERE order_id = 'order-1'`)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 3, stockCount: 3 })
    database.exec(`UPDATE orders SET status = 'cancelled' WHERE order_id = 'order-1'`)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 3, stockCount: 3 })
})

test('reactivating a terminal manual order reserves stock again', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 2, 2);
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-1', 'manual-1', 2, 2, 'cancelled');
        UPDATE orders SET status = 'paid' WHERE order_id = 'order-1';
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 0, stockCount: 0 })

    database.exec(`UPDATE orders SET status = 'refunded' WHERE order_id = 'order-1'`)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 2, stockCount: 2 })

    database.exec(`UPDATE products SET manual_stock_count = 1, stock_count = 1 WHERE id = 'manual-1'`)
    assert.throws(() => database.exec(`
        UPDATE orders SET status = 'paid' WHERE order_id = 'order-1'
    `), /manual_stock_insufficient/)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 1, stockCount: 1 })
})

test('deleting an active manual order restores stock without double-restoring terminal orders', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 4, 4);
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-active', 'manual-1', 1, 1, 'paid');
        DELETE FROM orders WHERE order_id = 'order-active';
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 4, stockCount: 4 })

    database.exec(`
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-refunded', 'manual-1', 1, 1, 'pending');
        UPDATE orders SET status = 'refunded' WHERE order_id = 'order-refunded';
        DELETE FROM orders WHERE order_id = 'order-refunded';
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 4, stockCount: 4 })
})

test('deleting a delivered manual order does not put fulfilled stock back', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 2, 2);
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-delivered', 'manual-1', 1, 1, 'delivered');
        DELETE FROM orders WHERE order_id = 'order-delivered';
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 1, stockCount: 1 })
})

test('manual stock reservations reject automatic products and mismatched quantities', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('auto-1', 'auto', 5, 5);
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 5, 5);
    `)
    assert.throws(() => database.exec(`
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-auto', 'auto-1', 1, 1, 'pending')
    `), /manual_stock_invalid_product/)
    assert.throws(() => database.exec(`
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-mismatch', 'manual-1', 2, 1, 'pending')
    `), /manual_stock_invalid_quantity/)
})

test('terminal orders imported from a backup do not reserve stock again', () => {
    const database = createDatabase()
    database.exec(`
        INSERT INTO products (id, fulfillment_mode, manual_stock_count, stock_count)
        VALUES ('manual-1', 'manual', 5, 5);
        INSERT INTO orders (order_id, product_id, quantity, manual_stock_quantity, status)
        VALUES ('order-cancelled', 'manual-1', 2, 2, 'cancelled');
    `)
    assert.deepEqual({ ...readStock(database) }, { manualStockCount: 5, stockCount: 5 })
})
