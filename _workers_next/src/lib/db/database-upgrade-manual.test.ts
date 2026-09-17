import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function functionSource(source: string, startMarker: string, endMarker: string) {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0, `missing source marker: ${startMarker}`)
    assert.ok(end > start, `missing source marker: ${endMarker}`)
    return source.slice(start, end)
}

test('ordinary database initialization is read-only and never runs registered upgrades', () => {
    const source = readSource('./queries.ts')
    const body = functionSource(
        source,
        'export async function ensureDatabaseInitialized()',
        'async function ensureProductsColumns()',
    )

    assert.match(body, /SELECT 1 FROM products LIMIT 1/)
    assert.doesNotMatch(body, /runRegisteredDatabaseUpgrades/)
    assert.doesNotMatch(body, /prepareDatabaseForManualUpgrade/)
    assert.doesNotMatch(body, /ensureStructuralSchema/)
    assert.doesNotMatch(body, /setSetting\(/)
})

test('registered upgrades run only after the manual upgrade preparation path', () => {
    const source = readSource('./queries.ts')
    const body = functionSource(
        source,
        'export async function runPendingDatabaseUpgrades()',
        'async function prepareDatabaseForManualUpgrade()',
    )

    assert.match(body, /await prepareDatabaseForManualUpgrade\(\)/)
    assert.match(body, /await runRegisteredDatabaseUpgrades\(\)/)
})

test('reading upgrade status does not create or alter migration tables', () => {
    const source = readSource('./queries.ts')
    const body = functionSource(
        source,
        'export async function getDatabaseUpgradeStatus()',
        'export async function runPendingDatabaseUpgrades()',
    )

    assert.match(body, /readDatabaseUpgradeStatus/)
    assert.doesNotMatch(body, /ensureDatabaseMigrationsTable/)
})

test('admin page load and manual action do not call ordinary request initialization', () => {
    const actionSource = readSource('../../actions/database-upgrades.ts')
    const pageSource = readSource('../../app/admin/database/page.tsx')

    assert.doesNotMatch(actionSource, /ensureDatabaseInitialized/)
    assert.doesNotMatch(pageSource, /ensureDatabaseInitialized/)
    assert.match(actionSource, /runPendingDatabaseUpgrades\(\)/)
})
