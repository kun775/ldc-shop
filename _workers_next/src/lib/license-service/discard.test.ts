import assert from 'node:assert/strict'
import test from 'node:test'
import { discardFailedAllocation } from './discard.ts'
import { buildSellIntentStatements, executeOrderRemoteSales, loadOrderRemoteSalePlan } from './delivery.ts'
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
    assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked' })
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
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked' })
        assert.deepEqual(snapshot(ctx), before)
    })
}

for (const [label, sql] of [
    ['批次已售', "UPDATE card_service_allocations SET state = 'sold'"],
    ['批次有销售时间', 'UPDATE card_service_allocations SET sold_at = 2'],
    ['映射已售', "UPDATE card_service_cards SET state = 'sold' WHERE local_card_id = 2"],
    ['映射已作废', "UPDATE card_service_cards SET state = 'revoked' WHERE local_card_id = 2"],
    ['映射已关联订单', "UPDATE card_service_cards SET order_id = 'order' WHERE local_card_id = 2"],
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
        assert.deepEqual(await discardFailedAllocation(ctx.database, 'failed'), { ok: false, reason: 'blocked' })
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
        assert.deepEqual(await discardFailedAllocation(database, 'failed'), { ok: false, reason: 'blocked' })
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
