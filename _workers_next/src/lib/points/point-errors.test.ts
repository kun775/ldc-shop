import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..')

const {
    POINT_ADMIN_ERROR_KEY_MAP,
    POINT_AUTOMATIC_ERROR_KEY_MAP,
    POINT_CHECKIN_ERROR_KEY_MAP,
} = await import(new URL('./point-errors.ts', import.meta.url).href)

function loadLocale(name: string): Record<string, unknown> {
    const raw = readFileSync(path.join(projectRoot, 'src', 'locales', `${name}.json`), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
}

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

const ALL_MAPS: Array<[string, Record<string, string>]> = [
    ['admin', POINT_ADMIN_ERROR_KEY_MAP],
    ['checkin', POINT_CHECKIN_ERROR_KEY_MAP],
    ['automatic', POINT_AUTOMATIC_ERROR_KEY_MAP],
]

test('every point error key resolves in both locales', () => {
    for (const [name, mapping] of ALL_MAPS) {
        for (const key of Object.values(mapping)) {
            assert.ok(readKey(zh, key), `[${name}] missing zh key: ${key}`)
            assert.ok(readKey(en, key), `[${name}] missing en key: ${key}`)
        }
    }
})

test('all mapped values are well-formed i18n keys, never raw messages', () => {
    for (const [name, mapping] of ALL_MAPS) {
        for (const [code, key] of Object.entries(mapping)) {
            assert.match(
                key,
                /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/,
                `[${name}] mapped value for ${code} must be a dotted i18n key, got: ${key}`,
            )
        }
    }
})

test('balance insufficiency maps to a dedicated message, not a generic error', () => {
    // 余额不足是管理员最需要看懂的失败原因，必须与「未知错误」区分开，
    // 否则界面只会显示「错误」而无法判断是余额问题还是系统故障。
    for (const code of ['POINT_BALANCE_NEGATIVE', 'insufficient_points']) {
        assert.equal(
            POINT_ADMIN_ERROR_KEY_MAP[code],
            'admin.users.adjustNegativeNotAllowed',
            `${code} should map to the negative-balance message`,
        )
    }
})

test('concurrency outcomes map to retryable messages, never to a hard failure', () => {
    // 抢占失败 / 处理中 / 业务键冲突都是可重试状态。
    // 若映射成 common.error，管理员会误以为系统坏了而不去重试。
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_LEDGER_EVENT_IN_PROGRESS, 'admin.users.adjustInProgress')
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_LEDGER_BUSINESS_KEY_CONFLICT, 'admin.users.adjustConflict')
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_LEDGER_CLAIM_FAILED, 'admin.users.adjustFailed')
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_LEDGER_CLAIM_LOST, 'admin.users.adjustFailed')
})

test('schema drift codes degrade to the availability message', () => {
    for (const code of ['no such table', 'no such column', 'column not found']) {
        assert.equal(
            POINT_ADMIN_ERROR_KEY_MAP[code],
            'admin.users.adjustUnavailable',
            `${code} should map to the unavailable message`,
        )
    }
})

test('validation codes map to the form-level messages the dialog already shows', () => {
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_REASON_REQUIRED, 'admin.users.adjustReasonRequired')
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_AMOUNT_INVALID, 'admin.users.adjustAmountInvalid')
})

test('checkin mapping keeps its existing semantics', () => {
    assert.equal(POINT_CHECKIN_ERROR_KEY_MAP.POINT_LEDGER_BUSINESS_KEY_CONFLICT, 'checkin.alreadyCheckedIn')
    assert.equal(POINT_CHECKIN_ERROR_KEY_MAP.POINT_LEDGER_EVENT_IN_PROGRESS, 'checkin.inProgress')
})

test('no mapping ever leaks an internal error code as the visible value', () => {
    // 内部错误码形如 POINT_LEDGER_*，必须是「键」而不是「值」。
    for (const [name, mapping] of ALL_MAPS) {
        for (const key of Object.values(mapping)) {
            assert.ok(
                !/^[A-Z][A-Z0-9_]{6,}$/.test(key),
                `[${name}] ${key} looks like an internal code, not an i18n key`,
            )
        }
    }
})

test('every action-side fallback key exists', () => {
    for (const key of ['common.error', 'admin.users.adjustUserMissing', 'points.insufficient']) {
        assert.ok(readKey(zh, key), `missing zh key: ${key}`)
        assert.ok(readKey(en, key), `missing en key: ${key}`)
    }
})
