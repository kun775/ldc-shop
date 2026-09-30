import test from 'node:test'
import assert from 'node:assert/strict'

import { CARD_SERVICE_PRODUCT_CONFIG_TABLE } from '../db/license-service-schema.ts'
import {
    listCardServiceProgramProducts,
    loadCardServiceProductConfig,
    saveCardServiceProductConfig,
} from './product-config.ts'
import { createSqliteCardServiceDatabase } from './test-support.ts'

test('配置表尚不存在（0038 未执行）时读取回落为 local 兜底，不抛错', async () => {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec(`DROP TABLE ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`)

    const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.deepEqual(config, {
        productId: 'prod_1',
        supplyMode: 'local',
        programKey: null,
        targetStock: null,
        configured: false,
    })
    // 列表接口同样要能容忍缺表，否则阶段 C 的公共入口在升级窗口内会 500。
    assert.deepEqual(await listCardServiceProgramProducts(ctx.database), [])
})

test('没有配置行的商品走 local 兜底：既有商品行为不变，无需数据回填', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const config = await loadCardServiceProductConfig(ctx.database, 'prod_unknown')
    assert.equal(config.configured, false)
    assert.equal(config.supplyMode, 'local')
})

test('配置写入后可读回，含 program_key 与 target_stock', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 3,
    }, 1_000)

    const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.deepEqual(config, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 3,
        configured: true,
    })
})

test('重复保存是同一条配置的更新（主键冲突走 upsert），不会留下两行', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: 'program-a',
        targetStock: 1,
    }, 1_000)
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: 'program-b',
        targetStock: 7,
    }, 2_000)

    const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.equal(config.programKey, 'program-b')
    assert.equal(config.targetStock, 7)
    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`).length, 1)
})

test('空白 program_key / 非法 supply_mode 一律归一，不把脏值透给调用方', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: '   ',
        targetStock: 0,
    }, 1_000)

    const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.equal(config.programKey, null)
    assert.equal(config.targetStock, 0)
    assert.equal(config.configured, true)

    ctx.exec(`UPDATE ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} SET supply_mode = 'weird' WHERE product_id = 'prod_1'`)
    const fallback = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.equal(fallback.supplyMode, 'local')
})

test('补货扫描只返回 license_service 商品，local / legacy_get 一律排除', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ls',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 2,
    }, 1_000)
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_local',
        supplyMode: 'local',
    }, 1_000)
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_legacy',
        supplyMode: 'legacy_get',
    }, 1_000)

    const products = await listCardServiceProgramProducts(ctx.database)
    assert.deepEqual(products.map((item) => item.productId), ['prod_ls'])
    assert.equal(products[0].targetStock, 2)
})
