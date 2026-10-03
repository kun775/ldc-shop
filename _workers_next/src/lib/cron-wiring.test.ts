/**
 * 定时任务「接线」守卫。
 *
 * 背景：`src/app/api/internal/cron/<name>/route.ts` 存在 **不等于** 被调度。
 * 真正的调度源是 `worker-entry.mjs` 的 `scheduled()` —— 它必须显式 POST 每个入口。
 * 曾经 `/api/internal/cron/license-service`（交付重放 / 对账 / 作废重放 / 低水位补货）
 * 就是这样静默漏接线的：路由、鉴权、单测全都在，生产里却一次都没跑过。
 *
 * 这里读 `worker-entry.mjs` 的**文本**（它是纯 JS，不在 TS 编译范围里，无法 import），
 * 做三件事：① 每个 cron 路由都被登记；② 登记项确实在 scheduled 里被逐个执行；
 * ③ 一个入口失败不会阻断其余入口。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { clampCardServiceCronLimit } from './license-service/replenish.ts'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const cronRouteDir = new URL('../app/api/internal/cron/', import.meta.url)
const workerEntry = source('../../worker-entry.mjs')

type CronEntry = { name: string; path: string; source: string }

/** 枚举 `src/app/api/internal/cron/<name>/route.ts` 下的全部入口。 */
function discoverCronEntries(): CronEntry[] {
    return readdirSync(cronRouteDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const routeUrl = new URL(`${entry.name}/route.ts`, cronRouteDir)
            try {
                if (!statSync(routeUrl).isFile()) return null
            } catch {
                return null
            }
            return {
                name: entry.name,
                path: `/api/internal/cron/${entry.name}`,
                source: readFileSync(routeUrl, 'utf8'),
            }
        })
        .filter((entry): entry is CronEntry => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
}

const cronEntries = discoverCronEntries()

test('cron routes are discoverable', () => {
    // 至少要有 cleanup 与 license-service 两个入口；数量下限只是防呆，
    // 真正的断言是下面「每个入口都被登记」。
    assert.ok(cronEntries.length >= 2, `expected >= 2 cron routes, found ${cronEntries.length}`)
    assert.ok(cronEntries.some((entry) => entry.name === 'license-service'))
})

test('every internal cron route is registered in worker-entry scheduled paths', () => {
    for (const entry of cronEntries) {
        assert.ok(
            workerEntry.includes(`"${entry.path}"`),
            `${entry.path} is missing from worker-entry.mjs SCHEDULED_CRON_PATHS — ` +
                'the route exists but nothing ever calls it',
        )
    }
})

test('each cron route still exposes a POST handler', () => {
    for (const entry of cronEntries) {
        assert.match(
            entry.source,
            /export async function POST\s*\(/,
            `${entry.path} must export an async POST handler`,
        )
    }
})

test('scheduled handler actually runs every registered cron path', () => {
    const start = workerEntry.indexOf('async function runScheduledCrons')
    const end = workerEntry.indexOf('export default {')
    assert.ok(start > 0 && end > start, 'runScheduledCrons must be defined before the default export')
    const scheduler = workerEntry.slice(start, end)

    assert.match(scheduler, /for \(const path of SCHEDULED_CRON_PATHS\)/)
    assert.match(scheduler, /await postInternalCron\(env, path\)/)

    const scheduledHandler = workerEntry.slice(workerEntry.indexOf('async scheduled('))
    assert.match(scheduledHandler, /ctx\.waitUntil\(/)
    assert.match(scheduledHandler, /runScheduledCrons\(env\)/)
})

test('one failing cron entry cannot block the remaining entries', () => {
    const start = workerEntry.indexOf('async function runScheduledCrons')
    const end = workerEntry.indexOf('export default {')
    const scheduler = workerEntry.slice(start, end)

    // 循环体内必须自带 try/catch：否则「清理挂了」会连带让卡密补偿停摆。
    assert.match(scheduler, /try\s*\{/)
    assert.match(scheduler, /catch \(error\)/)
    assert.match(scheduler, /console\.error/)
})

test('worker-entry sends the shared cron token header name', () => {
    const auth = source('./cron-auth.ts')
    const header = auth.match(/CRON_TOKEN_HEADER\s*=\s*["']([^"']+)["']/)
    assert.ok(header, 'CRON_TOKEN_HEADER must be defined in cron-auth.ts')
    assert.ok(
        workerEntry.includes(`"${header[1]}"`),
        `worker-entry.mjs must send the ${header[1]} header to match cron-auth.ts`,
    )
})

test('worker-entry resolves the same token sources as getCronToken', () => {
    // 两边都要「CRON_CLEANUP_TOKEN 优先，回退 OAUTH_CLIENT_SECRET」；
    // 只看字符串出现，防止某一侧被单方面改掉导致线上定时任务 401。
    for (const key of ['CRON_CLEANUP_TOKEN', 'OAUTH_CLIENT_SECRET']) {
        assert.ok(workerEntry.includes(key), `worker-entry.mjs must consider ${key}`)
    }
})

type CronEnv = Record<string, string | undefined>
const configuredEnv: CronEnv = {
    NEXT_PUBLIC_APP_URL: ' https://shop.example.com/ ',
    CRON_CLEANUP_TOKEN: ' cron-token ',
    OAUTH_CLIENT_SECRET: 'oauth-secret',
}

/** 隔离生成的 OpenNext 模块，只替换依赖；实际执行 worker-entry 中的调度代码。 */
function cronHarness(respond: (request: Request) => Promise<Response> = async () => Response.json({ success: true })) {
    const requests: Request[] = []
    const logs: unknown[][] = []
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    const pending: Promise<void>[] = []
    let nextCalls = 0
    const workerSource = workerEntry
        .replace(/^import nextWorker from[^\n]+\n/m, '')
        .replace(/^export \* from[^\n]+(?:\n|$)/m, '')
        .replace('export default ', 'const worker = ')
    const worker = runInNewContext(workerSource + '\nworker;', {
        URL, Request, Response,
        fetch: async (request: Request) => {
            requests.push(request)
            return respond(request)
        },
        nextWorker: {
            fetch: async () => {
                nextCalls++
                throw new Error('Cron must not execute Next.js in the scheduled invocation')
            },
        },
        console: {
            log: (...args: unknown[]) => logs.push(args),
            warn: (...args: unknown[]) => warnings.push(args),
            error: (...args: unknown[]) => errors.push(args),
        },
    }) as { scheduled: (event: object, env: CronEnv, ctx: { waitUntil: (task: Promise<void>) => void }) => Promise<void> }

    return {
        requests, logs, warnings, errors,
        nextCalls: () => nextCalls,
        run: async (env: CronEnv = configuredEnv) => {
            await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (task) => pending.push(task) })
            assert.equal(pending.length, 1, 'scheduled must register its work with waitUntil')
            await Promise.all(pending)
        },
    }
}

test('卡密 cron 的 limit：缺失、空串、非数字用 1，合法值夹在 1 到 10', () => {
    assert.equal(clampCardServiceCronLimit(null), 1)
    assert.equal(clampCardServiceCronLimit(''), 1)
    assert.equal(clampCardServiceCronLimit('   '), 1)
    assert.equal(clampCardServiceCronLimit('abc'), 1)
    assert.equal(clampCardServiceCronLimit('-3'), 1)
    assert.equal(clampCardServiceCronLimit('0'), 1)
    assert.equal(clampCardServiceCronLimit('4'), 4)
    assert.equal(clampCardServiceCronLimit('10'), 10)
    assert.equal(clampCardServiceCronLimit('50'), 10)
    assert.equal(clampCardServiceCronLimit('1e2'), 10)
})

test('scheduled jobs use separate public HTTP requests without invoking Next.js locally', async () => {
    const harness = cronHarness()
    await harness.run()
    assert.deepEqual(harness.requests.map((request) => new URL(request.url).pathname), [
        '/api/internal/cron/cleanup', '/api/internal/cron/license-service',
    ])
    for (const request of harness.requests) {
        assert.equal(new URL(request.url).origin, 'https://shop.example.com')
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.get('x-cron-cleanup-token'), 'cron-token')
        assert.equal(request.redirect, 'manual', 'Cron credentials must not follow redirects')
    }
    assert.equal(harness.nextCalls(), 0)
    assert.equal(harness.errors.length, 0)
    assert.equal(harness.logs.length, 2)
})

test('scheduled requests retain the OAuth secret fallback', async () => {
    const harness = cronHarness()
    await harness.run({ ...configuredEnv, CRON_CLEANUP_TOKEN: ' ', OAUTH_CLIENT_SECRET: ' fallback-secret ' })
    assert.equal(harness.requests.length, 2)
    assert.ok(harness.requests.every((request) => request.headers.get('x-cron-cleanup-token') === 'fallback-secret'))
})

test('missing cron credentials skip dispatch without loading Next.js', async () => {
    const harness = cronHarness()
    await harness.run({ NEXT_PUBLIC_APP_URL: configuredEnv.NEXT_PUBLIC_APP_URL })
    assert.equal(harness.requests.length, 0)
    assert.equal(harness.nextCalls(), 0)
    assert.equal(harness.warnings.length, 2)
})

test('missing runtime site URL never falls back to the expensive in-process handler', async () => {
    const harness = cronHarness()
    await harness.run({ CRON_CLEANUP_TOKEN: 'cron-token' })
    assert.equal(harness.requests.length, 0)
    assert.equal(harness.nextCalls(), 0)
    assert.equal(harness.errors.length, 2)
    assert.match(String(harness.errors[0][1]), /NEXT_PUBLIC_APP_URL is required/)
})

test('invalid or credential-bearing site URLs are rejected without exposing credentials', async () => {
    for (const url of [
        'not-a-url', 'http://shop.example.com', 'https://user:url-secret@shop.example.com',
        'https://shop.example.com/subpath', 'https://shop.example.com/?token=url-secret',
        'https://shop.example.com/#url-secret',
    ]) {
        const harness = cronHarness()
        await harness.run({ ...configuredEnv, NEXT_PUBLIC_APP_URL: url })
        assert.equal(harness.requests.length, 0, url)
        assert.equal(harness.errors.length, 2, url)
        assert.doesNotMatch(harness.errors.map((args) => args.map(String).join(' ')).join(' '), /url-secret|cron-token|oauth-secret/)
    }
})

test('HTTP failure in cleanup still dispatches license-service', async () => {
    const harness = cronHarness(async (request) => new URL(request.url).pathname.endsWith('/cleanup')
        ? Response.json({ error: 'cleanup_failed' }, { status: 500 })
        : Response.json({ success: true }))
    await harness.run()
    assert.equal(harness.requests.length, 2)
    assert.equal(harness.errors.length, 1)
    assert.match(String(harness.errors[0][0]), /cron-cleanup.*failed: 500/)
    assert.match(String(harness.logs[0][0]), /cron-license-service.*ok/)
})

test('network failure in cleanup still dispatches license-service', async () => {
    const harness = cronHarness(async (request) => {
        if (new URL(request.url).pathname.endsWith('/cleanup')) throw new Error('network unavailable')
        return Response.json({ success: true })
    })
    await harness.run()
    assert.equal(harness.requests.length, 2)
    assert.equal(harness.errors.length, 1)
    assert.match(String(harness.errors[0][1]), /network unavailable/)
    assert.match(String(harness.logs[0][0]), /cron-license-service.*ok/)
})

test('redirected cron endpoints are reported as failures', async () => {
    const harness = cronHarness(async () => Response.redirect('https://other.example.com', 307))
    await harness.run()
    assert.equal(harness.requests.length, 2)
    assert.ok(harness.requests.every((request) => request.redirect === 'manual'))
    assert.equal(harness.logs.length, 0)
    assert.equal(harness.errors.length, 2)
    assert.ok(harness.errors.every((args) => String(args[0]).includes('failed: 307')))
})

test('worker config permits same-site public dispatch without raising Free plan CPU limits', () => {
    const config = JSON.parse(source('../../wrangler.json'))
    assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'))
    assert.deepEqual(config.triggers.crons, ['* * * * *'])
    assert.equal(config.limits?.cpu_ms, undefined)
})
