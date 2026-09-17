import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { couponUsages } from '@/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { couponFailure } from './errors.ts'
import type { CouponRecord, CouponUsageStatus } from './types.ts'

export interface CouponReservationLine {
    coupon: CouponRecord
    sequence: number
    eligibleAmountCents: number
    discountAmountCents: number
    ruleSnapshot: string
}

export type CouponReservationOutcome =
    | { ok: true; reservedCount: number }
    | { ok: false; error: string; reservedCount: number }

function rowsOf(result: any): any[] {
    return result?.results || result?.rows || []
}

async function ensureUserCounterRow(couponId: string, userId: string, now: number) {
    await db.run(sql`
        INSERT INTO coupon_user_counters (coupon_id, user_id, reserved_count, consumed_count, updated_at)
        VALUES (${couponId}, ${userId}, 0, 0, ${now})
        ON CONFLICT(coupon_id, user_id) DO NOTHING
    `)
}

// reserveCouponUsages 原子预占优惠券使用次数
//
// 参数:
//   - input.orderId: 订单 ID
//   - input.userId: 登录用户 ID，可空
//   - input.lines: 本次下单应用的优惠券及其优惠金额
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增单条条件 UPDATE 抢占 + 用户计数表限次的并发安全预占，失败自动补偿。
export async function reserveCouponUsages(input: {
    orderId: string
    userId: string | null
    username: string | null
    now: number
    reservationTtlMs: number
    lines: CouponReservationLine[]
}): Promise<CouponReservationOutcome> {
    const { orderId, userId, username, now, reservationTtlMs, lines } = input
    if (!lines.length) return { ok: true, reservedCount: 0 }

    let reservedCount = 0

    for (const line of lines) {
        const coupon = line.coupon
        const reservationId = `${orderId}:${coupon.id}:${randomUUID()}`

        // 1) 原子抢占整券次数
        const couponClaim = await db.run(sql`
            UPDATE coupons
            SET reserved_count = reserved_count + 1,
                updated_at = ${now}
            WHERE id = ${coupon.id}
              AND status = 'active'
              AND (starts_at IS NULL OR starts_at <= ${now})
              AND (ends_at IS NULL OR ends_at >= ${now})
              AND (
                total_use_limit IS NULL
                OR (reserved_count + consumed_count) < total_use_limit
              )
            RETURNING id
        `)

        if (rowsOf(couponClaim).length === 0) {
            await releaseCouponUsages(orderId, 'reserve_conflict', now)
            return { ok: false, error: couponFailure('COUPON_RESERVATION_CONFLICT').error, reservedCount: 0 }
        }

        // 2) 原子抢占用户次数（仅设置了每人限次时需要）
        if (coupon.perUserLimit !== null && coupon.perUserLimit !== undefined) {
            if (!userId) {
                await releaseCouponUsages(orderId, 'reserve_login_required', now)
                return { ok: false, error: couponFailure('COUPON_LOGIN_REQUIRED').error, reservedCount: 0 }
            }

            await ensureUserCounterRow(coupon.id, userId, now)
            const userClaim = await db.run(sql`
                UPDATE coupon_user_counters
                SET reserved_count = reserved_count + 1,
                    updated_at = ${now}
                WHERE coupon_id = ${coupon.id}
                  AND user_id = ${userId}
                  AND (reserved_count + consumed_count) < ${coupon.perUserLimit}
                RETURNING user_id
            `)
            if (rowsOf(userClaim).length === 0) {
                await db.run(sql`
                    UPDATE coupons
                    SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                        updated_at = ${now}
                    WHERE id = ${coupon.id}
                `)
                await releaseCouponUsages(orderId, 'reserve_user_limit', now)
                return { ok: false, error: couponFailure('COUPON_USER_LIMIT_REACHED').error, reservedCount: 0 }
            }
        }

        // 3) 写入使用明细（含规则与金额快照）
        try {
            await db.insert(couponUsages).values({
                id: `cpu_${randomUUID()}`,
                couponId: coupon.id,
                orderId,
                userId: userId ?? null,
                username: username ?? null,
                status: 'reserved',
                sequence: line.sequence,
                reservationId,
                reservationExpiresAt: new Date(now + reservationTtlMs),
                couponCodeSnapshot: coupon.code,
                ruleSnapshot: line.ruleSnapshot,
                eligibleAmountCents: line.eligibleAmountCents,
                discountAmountCents: line.discountAmountCents,
                reservedAt: new Date(now),
                createdAt: new Date(now),
            })
        } catch {
            // 明细写入失败时回滚该张券的占用
            await db.run(sql`
                UPDATE coupons
                SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                    updated_at = ${now}
                WHERE id = ${coupon.id}
            `)
            if (coupon.perUserLimit !== null && coupon.perUserLimit !== undefined && userId) {
                await db.run(sql`
                    UPDATE coupon_user_counters
                    SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                        updated_at = ${now}
                    WHERE coupon_id = ${coupon.id} AND user_id = ${userId}
                `)
            }
            await releaseCouponUsages(orderId, 'reserve_write_failed', now)
            return { ok: false, error: couponFailure('COUPON_RESERVATION_CONFLICT').error, reservedCount: 0 }
        }

        reservedCount += 1
    }

    return { ok: true, reservedCount }
}

async function loadOrderUsagesByStatus(orderId: string, status: CouponUsageStatus) {
    const rows = await db
        .select()
        .from(couponUsages)
        .where(and(eq(couponUsages.orderId, orderId), eq(couponUsages.status, status)))
        .orderBy(asc(couponUsages.sequence))
    return rows
}

// consumeCouponReservations 将订单的预占优惠券核销（幂等）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增支付成功后 reserved→consumed 的幂等迁移，重复调用不重复计数。
export async function consumeCouponReservations(orderId: string, now: number = Date.now()): Promise<number> {
    const rows = await loadOrderUsagesByStatus(orderId, 'reserved')
    let consumed = 0

    for (const row of rows) {
        const updated = await db.update(couponUsages)
            .set({ status: 'consumed', consumedAt: new Date(now) })
            .where(and(eq(couponUsages.id, row.id), eq(couponUsages.status, 'reserved')))
            .returning({ id: couponUsages.id })
        if (!updated.length) continue

        await db.run(sql`
            UPDATE coupons
            SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                consumed_count = consumed_count + 1,
                updated_at = ${now}
            WHERE id = ${row.couponId}
        `)
        if (row.userId) {
            await db.run(sql`
                UPDATE coupon_user_counters
                SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                    consumed_count = consumed_count + 1,
                    updated_at = ${now}
                WHERE coupon_id = ${row.couponId} AND user_id = ${row.userId}
            `)
        }
        consumed += 1
    }

    return consumed
}

// releaseCouponUsages 释放订单的预占优惠券（幂等）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增创建失败、取消与超时场景下 reserved→released 的次数回退。
export async function releaseCouponUsages(
    orderId: string,
    reason: string,
    now: number = Date.now()
): Promise<number> {
    const rows = await loadOrderUsagesByStatus(orderId, 'reserved')
    let released = 0

    for (const row of rows) {
        const updated = await db.update(couponUsages)
            .set({ status: 'released', releasedAt: new Date(now), reason })
            .where(and(eq(couponUsages.id, row.id), eq(couponUsages.status, 'reserved')))
            .returning({ id: couponUsages.id })
        if (!updated.length) continue

        await db.run(sql`
            UPDATE coupons
            SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                updated_at = ${now}
            WHERE id = ${row.couponId}
        `)
        if (row.userId) {
            await db.run(sql`
                UPDATE coupon_user_counters
                SET reserved_count = CASE WHEN reserved_count > 0 THEN reserved_count - 1 ELSE 0 END,
                    updated_at = ${now}
                WHERE coupon_id = ${row.couponId} AND user_id = ${row.userId}
            `)
        }
        released += 1
    }

    return released
}

// reverseCouponUsages 退款时返还已核销的优惠券次数（幂等）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增 consumed→reversed 的返还逻辑，按策略由调用方决定是否触发。
export async function reverseCouponUsages(
    orderId: string,
    reason: string,
    now: number = Date.now()
): Promise<number> {
    const rows = await loadOrderUsagesByStatus(orderId, 'consumed')
    let reversed = 0

    for (const row of rows) {
        const updated = await db.update(couponUsages)
            .set({ status: 'reversed', reversedAt: new Date(now), reason })
            .where(and(eq(couponUsages.id, row.id), eq(couponUsages.status, 'consumed')))
            .returning({ id: couponUsages.id })
        if (!updated.length) continue

        await db.run(sql`
            UPDATE coupons
            SET consumed_count = CASE WHEN consumed_count > 0 THEN consumed_count - 1 ELSE 0 END,
                updated_at = ${now}
            WHERE id = ${row.couponId}
        `)
        if (row.userId) {
            await db.run(sql`
                UPDATE coupon_user_counters
                SET consumed_count = CASE WHEN consumed_count > 0 THEN consumed_count - 1 ELSE 0 END,
                    updated_at = ${now}
                WHERE coupon_id = ${row.couponId} AND user_id = ${row.userId}
            `)
        }
        reversed += 1
    }

    return reversed
}

// shouldReverseCouponsOnRefund 判断退款时是否应返还优惠券次数
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增按优惠券退款策略与订单履约状态的返券判定。
export function shouldReverseCouponsOnRefund(input: {
    refundPolicy: string | null | undefined
    fulfilled: boolean
}): boolean {
    const policy = input.refundPolicy || 'unfulfilled_full_refund'
    if (policy === 'never') return false
    if (policy === 'always') return true
    return !input.fulfilled
}

export async function listOrderCouponUsages(orderId: string) {
    if (!orderId) return []
    return db
        .select()
        .from(couponUsages)
        .where(eq(couponUsages.orderId, orderId))
        .orderBy(asc(couponUsages.sequence))
}

// getOrderCouponsForReverse 读取订单已核销的优惠券策略
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增退款前读取订单券策略，用于决定是否返还次数。
export async function getOrderCouponsForReverse(orderId: string) {
    if (!orderId) return []
    const rows = await db.run(sql`
        SELECT u.coupon_id AS couponId, u.status AS status, c.refund_policy AS refundPolicy, c.code AS code
        FROM coupon_usages u
        LEFT JOIN coupons c ON c.id = u.coupon_id
        WHERE u.order_id = ${orderId} AND u.status = 'consumed'
    `)
    return rowsOf(rows)
}
