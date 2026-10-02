import assert from 'node:assert/strict'
import test from 'node:test'
import { orderHasUnsettledCardServiceLedger } from './guards.ts'
import { discardFailedAllocation } from './discard.ts'
import { buildDeliverOrderStatements, buildSellIntentStatements, executeOrderRemoteSales, loadOrderRemoteSalePlan } from './delivery.ts'
import { listCardServiceReviewQueue } from './ops.ts'
import {
    ackAndMaterializeAllocation,
    buildDeferAckStatements,
    buildDiscardAllocationStatements,
    buildFailAckStatements,
    buildMaterializeStatements,
    loadCardServiceAllocation,
} from './restock.ts'
import { createFakeLicenseServiceClient, createSqliteCardServiceDatabase, type SqliteTestContext } from './test-support.ts'
import { buildRefundRevokeStatements, buildRevokeIntentStatements, executeOrderRevokes } from './revoke.ts'
import type { CardServiceDatabase } from './db-port.ts'

function seed(ctx: SqliteTestContext, operation = 'sell') {
    ctx.exec(`
        INSERT INTO products (id) VALUES ('product');
        INSERT INTO orders (order_id, product_id, product_name, amount, status, trade_no)
            VALUES ('order', 'product', 'Product', '9.99', 'paid', 'paid-trade');
        INSERT INTO card_service_allocations
            (allocation_id, product_id, program_key, external_ref, quantity, state,
             request_key, ack_key, expires_at, created_at, updated_at)
            VALUES ('batch', 'product', 'program', 'ref', 2,
                '${operation === 'ack' ? 'allocated' : 'acknowledged'}', 'req', 'ack', 999999, 1, 1);
        INSERT INTO card_service_staged_cards
            (remote_card_id, allocation_id, product_id, card_key, created_at)
            VALUES ('staged', 'batch', 'product', 'STAGED-KEY', 1);
        INSERT INTO card_service_operations
            (operation_key, operation, resource_id, order_id, state, attempts, last_error_code, created_at, updated_at)
            VALUES ('failed', '${operation}', 'batch', ${operation === 'ack' ? 'NULL' : "'order'"},
                'abandoned', 16, 'not_found', 1, 1);
    `)
    if (operation === 'sell') {
        ctx.exec(`
            INSERT INTO cards (id, product_id, card_key, reserved_order_id, reserved_at)
                VALUES (1, 'product', 'KEY-1', 'order', 1), (2, 'product', 'KEY-2', NULL, NULL);
            INSERT INTO card_service_cards
                (local_card_id, remote_card_id, allocation_id, product_id, state, created_at, updated_at)
                VALUES (1, 'remote-1', 'batch', 'product', 'acknowledged', 1, 1),
                       (2, 'remote-2', 'batch', 'product', 'acknowledged', 1, 1);
            INSERT INTO card_service_operations
                (operation_key, operation, resource_id, state, created_at, updated_at)
                VALUES ('ack', 'ack', 'batch', 'done', 1, 1),
                       ('old-revoke', 'revoke', 'remote-2', 'done', 1, 1);
        `)
    }
}

function snapshot(ctx: SqliteTestContext) {
    return Object.fromEntries(['cards', 'orders', 'card_service_allocations', 'card_service_staged_cards',
        'card_service_cards', 'card_service_operations'].map((table) => [table, ctx.all(`SELECT * FROM ${table}`)]))
}

function beforeWrite(ctx: SqliteTestContext, change: () => void): CardServiceDatabase {
    return {
        query: ctx.database.query,
        async write(statements) {
            change()
            return ctx.database.write(statements)
        },
    }
}

test('Sell not_found：整批清理本地卡、暂存、映射与待办，保留订单和其他批次', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx)
    ctx.exec(`
        INSERT INTO card_service_allocations
            (allocation_id, product_id, program_key, external_ref, quantity, state,
             request_key, ack_key, expires_at, created_at, updated_at)
            VALUES ('other', 'product', 'program', 'other-ref', 1, 'acknowledged', 'other-req', 'other-ack', 999999, 1, 1);
        INSERT INTO cards (id, product_id, card_key) VALUES (3, 'product', 'VALID-KEY');
        INSERT INTO card_service_cards
            (local_card_id, remote_card_id, allocation_id, product_id, state, created_at, updated_at)
            VALUES (3, 'remote-3', 'other', 'product', 'acknowledged', 1, 1);
        INSERT INTO card_service_operations
            (operation_key, operation, resource_id, state, last_error_code, created_at, updated_at)
            VALUES ('other-op', 'sell', 'other', 'failed', 'not_found', 1, 1);
    `)
    const orderBefore = ctx.get('SELECT * FROM orders')
    const result = await discardFailedAllocation(ctx.database, 'failed')
    assert.deepEqual(result, { ok: true, allocationId: 'batch', productId: 'product', deletedCards: 2, deletedStagedCards: 1 })
    assert.deepEqual(ctx.get('SELECT * FROM orders'), orderBefore)
    assert.deepEqual(ctx.all('SELECT id FROM cards').map((row) => row.id), [3])
    assert.deepEqual(ctx.all('SELECT local_card_id FROM card_service_cards').map((row) => row.local_card_id), [3])
    assert.deepEqual(ctx.all('SELECT operation_key FROM card_service_operations').map((row) => row.operation_key), ['other-op'])
    assert.equal(ctx.all('SELECT * FROM card_service_staged_cards').length, 0)
    assert.deepEqual({ ...ctx.get("SELECT state, last_error_code FROM card_service_allocations WHERE allocation_id = 'batch'") },
        { state: 'abandoned', last_error_code: 'manually_discarded' })
    const queue = await listCardServiceReviewQueue(ctx.database)
    assert.deepEqual(queue.failedOperations.map((op) => op.operationKey), ['other-op'])
    assert.equal(queue.orphanMappings.length, 0)

    // 原失败卡已不在预留候选池，订单下次可选到有效库存并正常构建 Sell 计划。
    const candidates = ctx.all(`SELECT id FROM cards WHERE product_id = 'product'
        AND COALESCE(is_used, 0) = 0 AND reserved_at IS NULL`)
    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: 'order', localCardIds: candidates.map((row) => Number(row.id)) })
    assert.equal(plan.kind, 'remote')
    if (plan.kind === 'remote') assert.equal(plan.groups[0].allocationId, 'other')

    const after = snapshot(ctx)
    assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'recordChanged' })
    assert.deepEqual(snapshot(ctx), after)
})

test('Ack not_found：仅有暂存卡的失败批次也能丢弃', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx, 'ack')
    ctx.exec("UPDATE card_service_operations SET state = 'failed' WHERE operation_key = 'failed'")
    assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'),
        { ok: true, allocationId: 'batch', productId: 'product', deletedCards: 0, deletedStagedCards: 1 })
    assert.equal(ctx.all('SELECT * FROM card_service_staged_cards').length, 0)
    assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 0)
    assert.equal(ctx.get('SELECT status FROM orders')?.status, 'paid')
})

for (const [label, sql] of [
    ['其他错误', "UPDATE card_service_operations SET last_error_code = 'unauthorized' WHERE operation_key = 'failed'"],
    ['无错误码', "UPDATE card_service_operations SET last_error_code = NULL WHERE operation_key = 'failed'"],
    ['待执行', "UPDATE card_service_operations SET state = 'pending' WHERE operation_key = 'failed'"],
    ['已完成', "UPDATE card_service_operations SET state = 'done' WHERE operation_key = 'failed'"],
    ['单卡作废', "UPDATE card_service_operations SET operation = 'revoke' WHERE operation_key = 'failed'"],
    ['资源不匹配', "UPDATE card_service_operations SET resource_id = 'missing' WHERE operation_key = 'failed'"],
    ['未知操作', "UPDATE card_service_operations SET operation_key = 'changed' WHERE operation_key = 'failed'"],
] as const) {
    test(`${label}不可丢弃，所有本地数据保留`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seed(ctx)
        ctx.exec(sql)
        const before = snapshot(ctx)
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'recordChanged' })
        assert.deepEqual(snapshot(ctx), before)
    })
}

for (const [label, sql] of [
    ['批次已售', "UPDATE card_service_allocations SET state = 'sold'"],
    ['批次有销售时间', 'UPDATE card_service_allocations SET sold_at = 2'],
    ['映射已售', "UPDATE card_service_cards SET state = 'sold' WHERE local_card_id = 2"],
    ['映射已作废', "UPDATE card_service_cards SET state = 'revoked' WHERE local_card_id = 2"],
    ['映射指向不存在订单', "UPDATE card_service_cards SET order_id = 'missing' WHERE local_card_id = 2"],
    ['卡已使用', 'UPDATE cards SET is_used = 1 WHERE id = 2'],
    ['卡有使用时间', 'UPDATE cards SET used_at = 2 WHERE id = 2'],
    ['订单正在履约', "UPDATE orders SET status = 'processing'"],
    ['订单已交付', "UPDATE orders SET status = 'delivered'"],
    ['订单有交付时间', 'UPDATE orders SET delivered_at = 2'],
    ['订单存有卡密', "UPDATE orders SET card_key = 'delivered-key'"],
    ['已交付订单存有卡ID', "UPDATE orders SET status = 'delivered', card_ids = '[2]'"],
    ['另一个订单引用逗号分隔卡ID', `INSERT INTO orders (order_id, product_id, product_name, amount, status, card_ids)
        VALUES ('another', 'product', 'Product', '1', 'delivered', '12,2,31')`],
    ['另一个订单引用卡ID', `INSERT INTO orders (order_id, product_id, product_name, amount, status, card_ids)
        VALUES ('another', 'product', 'Product', '1', 'delivered', '[2]')`],
    ['另一个订单引用明文卡', `INSERT INTO orders (order_id, product_id, product_name, amount, card_key)
        VALUES ('another', 'product', 'Product', '1', 'KEY-2')`],
    ['预留给另一个正在履约的订单', `INSERT INTO orders (order_id, product_id, product_name, amount, status)
        VALUES ('another', 'product', 'Product', '1', 'processing');
        UPDATE cards SET reserved_order_id = 'another' WHERE id = 2`],
    ['其他待执行任务', "UPDATE card_service_operations SET state = 'pending' WHERE operation_key = 'ack'"],
    ['卡归属异常', "INSERT INTO products (id) VALUES ('wrong'); UPDATE cards SET product_id = 'wrong' WHERE id = 2"],
    ['暂存归属异常', "UPDATE card_service_staged_cards SET product_id = 'wrong'"],
] as const) {
    test(`${label}：整批拒绝，不部分删除`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seed(ctx)
        ctx.exec(sql)
        const before = snapshot(ctx)
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: (() => {
                if (['批次已售', '批次有销售时间', '映射已售', '卡已使用', '卡有使用时间'].includes(label)) return 'soldOrUsed'
                if (['映射已作废', '映射指向不存在订单', '卡归属异常', '暂存归属异常'].includes(label)) return 'ownership'
                if (label === '其他待执行任务') return 'pendingOperation'
                if (['订单正在履约', '预留给另一个正在履约的订单'].includes(label)) return 'missingPayment'
                return 'delivered'
            })() })
        assert.deepEqual(snapshot(ctx), before)
    })
}

for (const [label, sql] of [
    ['开始履约', "UPDATE orders SET status = 'processing'"],
    ['卡刚使用', 'UPDATE cards SET is_used = 1 WHERE id = 2'],
    ['任务刚成功', "UPDATE card_service_operations SET state = 'done' WHERE operation_key = 'failed'"],
    ['失败码变化', "UPDATE card_service_operations SET last_error_code = 'timeout' WHERE operation_key = 'failed'"],
] as const) {
    test(`读取后并发${label}：原子校验阻止删除`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seed(ctx)
        const database = beforeWrite(ctx, () => ctx.exec(sql))
        assert.deepEqual(await discardFailedAllocation(database, 'failed'), { ok: false, reason: 'blocked',
            blockedBy: label === '开始履约' ? 'missingPayment' : label === '卡刚使用' ? 'soldOrUsed' : 'recordChanged' })
        assert.equal(ctx.all('SELECT * FROM cards').length, 2)
        assert.equal(ctx.all('SELECT * FROM card_service_staged_cards').length, 1)
        assert.equal(ctx.get('SELECT state FROM card_service_allocations')?.state, 'acknowledged')
        assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 3)
    })
}

test('删除途中失败：整批回滚卡密、映射、任务和丢弃标记', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx)
    ctx.exec("UPDATE orders SET card_ids = '1,2'")
    ctx.exec(`CREATE TRIGGER stop_delete BEFORE DELETE ON card_service_cards
        BEGIN SELECT RAISE(ABORT, 'simulated deletion failure'); END`)
    const before = snapshot(ctx)
    await assert.rejects(discardFailedAllocation(ctx.database, 'failed'), /simulated deletion failure/)
    assert.deepEqual(snapshot(ctx), before)
})

test('旧 Ack 写回不能覆盖手动丢弃的终态或恢复卡密', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx, 'ack')
    assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
    const before = snapshot(ctx)
    const input = { allocationId: 'batch', ackOperationKey: 'failed', errorCode: 'not_found', nowMs: 123 }
    await ctx.database.write(buildFailAckStatements({ ...input, requestId: null }))
    await ctx.database.write(buildDeferAckStatements({ ...input, requestId: null, nextRetryAtMs: 456 }))
    await ctx.database.write(buildDiscardAllocationStatements(input))
    await ctx.database.write(buildMaterializeStatements({ ...input, productId: 'product' }))
    assert.deepEqual(snapshot(ctx), before)
})

test('Ack 响应晚于丢弃：不复活批次，也不报告补货成功', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx, 'ack')
    const allocation = await loadCardServiceAllocation(ctx.database, 'batch')
    assert.ok(allocation)
    const client = createFakeLicenseServiceClient({
        async ack() {
            assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
            return { allocationId: 'batch', status: 'acknowledged' }
        },
    })
    const result = await ackAndMaterializeAllocation({ database: ctx.database, client, now: () => 999 }, allocation)
    assert.equal(result.status, 'expired')
    assert.equal(ctx.all('SELECT * FROM cards').length, 0)
    assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 0)
    assert.deepEqual({ ...ctx.get('SELECT state, last_error_code FROM card_service_allocations') },
        { state: 'abandoned', last_error_code: 'manually_discarded' })
})


test('丢弃后旧 Sell 计划不能重建待办或再次调用中心', async () => {
    const ctx = createSqliteCardServiceDatabase()
    seed(ctx)
    const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: 'order', localCardIds: [1, 2] })
    assert.equal(plan.kind, 'remote')
    if (plan.kind !== 'remote') return
    assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
    const before = snapshot(ctx)
    await ctx.database.write(buildSellIntentStatements({ orderId: 'order', groups: plan.groups, nowMs: 123 }))
    const client = createFakeLicenseServiceClient()
    const result = await executeOrderRemoteSales({ database: ctx.database, client }, { orderId: 'order', groups: plan.groups })
    assert.equal(result.status, 'blocked')
    assert.equal(client.calls.length, 0)
    assert.deepEqual(snapshot(ctx), before)
})

for (const cardIds of ['1,2', '[1,2]', '1,3,2']) {
    test(`未交付预留引用 ${cardIds}：丢弃失败批次并保留其他卡ID`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        seed(ctx)
        ctx.exec(`UPDATE orders SET amount = '0', trade_no = 'POINTS_REDEMPTION', card_ids = '${cardIds}'`)
        const before = ctx.get('SELECT * FROM orders')!
        assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
        assert.deepEqual({ ...ctx.get('SELECT * FROM orders') }, { ...before, card_ids: cardIds.includes('3') ? '3' : null })
        const plan = await loadOrderRemoteSalePlan(ctx.database, { orderId: 'order', localCardIds: [] })
        assert.notEqual(plan.kind, 'blocked')
    })
}

for (const claimedAt of ['NULL', '1']) {
    test(`复现零元订单：过期/缺失锁 ${claimedAt} 与 364 次失败可丢弃，随后通过删单检查`, async () => {
        const ctx = createSqliteCardServiceDatabase(); seed(ctx)
        ctx.exec(`UPDATE orders SET amount = '0', points_used = 21000, trade_no = 'POINTS_REDEMPTION:order',
            status = 'processing', paid_at = 123, fulfillment_claim_id = 'stale', fulfillment_claimed_at = ${claimedAt}, card_ids = '1,2';
            UPDATE card_service_operations SET attempts = 364 WHERE operation_key = 'failed';
            UPDATE card_service_cards SET order_id = 'order' WHERE local_card_id = 2`)
        assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'order'), true)
        assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
        const order = ctx.get('SELECT * FROM orders')!
        assert.equal(order.status, 'paid'); assert.equal(order.card_ids, null)
        assert.equal(order.fulfillment_claim_id, null); assert.equal(order.fulfillment_claimed_at, null)
        assert.equal(order.paid_at, 123); assert.equal(order.points_used, 21000)
        assert.equal(order.trade_no, 'POINTS_REDEMPTION:order')
        assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'order'), false)
        // 旧请求即使后来拿到 Sell 成功，也失去了原认领，不能交付或复活映射。
        const late = await ctx.database.write(buildDeliverOrderStatements({ orderId: 'order', claimId: 'stale', tradeNo: 'POINTS_REDEMPTION:order', cardKey: 'KEY-1', localCardIds: [1], deliveryNote: null, nowMs: Date.now(), remoteGroups: [{ allocationId: 'batch', localCardIds: [1] }] }))
        assert.equal(late[0].changes, 0); assert.equal(ctx.get('SELECT status FROM orders')?.status, 'paid')
        const removed = await ctx.database.write([{ sql: "DELETE FROM orders WHERE order_id = ? AND status <> 'processing'", params: ['order'] }])
        assert.equal(removed[0].changes, 1)
    })
}

test('有效履约锁仍阻止丢弃，并给出明确原因', async () => {
    const ctx = createSqliteCardServiceDatabase(); seed(ctx)
    ctx.exec(`UPDATE orders SET status = 'processing', paid_at = 123, fulfillment_claim_id = 'live', fulfillment_claimed_at = ${Date.now()}`)
    const before = snapshot(ctx)
    assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'fulfilling' })
    assert.deepEqual(snapshot(ctx), before)
})

test('读取后过期锁被另一请求续领：原子校验仍拒绝丢弃', async () => {
    const ctx = createSqliteCardServiceDatabase(); seed(ctx)
    ctx.exec("UPDATE orders SET status = 'processing', paid_at = 123, fulfillment_claim_id = 'stale', fulfillment_claimed_at = 1")
    const database = beforeWrite(ctx, () => ctx.exec(`UPDATE orders SET fulfillment_claim_id = 'live', fulfillment_claimed_at = ${Date.now()}`))
    assert.deepEqual(await discardFailedAllocation(database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'fulfilling' })
    assert.equal(ctx.all('SELECT * FROM cards').length, 2)
    assert.equal(ctx.get('SELECT fulfillment_claim_id FROM orders')?.fulfillment_claim_id, 'live')
})

/** 复现 Sell not_found 后退款：退款原子批次先结算订单，再把卡隔离成 is_used = 1。 */
async function seedRefunded(ctx: SqliteTestContext, mappingState = 'acknowledged', retainHistory = false) {
    seed(ctx)
    ctx.exec(`UPDATE orders SET amount = '0', points_used = 21000, paid_at = 123, card_ids = '1,2';
        UPDATE card_service_operations SET attempts = 1 WHERE operation_key = 'failed'`)
    if (mappingState !== 'acknowledged') {
        ctx.exec(`UPDATE card_service_cards SET state = '${mappingState}', order_id = 'order', sold_at = 123;
            UPDATE card_service_allocations SET state = 'sold', sold_at = 123`)
    }
    await ctx.database.write([
        { sql: `UPDATE orders SET status = 'refunded',
            card_key = ${retainHistory ? "'KEY-1' || char(10) || 'KEY-2'" : 'NULL'},
            card_ids = ${retainHistory ? "'1,2'" : 'NULL'}, delivered_at = ${retainHistory ? '123' : 'NULL'}` },
        ...buildRefundRevokeStatements({ orderId: 'order', nowMs: 456, cards: [1, 2].map(id => ({
            remoteCardId: 'remote-' + id, localCardId: id, allocationId: 'batch',
            state: mappingState, alreadyRevoked: mappingState === 'revoked',
        })) }),
    ])
}

for (const state of ['acknowledged', 'sold', 'revoked']) {
    for (const retainHistory of [false, true]) {
        test(`已退款 ${state} 批次（保留交付历史=${retainHistory}）：本地清理旧卡及全部待办，不改变退款记录`, async () => {
            const ctx = createSqliteCardServiceDatabase()
            await seedRefunded(ctx, state, retainHistory)
            const before = ctx.get('SELECT * FROM orders')!
            assert.equal(ctx.get('SELECT is_used FROM cards WHERE id = 1')?.is_used, 1)
            assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'order'), state !== 'revoked')
            assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), {
                ok: true, allocationId: 'batch', productId: 'product', deletedCards: 2, deletedStagedCards: 1,
            })
            assert.deepEqual({ ...ctx.get('SELECT * FROM orders') }, { ...before, card_ids: null })
            for (const table of ['cards', 'card_service_cards', 'card_service_operations', 'card_service_staged_cards']) {
                assert.equal(ctx.all('SELECT * FROM ' + table).length, 0)
            }
            assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'order'), false)
            assert.equal(ctx.get('SELECT last_error_code FROM card_service_allocations')?.last_error_code, 'manually_discarded')
        })
    }
}

for (const status of ['pending', 'paid', 'processing', 'delivered', 'cancelled']) {
    test(`同批次还关联 ${status} 订单：已退款订单不能越权清理其他订单的卡`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        await seedRefunded(ctx, 'sold')
        ctx.exec(`INSERT INTO orders (order_id, product_id, product_name, amount, status, card_ids)
            VALUES ('other-order', 'product', 'Other', '1', '${status}', '2')`)
        const before = snapshot(ctx)
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'soldOrUsed' })
        assert.deepEqual(snapshot(ctx), before)
    })
}

for (const [label, sql] of [
    ['映射归属不明', "UPDATE card_service_cards SET order_id = 'missing' WHERE local_card_id = 2"],
    ['预留归属不明', "UPDATE cards SET reserved_order_id = 'missing' WHERE id = 2"],
    ['作废待办归属不明', "UPDATE card_service_operations SET order_id = 'missing' WHERE operation = 'revoke'"],
    ['映射状态异常', "UPDATE card_service_cards SET state = 'unknown' WHERE local_card_id = 2"],
] as const) {
    test(`已退款但${label}：整批拒绝本地清理`, async () => {
        const ctx = createSqliteCardServiceDatabase()
        await seedRefunded(ctx, 'sold')
        ctx.exec(sql)
        const before = snapshot(ctx)
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'ownership' })
        assert.deepEqual(snapshot(ctx), before)
    })
}

test('读取后订单退款状态变化：原子校验阻止清理', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx, 'sold')
    const database = beforeWrite(ctx, () => ctx.exec("UPDATE orders SET status = 'paid'"))
    assert.deepEqual(await discardFailedAllocation(database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'soldOrUsed' })
    assert.equal(ctx.all('SELECT * FROM cards').length, 2)
    assert.equal(ctx.get('SELECT state FROM card_service_allocations')?.state, 'sold')
})

test('已退款批次删除失败时整批回滚，包括退款订单的历史卡ID', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx, 'sold', true)
    ctx.exec(`CREATE TRIGGER stop_refunded_delete BEFORE DELETE ON card_service_cards
        BEGIN SELECT RAISE(ABORT, 'simulated refunded deletion failure'); END`)
    const before = snapshot(ctx)
    await assert.rejects(discardFailedAllocation(ctx.database, 'failed'), /simulated refunded deletion failure/)
    assert.deepEqual(snapshot(ctx), before)
})

test('清理已退款批次只移除该批次，保留其他库存和历史引用', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx, 'sold', true)
    ctx.exec(`INSERT INTO cards (id, product_id, card_key) VALUES (3, 'product', 'OTHER-KEY');
        UPDATE orders SET card_ids = '1,3,2'`)
    assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
    assert.deepEqual(ctx.all('SELECT id FROM cards').map(row => row.id), [3])
    assert.equal(ctx.get('SELECT card_ids FROM orders')?.card_ids, '3')
    assert.equal(ctx.get('SELECT status FROM orders')?.status, 'refunded')
})

test('丢弃后的旧退款作废计划不能重建待办、恢复库存或调用中心', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx)
    const cards = [1, 2].map(id => ({ remoteCardId: 'remote-' + id, localCardId: id,
        allocationId: 'batch', state: 'acknowledged', alreadyRevoked: false }))
    assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
    const before = snapshot(ctx)
    await ctx.database.write(buildRevokeIntentStatements({ orderId: 'order', cards, nowMs: 999 }))
    await ctx.database.write(buildRefundRevokeStatements({ orderId: 'order', cards, nowMs: 999 }))
    const client = createFakeLicenseServiceClient()
    const outcome = await executeOrderRevokes({ database: ctx.database, client }, { orderId: 'order', cards, reason: 'refund' })
    assert.equal(outcome.failed, 2)
    assert.equal(client.calls.length, 0)
    assert.deepEqual(snapshot(ctx), before)
})

test('探测中心期间管理员丢弃已退款批次：晚到结果不再触发 Revoke', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx)
    const client = createFakeLicenseServiceClient({ async getCardStatus() {
        assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
        return { cardId: 'remote-1', status: 'active', allocationStatus: 'sold' } as never
    } })
    const outcome = await executeOrderRevokes({ database: ctx.database, client }, { orderId: 'order', reason: 'refund',
        cards: [{ remoteCardId: 'remote-1', localCardId: 1, allocationId: 'batch', state: 'acknowledged', alreadyRevoked: false }] })
    assert.equal(outcome.failed, 1)
    assert.equal(client.callCount('getCardStatus'), 1)
    assert.equal(client.callCount('revoke'), 0)
    assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 0)
    assert.equal(ctx.get('SELECT status FROM orders')?.status, 'refunded')
})

test('Revoke not_found 的已退款旧卡也能定位所属批次并本地清理', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx, 'sold', true)
    ctx.exec("UPDATE card_service_operations SET operation = 'revoke', resource_id = 'remote-1' WHERE operation_key = 'failed'")
    assert.equal((await discardFailedAllocation(ctx.database, 'failed')).ok, true)
    assert.equal(ctx.all('SELECT * FROM cards').length, 0)
    assert.equal(ctx.all('SELECT * FROM card_service_operations').length, 0)
    assert.equal(ctx.get('SELECT status FROM orders')?.status, 'refunded')
    assert.equal(await orderHasUnsettledCardServiceLedger(ctx.database, 'order'), false)
})

test('Revoke not_found 仅在整批订单已退款时允许清理', async () => {
    const ctx = createSqliteCardServiceDatabase()
    await seedRefunded(ctx, 'sold')
    ctx.exec(`UPDATE card_service_operations SET operation = 'revoke', resource_id = 'remote-1' WHERE operation_key = 'failed';
        INSERT INTO orders (order_id, product_id, product_name, amount, status, card_ids)
            VALUES ('other-order', 'product', 'Other', '1', 'paid', '2')`)
    const before = snapshot(ctx)
    assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked', blockedBy: 'recordChanged' })
    assert.deepEqual(snapshot(ctx), before)
})
