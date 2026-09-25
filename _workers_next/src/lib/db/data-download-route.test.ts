import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { getTableColumns, getTableName } from 'drizzle-orm'
import * as schema from './schema.ts'
import { prepareManualStockProductsForSqlBackup } from '../manual-stock-backup.ts'
import { AUDIT_EVENTS_CREATE_TABLE_STATEMENT, PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT, PLATFORM_ERROR_LOGS_ERROR_ID_COLUMN_DEFINITION, AUDIT_EVENTS_REQUIRED_COLUMNS, PLATFORM_ERROR_LOGS_CURRENT_REQUIRED_COLUMNS } from './audit-schema.ts'
import { RATE_LIMIT_CREATE_TABLE_STATEMENT } from './rate-limit-schema.ts'

const routeUrl = new URL('../../app/admin/data/download/route.ts', import.meta.url)
const routeRequire = createRequire(routeUrl)
const source = readFileSync(routeUrl, 'utf8')
const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const tables = Object.values(schema)
const independentTables = ['audit_events', 'platform_error_logs', 'rate_limit_counters']
const expectedTables = [...tables.map(getTableName), ...independentTables].sort()

function setup(options: { withoutRateLimit?: boolean } = {}) {
    const sqlite = new DatabaseSync(':memory:')
    for (const table of tables) {
        const columns = Object.values(getTableColumns(table))
            .map((column) => `"${column.name}" ${column.getSQLType()}`)
        sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${columns.join(', ')})`)
    }
    sqlite.exec(AUDIT_EVENTS_CREATE_TABLE_STATEMENT)
    sqlite.exec(PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT)
    sqlite.exec(`ALTER TABLE platform_error_logs ADD COLUMN ${PLATFORM_ERROR_LOGS_ERROR_ID_COLUMN_DEFINITION.join(' ')}`)
    if (!options.withoutRateLimit) sqlite.exec(RATE_LIMIT_CREATE_TABLE_STATEMENT)
    let onQuery: ((query: string) => void) | undefined
    const db = drizzle(async (query, params, method) => {
        const statement = sqlite.prepare(query)
        const values = params.map((value) => value instanceof Uint8Array ? Buffer.from(value) : value)
        if (method === 'run') { statement.run(...values); return { rows: [] } }
        const result = statement.all(...values)
        const rows = query.includes('sqlite_master') || query.startsWith('PRAGMA table_info')
            ? result : result.map((row) => Object.values(row))
        onQuery?.(query)
        return { rows }
    }, { schema })
    class NextResponse extends Response {
        static json(body: unknown, init?: ResponseInit) {
            return new NextResponse(JSON.stringify(body), init)
        }
    }
    const exports: Record<string, unknown> = {}
    runInNewContext(code, {
        exports,
        require(id: string) {
            if (id === '@/lib/db') return { db }
            if (id === '@/lib/db/schema') return schema
            if (id === '@/lib/auth') return { auth: async () => ({ user: { id: 'admin' } }) }
            if (id === '@/lib/db/queries') return { ensureDatabaseInitialized: async () => {} }
            if (id === '@/lib/admin-auth') return { isAdminIdentity: () => true }
            if (id === '@/lib/manual-stock-backup') return { prepareManualStockProductsForSqlBackup }
            if (id === '@/lib/errors/safe-error') return { logServerError: () => 'test-error', sanitizeClientErrorMessage: () => 'Export failed' }
            if (id === 'next/server') return { NextResponse }
            return routeRequire(id)
        },
        TextEncoder, ReadableStream, URL, Date, ArrayBuffer, Uint8Array, console,
    }, { filename: routeUrl.pathname })
    const GET = exports.GET as (request: Request) => Promise<Response>
    const request = (format: string) => GET(new Request(`http://localhost/admin/data/download?type=full&format=${format}`))
    return { sqlite, request, setOnQuery(fn: (query: string) => void) { onQuery = fn } }
}

test('全量导出覆盖 schema 中全部业务表，SQL 使用真实列名、毫秒时间戳和 BLOB', async () => {
    const { sqlite, request } = setup()
    sqlite.prepare('INSERT INTO products (id, name, description, price, point_discount_enabled, coupon_usage_restriction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1', '商品', '第一行\n第二行', '5', 1, 'all', 1720000000000)
    sqlite.prepare('INSERT INTO coupons (id, code, name, discount_type, rate_bps, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run('c1', 'C', '券', 'percent', 1000, 'active')
    sqlite.prepare('INSERT INTO order_delivery_files (id, order_id, file_name, content_type, size, storage, content) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(1, 'o1', 'a.bin', 'application/octet-stream', 3, 'db', Buffer.from([0, 39, 255]))
    const jsonResponse = await request('json')
    assert.equal(jsonResponse.status, 200)
    const json = await jsonResponse.json()
    assert.deepEqual(Object.keys(json).sort(), expectedTables)
    assert.equal(json.products[0].pointDiscountEnabled, true)
    assert.equal(json.coupons[0].rateBps, 1000)
    assert.deepEqual(json.audit_events, [])
    assert.deepEqual(json.platform_error_logs, [])
    assert.deepEqual(json.rate_limit_counters, [])

    const sqlResponse = await request('sql')
    assert.equal(sqlResponse.status, 200)
    const dump = await sqlResponse.text()
    assert.match(dump, /INSERT OR IGNORE INTO products \([^\n]*point_discount_enabled[^\n]*coupon_usage_restriction[^\n]*\) VALUES/)
    assert.match(dump, /1720000000000/)
    assert.match(dump, /INSERT OR IGNORE INTO coupons \([^\n]*rate_bps/)
    assert.match(dump, /X'0027ff'/i)
    assert.match(dump, /'第一行' \|\| char\(10\) \|\| '第二行'/)
    assert.ok(dump.endsWith('-- End of Dump\n'))
    const restored = new DatabaseSync(':memory:')
    for (const table of [schema.products, schema.orderDeliveryFiles]) {
        const columns = Object.values(getTableColumns(table))
            .map((column) => `"${column.name}" ${column.getSQLType()}`)
        restored.exec(`CREATE TABLE "${getTableName(table)}" (${columns.join(', ')})`)
    }
    for (const line of dump.split('\n')) {
        if (line.startsWith('INSERT OR IGNORE INTO products ') || line.startsWith('INSERT OR IGNORE INTO order_delivery_files ')) {
            restored.exec(line)
        }
    }
    assert.equal(restored.prepare('SELECT description FROM products').get()?.description, '第一行\n第二行')
    assert.equal(restored.prepare('SELECT hex(content) AS hex FROM order_delivery_files').get()?.hex, '0027FF')
})

test('独立 SQL DDL 表按真实列导出 JSON/SQL，SQL 可回灌，限流联合主键跨页有高水位', async () => {
    const { sqlite, request, setOnQuery } = setup()
    const auditColumns = sqlite.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name)
    const errorColumns = sqlite.prepare('PRAGMA table_info(platform_error_logs)').all().map((row) => row.name)
    assert.deepEqual(auditColumns, [...AUDIT_EVENTS_REQUIRED_COLUMNS])
    assert.deepEqual(errorColumns, [...PLATFORM_ERROR_LOGS_CURRENT_REQUIRED_COLUMNS])
    sqlite.prepare('INSERT INTO audit_events (id, event_name, category, metadata, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('a1', 'checkout', 'order', '{"note":"第一行\n第二行"}', 1720000000000)
    sqlite.prepare('INSERT INTO platform_error_logs (id, fingerprint, scope, error_id, occurrence_count, stack) VALUES (?, ?, ?, ?, ?, ?)')
        .run('e1', 'hash', 'checkout', 'err-1', 7, "line 'quoted'")
    const insert = sqlite.prepare('INSERT INTO rate_limit_counters (bucket, subject, window_start, count, expires_at) VALUES (?, ?, ?, ?, ?)')
    for (let i = 1; i <= 501; i++) insert.run('b', 's', i, i, 100)
    insert.run('z', 'last', 10, 9, 100)
    let mutated = false
    setOnQuery((query) => {
        if (query.includes('from "rate_limit_counters"') && query.includes('order by "rate_limit_counters"."bucket", "rate_limit_counters"."subject"') && !query.includes(' desc') && !mutated) {
            mutated = true
            queueMicrotask(() => {
                sqlite.exec("DELETE FROM rate_limit_counters WHERE bucket = 'b' AND subject = 's' AND window_start = 1")
                insert.run('b', 's', 502, 8, 100)
                insert.run('z', 'last', 20, 10, 100)
            })
        }
    })
    const jsonResponse = await request('json')
    assert.equal(jsonResponse.status, 200)
    assert.equal(jsonResponse.headers.get('X-Export-Missing-Optional-Tables'), null)
    const json = await jsonResponse.json()
    assert.equal(json.audit_events[0].metadata, '{"note":"第一行\n第二行"}')
    assert.equal(json.audit_events[0].created_at, 1720000000000)
    assert.equal(json.platform_error_logs[0].error_id, 'err-1')
    assert.equal(json.platform_error_logs[0].occurrence_count, 7)
    assert.equal(json.rate_limit_counters.length, 503)
    assert.equal(new Set(json.rate_limit_counters.map((row: { bucket: string; subject: string; window_start: number }) => `${row.bucket}/${row.subject}/${row.window_start}`)).size, 503)
    assert.equal(mutated, true)
    assert.ok(json.rate_limit_counters.some((row: { bucket: string; window_start: number }) => row.bucket === 'b' && row.window_start === 502))
    assert.ok(!json.rate_limit_counters.some((row: { bucket: string; window_start: number }) => row.bucket === 'z' && row.window_start === 20))

    setOnQuery(() => {})
    const sqlResponse = await request('sql')
    assert.equal(sqlResponse.status, 200)
    const dump = await sqlResponse.text()
    assert.match(dump, /INSERT OR IGNORE INTO audit_events \(id, event_name, category,[^\n]*created_at\) VALUES/)
    assert.match(dump, /INSERT OR IGNORE INTO platform_error_logs \(id, fingerprint, fingerprint_bucket,[^\n]*error_id\) VALUES/)
    assert.match(dump, /INSERT OR IGNORE INTO rate_limit_counters \(bucket, subject, window_start, count, expires_at\) VALUES/)
    assert.ok(dump.endsWith('-- End of Dump\n'))
    const restored = new DatabaseSync(':memory:')
    restored.exec(AUDIT_EVENTS_CREATE_TABLE_STATEMENT)
    restored.exec(PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT)
    restored.exec(`ALTER TABLE platform_error_logs ADD COLUMN ${PLATFORM_ERROR_LOGS_ERROR_ID_COLUMN_DEFINITION.join(' ')}`)
    restored.exec(RATE_LIMIT_CREATE_TABLE_STATEMENT)
    for (const line of dump.split('\n')) {
        if (/^INSERT OR IGNORE INTO (audit_events|platform_error_logs|rate_limit_counters) /.test(line)) restored.exec(line)
    }
    assert.equal(restored.prepare('SELECT metadata FROM audit_events WHERE id = ?').get('a1')?.metadata, '{"note":"第一行\n第二行"}')
    assert.equal(restored.prepare('SELECT error_id FROM platform_error_logs WHERE id = ?').get('e1')?.error_id, 'err-1')
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM rate_limit_counters').get()?.count, 503)
})

test('高水位 keyset 在翻页间删除旧行与新增新行时不漏不重，包括复合主键', async () => {
    const { sqlite, request, setOnQuery } = setup()
    const insert = sqlite.prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
    for (let i = 1; i <= 501; i++) insert.run(i, `category-${i}`)
    const composite = sqlite.prepare('INSERT INTO coupon_products (coupon_id, product_id) VALUES (?, ?)')
    for (let i = 1; i <= 501; i++) composite.run('coupon', String(i).padStart(4, '0'))
    composite.run('z-coupon', '0001')
    let categoryMutated = false
    let compositeMutated = false
    setOnQuery((query) => {
        if (query.includes('from "categories"') && query.includes('limit ?') && query.includes('order by "categories"."id" limit ?') && !categoryMutated) {
            categoryMutated = true
            // 查询返回后才修改：通过异步 microtask 在下一页调用前执行。
            queueMicrotask(() => { sqlite.exec('DELETE FROM categories WHERE id = 1'); insert.run(502, 'new') })
        }
        if (query.includes('from "coupon_products"') && query.includes('limit ?') && query.includes('order by "coupon_products"."coupon_id"') && !compositeMutated) {
            compositeMutated = true
            queueMicrotask(() => { sqlite.exec("DELETE FROM coupon_products WHERE coupon_id = 'coupon' AND product_id = '0001'"); composite.run('coupon', '0502'); composite.run('z-coupon', '0002') })
        }
    })
    const json = await (await request('json')).json()
    assert.equal(json.categories.length, 501)
    assert.equal(new Set(json.categories.map((row: { id: number }) => row.id)).size, 501)
    assert.ok(!json.categories.some((row: { id: number }) => row.id === 502))
    assert.equal(json.categories.at(-1).id, 501)
    assert.equal(json.coupon_products.length, 502)
    assert.equal(new Set(json.coupon_products.map((row: { couponId: string; productId: string }) => `${row.couponId}:${row.productId}`)).size, 502)
    assert.ok(json.coupon_products.some((row: { productId: string }) => row.productId === '0502'))
    assert.ok(!json.coupon_products.some((row: { couponId: string; productId: string }) => row.couponId === 'z-coupon' && row.productId === '0002'))
    assert.equal(json.coupon_products.at(-1).couponId, 'z-coupon')
    assert.equal(json.coupon_products.at(-1).productId, '0001')
})

test('可选限流表缺失显式标注；审计表缺失或空表缺列在 200 前失败', async () => {
    const { request } = setup({ withoutRateLimit: true })
    const jsonResponse = await request('json')
    assert.equal(jsonResponse.status, 200)
    assert.equal(jsonResponse.headers.get('X-Export-Missing-Optional-Tables'), 'rate_limit_counters')
    assert.equal((await jsonResponse.json()).rate_limit_counters, null)
    const sqlResponse = await request('sql')
    assert.equal(sqlResponse.headers.get('X-Export-Missing-Optional-Tables'), 'rate_limit_counters')
    assert.match(await sqlResponse.text(), /-- Missing optional tables: rate_limit_counters/)

    const required = setup()
    required.sqlite.exec('DROP TABLE audit_events')
    assert.equal((await required.request('json')).status, 500)
    const missingColumn = setup()
    missingColumn.sqlite.exec('DROP TABLE platform_error_logs')
    missingColumn.sqlite.exec('CREATE TABLE platform_error_logs (id TEXT PRIMARY KEY)')
    assert.equal((await missingColumn.request('sql')).status, 500)
    const optionalMissingColumn = setup()
    optionalMissingColumn.sqlite.exec('DROP TABLE rate_limit_counters')
    optionalMissingColumn.sqlite.exec('CREATE TABLE rate_limit_counters (bucket TEXT, subject TEXT, window_start INTEGER)')
    assert.equal((await optionalMissingColumn.request('json')).status, 500)
    const extraColumn = setup()
    extraColumn.sqlite.exec('ALTER TABLE audit_events ADD COLUMN unexpected TEXT')
    assert.equal((await extraColumn.request('sql')).status, 500)
    const extraTable = setup()
    extraTable.sqlite.exec('CREATE TABLE future_business_records (id TEXT PRIMARY KEY)')
    assert.equal((await extraTable.request('json')).status, 500)
})

test('缺表在发出 200 前失败，流中断后无结束标志且读取抛错', async () => {
    const { sqlite, request, setOnQuery } = setup()
    sqlite.exec('DROP TABLE coupon_usages')
    const missing = await request('sql')
    assert.equal(missing.status, 500)

    const couponUsageColumns = Object.values(getTableColumns(schema.couponUsages))
        .map((column) => `"${column.name}" ${column.getSQLType()}`)
    sqlite.exec(`CREATE TABLE coupon_usages (${couponUsageColumns.join(', ')})`)
    const insert = sqlite.prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
    for (let i = 1; i <= 501; i++) insert.run(i, `category-${i}`)
    let pages = 0
    setOnQuery((query) => {
        if (query.includes('from "categories"') && query.includes('order by "categories"."id"') && query.includes('limit ?')) {
            if (++pages === 2) throw new Error('simulated page failure')
        }
    })
    const response = await request('sql')
    assert.equal(response.status, 200)
    await assert.rejects(response.text(), (error: Error & { cause?: Error }) => {
        assert.match(error.message, /Failed query/)
        assert.match(error.cause?.message ?? '', /simulated page failure/)
        return true
    })
})
