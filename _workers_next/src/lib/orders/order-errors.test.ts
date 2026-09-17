import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

/**
 * 订单领域错误码的守卫测试。
 *
 * 目的：防止「服务端新增错误码 → 忘记补语言包」或「语言包键被误删」，
 * 这类问题在生产环境表现为用户看到裸 key（例如 admin.orders.orderMissing）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
// 测试文件位于 src/lib/orders/，向上三层即工程根目录
const projectRoot = path.resolve(here, '..', '..', '..')

const mod = await import(new URL('./order-errors.ts', import.meta.url).href)
const { ORDER_ERROR_CODES, ORDER_ERROR_KEY_MAP, DELIVERY_INPUT_ERROR_KEYS } = mod

function loadLocale(name: string): Record<string, unknown> {
    const file = path.join(projectRoot, 'src', 'locales', name)
    return JSON.parse(readFileSync(file, 'utf8'))
}

function getNested(obj: Record<string, unknown>, key: string): unknown {
    let current: unknown = obj
    for (const part of key.split('.')) {
        if (!current || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

test('every order error code resolves in both locales', () => {
    const zh = loadLocale('zh.json')
    const en = loadLocale('en.json')

    for (const code of Object.values(ORDER_ERROR_CODES)) {
        const zhValue = getNested(zh, code)
        const enValue = getNested(en, code)
        assert.equal(typeof zhValue, 'string', `zh.json missing ${code}`)
        assert.equal(typeof enValue, 'string', `en.json missing ${code}`)
        assert.ok(String(zhValue).trim().length > 0, `zh.json has empty ${code}`)
        assert.ok(String(enValue).trim().length > 0, `en.json has empty ${code}`)
    }
})

test('order error key map targets the same locale keys as the codes', () => {
    for (const [code, key] of Object.entries(ORDER_ERROR_KEY_MAP)) {
        assert.ok(
            (Object.values(ORDER_ERROR_CODES) as string[]).includes(code),
            `mapping source ${code} is not a declared order error code`
        )
        assert.ok(
            (Object.values(ORDER_ERROR_CODES) as string[]).includes(key),
            `mapping target ${key} is not a declared order error code`
        )
    }
})

test('delivery input error keys are a subset of declared codes', () => {
    const declared = new Set<string>(Object.values(ORDER_ERROR_CODES))
    for (const key of DELIVERY_INPUT_ERROR_KEYS) {
        assert.ok(declared.has(key), `${key} is not a declared order error code`)
    }
})

test('locale files exist where the guard test expects them', () => {
    assert.ok(existsSync(path.join(projectRoot, 'src', 'locales', 'zh.json')))
    assert.ok(existsSync(path.join(projectRoot, 'src', 'locales', 'en.json')))
})
