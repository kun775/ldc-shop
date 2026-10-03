import type { CardServiceDatabase, CardServiceStatement } from './db-port.ts'
import { FULFILLMENT_CLAIM_TTL_MS } from '../orders/fulfillment-lease.ts'

export type DiscardBlockReason = 'recordChanged' | 'soldOrUsed' | 'delivered' | 'fulfilling'
    | 'pendingOperation' | 'ownership' | 'missingPayment'

const relatedOrderTemplate = `(o.order_id IN (SELECT op.order_id FROM card_service_operations op
                                WHERE (op.operation IN ('ack', 'sell') AND op.resource_id = a.allocation_id)
                                   OR (op.operation = 'revoke' AND op.resource_id IN (
                                       SELECT remote_card_id FROM card_service_cards WHERE allocation_id = a.allocation_id)))
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

/** 已售/隔离卡必须能追溯到已退款订单，整批还不能关联任何未退款订单。 */
const refundedBatchTemplate = `EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrderTemplate}
        AND o.status = 'refunded' AND o.product_id = a.product_id)
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrderTemplate}
        AND (COALESCE(o.status, '') <> 'refunded' OR o.product_id <> a.product_id))
    AND NOT EXISTS (SELECT 1 FROM card_service_cards m LEFT JOIN cards c ON c.id = m.local_card_id
        WHERE m.allocation_id = a.allocation_id
          AND (m.state IN ('sold', 'revoked') OR m.sold_at IS NOT NULL
               OR COALESCE(c.is_used, 0) <> 0 OR c.used_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.status = 'refunded' AND o.product_id = a.product_id
            AND (o.order_id = m.order_id OR o.order_id = c.reserved_order_id
                OR EXISTS (SELECT 1 FROM card_service_operations op WHERE op.order_id = o.order_id
                    AND ((op.operation = 'sell' AND op.resource_id = a.allocation_id)
                        OR (op.operation = 'revoke' AND op.resource_id = m.remote_card_id)))
                OR instr(',' || replace(COALESCE(o.card_ids, ''), ' ', '') || ',', ',' || m.local_card_id || ',') > 0
                OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(o.card_ids) THEN o.card_ids ELSE '[]' END) j
                    WHERE CAST(j.value AS TEXT) = CAST(m.local_card_id AS TEXT))
                OR (COALESCE(c.card_key, '') <> '' AND instr(char(10) || COALESCE(o.card_key, '') || char(10),
                    char(10) || c.card_key || char(10)) > 0))))`

/** 已退款批次只清理本地残留；未完成退款或无法确认归属时仍走原有保护。 */
const refundedBlockerTemplate = `CASE
    WHEN a.state NOT IN ('allocated', 'acknowledged', 'sold', 'expired', 'cancelled', 'abandoned')
        OR EXISTS (SELECT 1 FROM card_service_staged_cards s WHERE s.allocation_id = a.allocation_id
            AND s.product_id <> a.product_id)
        OR EXISTS (SELECT 1 FROM card_service_cards m LEFT JOIN cards c ON c.id = m.local_card_id
            WHERE m.allocation_id = a.allocation_id AND (m.state NOT IN ('acknowledged', 'sold', 'revoked')
                OR m.product_id <> a.product_id OR c.product_id <> a.product_id
                OR (m.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o
                    WHERE o.order_id = m.order_id AND o.status = 'refunded' AND o.product_id = a.product_id))
                OR (c.reserved_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o
                    WHERE o.order_id = c.reserved_order_id AND o.status = 'refunded' AND o.product_id = a.product_id))))
        OR EXISTS (SELECT 1 FROM card_service_operations op WHERE op.order_id IS NOT NULL
            AND ((op.operation IN ('ack', 'sell') AND op.resource_id = a.allocation_id)
                OR (op.operation = 'revoke' AND op.resource_id IN (
                    SELECT remote_card_id FROM card_service_cards WHERE allocation_id = a.allocation_id)))
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_id = op.order_id
                AND o.status = 'refunded' AND o.product_id = a.product_id)) THEN 'ownership'
    ELSE NULL END`

/** 只有确认已付款且租约过期的声明可回收；其余 processing 保守保留。 */
function recoverableClaim(nowMs: number) {
    return `(o.paid_at IS NOT NULL OR (CAST(o.amount AS REAL) = 0 AND COALESCE(o.trade_no, '') <> ''))
        AND (o.fulfillment_claimed_at IS NULL OR o.fulfillment_claimed_at <= ${nowMs - FULFILLMENT_CLAIM_TTL_MS})`
}

function blockerTemplate(nowMs: number) {
    return `CASE WHEN (${refundedBatchTemplate}) THEN (${refundedBlockerTemplate}) ELSE CASE
        WHEN a.sold_at IS NOT NULL OR a.state = 'sold'
            OR EXISTS (SELECT 1 FROM card_service_cards m LEFT JOIN cards c ON c.id = m.local_card_id
                WHERE m.allocation_id = a.allocation_id AND (m.state = 'sold' OR m.sold_at IS NOT NULL
                    OR COALESCE(c.is_used, 0) <> 0 OR c.used_at IS NOT NULL)) THEN 'soldOrUsed'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrderTemplate}
            AND (o.status = 'delivered' OR o.delivered_at IS NOT NULL OR COALESCE(o.card_key, '') <> '')) THEN 'delivered'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrderTemplate} AND o.status = 'processing'
            AND o.fulfillment_claimed_at > ${nowMs - FULFILLMENT_CLAIM_TTL_MS}) THEN 'fulfilling'
        WHEN EXISTS (SELECT 1 FROM orders o WHERE ${relatedOrderTemplate} AND o.status = 'processing'
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
        ELSE NULL END END`
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

/**
 * 把模板里的 `a.allocation_id` / `a.product_id` 换成已解析出的常量。
 *
 * 模板原本靠外层 `card_service_allocations a` 关联：SQLite 无法缓存相关子查询，
 * 每个外层订单行都要把待办、映射、卡表重扫一遍，线上一次丢弃读到约 170 万行，
 * 直接耗尽 D1 免费读额度（2026-10-03 事故）。换成常量后子查询与外层无关，
 * `IN (SELECT ...)` 只物化一次，判定语义完全不变。
 */
function bindAllocation(template: string, target: { allocationId: string; productId: string }): string {
    return template
        // 用函数作替换值：字符串替换值里的 `$&` / `$'` 会被当作反向引用。
        .replace(/\ba\.allocation_id\b/g, () => sqlLiteral(target.allocationId))
        .replace(/\ba\.product_id\b/g, () => sqlLiteral(target.productId))
}

/** 查询诊断与原子 UPDATE 共用同一套条件，防止先读后写期间误删。 */
function discardConditions(target: { allocationId: string; productId: string }, nowMs: number) {
    return {
        relatedOrder: bindAllocation(relatedOrderTemplate, target),
        refundedBatch: bindAllocation(refundedBatchTemplate, target),
        blocker: bindAllocation(blockerTemplate(nowMs), target),
    }
}


export type DiscardFailedAllocationResult =
    | { ok: true; allocationId: string; productId: string; deletedCards: number; deletedStagedCards: number }
    | { ok: false; reason: 'blocked'; blockedBy: DiscardBlockReason }

/**
 * 管理员确认后整批丢弃 not_found 的失败 Ack / Sell；已退款的 Revoke 记录可定位并清理其所属批次。
 * 原子批次先重新校验并认领分配，后续删除只接受本次随机标记，避免读取后
 * 订单开始履约或卡已交付时误删。已退款订单允许清理曾售出或退款隔离的卡，
 * 保留退款/交付历史与分配终态，清理失效预留引用；整个过程不调用中心。
 */
export async function discardFailedAllocation(
    database: CardServiceDatabase,
    operationKey: string,
): Promise<DiscardFailedAllocationResult> {
    const nowMs = Date.now()
    // 第一步只按主键/唯一索引定位分配，不做任何判定（remote_card_id 唯一，最多一个批次）。
    const [resolved] = await database.query<{ operation: string; allocation_id: string; product_id: string }>(
        `SELECT op.operation, a.allocation_id, a.product_id
         FROM card_service_operations op
         JOIN card_service_allocations a ON a.allocation_id = CASE
             WHEN op.operation IN ('ack', 'sell') THEN op.resource_id
             ELSE (SELECT m.allocation_id FROM card_service_cards m WHERE m.remote_card_id = op.resource_id) END
         WHERE op.operation_key = ? AND op.operation IN ('ack', 'sell', 'revoke')
           AND op.state IN ('failed', 'abandoned') AND op.last_error_code = 'not_found'`,
        [operationKey],
    )
    if (!resolved) return { ok: false, reason: 'blocked', blockedBy: 'recordChanged' }
    const scope = { allocationId: resolved.allocation_id, productId: resolved.product_id }
    const { relatedOrder, refundedBatch, blocker } = discardConditions(scope, nowMs)

    const [target] = await database.query<{ allocation_id: string; product_id: string; blocked_by: DiscardBlockReason | null }>(
        `SELECT a.allocation_id, a.product_id, ${blocker} AS blocked_by
         FROM card_service_allocations a
         WHERE a.allocation_id = ? AND a.product_id = ?
           AND (? <> 'revoke' OR (${refundedBatch}))`,
        [scope.allocationId, scope.productId, resolved.operation],
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
                WHERE a.allocation_id = ? AND a.product_id = ?
                  AND COALESCE(a.last_error_code, '') <> 'manually_discarded'
                  AND EXISTS (SELECT 1 FROM card_service_operations op
                      WHERE op.operation_key = ? AND op.state IN ('failed', 'abandoned')
                        AND ((op.operation IN ('ack', 'sell') AND op.resource_id = ?)
                            OR (op.operation = 'revoke' AND (${refundedBatch})
                                AND EXISTS (SELECT 1 FROM card_service_cards m
                                    WHERE m.remote_card_id = op.resource_id AND m.allocation_id = ?)))
                        AND op.last_error_code = 'not_found')
                  AND (${blocker}) IS NULL`,
            params: [marker, nowMs, target.allocation_id, target.product_id, operationKey,
                target.allocation_id, target.allocation_id],
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
                WHERE (o.status = 'refunded' OR (o.status NOT IN ('processing', 'delivered')
                    AND o.delivered_at IS NULL AND COALESCE(o.card_key, '') = '')) AND ${fence}
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
            `SELECT ${blocker} AS blocked_by FROM card_service_allocations a WHERE allocation_id = ?`,
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
