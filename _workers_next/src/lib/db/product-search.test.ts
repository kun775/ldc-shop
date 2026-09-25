import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const { require: tsxRequire } = require('tsx/cjs/api') as typeof import('tsx/cjs/api')
const { DatabaseSync } = require('node:sqlite')

type D1Row = Record<string, unknown>

type D1Database = {
    prepare: (query: string) => {
        bind: (...values: unknown[]) => D1Statement
        all: () => Promise<{ results: D1Row[] }>
        run: () => Promise<{ success: boolean }>
    }
}

type D1Statement = {
    bind: (...values: unknown[]) => D1Statement
    all: () => Promise<{ results: D1Row[] }>
    run: () => Promise<{ success: boolean }>
    raw: () => Promise<unknown[][]>
}

function createD1(database: InstanceType<typeof DatabaseSync>, queries: string[]) {
    const d1: D1Database = {
        prepare(query) {
            let values: unknown[] = []
            const statement: D1Statement = {
                bind(...nextValues) {
                    values = nextValues
                    return statement
                },
                async all() {
                    queries.push(query)
                    return { results: database.prepare(query).all(...values) as D1Row[] }
                },
                async run() {
                    queries.push(query)
                    database.prepare(query).run(...values)
                    return { success: true }
                },
                async raw() {
                    queries.push(query)
                    const rows = database.prepare(query).all(...values) as D1Row[]
                    return rows.map((row) => Object.values(row))
                },
            }
            return statement
        },
    }
    return d1
}

function createProductsDatabase() {
    const database = new DatabaseSync(':memory:')
    database.exec(`
        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            price TEXT NOT NULL,
            compare_at_price TEXT,
            image TEXT,
            category TEXT,
            is_hot INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            is_shared INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            purchase_limit INTEGER,
            visibility_level INTEGER DEFAULT -1,
            point_discount_enabled INTEGER DEFAULT 0,
            point_discount_percent INTEGER DEFAULT 0,
            stock_count INTEGER DEFAULT 0,
            locked_count INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 0,
            rating REAL DEFAULT 0,
            review_count INTEGER DEFAULT 0,
            created_at INTEGER,
            variant_group_id TEXT,
            variant_label TEXT,
            fulfillment_mode TEXT DEFAULT 'auto'
        );
    `)
    database.exec(`
        INSERT INTO products
            (id, name, description, price, category, is_hot, is_active, sort_order, stock_count, locked_count, sold_count, rating, review_count, created_at, variant_group_id, fulfillment_mode, visibility_level)
        VALUES
            ('a1', 'Group parent', 'parent description', '100', 'games', 0, 1, 1, 2, 3, 5, 4, 2, 100, 'group-a', 'auto', -1),
            ('a2', 'Blue variant', 'matches the query', '20', 'games', 1, 1, 2, 4, 1, 7, 5, 3, 200, 'group-a', 'auto', -1),
            ('b1', 'Budget', 'budget item', '9', 'games', 0, 1, 3, 1, 0, 1, 0, 0, 300, NULL, 'auto', -1),
            ('c1', 'Manual', 'manual item', '80', 'games', 0, 1, 4, 7, 99, 2, 0, 0, 400, NULL, 'manual', -1),
            ('d1', 'Empty', 'out of stock', '50', 'games', 0, 1, 5, 0, 0, 0, 0, 0, 500, NULL, 'auto', -1),
            ('hidden', 'Hidden', 'not visible to guest', '1', 'games', 0, 1, 6, 3, 0, 0, 0, 0, 600, NULL, 'auto', 1),
            ('inactive', 'Inactive', 'not active', '2', 'games', 0, 0, 0, 3, 0, 0, 0, 0, 50, NULL, 'auto', -1);
    `)
    return database
}

const database = createProductsDatabase()
const queryLog: string[] = []
const d1 = createD1(database, queryLog)
;(globalThis as Record<symbol, unknown>)[Symbol.for('__cloudflare-context__')] = { env: { DB: d1 } }
process.env.NODE_ENV = 'production'

function resetQueryLog() {
    queryLog.length = 0
}

const { searchActiveProducts } = tsxRequire('./queries.ts', import.meta.url) as typeof import('./queries')

test('按变体组搜索时保留整组、代表规则和组聚合字段', async () => {
    resetQueryLog()
    const result = await searchActiveProducts({ q: 'Blue', page: 1, pageSize: 10 })

    assert.equal(result.total, 1)
    assert.equal(result.items.length, 1)
    const item = result.items[0] as any
    assert.equal(item.id, 'a1')
    assert.equal(item.variantCount, 2)
    assert.deepEqual(item.allVariantIds, ['a1', 'a2'])
    assert.equal(item.priceMin, 20)
    assert.equal(item.priceMax, 100)
    assert.equal(item.totalSold, 12)
    assert.equal(item.stockCount, 10)
    assert.equal(item.groupHot, true)
    assert.equal(item.totalReviewCount, 5)
    assert.equal(item.avgRating, 4.6)
    assert.equal(queryLog.length, 2)
})

test('价格排序使用数值组价格，分页按组且 total 准确', async () => {
    resetQueryLog()
    const result = await searchActiveProducts({ sort: 'priceAsc', page: 2, pageSize: 1 })

    assert.equal(result.total, 4, '访客只应看到 4 个商品组')
    assert.deepEqual(result.items.map((item: any) => item.id), ['a1'])
    assert.equal((result.items[0] as any).priceMin, 20)
    assert.equal((result.items[0] as any).variantCount, 2)
    assert.match(queryLog[1], /ROW_NUMBER\(\) OVER/i)

    const descending = await searchActiveProducts({ sort: 'priceDesc', pageSize: 2 })
    assert.deepEqual(descending.items.map((item) => item.id), ['a1', 'c1'])
})

test('分类、可见性和履约过滤在组分页前生效', async () => {
    const manual = await searchActiveProducts({ category: 'games', fulfillment: 'manual', pageSize: 10 })
    assert.equal(manual.total, 1)
    assert.deepEqual(manual.items.map((item: any) => item.id), ['c1'])
    assert.equal((manual.items[0] as any).stockCount, 7)

    const auto = await searchActiveProducts({ category: 'games', fulfillment: 'auto', pageSize: 10 })
    assert.equal(auto.total, 3)
    assert.ok(auto.items.every((item: any) => item.fulfillmentMode !== 'manual'))

    const inStock = await searchActiveProducts({ category: 'games', fulfillment: 'inStock', pageSize: 10 })
    assert.equal(inStock.total, 3)
    assert.ok(!inStock.items.some((item: any) => item.id === 'd1'))

    const loggedIn = await searchActiveProducts({ category: 'games', isLoggedIn: true, trustLevel: 1, pageSize: 10 })
    assert.equal(loggedIn.total, 5)
    assert.ok(loggedIn.items.some((item: any) => item.id === 'hidden'))
})

test('搜索长描述时匹配完整内容，返回摘要仍限制长度', async () => {
    database.prepare('UPDATE products SET description = ? WHERE id = ?')
        .run(`${'x'.repeat(1100)}needle`, 'b1')

    const result = await searchActiveProducts({ q: 'needle' })
    assert.equal(result.total, 1)
    assert.equal(result.items[0].id, 'b1')
    assert.equal(result.items[0].description?.length, 1000)
})

test('混合履约变体按组过滤，且保持代表商品', async () => {
    database.exec(`INSERT INTO products (id, name, price, category, sort_order, stock_count, variant_group_id, fulfillment_mode)
        VALUES ('mixed-auto', 'Mixed auto', '30', 'mixed', 1, 1, 'mixed-group', 'auto'),
               ('mixed-manual', 'Mixed manual', '40', 'mixed', 2, 2, 'mixed-group', 'manual')`)

    const manual = await searchActiveProducts({ category: 'mixed', fulfillment: 'manual' })
    assert.equal(manual.total, 1)
    assert.equal(manual.items[0].id, 'mixed-auto')
    assert.equal(manual.items[0].groupManual, true)
    assert.deepEqual(manual.items[0].allVariantIds, ['mixed-auto', 'mixed-manual'])
    assert.equal(manual.items[0].stockCount, 3)

    const auto = await searchActiveProducts({ category: 'mixed', fulfillment: 'auto' })
    assert.equal(auto.total, 0)
})

test('共享商品缺货但有锁定量时，不应进入现货结果', async () => {
    database.exec(`INSERT INTO products (id, name, price, category, is_shared, stock_count, locked_count)
        VALUES ('shared-empty', 'Shared empty', '25', 'shared', 1, 0, 8)`)

    const result = await searchActiveProducts({ category: 'shared', fulfillment: 'inStock' })
    assert.equal(result.total, 0)
    assert.deepEqual(result.items, [])
})

test('用户排序不会被变体整形阶段改回默认排序', async () => {
    const sold = await searchActiveProducts({ sort: 'soldDesc', pageSize: 2 })
    assert.deepEqual(sold.items.map((item: any) => item.id), ['a1', 'c1'])

    const stock = await searchActiveProducts({ sort: 'stockDesc', pageSize: 2 })
    assert.deepEqual(stock.items.map((item: any) => item.id), ['a1', 'c1'])

    const hot = await searchActiveProducts({ sort: 'hot', pageSize: 2 })
    assert.equal(hot.items[0].id, 'a1')
})
