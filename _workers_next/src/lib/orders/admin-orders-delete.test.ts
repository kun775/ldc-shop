import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// 执行实际 Server Action，替换鉴权、D1 和积分依赖，避免访问生产数据。
const source = readFileSync(new URL('../../actions/admin-orders.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function setup(statuses: Record<string, string>, blockedIds: string[] = [], guardFails = false) {
    const rows = new Map(Object.entries(statuses).map(([orderId, status]) => [orderId,
        { orderId, status, userId: 'user', productId: 'product', pointsUsed: 10 }]))
    let pointReturns = 0
    let sideEffects = 0
    const orders = { orderId: 'orderId' }
    const cards = {}
    const db = {
        query: { orders: { async findFirst({ where }: { where: string }) { return rows.get(where) } } },
        async run() { sideEffects += 1 },
        update() { return { set() { return { async where() { sideEffects += 1 } } } } },
        delete(table: unknown) {
            return { where(id: string) {
                if (table === orders) return { async returning() {
                    sideEffects += 1
                    const removed = rows.delete(id)
                    return removed ? [{ orderId: id }] : []
                } }
                sideEffects += 1
                return Promise.resolve()
            } }
        },
    }
    const sql = Object.assign(() => '', { raw: (value: string) => value })
    const noop = async () => {}
    const exports: Record<string, unknown> = {}
    runInNewContext(code, {
        exports, console: { warn() {}, error() {} },
        require(id: string) {
            if (id === '@/lib/db') return { db }
            if (id === '@/lib/db/schema') return { orders, cards, refundRequests: {} }
            if (id === 'drizzle-orm') return { eq: (_column: unknown, value: string) => value, sql }
            if (id === '@/actions/admin') return { checkAdmin: noop }
            if (id === 'next/cache') return { revalidatePath() {}, updateTag() {} }
            if (id === '@/lib/db/queries') return { recalcProductAggregates: noop, recalcProductAggregatesForMany: noop }
            if (id === '@/lib/points/ledger-db') return { ensurePointLedgerUserRecord: noop,
                async applyUserAutomaticPointEvent() { pointReturns += 1 } }
            if (id === '@/lib/delivery-files') return { deleteDeliveryFiles: noop }
            if (id === '@/lib/coupons/reservation') return { releaseCouponUsages: noop }
            if (id === '@/lib/license-service/database') return { createD1CardServiceDatabase: () => ({}) }
            if (id === '@/lib/license-service/guards') return { async orderHasUnsettledCardServiceLedger(_db: unknown, id: string) {
                if (guardFails) throw new Error('database unavailable')
                return blockedIds.includes(id)
            } }
            if (id === '@/lib/errors/safe-error') return { logServerError: () => 'test', resolveClientErrorKey: () => 'common.error' }
            if (id === '@/lib/orders/order-errors') return { ORDER_ERROR_KEY_MAP: {} }
            return {}
        },
    })
    const actions = exports as {
        deleteOrder(id: string): Promise<{ ok: boolean; errorKey?: string }>
        deleteOrders(ids: string[]): Promise<{ ok: boolean; deletedCount: number; skippedOrderIds: string[] }>
    }
    return { actions, rows, pointReturns: () => pointReturns, sideEffects: () => sideEffects }
}

for (const guardFails of [false, true]) {
    test(`单条删除被${guardFails ? '查询异常' : '未结账本'}拦截时不能误报成功或返积分`, async () => {
        const ctx = setup({ ORDER: 'paid' }, ['ORDER'], guardFails)
        const result = await ctx.actions.deleteOrder('ORDER')
        assert.equal(result.ok, false)
        assert.equal(result.errorKey, 'admin.orders.deleteBlocked')
        assert.equal(ctx.rows.size, 1)
        assert.equal(ctx.pointReturns(), 0)
        assert.equal(ctx.sideEffects(), 0)
    })
}

test('批量删除去重，返回实际删除数量和保留订单', async () => {
    const ctx = setup({ A: 'paid', B: 'paid' }, ['B'])
    const result = await ctx.actions.deleteOrders(['A', 'B', 'A'])
    assert.equal(result.ok, true)
    assert.equal(result.deletedCount, 1)
    assert.deepEqual(Array.from(result.skippedOrderIds), ['B'])
    assert.equal(ctx.rows.has('B'), true)
    assert.equal(ctx.pointReturns(), 1)
})

test('删除已退款订单不再次返还积分', async () => {
    const ctx = setup({ ORDER: 'refunded' })
    assert.equal((await ctx.actions.deleteOrder('ORDER')).ok, true)
    assert.equal(ctx.rows.size, 0)
    assert.equal(ctx.pointReturns(), 0)
})

test('正在履约与不存在订单不能报告删除成功', async () => {
    const ctx = setup({ ORDER: 'processing' })
    assert.equal((await ctx.actions.deleteOrder('ORDER')).ok, false)
    assert.equal((await ctx.actions.deleteOrder('MISSING')).ok, false)
    assert.equal(ctx.pointReturns(), 0)
    assert.equal(ctx.sideEffects(), 0)
})