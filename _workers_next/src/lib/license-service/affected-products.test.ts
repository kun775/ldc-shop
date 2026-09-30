import test from 'node:test'
import assert from 'node:assert/strict'

import { CARD_SERVICE_CARDS_TABLE } from '../db/license-service-schema.ts'
import { resolveAffectedProductIds } from './affected-products.ts'
import { createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'

function seedProduct(ctx: SqliteTestContext, productId: string) {
    ctx.exec(`INSERT INTO products (id, is_shared) VALUES ('${productId}', 0)`)
}

function seedMapping(
    ctx: SqliteTestContext,
    input: { localCardId: number; remoteCardId: string; productId: string; orderId: string | null; state?: string },
) {
    ctx.exec(`INSERT INTO ${CARD_SERVICE_CARDS_TABLE}
        (local_card_id, remote_card_id, allocation_id, product_id, order_id, state, created_at, updated_at)
        VALUES (${input.localCardId}, '${input.remoteCardId}', 'all_${input.localCardId}', '${input.productId}',
                ${input.orderId ? `'${input.orderId}'` : 'NULL'}, '${input.state ?? 'sold'}', 0, 0)`)
}

test('已知商品 ID 时直接返回，不额外查任何表', async () => {
    const ctx = createSqliteCardServiceDatabase()
    // 连表都删掉也要能返回：补货路径手里本来就有 productId。
    ctx.exec(`DROP TABLE ${CARD_SERVICE_CARDS_TABLE}`)
    ctx.exec('DROP TABLE orders')

    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { productId: 'prod_x' }), ['prod_x'])
})

test('没有可用的线索时返回空数组——调用方据此跳过重算', async () => {
    const ctx = createSqliteCardServiceDatabase()
    assert.deepEqual(await resolveAffectedProductIds(ctx.database, {}), [])
    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { productId: '   ', localCardIds: [] }), [])
})

test('按订单号反查远端映射台账，拿到该订单涉及的商品', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_ls')
    seedMapping(ctx, { localCardId: 11, remoteCardId: 'rc_a', productId: 'prod_ls', orderId: 'order_1' })
    seedMapping(ctx, { localCardId: 12, remoteCardId: 'rc_b', productId: 'prod_ls', orderId: 'order_1' })
    seedMapping(ctx, { localCardId: 13, remoteCardId: 'rc_c', productId: 'prod_other', orderId: 'order_2' })

    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { orderId: 'order_1' }), ['prod_ls'])
})

test('按本地卡 / 远端卡反查，两条线索都命中', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_a')
    seedProduct(ctx, 'prod_b')
    seedMapping(ctx, { localCardId: 21, remoteCardId: 'rc_a', productId: 'prod_a', orderId: null })
    seedMapping(ctx, { localCardId: 22, remoteCardId: 'rc_b', productId: 'prod_b', orderId: null })

    assert.deepEqual(
        await resolveAffectedProductIds(ctx.database, { localCardIds: [21] }),
        ['prod_a'],
    )
    assert.deepEqual(
        await resolveAffectedProductIds(ctx.database, { remoteCardIds: ['rc_b'] }),
        ['prod_b'],
    )
    // 去重 + 排序
    assert.deepEqual(
        await resolveAffectedProductIds(ctx.database, { localCardIds: [22, 21, 22], remoteCardIds: ['rc_a'] }),
        ['prod_a', 'prod_b'],
    )
})

test('台账行已被清理时，仍能用本地卡表定位商品', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_local')
    ctx.exec(`INSERT INTO cards (id, product_id, card_key, is_used, created_at) VALUES (31, 'prod_local', 'k31', 0, 0)`)

    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { localCardIds: [31] }), ['prod_local'])
})

test('回溯到订单表：只给订单号、台账已被清空也能定位', async () => {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec(`INSERT INTO orders (order_id, product_id, product_name, amount) VALUES ('order_9', 'prod_9', 'p', '1.00')`)

    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { orderId: 'order_9' }), ['prod_9'])
})

test('台账表不存在（0038 未执行）时跳过该路而不是抛错', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seedProduct(ctx, 'prod_local')
    ctx.exec(`INSERT INTO cards (id, product_id, card_key, is_used, created_at) VALUES (41, 'prod_local', 'k41', 0, 0)`)
    ctx.exec(`DROP TABLE ${CARD_SERVICE_CARDS_TABLE}`)

    assert.deepEqual(
        await resolveAffectedProductIds(ctx.database, { localCardIds: [41], remoteCardIds: ['rc_x'], orderId: 'order_x' }),
        ['prod_local'],
    )
})

test('绑定数量有上限，异常数据不会把一次查询撑爆', async () => {
    const ctx = createSqliteCardServiceDatabase()
    const localCardIds = Array.from({ length: 500 }, (_, index) => index + 1)
    // 只要不抛错即可：上限的作用是保护 SQL 长度，不是精确截断语义。
    assert.deepEqual(await resolveAffectedProductIds(ctx.database, { localCardIds }), [])
})
