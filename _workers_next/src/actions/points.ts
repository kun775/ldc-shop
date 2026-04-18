'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { loginUsers } from "@/lib/db/schema"
import { ensureLoginUsersSchema, getSetting } from "@/lib/db/queries"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"

export async function checkIn() {
    const session = await auth()
    if (!session?.user?.id) {
        return { success: false, error: "Not logged in" }
    }

    // 0. Check if feature is enabled
    const enabledStr = await getSetting('checkin_enabled')
    if (enabledStr === 'false') {
        return { success: false, error: "Check-in is currently disabled" }
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
            return { success: false, error: "Already checked in today" }
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
        console.error("Check-in error:", error)
        return { success: false, error: `Check-in failed: ${error?.message || 'Unknown error'}` }
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
