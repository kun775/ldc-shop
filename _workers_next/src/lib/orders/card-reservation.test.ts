import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createSqliteCardServiceDatabase, type SqliteTestContext } from '../license-service/test-support.ts'
import {
    countReservableCards,
    reserveCardsForNewOrder,
    STOCK_LOCKED_ERROR,
    type ReservedCard,
} from './card-reservation.ts'

const PRODUCT_ID = 'p1'
const NOW = 1_800_000_000_000
const TTL = 5 * 60 * 1000

function setup(freeCards: number): SqliteTestContext {
    const ctx = createSqliteCardServiceDatabase()
    ctx.exec(`INSERT INTO products (id, name) VALUES ('${PRODUCT_ID}', 'P1')`)
    for (let i = 0; i < freeCards; i++) {
        ctx.sqlite.prepare('INSERT INTO cards (product_id, card_key) VALUES (?, ?)').run(PRODUCT_ID, `KEY-${i + 1}`)
    }
    return ctx
}

function insertCard(ctx: SqliteTestContext, values: {
    key: string
    isUsed?: number
    reservedOrderId?: string | null
    reservedAt?: number | null
    expiresAt?: number | null
}) {
    ctx.sqlite.prepare(
        `INSERT INTO cards (product_id, card_key, is_used, reserved_order_id, reserved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(PRODUCT_ID, values.key, values.isUsed ?? 0, values.reservedOrderId ?? null,
        values.reservedAt ?? null, values.expiresAt ?? null)
}

function reservedBy(ctx: SqliteTestContext, orderId: string): number {
    return Number(ctx.get('SELECT COUNT(*) AS c FROM cards WHERE reserved_order_id = ?', [orderId])?.c)
}

const noReclaim = async (): Promise<ReservedCard | null> => null

test('库存 50 一次下单 50 件：一条语句领满，不走回收', async () => {
    const ctx = setup(50)
    let reclaimCalls = 0

    const cards = await reserveCardsForNewOrder(ctx.database, {
        orderId: 'o1', productId: PRODUCT_ID, quantity: 50, nowMs: NOW,
        reclaimExpiredCard: async () => { reclaimCalls++; return null },
    })

    assert.equal(cards.length, 50)
    assert.equal(new Set(cards.map((card) => card.id)).size, 50)
    assert.deepEqual(cards.map((card) => card.key), Array.from({ length: 50 }, (_, i) => `KEY-${i + 1}`))
    assert.equal(reservedBy(ctx, 'o1'), 50)
    assert.equal(reclaimCalls, 0)
    assert.equal(ctx.sqlCalls.length, 1, '领取次数不随购买数量增长')
})

test('大数量领取仍只绑定固定个数参数', async () => {
    const ctx = setup(300)
    const cards = await reserveCardsForNewOrder(ctx.database, {
        orderId: 'o1', productId: PRODUCT_ID, quantity: 300, nowMs: NOW, reclaimExpiredCard: noReclaim,
    })
    assert.equal(cards.length, 300)
    assert.ok(ctx.sqlCalls.every((call) => (call.params?.length ?? 0) <= 5))
})

test('库存计数与领取同口径：排除已用、已过期和 TTL 内的预留，计入超时预留', async () => {
    const ctx = setup(3)
    insertCard(ctx, { key: 'USED', isUsed: 1 })
    insertCard(ctx, { key: 'EXPIRED', expiresAt: NOW - 1 })
    insertCard(ctx, { key: 'FUTURE', expiresAt: NOW + 60_000 })
    insertCard(ctx, { key: 'HELD', reservedOrderId: 'other', reservedAt: NOW - 1000 })
    insertCard(ctx, { key: 'STALE', reservedOrderId: 'old', reservedAt: NOW - TTL - 1 })

    // 3 张空闲 + FUTURE + STALE（可回收）
    assert.equal(await countReservableCards(ctx.database, { productId: PRODUCT_ID, nowMs: NOW, reservationTtlMs: TTL }), 5)

    // 空闲可直接领取的只有 3 + FUTURE，已过期卡不会被领走
    const cards = await reserveCardsForNewOrder(ctx.database, {
        orderId: 'o1', productId: PRODUCT_ID, quantity: 4, nowMs: NOW, reclaimExpiredCard: noReclaim,
    })
    assert.deepEqual(cards.map((card) => card.key).sort(), ['FUTURE', 'KEY-1', 'KEY-2', 'KEY-3'])
})

test('空闲卡不足时逐张回收过期预留补齐', async () => {
    const ctx = setup(2)
    insertCard(ctx, { key: 'STALE', reservedOrderId: 'old', reservedAt: NOW - TTL - 1 })
    const staleId = Number(ctx.get(`SELECT id FROM cards WHERE card_key = 'STALE'`)?.id)

    const cards = await reserveCardsForNewOrder(ctx.database, {
        orderId: 'o1', productId: PRODUCT_ID, quantity: 3, nowMs: NOW,
        reclaimExpiredCard: async () => {
            ctx.sqlite.prepare('UPDATE cards SET reserved_order_id = ?, reserved_at = ? WHERE id = ?').run('o1', NOW, staleId)
            return { id: staleId, key: 'STALE' }
        },
    })

    assert.equal(cards.length, 3)
    assert.equal(reservedBy(ctx, 'o1'), 3)
})

test('领不满时抛 stock_locked 并释放本单已领取的卡，不影响他人预留和已用卡', async () => {
    const ctx = setup(30)
    insertCard(ctx, { key: 'HELD', reservedOrderId: 'other', reservedAt: NOW - 1000 })
    insertCard(ctx, { key: 'USED-BY-O1', isUsed: 1, reservedOrderId: 'o1', reservedAt: NOW - 1000 })

    await assert.rejects(
        reserveCardsForNewOrder(ctx.database, {
            orderId: 'o1', productId: PRODUCT_ID, quantity: 50, nowMs: NOW, reclaimExpiredCard: noReclaim,
        }),
        { message: STOCK_LOCKED_ERROR },
    )

    assert.equal(Number(ctx.get(`SELECT COUNT(*) AS c FROM cards WHERE reserved_at IS NULL AND is_used = 0`)?.c), 30)
    assert.equal(reservedBy(ctx, 'other'), 1)
    assert.equal(reservedBy(ctx, 'o1'), 1, '已用卡不属于释放范围')
    // 释放后立即可再次下单
    assert.equal(await countReservableCards(ctx.database, { productId: PRODUCT_ID, nowMs: NOW, reservationTtlMs: TTL }), 30)
})

test('回收过程抛错时同样释放并原样抛出', async () => {
    const ctx = setup(10)
    const failure = new Error('gateway down')

    await assert.rejects(
        reserveCardsForNewOrder(ctx.database, {
            orderId: 'o1', productId: PRODUCT_ID, quantity: 11, nowMs: NOW,
            reclaimExpiredCard: async () => { throw failure },
        }),
        (error) => error === failure,
    )
    assert.equal(reservedBy(ctx, 'o1'), 0)
})

test('并发订单：后到订单领不满时只释放自己的卡，先到订单的预留保持不变', async () => {
    const ctx = setup(50)

    const first = await reserveCardsForNewOrder(ctx.database, {
        orderId: 'a', productId: PRODUCT_ID, quantity: 30, nowMs: NOW, reclaimExpiredCard: noReclaim,
    })
    assert.equal(first.length, 30)

    await assert.rejects(
        reserveCardsForNewOrder(ctx.database, {
            orderId: 'b', productId: PRODUCT_ID, quantity: 50, nowMs: NOW, reclaimExpiredCard: noReclaim,
        }),
        { message: STOCK_LOCKED_ERROR },
    )

    assert.equal(reservedBy(ctx, 'a'), 30)
    assert.equal(reservedBy(ctx, 'b'), 0)
    assert.equal(await countReservableCards(ctx.database, { productId: PRODUCT_ID, nowMs: NOW, reservationTtlMs: TTL }), 20)
})

test('回收返回重复卡 ID 时按领不到处理，不会死循环', async () => {
    const ctx = setup(1)
    const [only] = ctx.all('SELECT id, card_key FROM cards')

    await assert.rejects(
        reserveCardsForNewOrder(ctx.database, {
            orderId: 'o1', productId: PRODUCT_ID, quantity: 2, nowMs: NOW,
            reclaimExpiredCard: async () => ({ id: Number(only.id), key: String(only.card_key) }),
        }),
        { message: STOCK_LOCKED_ERROR },
    )
    assert.equal(reservedBy(ctx, 'o1'), 0)
})

test('checkout 通过批量预留模块领卡并按同口径计数', () => {
    const checkout = readFileSync(new URL('../../actions/checkout.ts', import.meta.url), 'utf8')

    assert.match(checkout, /reserveCardsForNewOrder\(cardDatabase,/)
    assert.match(checkout, /countReservableCards\(cardDatabase,/)
    // 不允许回到逐张领取空闲卡的循环
    assert.doesNotMatch(checkout, /WHERE id = \(\s*SELECT id FROM cards/)
    // 共享商品计数同样排除过期卡
    const sharedStart = checkout.indexOf('if (product.isShared) {')
    const sharedCount = checkout.slice(sharedStart, checkout.indexOf('return countReservableCards', sharedStart))
    assert.match(sharedCount, /gt\(cards\.expiresAt, new Date\(\)\)/)
})
