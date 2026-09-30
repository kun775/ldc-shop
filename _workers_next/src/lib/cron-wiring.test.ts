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
    assert.match(scheduler, /await postInternalCron\(env, ctx, path\)/)

    const scheduledHandler = workerEntry.slice(workerEntry.indexOf('async scheduled('))
    assert.match(scheduledHandler, /ctx\.waitUntil\(/)
    assert.match(scheduledHandler, /runScheduledCrons\(env, ctx\)/)
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
