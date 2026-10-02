import type { CardServiceDatabase, CardServiceStatement } from './db-port.ts'
import { FULFILLMENT_CLAIM_TTL_MS } from '../orders/fulfillment-lease.ts'

export type DiscardBlockReason = 'recordChanged' | 'soldOrUsed' | 'delivered' | 'fulfilling'
    | 'pendingOperation' | 'ownership' | 'missingPayment'

const relatedOrder = `(o.order_id IN (SELECT op.order_id FROM card_service_operations op
                                WHERE op.operation IN ('ack', 'sell') AND op.resource_id = a.allocation_id)
                            OR o.order_id IN (SELECT m.order_id FROM card_service_cards m
                                WHERE m.allocation_id = a.allocation_id)
                            OR o.order_id IN (SELECT c.reserved_order_id FROM cards c
                                JOIN card_service_cards m ON m.local_card_id = c.id
                                WHERE m.allocation_id = a.allocation_id)
                            OR EXISTS (SELECT 1 FROM card_service_cards m
                                WHERE m.allocation_id = a.allocation_id AND (
                                    instr(',' || replace(COALESCE(o.card_ids, ''), ' ', '') || ',',
                                          ',' || m.local_card_id || ',') > 0
                                    OR EXISTS (SELECT 1 FROM json_each(
                                        CASE WHEN json_valid(o.card_ids) THEN o.card_ids ELSE '[]' END) j
                                        WHERE CAST(j.value AS TEXT) = CAST(m.local_card_id AS TEXT))))
                            OR EXISTS (SELECT 1 FROM cards c
                                JOIN card_service_cards m ON m.local_card_id = c.id
                                WHERE m.allocation_id = a.allocation_id AND c.card_key <> ''
                                  AND instr(char(10) || COALESCE(o.card_key, '') || char(10),
                                            char(10) || c.card_key || char(10)) > 0))`

/** 只有确认已付款且租约过期的声明可回收；其余 processing 保守保留。 */
function recoverableClaim(nowMs: number) {
    return `(o.paid_at IS NOT NULL OR (CAST(o.amount AS REAL) = 0 AND COALESCE(o.trade_no, '') <> ''))
        AND (o.fulfillment_claimed_at IS NULL OR o.fulfillment_claimed_at <= ${nowMs - FULFILLMENT_CLAIM_TTL_MS})`
}

/** 查询诊断与原子 UPDATE 共用同一套条件，防止先读后写期间误删。 */
function blocker(nowMs: number) {
    return `CASE
        WHEN a.sold_at IS NOT NULL OR a.state = 'sold'
            OR EXISTS (SELECT 1 FROM card_service_cards m LEFT JOIN cards c ON c.id = m.local_card_id
                WHERE m.allocation_id = a.allocation_id AND (m.state = 'sold' OR m.sold_at IS NOT NULL
                    OR COALESCE(c.is_used, 0) <> 0 OR c.used_at IS NOT NULL)) THEN 'soldOrUsed'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrder}
            AND (o.status = 'delivered' OR o.delivered_at IS NOT NULL OR COALESCE(o.card_key, '') <> '')) THEN 'delivered'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrder} AND o.status = 'processing'
            AND o.fulfillment_claimed_at > ${nowMs - FULFILLMENT_CLAIM_TTL_MS}) THEN 'fulfilling'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrder} AND o.status = 'processing'
            AND NOT (${recoverableClaim(nowMs)})) THEN 'missingPayment'
        WHEN EXISTS (SELECT 1 FROM card_service_operations op WHERE op.resource_id = a.allocation_id
            AND op.operation IN ('ack', 'sell') AND op.state = 'pending') THEN 'pendingOperation'
        WHEN a.state NOT IN ('allocated', 'acknowledged', 'expired', 'cancelled', 'abandoned')
            OR EXISTS (SELECT 1 FROM card_service_staged_cards s
                WHERE s.allocation_id = a.allocation_id AND s.product_id <> a.product_id)
            OR EXISTS (SELECT 1 FROM card_service_cards m LEFT JOIN cards c ON c.id = m.local_card_id
                WHERE m.allocation_id = a.allocation_id AND (m.state <> 'acknowledged'
                    OR m.product_id <> a.product_id OR c.product_id <> a.product_id
                    OR (m.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_id = m.order_id AND o.product_id = a.product_id))))
            THEN 'ownership'
        ELSE NULL END`
}


export type DiscardFailedAllocationResult =
    | { ok: true; allocationId: string; productId: string; deletedCards: number; deletedStagedCards: number }
    | { ok: false; reason: 'blocked'; blockedBy: DiscardBlockReason }

/**
 * 管理员确认后整批丢弃 not_found 的失败 Ack / Sell。
 * 原子批次先重新校验并认领分配，后续删除只接受本次随机标记，避免读取后
 * 订单开始履约或卡已交付时误删。保留分配终态以阻止旧任务重新入库，清理未交付订单的失效预留引用。
 */
export async function discardFailedAllocation(
    database: CardServiceDatabase,
    operationKey: string,
): Promise<DiscardFailedAllocationResult> {
    const nowMs = Date.now()
    const [target] = await database.query<{ allocation_id: string; product_id: string; blocked_by: DiscardBlockReason | null }>(
        `SELECT a.allocation_id, a.product_id, ${blocker(nowMs)} AS blocked_by
         FROM card_service_operations op
         JOIN card_service_allocations a ON a.allocation_id = op.resource_id
         WHERE op.operation_key = ? AND op.operation IN ('ack', 'sell')
           AND op.state IN ('failed', 'abandoned') AND op.last_error_code = 'not_found'`,
        [operationKey],
    )
    if (!target) return { ok: false, reason: 'blocked', blockedBy: 'recordChanged' }
    if (target.blocked_by) return { ok: false, reason: 'blocked', blockedBy: target.blocked_by }

    const marker = `manual_discard:${crypto.randomUUID()}`
    const fence = `EXISTS (SELECT 1 FROM card_service_allocations
        WHERE allocation_id = ? AND state = 'abandoned' AND last_error_code = ?)`
    const fenceParams = [target.allocation_id, marker]
    const statements: CardServiceStatement[] = [
        {
            sql: `UPDATE card_service_allocations AS a
                SET state = 'abandoned', last_error_code = ?, updated_at = ?
                WHERE a.allocation_id = ? AND a.product_id = ? AND a.sold_at IS NULL
                  AND a.state IN ('allocated', 'acknowledged', 'expired', 'cancelled', 'abandoned')
                  AND COALESCE(a.last_error_code, '') <> 'manually_discarded'
                  AND EXISTS (SELECT 1 FROM card_service_operations op
                      WHERE op.operation_key = ? AND op.resource_id = a.allocation_id
                        AND op.operation IN ('ack', 'sell') AND op.state IN ('failed', 'abandoned')
                        AND op.last_error_code = 'not_found')
                  AND (${blocker(nowMs)}) IS NULL`,
            params: [marker, nowMs, target.allocation_id, target.product_id, operationKey],
        },
        {
            sql: `UPDATE orders AS o SET status = 'paid', paid_at = COALESCE(paid_at, ?),
                fulfillment_claim_id = NULL, fulfillment_claimed_at = NULL, current_payment_id = NULL
                WHERE o.status = 'processing' AND (${recoverableClaim(nowMs)})
                  AND EXISTS (SELECT 1 FROM card_service_allocations a
                    WHERE a.allocation_id = ? AND a.last_error_code = ? AND a.state = 'abandoned'
                      AND ${relatedOrder})`,
            params: [nowMs, ...fenceParams],
        },
        {
            sql: `UPDATE orders AS o SET card_ids = (
                SELECT group_concat(j.value, ',') FROM json_each(
                    CASE WHEN json_valid(o.card_ids) AND substr(trim(o.card_ids), 1, 1) = '['
                        THEN o.card_ids
                        WHEN json_valid('[' || COALESCE(o.card_ids, '') || ']')
                        THEN '[' || COALESCE(o.card_ids, '') || ']' ELSE '[]' END) j
                WHERE CAST(j.value AS TEXT) NOT IN (
                    SELECT CAST(local_card_id AS TEXT) FROM card_service_cards WHERE allocation_id = ?))
                WHERE o.status NOT IN ('processing', 'delivered') AND o.delivered_at IS NULL
                  AND COALESCE(o.card_key, '') = '' AND ${fence}
                  AND EXISTS (SELECT 1 FROM json_each(
                    CASE WHEN json_valid(o.card_ids) AND substr(trim(o.card_ids), 1, 1) = '['
                        THEN o.card_ids
                        WHEN json_valid('[' || COALESCE(o.card_ids, '') || ']')
                        THEN '[' || COALESCE(o.card_ids, '') || ']' ELSE '[]' END) j
                    JOIN card_service_cards m ON CAST(j.value AS TEXT) = CAST(m.local_card_id AS TEXT)
                    WHERE m.allocation_id = ?)`,
            params: [target.allocation_id, ...fenceParams, target.allocation_id],
        },
        {
            sql: `DELETE FROM cards WHERE id IN (
                SELECT local_card_id FROM card_service_cards WHERE allocation_id = ?)
                AND ${fence}`,
            params: [target.allocation_id, ...fenceParams],
        },
        {
            sql: `DELETE FROM card_service_staged_cards WHERE allocation_id = ? AND ${fence}`,
            params: [target.allocation_id, ...fenceParams],
        },
        {
            sql: `DELETE FROM card_service_operations WHERE (
                (operation IN ('ack', 'sell') AND resource_id = ?)
                OR (operation = 'revoke' AND resource_id IN (
                    SELECT remote_card_id FROM card_service_cards WHERE allocation_id = ?)))
                AND ${fence}`,
            params: [target.allocation_id, target.allocation_id, ...fenceParams],
        },
        {
            sql: `DELETE FROM card_service_cards WHERE allocation_id = ? AND ${fence}`,
            params: [target.allocation_id, ...fenceParams],
        },
        {
            sql: `UPDATE card_service_allocations SET last_error_code = 'manually_discarded'
                WHERE allocation_id = ? AND last_error_code = ? AND state = 'abandoned'`,
            params: fenceParams,
        },
    ]
    const results = await database.write(statements)
    if (!results[0]?.changes) {
        const [latest] = await database.query<{ blocked_by: DiscardBlockReason | null }>(
            `SELECT ${blocker(nowMs)} AS blocked_by FROM card_service_allocations a WHERE allocation_id = ?`,
            [target.allocation_id],
        )
        return { ok: false, reason: 'blocked', blockedBy: latest?.blocked_by ?? 'recordChanged' }
    }
    return {
        ok: true,
        allocationId: target.allocation_id,
        productId: target.product_id,
        deletedCards: results[3]?.changes ?? 0,
        deletedStagedCards: results[4]?.changes ?? 0,
    }
}
