import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    POINT_ADMIN_ERROR_KEY_MAP,
    POINT_AUTOMATIC_ERROR_KEY_MAP,
    POINT_CHECKIN_ERROR_KEY_MAP,
} from '../point-errors.ts'

const ledgerSource = readFileSync(new URL('../ledger-db.ts', import.meta.url), 'utf8')

test('the D1 balance trigger is created as one prepared statement', () => {
    assert.doesNotMatch(ledgerSource, /\bexecD1\b/)
    assert.match(
        ledgerSource,
        /db\.run\(sql\.raw\(USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT\)\)/,
    )
})

test('ordinary point requests verify schema without running repair DDL', () => {
    const start = ledgerSource.indexOf('export async function ensureUserPointLedgerSchema')
    const end = ledgerSource.indexOf('export function resetPointLedgerSchemaReady', start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)

    const functionSource = ledgerSource.slice(start, end)
    assert.match(functionSource, /if \(options\?\.force\) \{\s*await repairPointLedgerStructure\(\)/)

    const ordinaryPath = functionSource.slice(functionSource.indexOf('if (pointLedgerSchemaReady)'))
    assert.doesNotMatch(ordinaryPath, /repairPointLedgerStructure\(/)
    assert.match(ordinaryPath, /throw new Error\('POINT_LEDGER_SCHEMA_UNAVAILABLE'\)/)
})

test('schema-unavailable errors are mapped for every point entry point', () => {
    assert.equal(POINT_ADMIN_ERROR_KEY_MAP.POINT_LEDGER_SCHEMA_UNAVAILABLE, 'admin.users.adjustUnavailable')
    assert.equal(POINT_CHECKIN_ERROR_KEY_MAP.POINT_LEDGER_SCHEMA_UNAVAILABLE, 'checkin.failed')
    assert.equal(POINT_AUTOMATIC_ERROR_KEY_MAP.POINT_LEDGER_SCHEMA_UNAVAILABLE, 'common.error')
})
