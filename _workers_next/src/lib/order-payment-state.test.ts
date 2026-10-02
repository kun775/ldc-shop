import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { FULFILLMENT_CLAIM_TTL_MS } from './orders/fulfillment-lease.ts'

// 执行真实付款入口，数据库和履约依赖在内存中模拟，不接触 D1 或支付平台。
const code = ts.transpileModule(readFileSync(new URL('./order-processing.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

type Row = Record<string, unknown>
type Predicate = (row: Row) => boolean
function setup(status = 'pending', reclaimed = false) {
    const row: Row = { orderId: 'ORDER', productId: 'product', productName: 'Product', status, amount: '9.99',
        paidAt: null, tradeNo: null, currentPaymentId: 'payment',
        fulfillmentClaimId: reclaimed ? 'stale' : null, fulfillmentClaimedAt: reclaimed ? new Date(1) : null }
    const schema = Object.fromEntries(['orderId', 'status', 'fulfillmentClaimedAt', 'fulfillmentClaimId'].map(key => [key, key]))
    const db = {
        query: { orders: { async findFirst() { return { ...row } } },
            products: { async findFirst() { throw new Error('simulated product query failure') } } },
        update() { return { set(values: Row) { return { where(predicate: Predicate) {
            const updates = predicate(row)
            if (updates) Object.assign(row, values)
            return { async returning() { return updates ? [{ orderId: row.orderId }] : [] } }
        } } } } },
    }
    const exports: Record<string, unknown> = {}
    runInNewContext(code, { exports, Date, console: { error() {}, warn() {} }, require(id: string) {
        if (id === './orders/fulfillment-lease.ts') return { FULFILLMENT_CLAIM_TTL_MS }
        if (id === 'crypto') return { randomUUID: () => 'new-claim' }
        if (id === '@/lib/db') return { db }
        if (id === '@/lib/db/schema') return { orders: schema, products: { id: 'productId' } }
        if (id === '@/lib/db/queries') return { ensureDatabaseInitialized: async () => {} }
        if (id === '@/lib/payment') return { isPaymentOrder: () => false }
        if (id === 'drizzle-orm') return {
            eq: (key: string, value: unknown): Predicate => row => row[key] === value,
            lt: (key: string, value: Date): Predicate => row => Number(row[key]) < Number(value),
            isNull: (key: string): Predicate => row => row[key] == null,
            and: (...predicates: Predicate[]): Predicate => row => predicates.every(p => p(row)),
            or: (...predicates: Predicate[]): Predicate => row => predicates.some(p => p(row)),
        }
        return {}
    } })
    return { row, process: exports.processOrderFulfillment as (orderId: string, amount: number, tradeNo: string) => Promise<unknown> }
}

for (const reclaimed of [false, true]) {
    test(`付款已核验后前置发货错误：${reclaimed ? '回收过期锁' : '新付款'}仍保持已支付并释放锁`, async () => {
        const ctx = setup(reclaimed ? 'processing' : 'pending', reclaimed)
        await assert.rejects(ctx.process('ORDER', 9.99, 'real-trade'), /simulated product query failure/)
        assert.equal(ctx.row.status, 'paid'); assert.equal(ctx.row.tradeNo, 'real-trade')
        assert.ok(ctx.row.paidAt instanceof Date)
        assert.equal(ctx.row.fulfillmentClaimId, null); assert.equal(ctx.row.fulfillmentClaimedAt, null)
    })
}

test('付款金额核验失败：不标记付款、不认领履约', async () => {
    const ctx = setup()
    await assert.rejects(ctx.process('ORDER', 1, 'wrong-trade'), /Amount mismatch/)
    assert.equal(ctx.row.status, 'pending'); assert.equal(ctx.row.paidAt, null)
    assert.equal(ctx.row.tradeNo, null); assert.equal(ctx.row.fulfillmentClaimId, null)
})
