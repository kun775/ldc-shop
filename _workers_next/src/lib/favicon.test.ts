import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { buildDefaultLogoSvg } from './default-logo.ts'
import { resolveEffectiveShopLogo } from './shop-logo.ts'

function favicon() {
    const source = readFileSync(new URL('../app/favicon/route.ts', import.meta.url), 'utf8')
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    let values: Record<string, string> = {}
    let reads = 0
    let decodes = 0
    let fail = false
    class NextResponse extends Response {
        static redirect(url: URL, init: ResponseInit) {
            return new NextResponse(null, { ...init, headers: { ...init.headers, Location: url.toString() } })
        }
    }
    const exports: Record<string, unknown> = {}
    runInNewContext(code, {
        exports, Request, Response, URL, ArrayBuffer, Uint8Array, Date,
        atob(value: string) { decodes += 1; return atob(value) },
        require(id: string) {
            if (id === 'next/server') return { NextResponse }
            if (id === '@/lib/default-logo') return { buildDefaultLogoSvg }
            if (id === '@/lib/shop-logo') return { resolveEffectiveShopLogo }
            if (id === '@/lib/db/schema') return { settings: { key: 'key', value: 'value' } }
            if (id === 'drizzle-orm') return { inArray: (_key: unknown, keys: string[]) => keys }
            if (id === '@/lib/db') return { db: { select() { return { from() { return {
                async where(keys: string[]) {
                    reads += 1
                    if (fail) throw new Error('simulated missing settings')
                    return Object.entries(values).filter(([key]) => keys.includes(key)).map(([key, value]) => ({ key, value }))
                },
            } } } } } }
            throw new Error(`Unexpected import ${id}`)
        },
    })
    return {
        get: () => (exports.GET as (request: Request) => Promise<Response>)(new Request('https://example.test/favicon')),
        set: (next: Record<string, string>) => { values = next },
        fail: () => { fail = true },
        counts: () => ({ reads, decodes }),
    }
}

test('favicon 图片缓存命中不重新解码，配置每次只查询一次', async () => {
    const ctx = favicon()
    ctx.set({ shop_logo: 'data:image/png;base64,AQID', shop_logo_source: 'custom' })
    assert.deepEqual(new Uint8Array(await (await ctx.get()).arrayBuffer()), new Uint8Array([1, 2, 3]))
    await ctx.get()
    assert.deepEqual(ctx.counts(), { reads: 2, decodes: 1 })
    // 即使时间戳与长度相同，替换图片也不能命中旧图片缓存。
    ctx.set({ shop_logo: 'data:image/png;base64,BAUG', shop_logo_source: 'custom' })
    assert.deepEqual(new Uint8Array(await (await ctx.get()).arrayBuffer()), new Uint8Array([4, 5, 6]))
    assert.deepEqual(ctx.counts(), { reads: 3, decodes: 2 })
})

test('远程 favicon 直接跳转，不解码或代理远程图片', async () => {
    const ctx = favicon()
    ctx.set({ shop_logo: 'https://images.example.test/logo.png', shop_logo_source: 'custom' })
    const response = await ctx.get()
    assert.equal(response.status, 307)
    assert.equal(response.headers.get('Location'), 'https://images.example.test/logo.png')
    assert.equal(ctx.counts().decodes, 0)
})

test('数据库不可读与非法图片回退生成图标', async () => {
    const ctx = favicon()
    ctx.fail()
    assert.equal((await ctx.get()).headers.get('Content-Type'), 'image/svg+xml')
    const invalid = favicon()
    invalid.set({ shop_logo: 'data:image/png;base64,???', shop_logo_source: 'custom' })
    assert.equal((await invalid.get()).headers.get('Content-Type'), 'image/svg+xml')
})

function worker() {
    const source = readFileSync(new URL('../../worker-entry.mjs', import.meta.url), 'utf8')
        .replace(/^import nextWorker .*;$/m, '')
        .replace('export default {', 'globalThis.worker = {')
        .replace(/^export \* .*;$/m, '')
    let calls = 0
    const context = {
        Request, Response, URL, console,
        nextWorker: { async fetch() { calls += 1; return new Response('next') } },
        worker: {} as { fetch(request: Request, env: object, ctx: object): Promise<Response> },
    }
    runInNewContext(source, context)
    return { fetch: (request: Request) => context.worker.fetch(request, {}, {}), calls: () => calls }
}

for (const method of ['GET', 'HEAD']) {
    test(`favicon.ico ${method} 在进入 Next 处理器前跳转并保留版本参数`, async () => {
        const ctx = worker()
        const response = await ctx.fetch(new Request('https://example.test/favicon.ico?v=123', { method }))
        assert.equal(response.status, 307)
        assert.equal(response.headers.get('Location'), 'https://example.test/favicon?v=123')
        assert.equal(ctx.calls(), 0)
    })
}

test('其他页面与方法继续由 Next 处理', async () => {
    const ctx = worker()
    for (const path of ['/', '/admin', '/favicon', '/_next/static/chunk.js']) {
        assert.equal(await (await ctx.fetch(new Request(`https://example.test${path}`))).text(), 'next')
    }
    await ctx.fetch(new Request('https://example.test/favicon.ico', { method: 'POST' }))
    assert.equal(ctx.calls(), 5)
})