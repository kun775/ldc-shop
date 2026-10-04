import test from 'node:test'
import assert from 'node:assert/strict'

import { CARD_SERVICE_CARDS_TABLE, CARD_SERVICE_PRODUCT_CONFIG_TABLE } from '../db/license-service-schema.ts'
import {
    countUnsettledRemoteMappings,
    listCardServiceProgramProducts,
    loadCardServiceProductConfig,
    loadProductSupplyGuard,
    saveCardServiceProductConfig,
} from './product-config.ts'
import { createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

/**
 * `products` 行必须显式 seed：`saveCardServiceProductConfig` 的第一道闸门就是
 * 「商品必须存在」。测试替身不会自动建商品 —— 那是真实库里的既有数据。
 */
function seedProduct(ctx: SqliteTestContext, productId: string, isShared = 0) {
    ctx.exec(`INSERT INTO products (id, is_shared) VALUES ('${productId}', ${isShared})`)
}

/** 直接往远端映射台账里塞一行，用于供应模式切换的互斥判定。 */
function seedRemoteMapping(ctx: SqliteTestContext, productId: string, state: string, localCardId: number) {
    ctx.exec(`INSERT INTO products (id, is_shared) VALUES ('${productId}', 0) ON CONFLICT(id) DO NOTHING`)
    ctx.exec(`INSERT INTO ${CARD_SERVICE_CARDS_TABLE}
        (local_card_id, remote_card_id, allocation_id, product_id, state, created_at, updated_at)
        VALUES (${localCardId}, 'card_seed_${localCardId}', 'all_seed_${localCardId}', '${productId}', '${state}', 0, 0)`)
}

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
    seedProduct(ctx, 'prod_1')
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
    seedProduct(ctx, 'prod_1')
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
    seedProduct(ctx, 'prod_1')
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
    seedProduct(ctx, 'prod_ls')
    seedProduct(ctx, 'prod_local')
    seedProduct(ctx, 'prod_legacy')
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

test('补货候选排除下架与 NULL 状态商品，重新上架后原配置恢复候选', async () => {
    const ctx = createSqliteCardServiceDatabase()
    for (const productId of ['prod_active', 'prod_inactive', 'prod_null']) {
        seedProduct(ctx, productId)
        await saveCardServiceProductConfig(ctx.database, {
            productId,
            supplyMode: 'license_service',
            programKey: 'bill-service',
            targetStock: 2,
        }, 1_000)
    }
    ctx.exec(`UPDATE products SET is_active = 0 WHERE id = 'prod_inactive'`)
    ctx.exec(`UPDATE products SET is_active = NULL WHERE id = 'prod_null'`)

    assert.deepEqual((await listCardServiceProgramProducts(ctx.database)).map((item) => item.productId), ['prod_active'])
    for (const productId of ['prod_inactive', 'prod_null']) {
        assert.deepEqual(await loadProductSupplyGuard(ctx.database, productId), {
            exists: true, isShared: false, isActive: false,
        })
    }

    ctx.exec(`UPDATE products SET is_active = 1 WHERE id = 'prod_inactive'`)
    assert.deepEqual(
        (await listCardServiceProgramProducts(ctx.database)).map((item) => item.productId).sort(),
        ['prod_active', 'prod_inactive'],
    )
    assert.deepEqual(await loadProductSupplyGuard(ctx.database, 'prod_inactive'), {
        exists: true, isShared: false, isActive: true,
    })
    assert.equal((await loadCardServiceProductConfig(ctx.database, 'prod_inactive')).targetStock, 2)
})

test('删除商品留下的孤儿配置不进入补货候选，缺失商品或商品表的守卫均不可补货', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_deleted')
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_deleted',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 2,
    }, 1_000)
    ctx.exec(`DELETE FROM products WHERE id = 'prod_deleted'`)

    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`).length, 1)
    assert.deepEqual(await listCardServiceProgramProducts(ctx.database), [])
    assert.deepEqual(await loadProductSupplyGuard(ctx.database, 'prod_deleted'), {
        exists: false, isShared: false, isActive: false,
    })

    ctx.exec('DROP TABLE products')
    assert.deepEqual(await loadProductSupplyGuard(ctx.database, 'prod_deleted'), {
        exists: false, isShared: false, isActive: false,
    })
    assert.deepEqual(await listCardServiceProgramProducts(ctx.database), [])
})

// ---------------------------------------------------------------------------
// 准入闸门
// ---------------------------------------------------------------------------

test('准入闸门：商品不存在时拒绝写入，不留下永远对不上的配置行', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const result = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ghost',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 2,
    }, 1_000)

    assert.deepEqual(result, { ok: false, reason: 'product_not_found' })
    // 关键：一条行都不能留下 —— 否则补货调度会对着空气 Allocate。
    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`).length, 0)
})

test('准入闸门：共享商品不得接入中心供应（它的交付绕过 Sell）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_shared', 1)

    const result = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_shared',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 1,
    }, 1_000)

    assert.deepEqual(result, { ok: false, reason: 'shared_product' })
    assert.equal(ctx.all(`SELECT * FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`).length, 0)
    // 守卫本身也要能读出共享事实，别的调用方（补货兜底闸门）依赖它。
    assert.deepEqual(await loadProductSupplyGuard(ctx.database, 'prod_shared'), { exists: true, isShared: true, isActive: true })
})

test('准入闸门：切离 license_service 时手上有未结清的远端卡必须拒绝', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_ls')
    seedRemoteMapping(ctx, 'prod_ls', 'acknowledged', 1)
    seedRemoteMapping(ctx, 'prod_ls', 'sold', 2)

    assert.equal(await countUnsettledRemoteMappings(ctx.database, 'prod_ls'), 2)

    const result = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ls',
        supplyMode: 'local',
    }, 1_000)
    assert.deepEqual(result, { ok: false, reason: 'unsettled_remote_cards' })

    // 留在 license_service 是允许的（本来就该继续由中心管）。
    const stay = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ls',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 2,
    }, 1_000)
    assert.deepEqual(stay, { ok: true })
})

test('准入闸门：远端卡都已结清（revoked / cancelled）后可以切走', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_ls')
    seedRemoteMapping(ctx, 'prod_ls', 'revoked', 1)
    seedRemoteMapping(ctx, 'prod_ls', 'cancelled', 2)

    // 终态不参与互斥计数：`acknowledged` / `sold` 才是「中心那边还有账」。
    assert.equal(await countUnsettledRemoteMappings(ctx.database, 'prod_ls'), 0)

    const result = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ls',
        supplyMode: 'local',
    }, 1_000)
    assert.deepEqual(result, { ok: true })
})

test('台账表不存在（0038 未执行）时未结清计数按 0 处理，切换不被误挡', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_ls')
    ctx.exec(`DROP TABLE ${CARD_SERVICE_CARDS_TABLE}`)

    assert.equal(await countUnsettledRemoteMappings(ctx.database, 'prod_ls'), 0)
    const result = await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_ls',
        supplyMode: 'local',
    }, 1_000)
    assert.deepEqual(result, { ok: true })
})

// ---------------------------------------------------------------------------
// target_stock 的空值语义
// ---------------------------------------------------------------------------

test('目标库存留空读回 null，绝不能被折算成 0（0 表示暂停补货）', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_1')

    // 表单留空经过 `Number(null) === 0` / `Number('') === 0` 两道陷阱，
    // 任一失守都会让「没填」变成「静默停掉这个商品的自动补货」。
    for (const targetStock of [null, undefined, '', '   '] as const) {
        await saveCardServiceProductConfig(ctx.database, {
            productId: 'prod_1',
            supplyMode: 'license_service',
            programKey: 'bill-service',
            targetStock,
        }, 1_000)

        const row = ctx.get(`SELECT target_stock FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} WHERE product_id = 'prod_1'`)
        assert.equal(row?.target_stock, null, `targetStock=${JSON.stringify(targetStock)} 应落 NULL`)

        const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
        assert.equal(config.targetStock, null)
    }
})

test('显式填 0 仍然是 0：暂停补货的开关必须保持可用', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_1')
    await saveCardServiceProductConfig(ctx.database, {
        productId: 'prod_1',
        supplyMode: 'license_service',
        programKey: 'bill-service',
        targetStock: 0,
    }, 1_000)

    const config = await loadCardServiceProductConfig(ctx.database, 'prod_1')
    assert.equal(config.targetStock, 0)
})
