import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// 执行 queries.ts 中 0035 的原函数体，而不是在测试里重写迁移 SQL。
const source = readFileSync(new URL('./queries.ts', import.meta.url), 'utf8')
const migration = source.match(/^async function dedupeAndIndexReviewsOrderId\(\)\s*\{([\s\S]*?)^\}/m)
const index = source.match(/^export const REVIEW_ORDER_ID_UNIQUE_INDEX\s*=\s*'([^']+)'/m)
assert.ok(migration, '0035 migration function must exist in queries.ts')
assert.ok(index, '0035 index name must exist in queries.ts')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
) => (batch: (statements: readonly { query: string; bindings?: readonly unknown[] }[]) => Promise<void>, indexName: string) => Promise<void>
const executeProductionMigration = new AsyncFunction(
    'runAtomicD1Batch',
    'REVIEW_ORDER_ID_UNIQUE_INDEX',
    migration[1],
)
const indexName = index[1]

function createDatabase() {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE products (id TEXT PRIMARY KEY, rating REAL NOT NULL, review_count INTEGER NOT NULL);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, order_id TEXT NOT NULL, rating INTEGER NOT NULL);
        INSERT INTO products (id, rating, review_count) VALUES
            ('kept', 99, 99), ('deleted', 88, 88), ('empty', 77, 77), ('unaffected', 66, 66);
        INSERT INTO reviews (id, product_id, order_id, rating) VALUES
            (1, 'kept', 'shared', 5),
            (2, 'deleted', 'shared', 1),
            (3, 'kept', 'kept-only', 3),
            (4, 'deleted', 'deleted-only', 4),
            (5, 'kept', 'second-shared', 4),
            (6, 'empty', 'second-shared', 2),
            (7, 'unaffected', 'unaffected-only', 2);
    `)
    return database
}

function products(database: InstanceType<typeof DatabaseSync>) {
    return database.prepare('SELECT id, rating, review_count FROM products ORDER BY id').all()
        .map((row: { id: string; rating: number; review_count: number }) => ({ ...row }))
}

function reviews(database: InstanceType<typeof DatabaseSync>) {
    return database.prepare('SELECT id, product_id, order_id, rating FROM reviews ORDER BY id').all()
        .map((row: { id: number; product_id: string; order_id: string; rating: number }) => ({ ...row }))
}

async function runMigration(database: InstanceType<typeof DatabaseSync>) {
    await executeProductionMigration(async (statements) => {
        assert.equal(statements.length, 3, '0035 must update aggregates, delete duplicates, then create the index in one batch')
        database.exec('BEGIN')
        try {
            for (const { query, bindings } of statements) {
                database.prepare(query).run(...(bindings ?? []))
            }
            database.exec('COMMIT')
        } catch (error) {
            database.exec('ROLLBACK')
            throw error
        }
    }, indexName)
}

test('0035 recomputes both sides of cross-product duplicates and enforces the order index', async (t) => {
    const database = createDatabase()
    t.after(() => database.close())

    await runMigration(database)

    assert.deepEqual(reviews(database), [
        { id: 1, product_id: 'kept', order_id: 'shared', rating: 5 },
        { id: 3, product_id: 'kept', order_id: 'kept-only', rating: 3 },
        { id: 4, product_id: 'deleted', order_id: 'deleted-only', rating: 4 },
        { id: 5, product_id: 'kept', order_id: 'second-shared', rating: 4 },
        { id: 7, product_id: 'unaffected', order_id: 'unaffected-only', rating: 2 },
    ])
    assert.deepEqual(products(database), [
        { id: 'deleted', rating: 4, review_count: 1 },
        { id: 'empty', rating: 0, review_count: 0 },
        { id: 'kept', rating: 4, review_count: 3 },
        { id: 'unaffected', rating: 66, review_count: 66 },
    ])

    const indexes = database.prepare('PRAGMA index_list(reviews)').all() as { name: string; unique: number }[]
    assert.equal(indexes.find((item) => item.name === indexName)?.unique, 1)
    assert.deepEqual(
        database.prepare(`PRAGMA index_info(${indexName})`).all().map((item: { name: string }) => item.name),
        ['order_id'],
    )
    assert.throws(
        () => database.prepare('INSERT INTO reviews (id, product_id, order_id, rating) VALUES (8, ?, ?, 1)').run('deleted', 'shared'),
        /unique constraint failed: reviews\.order_id/i,
    )

    await runMigration(database)
    assert.equal(reviews(database).length, 5, '0035 is safe to rerun')
    assert.equal((products(database).find((item) => item.id === 'kept'))?.review_count, 3)
})

test('0035 rolls back aggregate changes and deletions when index creation fails', async (t) => {
    const database = createDatabase()
    t.after(() => database.close())
    // SQLite 中同名表使真实的 CREATE UNIQUE INDEX 失败，不替换生产 SQL。
    database.exec(`CREATE TABLE ${indexName} (id INTEGER)`)
    const beforeProducts = products(database)
    const beforeReviews = reviews(database)

    await assert.rejects(runMigration(database), /already a table named/i)

    assert.deepEqual(products(database), beforeProducts)
    assert.deepEqual(reviews(database), beforeReviews)
    assert.equal(
        (database.prepare('PRAGMA index_list(reviews)').all() as { name: string }[]).some((item) => item.name === indexName),
        false,
    )
})
