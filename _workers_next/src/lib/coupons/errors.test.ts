import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..')

const { COUPON_ADMIN_ERROR_KEY_MAP } = await import(new URL('./errors.ts', import.meta.url).href)

function loadLocale(name: string): Record<string, unknown> {
    const raw = readFileSync(path.join(projectRoot, 'src', 'locales', `${name}.json`), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
}

/** 按点号路径取嵌套字符串，取不到返回 null */
function readKey(source: Record<string, unknown>, key: string): string | null {
    let current: unknown = source
    for (const part of key.split('.')) {
        if (!current || typeof current !== 'object') return null
        current = (current as Record<string, unknown>)[part]
    }
    return typeof current === 'string' ? current : null
}

const zh = loadLocale('zh')
const en = loadLocale('en')

test('every coupon admin error key resolves in both locales', () => {
    for (const key of Object.values(COUPON_ADMIN_ERROR_KEY_MAP)) {
        assert.ok(readKey(zh, key), `missing zh key: ${key}`)
        assert.ok(readKey(en, key), `missing en key: ${key}`)
    }
})

test('all mapped values are well-formed i18n keys, never raw messages', () => {
    for (const [code, key] of Object.entries(COUPON_ADMIN_ERROR_KEY_MAP)) {
        assert.match(
            key,
            /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/,
            `mapped value for ${code} must be a dotted i18n key, got: ${key}`
        )
    }
})

test('schema drift codes degrade to the availability message, not a generic error', () => {
    const schemaCodes = [
        'no such table',
        'no such column',
        'column not found',
        'd1_relation_notfound',
        'd1_column_notfound',
    ]
    for (const code of schemaCodes) {
        assert.equal(
            COUPON_ADMIN_ERROR_KEY_MAP[code],
            'coupon.errors.unavailable',
            `${code} should map to the unavailable message`
        )
    }
})

test('duplicate-code constraint maps to the codeTaken message', () => {
    assert.equal(COUPON_ADMIN_ERROR_KEY_MAP['unique constraint'], 'coupon.admin.errors.codeTaken')
})

test('coupon admin errors section exposes the codes the actions return directly', () => {
    const directKeys = [
        'coupon.admin.errors.notFound',
        'coupon.admin.errors.codeTaken',
        'coupon.admin.errors.lockedAfterUsage',
        'coupon.admin.errors.hasUsage',
    ]
    for (const key of directKeys) {
        assert.ok(readKey(zh, key), `missing zh key: ${key}`)
        assert.ok(readKey(en, key), `missing en key: ${key}`)
    }
})

test('common.error fallback exists in both locales', () => {
    assert.ok(readKey(zh, 'common.error'))
    assert.ok(readKey(en, 'common.error'))
})
