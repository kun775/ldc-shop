import test from 'node:test'
import assert from 'node:assert/strict'

const registry = await import(new URL('./database-upgrade-registry.ts', import.meta.url).href)
const {
    buildDatabaseUpgradeStatus,
    DATABASE_UPGRADE_DEFINITIONS,
    DATABASE_UPGRADE_RUNNING_TIMEOUT_MS,
} = registry

function appliedRecord() {
    return {
        id: DATABASE_UPGRADE_DEFINITIONS[0].id,
        name: DATABASE_UPGRADE_DEFINITIONS[0].name,
        description: DATABASE_UPGRADE_DEFINITIONS[0].description,
        status: 'applied',
        claimId: 'claim-1',
        startedAt: 100,
        executedAt: 200,
        durationMs: 100,
        errorId: null,
        errorMessage: null,
        updatedAt: 200,
    }
}

test('database upgrade ids are unique and ordered', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual([...ids].sort(), ids)
})

test('applied upgrade remains applied when structure is healthy', () => {
    const status = buildDatabaseUpgradeStatus([appliedRecord()], true, 1_000)
    assert.equal(status.total, 1)
    assert.equal(status.applied, 1)
    assert.equal(status.pending, 0)
    assert.equal(status.items[0].repairRequired, false)
})

test('applied structural upgrade becomes pending when drift is detected', () => {
    const status = buildDatabaseUpgradeStatus([appliedRecord()], false, 1_000)
    assert.equal(status.applied, 0)
    assert.equal(status.pending, 1)
    assert.equal(status.items[0].status, 'pending')
    assert.equal(status.items[0].repairRequired, true)
})

test('stale running upgrade becomes retryable failure', () => {
    const record = {
        ...appliedRecord(),
        status: 'running',
        executedAt: null,
        startedAt: 1_000,
    }
    const checkedAt = 1_000 + DATABASE_UPGRADE_RUNNING_TIMEOUT_MS
    const status = buildDatabaseUpgradeStatus([record], true, checkedAt)
    assert.equal(status.running, 0)
    assert.equal(status.failed, 1)
    assert.equal(status.pending, 1)
})
