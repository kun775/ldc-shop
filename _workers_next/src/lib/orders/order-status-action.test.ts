import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../../actions/order.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function setup(status: string, behavior: 'processing' | 'paid-error' | 'query-error' = 'processing', owner = true) {
    const row = { userId: 'user', status, amount: '9.99', currentPaymentId: null }
    let queries = 0
    const exports: Record<string, unknown> = {}
    runInNewContext(code, { exports, console: { error() {} }, require(id: string) {
        if (id === '@/lib/auth') return { auth: async () => ({ user: { id: owner ? 'user' : 'other' } }) }
        if (id === '@/lib/db') return { db: { query: { orders: { findFirst: async () => ({ ...row }) } } } }
        if (id === '@/lib/db/schema') return { orders: { orderId: 'orderId' } }
        if (id === 'drizzle-orm') return { eq: () => true }
        if (id === '@/lib/db/queries') return { withOrderColumnFallback: (fn: () => unknown) => fn() }
        if (id === 'next/headers') return { cookies: async () => ({ get() {} }) }
        if (id === '@/lib/admin-auth') return { isAdminIdentity: () => false }
        if (id === '@/lib/epay') return { queryOrderStatus: async () => {
            queries++
            if (behavior === 'query-error') throw new Error('gateway unavailable')
            return { success: true, status: 1, data: { trade_no: 'real-trade', money: '9.99' } }
        } }
        if (id === '@/lib/order-processing') return { processOrderFulfillment: async () => {
            row.status = behavior === 'paid-error' ? 'paid' : 'processing'
            if (behavior === 'paid-error') throw new Error('delivery failed after confirmed payment')
            return { status: 'processing', orderStatus: 'processing' }
        } }
        if (id === 'next/cache') return { revalidatePath() {} }
        if (id === '@/lib/errors/safe-error') return { sanitizeClientErrorMessage: () => 'common.error' }
        return {}
    } })
    return { check: exports.checkOrderStatus as (orderId: string) => Promise<{ success: boolean; status?: string }>, queries: () => queries }
}

for (const status of ['paid', 'processing', 'delivered']) {
    test(`订单状态查询 ${status} 不查询支付平台，正确返回付款成功`, async () => {
        const ctx = setup(status)
        const result = await ctx.check('ORDER')
        assert.equal(result.success, true); assert.equal(result.status, status); assert.equal(ctx.queries(), 0)
    })
}

for (const behavior of ['processing', 'paid-error'] as const) {
    test(`核验付款后 ${behavior} 仍返回已付款状态`, async () => {
        const ctx = setup('pending', behavior)
        const result = await ctx.check('ORDER')
        assert.equal(result.success, true); assert.equal(result.status, behavior === 'processing' ? 'processing' : 'paid')
        assert.equal(ctx.queries(), 1)
    })
}

test('支付查询异常不能将待支付订单标成已支付', async () => {
    const ctx = setup('pending', 'query-error')
    assert.equal((await ctx.check('ORDER')).success, false)
})

test('正在履约订单仍执行订单归属鉴权', async () => {
    const ctx = setup('processing', 'processing', false)
    assert.equal((await ctx.check('ORDER')).success, false); assert.equal(ctx.queries(), 0)
})
