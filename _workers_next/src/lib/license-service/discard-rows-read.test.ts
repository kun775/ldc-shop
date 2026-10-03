import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { CARD_SERVICE_DDL_STATEMENTS } from '../db/license-service-schema.ts'
import { CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS } from '../db/license-service-operation-index-schema.ts'
import type { CardServiceDatabase } from './db-port.ts'
import { discardFailedAllocation } from './discard.ts'

type LocalD1Database = Awaited<ReturnType<Miniflare['getD1Database']>>

const CORE_DDL_STATEMENTS = [
    `CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', is_shared INTEGER DEFAULT 0)`,
    `CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, card_key TEXT NOT NULL,
        is_used INTEGER DEFAULT 0, reserved_order_id TEXT, reserved_at INTEGER, expires_at INTEGER,
        used_at INTEGER, created_at INTEGER)`,
    `CREATE TABLE orders (order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
        amount TEXT NOT NULL, status TEXT DEFAULT 'pending', trade_no TEXT, card_key TEXT, card_ids TEXT,
        paid_at INTEGER, delivered_at INTEGER, points_used INTEGER DEFAULT 0, current_payment_id TEXT,
        fulfillment_claim_id TEXT, fulfillment_claimed_at INTEGER, created_at INTEGER)`,
    `CREATE INDEX cards_product_used_reserved_idx ON cards(product_id, is_used, reserved_at)`,
    `CREATE INDEX cards_reserved_order_idx ON cards(reserved_order_id)`,
    `CREATE INDEX orders_status_paid_at_idx ON orders(status, paid_at)`,
    `CREATE INDEX orders_product_status_idx ON orders(product_id, status)`,
]

const SCENARIOS = [
    { binding: 'BASE_82_250', allocations: 82, orders: 250, with0040: false },
    { binding: 'INDEX_82_250', allocations: 82, orders: 250, with0040: true },
    { binding: 'INDEX_164_250', allocations: 164, orders: 250, with0040: true },
    { binding: 'INDEX_328_250', allocations: 328, orders: 250, with0040: true },
    { binding: 'INDEX_82_500', allocations: 82, orders: 500, with0040: true },
    { binding: 'INDEX_82_1000', allocations: 82, orders: 1000, with0040: true },
] as const

async function seedGroupA(d1: LocalD1Database, allocations: number, orders: number, with0040: boolean) {
    for (const sql of [...CORE_DDL_STATEMENTS, ...CARD_SERVICE_DDL_STATEMENTS,
        ...(with0040 ? CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS : [])]) {
        await d1.prepare(sql).run()
    }

    // 与基准 A 组一致：400 张背景卡、已交付订单，以及退款单上的单卡分配。
    const cards = 400
    const statements = [d1.prepare("INSERT INTO products (id) VALUES ('demo'), ('other')")]
    for (let i = 1; i <= cards; i++) {
        statements.push(d1.prepare(`INSERT INTO cards (id, product_id, card_key, is_used)
            VALUES (?, ?, ?, ?)`).bind(i, i % 3 ? 'other' : 'demo', `KEY-${i}-${'x'.repeat(30)}`,
                i < cards * 0.6 ? 1 : 0))
    }
    for (let i = 1; i <= orders; i++) {
        const ids = [i, i + 1].filter((id) => id <= cards)
        statements.push(d1.prepare(`INSERT INTO orders
            (order_id, product_id, product_name, amount, status, card_key, card_ids, delivered_at)
            VALUES (?, ?, 'P', '1', 'delivered', ?, ?, 1)`).bind(`ORD${i}`, i % 3 ? 'other' : 'demo',
                ids.map((id) => `KEY-${id}-${'x'.repeat(30)}`).join('\n'), ids.join(',')))
    }
    statements.push(d1.prepare(`INSERT INTO orders
        (order_id, product_id, product_name, amount, status, trade_no, paid_at)
        VALUES ('REF', 'demo', 'P', '0.00', 'refunded', 't', 1)`))
    for (let a = 0; a < allocations; a++) {
        const card = cards + 1 + a
        const allocation = `all-${a}`
        const remote = `rc-${a}`
        statements.push(
            d1.prepare(`INSERT INTO cards (id, product_id, card_key, is_used, used_at)
                VALUES (?, 'demo', ?, 1, 1)`).bind(card, `R-${a}`),
            d1.prepare(`INSERT INTO card_service_allocations
                (allocation_id, product_id, program_key, external_ref, quantity, state,
                 request_key, ack_key, expires_at, created_at, updated_at)
                VALUES (?, 'demo', 'p', ?, 1, 'acknowledged', ?, ?, 9e12, 1, 1)`)
                .bind(allocation, `ref-${a}`, `req-${a}`, `ack-${a}`),
            d1.prepare(`INSERT INTO card_service_cards
                (local_card_id, remote_card_id, allocation_id, product_id, state, created_at, updated_at)
                VALUES (?, ?, ?, 'demo', 'acknowledged', 1, 1)`).bind(card, remote, allocation),
            d1.prepare(`INSERT INTO card_service_operations
                (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
                VALUES (?, 'ack', ?, NULL, 'done', 1, 1, 1)`).bind(`ack-${a}`, allocation),
            d1.prepare(`INSERT INTO card_service_operations
                (operation_key, operation, resource_id, order_id, state, attempts, created_at, updated_at)
                VALUES (?, 'sell', ?, 'REF', 'pending', 0, 1, 1)`).bind(`sell-${a}`, allocation),
            d1.prepare(`INSERT INTO card_service_operations
                (operation_key, operation, resource_id, order_id, state, attempts,
                 last_error_code, created_at, updated_at)
                VALUES (?, 'revoke', ?, 'REF', 'abandoned', 48, 'not_found', 1, 1)`)
                .bind(`rv-${a}`, remote),
        )
    }
    for (let i = 0; i < statements.length; i += 90) {
        await d1.batch(statements.slice(i, i + 90))
    }
}

test('真实本地 D1：丢弃退款批次的 rows_read 阈值与规模增长回归', { timeout: 120_000 }, async (t) => {
    const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: SCENARIOS.map((scenario) => scenario.binding),
        d1Persist: false,
        cf: false,
        outboundService: () => { throw new Error('本地回归测试禁止访问远程') },
    })
    const totals = new Map<string, number>()
    try {
        for (const scenario of SCENARIOS) {
            await t.test(`${scenario.with0040 ? '执行' : '未执行'}0040：${scenario.allocations}/${scenario.orders}`,
                { timeout: 30_000 }, async (st) => {
                    const d1 = await mf.getD1Database(scenario.binding)
                    await seedGroupA(d1, scenario.allocations, scenario.orders, scenario.with0040)
                    // 只统计生产调用；DDL、造数和结果校验不计入读取量。
                    const reads: { kind: 'query' | 'write'; rows: number }[] = []
                    function record(kind: 'query' | 'write', rows: number) {
                        assert.ok(Number.isSafeInteger(rows) && rows >= 0, `无效 meta.rows_read：${rows}`)
                        reads.push({ kind, rows })
                    }
                    const database: CardServiceDatabase = {
                        async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
                            const result = await d1.prepare(sql).bind(...(params ?? [])).all<T>()
                            record('query', result.meta.rows_read)
                            return result.results
                        },
                        async write(statements) {
                            const results = await d1.batch(statements.map((statement) =>
                                d1.prepare(statement.sql).bind(...(statement.params ?? []))))
                            return results.map((result) => {
                                record('write', result.meta.rows_read)
                                return { lastRowId: result.meta.last_row_id, changes: result.meta.changes }
                            })
                        },
                    }
                    assert.deepEqual(await discardFailedAllocation(database, 'rv-0'), {
                        ok: true, allocationId: 'all-0', productId: 'demo', deletedCards: 1, deletedStagedCards: 0,
                    })
                    assert.equal(reads.filter((read) => read.kind === 'query').length, 2)
                    assert.equal(reads.filter((read) => read.kind === 'write').length, 8)
                    const total = reads.reduce((sum, read) => sum + read.rows, 0)
                    totals.set(scenario.binding, total)
                    st.diagnostic(`rows_read=${total}（查询=${reads.filter((read) => read.kind === 'query')
                        .reduce((sum, read) => sum + read.rows, 0)}，写入=${reads.filter((read) => read.kind === 'write')
                        .reduce((sum, read) => sum + read.rows, 0)}）`)
                    assert.ok(total > 0 && total < 40_000, `总读取量 ${total} 必须在 (0, 40000) 内`)
                    if (!scenario.with0040) {
                        assert.ok(total < 12_000, `未执行0040时读取量 ${total} 必须低于12000`)
                    }
                    assert.deepEqual(await d1.prepare(`SELECT state, last_error_code
                        FROM card_service_allocations WHERE allocation_id = 'all-0'`).first(),
                    { state: 'abandoned', last_error_code: 'manually_discarded' })
                    assert.equal(await d1.prepare('SELECT COUNT(*) AS count FROM cards').first<number>('count'),
                        400 + scenario.allocations - 1)
                    assert.equal(await d1.prepare('SELECT COUNT(*) AS count FROM card_service_cards').first<number>('count'),
                        scenario.allocations - 1)
                    assert.equal(await d1.prepare('SELECT COUNT(*) AS count FROM card_service_operations').first<number>('count'),
                        (scenario.allocations - 1) * 3)
                    assert.equal(await d1.prepare('SELECT COUNT(*) AS count FROM orders').first<number>('count'),
                        scenario.orders + 1)
                    assert.equal(await d1.prepare("SELECT status FROM orders WHERE order_id = 'REF'").first<string>('status'),
                        'refunded')
                })
        }
        await t.test('分配翻倍不近似平方增长，订单翻倍读取增长低于2.3倍', (st) => {
            function ratio(numerator: string, denominator: string) {
                const larger = totals.get(numerator)
                const smaller = totals.get(denominator)
                assert.ok(larger !== undefined && smaller !== undefined && smaller > 0, '缺少场景实测读取量')
                const value = larger / smaller
                st.diagnostic(`${numerator}/${denominator}=${value.toFixed(4)}`)
                return value
            }
            assert.ok(ratio('INDEX_164_250', 'INDEX_82_250') <= 3, '82→164 分配读取增长不得近似平方')
            assert.ok(ratio('INDEX_328_250', 'INDEX_164_250') <= 3, '164→328 分配读取增长不得近似平方')
            assert.ok(ratio('INDEX_328_250', 'INDEX_82_250') <= 3, '82→328 分配读取增长不得超过3倍')
            assert.ok(ratio('INDEX_82_500', 'INDEX_82_250') < 2.3, '250→500 订单读取增长必须低于2.3倍')
            assert.ok(ratio('INDEX_82_1000', 'INDEX_82_500') < 2.3, '500→1000 订单读取增长必须低于2.3倍')
        })
    } finally {
        await mf.dispose()
    }
})
