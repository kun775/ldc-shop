import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildDatabaseUpgradeStatus, DATABASE_UPGRADE_DEFINITIONS } from './database-upgrade-registry.ts'
import { CARD_SERVICE_OPERATIONS_CREATE_TABLE_STATEMENT } from './license-service-schema.ts'
import {
    CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS,
    CARD_SERVICE_OPERATION_REQUIRED_INDEX_NAMES,
    CARD_SERVICE_OPERATIONS_RESOURCE_INDEX,
    CARD_SERVICE_OPERATIONS_ORDER_INDEX,
} from './license-service-operation-index-schema.ts'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

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

test('registered upgrades use per-item structure verification', () => {
    const querySource = readSource('./queries.ts')
    const runnerSource = readSource('./database-upgrades.ts')

    assert.match(querySource, /verifyStructures:\s*verifyDatabaseUpgradeStructures/)
    assert.match(runnerSource, /structureHealth\[item\.id\]/)
    assert.doesNotMatch(runnerSource, /if \(!structureHealthy\)/)
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

test('0037 stays on manual registered path regardless of schema version, not on ensure or baseline backfill', () => {
    const source = readSource('./queries.ts')
    const runner = functionSource(source, 'async function runRegisteredDatabaseUpgrades()', 'export async function getDatabaseUpgradeStatus()')
    const manual = functionSource(source, 'export async function runPendingDatabaseUpgrades()', 'async function prepareDatabaseForManualUpgrade()')
    const ensure = functionSource(source, 'export async function ensureDatabaseInitialized()', 'async function ensureProductsColumns()')
    const preparation = functionSource(source, 'async function prepareDatabaseForManualUpgrade()', 'export async function ensureDatabaseInitialized()')

    assert.match(source, /const CURRENT_SCHEMA_VERSION = 40;/)
    assert.match(runner, /async '0037_product_review_aggregates_rebuild'\(\)\s*\{\s*await rebuildProductReviewAggregates\(\)/)
    assert.match(manual, /await runRegisteredDatabaseUpgrades\(\)/)
    assert.match(manual, /status\.pending === 0 && status\.running === 0/)
    assert.doesNotMatch(ensure, /rebuildProductReviewAggregates|markCurrentSchemaReady|setSetting\(/)
    assert.doesNotMatch(preparation, /rebuildProductReviewAggregates/)
    assert.doesNotMatch(readSource('./database-upgrades.ts'), /schemaVersion|CURRENT_SCHEMA_VERSION/)
})

test('0038 owns the card service ledger DDL and never marks the schema ready itself', () => {
    // 版本标记只能由 runPendingDatabaseUpgrades 在「全部升级项通过」后统一写入。
    // 建表执行体若顺手 setSetting('schema_version')，会让「建了一半」也变成
    // 「版本已达标」，此后缺表将永久无法自愈 —— 这正是 0028 基线遗留的坑。
    const source = readSource('./queries.ts')
    const runner = functionSource(source, 'async function runRegisteredDatabaseUpgrades()', 'export async function getDatabaseUpgradeStatus()')
    assert.match(runner, /async '0038_license_service_ledger'\(\) \{/)
    assert.match(runner, /await ensureCardServiceStructureObjects\(\);/)

    const body = functionSource(source, 'async function ensureCardServiceStructureObjects() {', '// ensureStructuralSchema')
    assert.match(body, /CARD_SERVICE_DDL_STATEMENTS/)
    assert.doesNotMatch(body, /setSetting\(|markCurrentSchemaReady|schema_version/)

    // 全新库初始化必须直接建出远端账本，否则新装的实例要等管理员点升级才有表。
    const preparation = functionSource(source, 'async function prepareDatabaseForManualUpgrade()', 'export async function ensureDatabaseInitialized()')
    assert.match(preparation, /await ensureCardServiceStructureObjects\(\)/)
})

test('0038 fails structure verification when a unique index is missing, not only when a table is missing', () => {
    // 唯一索引无法用 SELECT LIMIT 0 探测；若只探表/列，「缺唯一索引」的历史库
    // 会被判为结构健康，重复 external_ref 领卡将静默复活。
    const source = readSource('./queries.ts')
    const body = functionSource(source, 'async function verifyCardServiceStructure()', 'async function verifyDatabaseUpgradeStructures()')
    assert.match(body, /CARD_SERVICE_SCHEMA_DRIFT_PROBES/)
    assert.match(body, /CARD_SERVICE_REQUIRED_INDEX_NAMES/)
    assert.match(body, /indexExists\(/)
    assert.match(source, /'0038_license_service_ledger': cardService/)
})

test('0037 uses actual SQLite to rebuild all products once after historical 0035 was applied', async (t) => {
    const source = readSource('./queries.ts')
    const body = functionSource(source, 'async function rebuildProductReviewAggregates() {', '// ensureRateLimitStructureObjects')
        .replace(/^async function rebuildProductReviewAggregates\(\)\s*\{/, '').replace(/\}\s*$/, '')
    const statement = body.match(/await db\.run\(sql`([\s\S]*?)`\);/)
    assert.ok(statement, '0037 production SQL must be a single atomic UPDATE')
    const database = new DatabaseSync(':memory:')
    t.after(() => database.close())
    database.exec(`
        CREATE TABLE products (id TEXT PRIMARY KEY, rating REAL NOT NULL, review_count INTEGER NOT NULL);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, order_id TEXT NOT NULL, rating INTEGER NOT NULL);
        CREATE TABLE database_migrations (id TEXT PRIMARY KEY, status TEXT NOT NULL);
        INSERT INTO database_migrations VALUES ('0035_review_order_id_unique', 'applied');
        INSERT INTO products VALUES ('many', 99, 99), ('single', 88, 88), ('empty', 77, 77);
        INSERT INTO reviews VALUES (1, 'many', 'order-1', 5), (2, 'many', 'order-2', 3), (3, 'single', 'order-3', 2);
        CREATE UNIQUE INDEX reviews_order_id_uq ON reviews(order_id);
    `)
    const repairId = '0037_product_review_aggregates_rebuild'
    const health = Object.fromEntries(DATABASE_UPGRADE_DEFINITIONS.map((item) => [item.id, true])) as Record<(typeof DATABASE_UPGRADE_DEFINITIONS)[number]['id'], boolean>
    const records = () => database.prepare('SELECT id, status FROM database_migrations').all() as Array<{ id: string; status: 'applied' }>
    const getItem = () => buildDatabaseUpgradeStatus(records() as any, health).items.find((item) => item.id === repairId)
    assert.equal(getItem()?.status, 'pending', '0035 applied and the unique index cannot silently complete 0037')

    database.prepare(statement[1]).run()
    database.prepare('INSERT INTO database_migrations VALUES (?, ?)').run(repairId, 'applied')
    assert.deepEqual(database.prepare('SELECT id, rating, review_count FROM products ORDER BY id').all().map((row: object) => ({ ...row })), [
        { id: 'empty', rating: 0, review_count: 0 },
        { id: 'many', rating: 4, review_count: 2 },
        { id: 'single', rating: 2, review_count: 1 },
    ])
    assert.equal(getItem()?.status, 'applied')
    database.prepare('UPDATE products SET rating = 42, review_count = 42 WHERE id = ?').run('many')
    assert.equal(getItem()?.status, 'applied', 'completed data repair must not reopen on aggregate drift')
    assert.deepEqual({ ...database.prepare('SELECT rating, review_count FROM products WHERE id = ?').get('many') }, { rating: 42, review_count: 42 })
})

test('0037 single SQLite statement rolls back all product updates when one row fails', (t) => {
    const source = readSource('./queries.ts')
    const body = functionSource(source, 'async function rebuildProductReviewAggregates() {', '// ensureRateLimitStructureObjects')
    const statement = body.match(/await db\.run\(sql`([\s\S]*?)`\);/)
    assert.ok(statement)
    const database = new DatabaseSync(':memory:')
    t.after(() => database.close())
    database.exec(`
        CREATE TABLE products (id TEXT PRIMARY KEY, rating REAL NOT NULL, review_count INTEGER NOT NULL);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, rating INTEGER NOT NULL);
        INSERT INTO products VALUES ('a', 99, 99), ('b', 88, 88);
        INSERT INTO reviews VALUES (1, 'a', 5), (2, 'b', 3);
        CREATE TRIGGER reject_b BEFORE UPDATE ON products WHEN NEW.id = 'b'
        BEGIN SELECT RAISE(ABORT, 'reject b'); END;
    `)
    assert.throws(() => database.prepare(statement[1]).run(), /reject b/)
    assert.deepEqual(database.prepare('SELECT id, rating, review_count FROM products ORDER BY id').all().map((row: object) => ({ ...row })), [
        { id: 'a', rating: 99, review_count: 99 },
        { id: 'b', rating: 88, review_count: 88 },
    ])
})


test('0039 商品凭据升级独立于 0038，普通请求不执行 DDL', () => {
    const source = readSource('./queries.ts')
    const runner = functionSource(source, 'async function runRegisteredDatabaseUpgrades()', 'export async function getDatabaseUpgradeStatus()')
    assert.match(runner, /async '0039_license_service_product_credentials'\(\) \{\s*await ensureCardServiceCredentialsStructureObjects\(\);/)
    const ensure = functionSource(source, 'export async function ensureDatabaseInitialized()', 'async function ensureProductsColumns()')
    assert.doesNotMatch(ensure, /ensureCardServiceCredentialsStructureObjects/)
    const body = functionSource(source, 'async function ensureCardServiceCredentialsStructureObjects()', '// ensureStructuralSchema')
    assert.match(body, /CARD_SERVICE_CREDENTIALS_DDL_STATEMENTS/)
    assert.doesNotMatch(body, /setSetting|ALTER TABLE|DELETE FROM/)
    assert.match(source, /'0039_license_service_product_credentials': cardServiceCredentials/)
    const item = DATABASE_UPGRADE_DEFINITIONS.find((d) => d.id === '0039_license_service_product_credentials')
    assert.equal(item?.verifiesStructure, true)
})

test('0040 独立补索引，接入结构校验与全新库初始化，不在普通请求执行', () => {
    const source = readSource('./queries.ts')
    const runner = functionSource(source, 'async function runRegisteredDatabaseUpgrades()', 'export async function getDatabaseUpgradeStatus()')
    assert.match(runner, /async '0040_license_service_operation_indexes'\(\) \{[\s\S]*?await ensureCardServiceOperationIndexObjects\(\);/)
    const ensure = functionSource(source, 'async function ensureCardServiceOperationIndexObjects()', '// ensureStructuralSchema')
    assert.match(ensure, /CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS/)
    assert.doesNotMatch(ensure, /setSetting|markCurrentSchemaReady|schema_version|DELETE FROM|ALTER TABLE/)
    const ordinary = functionSource(source, 'export async function ensureDatabaseInitialized()', 'async function ensureProductsColumns()')
    assert.doesNotMatch(ordinary, /ensureCardServiceOperationIndexObjects/)
    const preparation = functionSource(source, 'async function prepareDatabaseForManualUpgrade()', 'export async function ensureDatabaseInitialized()')
    assert.match(preparation, /await ensureCardServiceStructureObjects\(\);[\s\S]*?await ensureCardServiceOperationIndexObjects\(\);/)
    const verify = functionSource(source, 'async function verifyDatabaseUpgradeStructures()', 'async function getPersistedSchemaVersion()')
    assert.match(verify, /verifyCardServiceOperationIndexStructure\(\)/)
    assert.match(verify, /'0040_license_service_operation_indexes': cardServiceOperationIndexes/)
    assert.equal(DATABASE_UPGRADE_DEFINITIONS.find((item) => item.id === '0040_license_service_operation_indexes')?.verifiesStructure, true)
    const schema = readSource('./schema.ts')
    assert.match(schema, /index\('card_service_operations_resource_idx'\)\.on\(table\.resourceId\)/)
    assert.match(schema, /index\('card_service_operations_order_idx'\)\.on\(table\.orderId\)/)
})

test('0040 真实 SQLite：幂等、缺任一索引判不健康、按资源和订单查找均命中索引', async (t) => {
    const database = new DatabaseSync(':memory:')
    t.after(() => database.close())
    database.exec(CARD_SERVICE_OPERATIONS_CREATE_TABLE_STATEMENT)
    database.exec(`INSERT INTO card_service_operations
        (operation_key, operation, resource_id, order_id, state, created_at, updated_at)
        VALUES ('keep', 'sell', 'allocation', 'order', 'pending', 1, 1)`)
    const before = database.prepare('SELECT * FROM card_service_operations').all()
    const source = readSource('./queries.ts')
    const verifierSource = functionSource(source, 'async function verifyCardServiceOperationIndexStructure()', 'async function verifyDatabaseUpgradeStructures()')
        .replace(': Promise<boolean>', '').replace('error: unknown', 'error')
    // 执行生产校验函数，而非手抄一份健康判定逻辑。
    const verify = new Function('indexExists', 'CARD_SERVICE_OPERATION_REQUIRED_INDEX_NAMES', 'isSchemaDriftError',
        `${verifierSource}; return verifyCardServiceOperationIndexStructure;`)(
        async (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)),
        CARD_SERVICE_OPERATION_REQUIRED_INDEX_NAMES,
        () => false,
    ) as () => Promise<boolean>
    assert.equal(await verify(), false)
    for (let round = 0; round < 2; round += 1) {
        for (const ddl of CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS) database.exec(ddl)
    }
    assert.equal(await verify(), true)
    assert.deepEqual(database.prepare('SELECT * FROM card_service_operations').all(), before)
    for (const [name, column] of [[CARD_SERVICE_OPERATIONS_RESOURCE_INDEX, 'resource_id'], [CARD_SERVICE_OPERATIONS_ORDER_INDEX, 'order_id']]) {
        const columns = database.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>
        assert.deepEqual(columns.map((row) => row.name), [column])
        const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT operation_key FROM card_service_operations WHERE ${column} = ?`).all('target') as Array<{ detail: string }>
        assert.ok(plan.some((row) => row.detail.includes(`USING INDEX ${name}`)), JSON.stringify(plan))
        assert.ok(plan.every((row) => !row.detail.includes('SCAN card_service_operations')), JSON.stringify(plan))
        database.exec(`DROP INDEX ${name}`)
        assert.equal(await verify(), false, `缺 ${name} 必须判不健康`)
        for (const ddl of CARD_SERVICE_OPERATION_INDEX_DDL_STATEMENTS) database.exec(ddl)
        assert.equal(await verify(), true)
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_list(card_service_operations)').all(), [])
})
