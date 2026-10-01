import type { CardServiceDatabase, CardServiceStatement } from './db-port.ts'

export type DiscardFailedAllocationResult =
    | { ok: true; allocationId: string; productId: string; deletedCards: number; deletedStagedCards: number }
    | { ok: false; reason: 'blocked' }

/**
 * 管理员确认后整批丢弃 not_found 的失败 Ack / Sell。
 * 原子批次先重新校验并认领分配，后续删除只接受本次随机标记，避免读取后
 * 订单开始履约或卡已交付时误删。保留分配终态以阻止旧任务重新入库，订单不变。
 */
export async function discardFailedAllocation(
    database: CardServiceDatabase,
    operationKey: string,
): Promise<DiscardFailedAllocationResult> {
    const [target] = await database.query<{ allocation_id: string; product_id: string }>(
        `SELECT a.allocation_id, a.product_id
         FROM card_service_operations op
         JOIN card_service_allocations a ON a.allocation_id = op.resource_id
         WHERE op.operation_key = ? AND op.operation IN ('ack', 'sell')
           AND op.state IN ('failed', 'abandoned') AND op.last_error_code = 'not_found'`,
        [operationKey],
    )
    if (!target) return { ok: false, reason: 'blocked' }

    const marker = `manual_discard:${crypto.randomUUID()}`
    const nowMs = Date.now()
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
                  AND NOT EXISTS (SELECT 1 FROM card_service_operations op
                      WHERE op.operation IN ('ack', 'sell') AND op.resource_id = a.allocation_id
                        AND op.state = 'pending')
                  AND NOT EXISTS (SELECT 1 FROM card_service_staged_cards s
                      WHERE s.allocation_id = a.allocation_id AND s.product_id <> a.product_id)
                  AND NOT EXISTS (SELECT 1 FROM card_service_cards m
                      LEFT JOIN cards c ON c.id = m.local_card_id
                      WHERE m.allocation_id = a.allocation_id
                        AND (m.state <> 'acknowledged' OR m.order_id IS NOT NULL OR m.sold_at IS NOT NULL
                          OR m.product_id <> a.product_id OR c.product_id <> a.product_id
                          OR COALESCE(c.is_used, 0) <> 0 OR c.used_at IS NOT NULL))
                  AND NOT EXISTS (SELECT 1 FROM orders o
                      WHERE (
                          (o.status IN ('processing', 'delivered') OR o.delivered_at IS NOT NULL
                            OR COALESCE(o.card_key, '') <> '' OR COALESCE(o.card_ids, '') NOT IN ('', '[]'))
                          AND (o.order_id IN (SELECT op.order_id FROM card_service_operations op
                                  WHERE op.operation IN ('ack', 'sell') AND op.resource_id = a.allocation_id)
                              OR o.order_id IN (SELECT c.reserved_order_id FROM cards c
                                  JOIN card_service_cards m ON m.local_card_id = c.id
                                  WHERE m.allocation_id = a.allocation_id))
                      ) OR EXISTS (SELECT 1 FROM card_service_cards m
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
                                      char(10) || c.card_key || char(10)) > 0))`,
            params: [marker, nowMs, target.allocation_id, target.product_id, operationKey],
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
    if (!results[0]?.changes) return { ok: false, reason: 'blocked' }
    return {
        ok: true,
        allocationId: target.allocation_id,
        productId: target.product_id,
        deletedCards: results[1]?.changes ?? 0,
        deletedStagedCards: results[2]?.changes ?? 0,
    }
}
