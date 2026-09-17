import test from 'node:test'
import assert from 'node:assert/strict'

const schemaMod = await import(new URL('../../db/audit-schema.ts', import.meta.url).href)
const eventsMod = await import(new URL('../events.ts', import.meta.url).href)

const {
    AUDIT_EVENTS_COLUMN_DEFINITIONS,
    AUDIT_EVENTS_CREATE_TABLE_STATEMENT,
    AUDIT_EVENTS_INDEX_NAMES,
    AUDIT_EVENTS_INDEX_STATEMENTS,
    AUDIT_EVENTS_REQUIRED_COLUMNS,
    AUDIT_EVENTS_TABLE,
    PLATFORM_ERROR_LOGS_ALL_INDEX_NAMES,
    PLATFORM_ERROR_LOGS_COLUMN_DEFINITIONS,
    PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT,
    PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT,
    PLATFORM_ERROR_LOGS_INDEX_STATEMENTS,
    PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS,
    PLATFORM_ERROR_LOGS_TABLE,
    evaluateAuditStructure,
} = schemaMod

const {
    AUDIT_CATEGORIES,
    AUDIT_EVENT_DEFINITIONS,
    AUDIT_EVENT_NAMES,
    AUDIT_RESULTS,
    AUDIT_SEVERITIES,
    getAuditEventDefinition,
    isKnownAuditEvent,
    resolveAuditEvent,
} = eventsMod

function fullSnapshot() {
    return {
        auditEventsTableExists: true,
        auditEventsColumns: [...AUDIT_EVENTS_REQUIRED_COLUMNS],
        auditEventsIndexes: [...AUDIT_EVENTS_INDEX_NAMES],
        platformErrorTableExists: true,
        platformErrorColumns: [...PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS],
        platformErrorIndexes: [...PLATFORM_ERROR_LOGS_ALL_INDEX_NAMES],
    }
}

test('audit DDL is idempotent', () => {
    for (const statement of [
        AUDIT_EVENTS_CREATE_TABLE_STATEMENT,
        PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT,
    ]) {
        assert.match(statement, /CREATE TABLE IF NOT EXISTS/i)
    }
    for (const statement of [
        ...AUDIT_EVENTS_INDEX_STATEMENTS,
        ...PLATFORM_ERROR_LOGS_INDEX_STATEMENTS,
        PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT,
    ]) {
        assert.match(statement, /CREATE (UNIQUE )?INDEX IF NOT EXISTS/i, statement)
    }
})

test('column definitions are safe for ALTER TABLE ADD COLUMN', () => {
    // SQLite 不允许 ADD COLUMN 带「无默认值的 NOT NULL」，否则历史库补列直接失败
    for (const [column, definition] of [
        ...AUDIT_EVENTS_COLUMN_DEFINITIONS,
        ...PLATFORM_ERROR_LOGS_COLUMN_DEFINITIONS,
    ]) {
        assert.ok(String(definition).trim().length > 0, `${column} must have a definition`)
        if (/NOT NULL/i.test(String(definition))) {
            assert.match(
                String(definition),
                /DEFAULT/i,
                `${column} is NOT NULL without DEFAULT and cannot be added to a legacy table`,
            )
        }
    }
})

test('required columns match the create statements and definitions', () => {
    const hasColumn = (statement: string, column: string) =>
        new RegExp(`^\\s*${column}\\s`, 'im').test(statement)

    for (const column of AUDIT_EVENTS_REQUIRED_COLUMNS) {
        assert.ok(hasColumn(AUDIT_EVENTS_CREATE_TABLE_STATEMENT, column), `audit_events missing declaration for ${column}`)
    }
    for (const column of PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS) {
        assert.ok(hasColumn(PLATFORM_ERROR_LOGS_CREATE_TABLE_STATEMENT, column), `platform_error_logs missing declaration for ${column}`)
    }
})

test('fingerprint unique index is a composite of fingerprint and bucket', () => {
    // 只按 fingerprint 唯一会让「很久以前处理过的同一错误再次爆发」被折叠进
    // 已处理的旧记录，复发永远不可见。必须带上时间桶。
    assert.match(PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT, /UNIQUE INDEX/i)
    const columns = PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT
        .replace(/\s+/g, ' ')
        .match(/\(([^)]*)\)/)?.[1] ?? ''
    assert.ok(columns.includes('fingerprint'), columns)
    assert.ok(columns.includes('fingerprint_bucket'), columns)
})

test('every lookup index is time-anchored so paging stays stable', () => {
    for (const statement of [
        ...AUDIT_EVENTS_INDEX_STATEMENTS,
        ...PLATFORM_ERROR_LOGS_INDEX_STATEMENTS,
    ]) {
        const columns = statement.replace(/\s+/g, ' ').match(/\(([^)]*)\)/)?.[1] ?? ''
        assert.ok(
            /(created_at|last_seen_at)/.test(columns),
            `index must be time-anchored: ${statement}`,
        )
    }
})

test('the aggregation unique index intentionally carries no time column', () => {
    // 例外说明：这张唯一索引的时间维度由 `fingerprint_bucket` 承载
    // （见 audit-schema 中「为什么错误日志要带 fingerprint_bucket」）。
    // 若把 created_at 也塞进唯一键，同一窗口内的错误就不会被聚合，
    // 反而破坏了「防写入放大」这个它存在的唯一理由。
    const columns = PLATFORM_ERROR_LOGS_FINGERPRINT_UNIQUE_INDEX_STATEMENT
        .replace(/\s+/g, ' ')
        .match(/\(([^)]*)\)/)?.[1] ?? ''
    assert.ok(!columns.includes('created_at'), columns)
    assert.ok(columns.includes('fingerprint_bucket'), columns)
})

test('structure verdict is complete for a full snapshot', () => {
    const verdict = evaluateAuditStructure(fullSnapshot())
    assert.equal(verdict.complete, true)
    assert.deepEqual(verdict.missingColumns, [])
    assert.deepEqual(verdict.missingIndexes, [])
    assert.deepEqual(verdict.missingTables, [])
})

test('structure verdict reports both missing tables', () => {
    const verdict = evaluateAuditStructure({
        auditEventsTableExists: false,
        auditEventsColumns: [],
        auditEventsIndexes: [],
        platformErrorTableExists: false,
        platformErrorColumns: [],
        platformErrorIndexes: [],
    })
    assert.equal(verdict.complete, false)
    assert.deepEqual(verdict.missingTables, [AUDIT_EVENTS_TABLE, PLATFORM_ERROR_LOGS_TABLE])
    assert.equal(verdict.missingColumns.length, AUDIT_EVENTS_REQUIRED_COLUMNS.length + PLATFORM_ERROR_LOGS_REQUIRED_COLUMNS.length)
    assert.equal(
        verdict.missingIndexes.length,
        AUDIT_EVENTS_INDEX_NAMES.length + PLATFORM_ERROR_LOGS_ALL_INDEX_NAMES.length,
        'the fingerprint unique index must be verified too',
    )
})

test('structure verdict detects a single missing column', () => {
    const snapshot = fullSnapshot()
    const verdict = evaluateAuditStructure({
        ...snapshot,
        platformErrorColumns: snapshot.platformErrorColumns.filter((c) => c !== 'handle_note'),
    })
    assert.equal(verdict.complete, false)
    assert.deepEqual(verdict.missingColumns, ['handle_note'])
    assert.deepEqual(verdict.missingIndexes, [])
})

test('structure verdict detects a missing index (SELECT probes cannot)', () => {
    const snapshot = fullSnapshot()
    const verdict = evaluateAuditStructure({
        ...snapshot,
        auditEventsIndexes: snapshot.auditEventsIndexes.filter((i) => i !== 'audit_events_target_idx'),
    })
    assert.equal(verdict.complete, false)
    assert.deepEqual(verdict.missingIndexes, ['audit_events_target_idx'])
    assert.deepEqual(verdict.missingColumns, [])
})

test('structure verdict detects a missing fingerprint unique index', () => {
    const snapshot = fullSnapshot()
    const verdict = evaluateAuditStructure({ ...snapshot, platformErrorIndexes: [] })
    assert.equal(verdict.complete, false)
    assert.ok(verdict.missingIndexes.includes('platform_error_logs_fingerprint_uq'))
})

test('audit event names are unique and namespaced', () => {
    assert.equal(new Set(AUDIT_EVENT_NAMES).size, AUDIT_EVENT_NAMES.length)
    for (const name of AUDIT_EVENT_NAMES) {
        assert.match(name, /^[a-z]+(\.[a-z]+)+$/, `event name must be dot-namespaced: ${name}`)
    }
    assert.equal(AUDIT_EVENT_NAMES.length, AUDIT_EVENT_DEFINITIONS.length)
})

test('audit event definitions use declared enums', () => {
    for (const definition of AUDIT_EVENT_DEFINITIONS) {
        assert.ok(AUDIT_CATEGORIES.includes(definition.category), `${definition.name} has invalid category`)
        assert.ok(AUDIT_SEVERITIES.includes(definition.severity), `${definition.name} has invalid severity`)
        assert.ok(definition.description.length > 0, `${definition.name} needs a description`)
    }
    assert.ok(AUDIT_RESULTS.includes('success') && AUDIT_RESULTS.includes('failure'))
})

test('the plan-required events are all registered', () => {
    for (const required of [
        'auth.login',
        'points.checkin',
        'order.created',
        'refund.requested',
        'refund.approved',
        'refund.rejected',
        'refund.completed',
        'admin.points.adjusted',
        'coupon.created',
        'coupon.updated',
    ]) {
        assert.ok(isKnownAuditEvent(required), `missing required audit event: ${required}`)
    }
})

test('event categories match their name prefix', () => {
    for (const definition of AUDIT_EVENT_DEFINITIONS) {
        const prefix = definition.name.split('.')[0]
        const allowed: Record<string, string> = {
            auth: 'auth',
            points: 'points',
            order: 'order',
            refund: 'refund',
            coupon: 'coupon',
            admin: 'admin',
            database: 'admin',
        }
        assert.equal(definition.category, allowed[prefix], `${definition.name} category/prefix mismatch`)
    }
})

test('resolveAuditEvent keeps a registered event unchanged', () => {
    const resolved = resolveAuditEvent({ eventName: 'order.created', actorType: 'user' })
    assert.equal(resolved.eventName, 'order.created')
    assert.equal(resolved.category, 'order')
    assert.equal(resolved.severity, 'info')
    assert.equal(resolved.result, 'success')
    assert.equal(resolved.targetType, 'order')
})

test('resolveAuditEvent escalates severity for failures', () => {
    // 「只看严重」筛选不该漏掉失败事件
    const resolved = resolveAuditEvent({ eventName: 'auth.login', result: 'failure' })
    assert.equal(resolved.result, 'failure')
    assert.equal(resolved.severity, 'warning')
    assert.notEqual(resolved.severity, 'info')
})

test('resolveAuditEvent does not downgrade explicit severities', () => {
    assert.equal(resolveAuditEvent({ eventName: 'order.created', severity: 'critical' }).severity, 'critical')
    assert.equal(resolveAuditEvent({ eventName: 'order.created', result: 'failure', severity: 'critical' }).severity, 'critical')
    assert.equal(resolveAuditEvent({ eventName: 'refund.approved', severity: 'error' }).severity, 'error')
})

test('resolveAuditEvent degrades unknown events instead of dropping them', () => {
    // 退化的记录比丢失的记录有用，且要在后台明显可见
    const resolved = resolveAuditEvent({ eventName: 'something.unregistered' })
    assert.equal(resolved.eventName, 'something.unregistered')
    assert.equal(resolved.category, 'admin')
    assert.equal(resolved.severity, 'warning')
})

test('resolveAuditEvent allows overriding the target type', () => {
    const resolved = resolveAuditEvent({ eventName: 'order.created', targetType: 'refund' })
    assert.equal(resolved.targetType, 'refund')
})

test('getAuditEventDefinition returns null for unknown names', () => {
    assert.equal(getAuditEventDefinition('nope.nope'), null)
    assert.ok(getAuditEventDefinition('auth.login'))
})
