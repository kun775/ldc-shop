import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { couponUsages } from '@/lib/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { couponFailure } from './errors.ts'
import type { CouponRecord } from './types.ts'

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

function reservationFailureFor(error: unknown): string {
    const text = (
        JSON.stringify(error ?? '') +
        String(error ?? '') +
        ((error as { message?: unknown } | null)?.message || '')
    ).toLowerCase()
    if (text.includes('coupon_login_required')) {
        return couponFailure('COUPON_LOGIN_REQUIRED').error
    }
    if (text.includes('coupon_user_limit_reached')) {
        return couponFailure('COUPON_USER_LIMIT_REACHED').error
    }
    return couponFailure('COUPON_RESERVATION_CONFLICT').error
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
//   - 更新内容: 使用单条流水 INSERT 预占，计数与限次校验由数据库触发器原子完成。
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

        if (coupon.perUserLimit !== null && coupon.perUserLimit !== undefined) {
            if (!userId) {
                await releaseCouponUsages(orderId, 'reserve_login_required', now)
                return { ok: false, error: couponFailure('COUPON_LOGIN_REQUIRED').error, reservedCount: 0 }
            }
        }

        // INSERT 与触发器中的总计数、用户计数更新属于同一条 SQLite 语句。
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
        } catch (error) {
            await releaseCouponUsages(orderId, 'reserve_write_failed', now)
            return { ok: false, error: reservationFailureFor(error), reservedCount: 0 }
        }

        reservedCount += 1
    }

    return { ok: true, reservedCount }
}

// consumeCouponReservations 将订单的预占优惠券核销（幂等）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增支付成功后 reserved→consumed 的幂等迁移，重复调用不重复计数。
export async function consumeCouponReservations(orderId: string, now: number = Date.now()): Promise<number> {
    const updated = await db.update(couponUsages)
        .set({ status: 'consumed', consumedAt: new Date(now) })
        .where(and(eq(couponUsages.orderId, orderId), eq(couponUsages.status, 'reserved')))
        .returning({ id: couponUsages.id })
    return updated.length
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
    const updated = await db.update(couponUsages)
        .set({ status: 'released', releasedAt: new Date(now), reason })
        .where(and(eq(couponUsages.orderId, orderId), eq(couponUsages.status, 'reserved')))
        .returning({ id: couponUsages.id })
    return updated.length
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
    now: number = Date.now(),
    usageIds?: string[]
): Promise<number> {
    if (usageIds && usageIds.length === 0) return 0
    const where = usageIds
        ? and(
            eq(couponUsages.orderId, orderId),
            eq(couponUsages.status, 'consumed'),
            inArray(couponUsages.id, usageIds)
        )
        : and(eq(couponUsages.orderId, orderId), eq(couponUsages.status, 'consumed'))
    const updated = await db.update(couponUsages)
        .set({ status: 'reversed', reversedAt: new Date(now), reason })
        .where(where)
        .returning({ id: couponUsages.id })
    return updated.length
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
        SELECT
            u.id AS usageId,
            u.rule_snapshot AS ruleSnapshot,
            c.refund_policy AS refundPolicy
        FROM coupon_usages u
        LEFT JOIN coupons c ON c.id = u.coupon_id
        WHERE u.order_id = ${orderId} AND u.status = 'consumed'
    `)
    return rowsOf(rows)
}
