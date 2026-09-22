import test from 'node:test'
import assert from 'node:assert/strict'

const registry = await import(new URL('./database-upgrade-registry.ts', import.meta.url).href)
const {
    buildDatabaseUpgradeStatus,
    DATABASE_UPGRADE_BASELINE_SCHEMA_VERSION,
    DATABASE_UPGRADE_DEFINITIONS,
    DATABASE_UPGRADE_RUNNING_TIMEOUT_MS,
    supportsRegisteredDatabaseUpgrades,
} = registry

function health() {
    return Object.fromEntries(
        DATABASE_UPGRADE_DEFINITIONS.map((definition: { id: string }) => [definition.id, true]),
    ) as Record<string, boolean>
}

function appliedRecord(definitionIndex = 0) {
    const definition = DATABASE_UPGRADE_DEFINITIONS[definitionIndex]
    return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
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

/** 为每个已注册升级项各生成一条 applied 记录 */
function allAppliedRecords() {
    return DATABASE_UPGRADE_DEFINITIONS.map((_: unknown, index: number) => appliedRecord(index))
}

test('database upgrade ids are unique and ordered', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual([...ids].sort(), ids)
    assert.ok(ids.length >= 2, 'point ledger trigger rebuild must be its own upgrade item')
})

test('the point ledger trigger rebuild is registered as a separate upgrade item', () => {
    // 数据库变更铁律：结构变更必须新增独立升级项，不得堆进既有的全量修复项。
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(
        ids.includes('0029_point_ledger_balance_trigger'),
        'the balance trigger fix must never be folded into the earlier structural upgrade',
    )
    const item = DATABASE_UPGRADE_DEFINITIONS.find(
        (entry: { id: string }) => entry.id === '0029_point_ledger_balance_trigger',
    )
    assert.equal(item.verifiesStructure, true, '结构修复项必须参与结构校验')
    assert.ok(item.description.length > 0)
})

test('the audit infrastructure is registered as its own upgrade item', () => {
    // 新增表同样必须独立成项：审计表与积分账本无关，
    // 混进任一项都会让「只为建一张表」被迫重跑别处的结构 DDL。
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(ids.includes('0030_audit_infrastructure'))

    const item = DATABASE_UPGRADE_DEFINITIONS.find(
        (entry: { id: string }) => entry.id === '0030_audit_infrastructure',
    )
    assert.equal(item.verifiesStructure, true, '结构修复项必须参与结构校验')
    assert.ok(item.description.length > 0)
    assert.ok(
        ids.indexOf('0030_audit_infrastructure') > ids.indexOf('0029_point_ledger_balance_trigger'),
        'ids must stay in ascending order so the status list reads chronologically',
    )
})

test('the audit error id lookup is registered after the base audit infrastructure', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(ids.includes('0031_audit_error_id_lookup'))
    assert.ok(
        ids.indexOf('0031_audit_error_id_lookup') > ids.indexOf('0030_audit_infrastructure'),
        'new audit columns must be owned by a new immutable upgrade item',
    )
})

test('delivery file download tracking is registered as an independent upgrade', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(ids.includes('0032_delivery_file_download_tracking'))
    assert.ok(
        ids.indexOf('0032_delivery_file_download_tracking') > ids.indexOf('0031_audit_error_id_lookup'),
        'delivery tracking must not be folded into an older immutable upgrade',
    )
})

test('product coupon restriction is registered after delivery tracking', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(ids.includes('0033_product_coupon_restriction'))
    assert.ok(
        ids.indexOf('0033_product_coupon_restriction') > ids.indexOf('0032_delivery_file_download_tracking'),
        'product coupon restriction must be owned by a new immutable upgrade item',
    )
})

test('point ledger history preservation is registered after product coupon restriction', () => {
    const ids = DATABASE_UPGRADE_DEFINITIONS.map((item: { id: string }) => item.id)
    assert.ok(ids.includes('0034_point_ledger_preserve_history'))
    assert.ok(
        ids.indexOf('0034_point_ledger_preserve_history') > ids.indexOf('0033_product_coupon_restriction'),
        'point ledger foreign key removal must be owned by a new immutable upgrade item',
    )
})

test('registered upgrades start from the schema version before the registry was introduced', () => {
    assert.equal(DATABASE_UPGRADE_BASELINE_SCHEMA_VERSION, 27)
    assert.equal(supportsRegisteredDatabaseUpgrades(null), false)
    assert.equal(supportsRegisteredDatabaseUpgrades(26), false)
    assert.equal(supportsRegisteredDatabaseUpgrades(27), true)
    assert.equal(supportsRegisteredDatabaseUpgrades(28), true)
})

test('applied upgrade remains applied when structure is healthy', () => {
    const status = buildDatabaseUpgradeStatus(allAppliedRecords(), health(), 1_000)
    assert.equal(status.total, DATABASE_UPGRADE_DEFINITIONS.length)
    assert.equal(status.applied, DATABASE_UPGRADE_DEFINITIONS.length)
    assert.equal(status.pending, 0)
    for (const item of status.items) {
        assert.equal(item.repairRequired, false, `${item.id} must not require repair`)
    }
})

test('drift only reopens the upgrade item that owns the missing structure', () => {
    const structureHealth = health()
    structureHealth['0029_point_ledger_balance_trigger'] = false
    const status = buildDatabaseUpgradeStatus(allAppliedRecords(), structureHealth, 1_000)

    assert.equal(status.applied, DATABASE_UPGRADE_DEFINITIONS.length - 1)
    assert.equal(status.pending, 1)
    assert.equal(status.structureHealthy, false)
    for (const item of status.items) {
        if (item.id === '0029_point_ledger_balance_trigger') {
            assert.equal(item.status, 'pending')
            assert.equal(item.repairRequired, true)
        } else {
            assert.equal(item.status, 'applied')
            assert.equal(item.repairRequired, false)
        }
    }
})

test('healthy structure overrides missing or failed historical records', () => {
    const failed = {
        ...appliedRecord(0),
        status: 'failed',
        errorId: 'old-error',
        errorMessage: 'old failure',
    }
    const status = buildDatabaseUpgradeStatus([failed], health(), 1_000)

    assert.equal(status.applied, DATABASE_UPGRADE_DEFINITIONS.length)
    assert.equal(status.pending, 0)
    for (const item of status.items) {
        assert.equal(item.status, 'applied')
        assert.equal(item.errorId, null)
        assert.equal(item.errorMessage, null)
    }
})

test('stale running upgrade becomes retryable failure', () => {
    const record = {
        ...appliedRecord(),
        status: 'running',
        executedAt: null,
        startedAt: 1_000,
    }
    const checkedAt = 1_000 + DATABASE_UPGRADE_RUNNING_TIMEOUT_MS
    const structureHealth = health()
    structureHealth[DATABASE_UPGRADE_DEFINITIONS[0].id] = false
    const status = buildDatabaseUpgradeStatus([record], structureHealth, checkedAt)
    assert.equal(status.running, 0)
    assert.equal(status.failed, 1)
    assert.equal(status.pending, 1, 'only the stale item remains retryable')
    assert.equal(status.applied, DATABASE_UPGRADE_DEFINITIONS.length - 1)
})
