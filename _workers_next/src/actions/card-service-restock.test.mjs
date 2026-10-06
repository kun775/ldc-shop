import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const actionSource = readFileSync(new URL('./card-service.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../components/admin/card-service-content.tsx', import.meta.url), 'utf8')
const zh = JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))

function compile(source) {
    return ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
}

function actionHarness(batch, options = {}) {
    const calls = []
    const exports = {}
    const modules = {
        'next/cache': { revalidatePath: (path) => {
            calls.push(['revalidate', path])
            if (options.revalidateError) throw options.revalidateError
        } },
        '@/actions/admin': { checkAdmin: async () => {
            calls.push(['admin'])
            if (options.authError) throw options.authError
        } },
        '@/lib/errors/safe-error': { logServerError: (scope, error) => {
            calls.push(['safeError', scope, error])
            return 'safe-error-id'
        } },
        '@/lib/audit/record': { recordAuditEvent: async (event) => {
            calls.push(['audit', event])
            if (options.auditError) throw options.auditError
        } },
        '@/lib/license-service': { restockProductCardBatch: async (id, quantity) => {
            calls.push(['batch', id, quantity])
            if (options.coreError) throw options.coreError
            return batch
        } },
        '@/lib/license-service/database': {},
        '@/lib/db/license-service-schema': {},
        '@/lib/license-service/product-connection': {},
        '@/lib/license-service/operation-queue': {},
        '@/lib/order-processing': {},
    }
    runInNewContext(compile(actionSource), {
        exports,
        require: (id) => {
            assert.ok(Object.hasOwn(modules, id), `未预期的依赖：${id}`)
            return modules[id]
        },
    })
    return { action: exports.restockCardServiceProductAction, calls }
}

const batch = (requested, restocked, results) => ({ requested, restocked, results })
const restocked = { status: 'restocked', localCardIds: [1, 2], remoteCardIds: ['remote'], secret: '不能回传的密钥' }

function plain(value) {
    return JSON.parse(JSON.stringify(value))
}

test('鉴权先于校验和核心调用；默认数量为 1', async () => {
    const denied = actionHarness(null, { authError: new Error('内部鉴权错误') })
    const result = await denied.action('p', 0)
    assert.equal(result.ok, false)
    assert.equal(result.errorKey, 'common.error')
    assert.equal(result.errorId, 'safe-error-id')
    assert.deepEqual(denied.calls.map(([name]) => name), ['admin', 'safeError'])
    const allowed = actionHarness(batch(1, 1, [restocked]))
    assert.equal((await allowed.action(' p ')).ok, true)
    assert.deepEqual(allowed.calls[1], ['batch', 'p', 1])
})

test('严格拒绝非 number 整数与 1..100 以外数量，不调用核心', async () => {
    for (const quantity of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, '10', null, true, {}, 1n]) {
        const { action, calls } = actionHarness(null)
        const result = await action('p', quantity)
        assert.equal(result.ok, false)
        assert.equal(result.errorKey, 'admin.cardService.restock.invalidQuantity')
        assert.deepEqual(calls.map(([name]) => name), ['admin'])
    }
    for (const quantity of [1, 10, 100]) {
        const { action, calls } = actionHarness(batch(quantity, quantity, [restocked]))
        assert.equal((await action('p', quantity)).ok, true)
        assert.deepEqual(calls[1], ['batch', 'p', quantity])
    }
})

test('空商品 ID 不调用核心', async () => {
    for (const id of ['', ' ', null, 123]) {
        const { action, calls } = actionHarness(null)
        assert.equal((await action(id, 10)).errorKey, 'admin.cardService.errorProductId')
        assert.deepEqual(calls.map(([name]) => name), ['admin'])
    }
})

test('以实际张数而非 results 长度统计成功，保留刷新并审计数量', async () => {
    const { action, calls } = actionHarness(batch(10, 10, [restocked]))
    assert.deepEqual(plain(await action('p', 10)), {
        ok: true, requested: 10, restocked: 10, incomplete: 0, errorKeys: [],
    })
    assert.ok(calls.some(([name, path]) => name === 'revalidate' && path === '/admin/card-service'))
    const event = calls.find(([name]) => name === 'audit')[1]
    assert.equal(event.result, 'success')
    assert.equal(event.metadata.requested, 10)
    assert.equal(event.metadata.restocked, 10)
})

test('部分成功保留进度，所有未完成状态与 skipped 原因保留为稳定键', async () => {
    const results = [restocked, { status: 'skipped', reason: 'materialize_pending' },
        { status: 'deferred' }, { status: 'expired' }, { status: 'failed', message: 'SQL 密钥原文' }]
    const { action, calls } = actionHarness(batch(10, 3, results))
    const result = await action('p', 10)
    assert.equal(result.ok, false)
    assert.equal(result.requested, 10)
    assert.equal(result.restocked, 3)
    assert.equal(result.incomplete, 7)
    assert.deepEqual(plain(result.errorKeys), ['admin.cardService.restock.skipped_materialize_pending',
        'admin.cardService.restock.deferred', 'admin.cardService.restock.expired', 'admin.cardService.restock.failed'])
    assert.equal(result.errorKey, result.errorKeys[0])
    assert.ok(!JSON.stringify(result).includes('SQL'))
    assert.ok(!JSON.stringify(result).includes('密钥'))
    const event = calls.find(([name]) => name === 'audit')[1]
    assert.equal(event.result, 'failure')
    assert.equal(event.metadata.requested, 10)
    assert.equal(event.metadata.restocked, 3)
})

test('零成功、提前停止及不一致状态均不误报全成功', async () => {
    for (const outcome of [batch(10, 0, [{ status: 'skipped', reason: 'product_inactive' }]),
        batch(10, 3, [restocked]), batch(10, 0, []), batch(10, 10, [{ status: 'deferred' }])]) {
        const result = await actionHarness(outcome).action('p', 10)
        assert.equal(result.ok, false)
        assert.equal(result.restocked, outcome.restocked)
    }
})

test('异常使用 safe-error；核心返回后审计或刷新异常不丢成功数量', async () => {
    const core = await actionHarness(null, { coreError: new Error('SELECT secret FROM internal') }).action('p', 10)
    assert.equal(core.errorKey, 'common.error')
    assert.equal(core.errorId, 'safe-error-id')
    assert.ok(!JSON.stringify(core).includes('SELECT'))
    for (const option of ['auditError', 'revalidateError']) {
        const result = await actionHarness(batch(10, 3, [restocked, { status: 'deferred' }]),
            { [option]: new Error('内部故障') }).action('p', 10)
        assert.equal(result.ok, false)
        assert.equal(result.restocked, 3)
        assert.equal(result.requested, 10)
        assert.equal(result.incomplete, 7)
        assert.equal(result.errorKey, 'common.error')
        assert.equal(result.errorId, 'safe-error-id')
    }
})

function translate(key, params = {}) {
    let text = key.split('.').reduce((value, part) => value?.[part], zh)
    assert.equal(typeof text, 'string', `缺少文案：${key}`)
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{{${name}}}`, String(value))
    return text
}

function uiHarness(result, { quantity = '10', refreshError = false } = {}) {
    // 从真实组件提取两个局部函数，避免为测试加载 React/Next/D1。
    const source = ts.createSourceFile('ui.tsx', uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const fragments = []
    const visit = (node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
            ['restockMessage', 'runRestock'].includes(declaration.name.getText(source)))) fragments.push(node.getText(source))
        ts.forEachChild(node, visit)
    }
    visit(source)
    assert.equal(fragments.length, 2)
    const notices = []
    const calls = []
    let saved
    let task
    const context = {
        t: translate,
        restockQuantities: { p: quantity },
        restockCardServiceProductAction: async (...args) => { calls.push(args); return result },
        setRestockResults: (update) => { saved = update({}) },
        setBusyKey: () => {},
        setSnapshot: () => {},
        loadCardServiceSnapshotAction: async () => { if (refreshError) throw new Error('刷新失败'); return {} },
        startTask: (work) => { task = work() },
        toast: Object.fromEntries(['success', 'warning', 'error'].map((tone) => [tone, (message) => notices.push([tone, message])])),
        console: { error: () => {} },
    }
    runInNewContext(compile(`${fragments.join('\n')}\nrunRestock('p')`), context)
    return { done: task, notices, calls, saved: () => saved }
}

test('UI 部分成功显示已补 X/Y、未完成和业务原因，刷新失败不吞结果', async () => {
    const result = { ok: false, requested: 10, restocked: 3, incomplete: 7,
        errorKey: 'admin.cardService.restock.deferred', errorKeys: ['admin.cardService.restock.deferred'], errorId: '' }
    const ui = uiHarness(result, { refreshError: true })
    await ui.done
    assert.deepEqual(ui.calls, [['p', 10]])
    assert.equal(ui.notices[0][0], 'warning')
    assert.match(ui.notices[0][1], /已补 3\/10/)
    assert.match(ui.notices[0][1], /未完成 7 张/)
    assert.match(ui.notices[0][1], /补货在途/)
    assert.equal(ui.notices[1][1], translate('admin.cardService.refreshFailed'))
    assert.equal(ui.saved().p, result)
})

test('UI 完全成功显示数量；零成功仍显示进度；非法输入不调用 action', async () => {
    for (const count of [0, 10]) {
        const ok = count === 10
        const result = { ok, requested: 10, restocked: count, incomplete: 10 - count, errorKeys: [],
            ...(ok ? {} : { errorKey: 'admin.cardService.restock.failed', errorId: '' }) }
        const ui = uiHarness(result)
        await ui.done
        assert.equal(ui.notices[0][0], ok ? 'success' : 'error')
        assert.match(ui.notices[0][1], new RegExp(`已补 ${count}/10`))
    }
    for (const quantity of ['', '0', '101', '1.5']) {
        const ui = uiHarness(null, { quantity })
        await ui.done
        assert.equal(ui.calls.length, 0)
        assert.equal(ui.notices[0][1], translate('admin.cardService.restock.invalidQuantity'))
    }
})

test('UI 输入默认 10、整数范围 1..100；保留旧业务禁用闸门与行内结果', () => {
    assert.match(uiSource, /restockQuantities\[product\.productId\] \?\? '10'/)
    assert.match(uiSource, /type="number"\s+min=\{1\}\s+max=\{100\}\s+step=\{1\}\s+value=\{restockQuantity\}/)
    assert.match(uiSource, /disabled=\{busy \|\| !enabled \|\| !product\.apiKeyPresent \|\| !validRestockQuantity\}/)
    assert.match(uiSource, /onClick=\{\(\) => runRestock\(product\.productId\)\}/)
    assert.match(uiSource, /role="status"/)
    assert.match(uiSource, /\{restockMessage\(restockResult\)\}/)
})

function flatten(value, prefix = '') {
    return Object.entries(value).flatMap(([key, item]) => typeof item === 'object'
        ? flatten(item, `${prefix}${key}.`) : [`${prefix}${key}`]).sort()
}

test('双语键集合 1:1，插值字段一致，覆盖现有全部跳过原因', () => {
    assert.deepEqual(flatten(zh), flatten(en))
    for (const key of flatten(zh.admin.cardService, 'admin.cardService.')) {
        const get = (dict) => key.split('.').reduce((value, part) => value[part], dict)
        const params = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
        assert.deepEqual(params(get(zh)), params(get(en)), key)
    }
    for (const reason of ['not_configured', 'supply_mode_not_license_service', 'program_key_missing',
        'shared_product', 'product_not_found', 'product_inactive', 'materialize_pending']) {
        assert.ok(translate(`admin.cardService.restock.skipped_${reason}`))
    }
})
