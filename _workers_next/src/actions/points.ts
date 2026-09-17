'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { loginUsers } from "@/lib/db/schema"
import { ensureLoginUsersSchema, getSetting } from "@/lib/db/queries"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { createErrorId, logServerError, resolveClientErrorKey } from "@/lib/errors/safe-error"

/**
 * 积分账本内部错误码 → 面向用户的 checkin.* 文案 key。
 * 未命中的错误一律退化为 checkin.failed，避免任何内部信息（SQL 原文、
 * 绑定参数、表结构）通过返回值泄漏到前台。
 */
const CHECKIN_ERROR_KEY_MAP: Record<string, string> = {
    POINT_LEDGER_EVENT_IN_PROGRESS: "checkin.inProgress",
    POINT_LEDGER_CLAIM_FAILED: "checkin.failed",
    POINT_LEDGER_CLAIM_LOST: "checkin.failed",
    POINT_LEDGER_BUSINESS_KEY_CONFLICT: "checkin.alreadyCheckedIn",
    POINT_BALANCE_NEGATIVE: "checkin.balanceNegative",
    insufficient_points: "checkin.balanceNegative",
}

export async function checkIn() {
    const session = await auth()
    if (!session?.user?.id) {
        return { success: false, error: "checkin.loginRequired" }
    }

    // 0. Check if feature is enabled
    const enabledStr = await getSetting('checkin_enabled')
    if (enabledStr === 'false') {
        return { success: false, error: "checkin.disabled" }
    }

    const userId = session.user.id

    try {
        await ensureLoginUsersSchema()
        await ensurePointLedgerUserRecord({
            userId,
            username: session.user.username ?? null,
            email: session.user.email ?? null,
        })

        const nowMs = Date.now()
        const nowDate = new Date(nowMs)
        const todayStartUtcMs = Date.UTC(
            nowDate.getUTCFullYear(),
            nowDate.getUTCMonth(),
            nowDate.getUTCDate()
        )
        const yesterdayStartUtcMs = todayStartUtcMs - 86400000

        // 2. Get Reward Amount
        const rewardStr = await getSetting('checkin_reward')
        const reward = parseInt(rewardStr || '10', 10)
        const existingUser = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, userId),
            columns: {
                username: true,
                email: true,
                lastCheckinAt: true,
                consecutiveDays: true,
            }
        })
        const businessKey = `checkin_reward:${userId}:${todayStartUtcMs}`

        // 3. Perform Check-in & Award Points (atomic guard in DB)
        const updated = await db.update(loginUsers)
            .set({
                lastCheckinAt: new Date(nowMs),
                consecutiveDays: sql`CASE 
                    WHEN ${loginUsers.lastCheckinAt} IS NOT NULL 
                        AND ${loginUsers.lastCheckinAt} >= ${yesterdayStartUtcMs}
                        AND ${loginUsers.lastCheckinAt} < ${todayStartUtcMs}
                    THEN COALESCE(${loginUsers.consecutiveDays}, 0) + 1
                    ELSE 1
                END`
            })
            .where(and(
                eq(loginUsers.userId, userId),
                or(
                    isNull(loginUsers.lastCheckinAt),
                    lt(loginUsers.lastCheckinAt, new Date(todayStartUtcMs))
                )
            ))
            .returning({ consecutiveDays: loginUsers.consecutiveDays });

        if (!updated.length) {
            return { success: false, error: "checkin.alreadyCheckedIn" }
        }

        try {
            await applyUserAutomaticPointEvent({
                userId,
                username: existingUser?.username ?? session.user.username ?? null,
                email: existingUser?.email ?? session.user.email ?? null,
                eventType: "checkin_reward",
                delta: reward,
                businessKey,
                sourceType: "checkin",
                sourceId: new Date(todayStartUtcMs).toISOString().slice(0, 10),
                reason: "每日签到奖励",
                metadata: JSON.stringify({
                    consecutiveDays: updated[0]?.consecutiveDays ?? 1,
                }),
            })
        } catch (ledgerError: any) {
            await db.update(loginUsers)
                .set({
                    lastCheckinAt: existingUser?.lastCheckinAt ?? null,
                    consecutiveDays: existingUser?.consecutiveDays ?? 0,
                })
                .where(eq(loginUsers.userId, userId))

            throw ledgerError
        }

        revalidatePath('/')
        revalidatePath('/admin/users')
        revalidatePath(`/admin/users/${userId}`)
        return { success: true, points: reward, consecutiveDays: updated[0]?.consecutiveDays ?? 1 }
    } catch (error: any) {
        const errorId = logServerError('checkin', error)
        const errorKey = resolveClientErrorKey(error, CHECKIN_ERROR_KEY_MAP, "checkin.failed")
        return { success: false, error: errorKey, errorId }
    }
}

export async function getUserPoints() {
    const session = await auth()
    if (!session?.user?.id) return 0

    const user = await db.query.loginUsers.findFirst({
        where: eq(loginUsers.userId, session.user.id),
        columns: { points: true }
    })

    return user?.points || 0
}

export async function getCheckinStatus() {
    const session = await auth()
    if (!session?.user?.id) return { checkedIn: false }

    const enabledStr = await getSetting('checkin_enabled')
    if (enabledStr === 'false') {
        return { checkedIn: false, disabled: true }
    }

    try {
        await ensureLoginUsersSchema()
        const user = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, session.user.id),
            columns: { lastCheckinAt: true }
        })

        if (!user || !user.lastCheckinAt) {
            return { checkedIn: false }
        }

        const lastCheckinDate = new Date(user.lastCheckinAt).toISOString().split('T')[0];
        const todayDate = new Date().toISOString().split('T')[0];

        return { checkedIn: lastCheckinDate === todayDate }
    } catch (error: any) {
        console.error('[CheckinStatus] Error:', error?.message)
        return { checkedIn: false }
    }
}
