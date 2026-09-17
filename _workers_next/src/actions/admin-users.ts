'use server'

import { auth } from "@/lib/auth"
import { checkAdmin } from "./admin"
import { applyUserManualPointAdjustment } from "@/lib/points/ledger-db"
import { POINT_ADMIN_ERROR_KEY_MAP } from "@/lib/points/point-errors"
import { revalidatePath } from "next/cache"
import { logServerError, resolveClientErrorKey } from "@/lib/errors/safe-error"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"

/**
 * 后台积分调整结果协议。
 *
 * 为什么显式返回而不是 throw：Server Action 的返回值**不会**被 Next.js
 * 脱敏（只有 throw 才会）。因此这里主动把底层错误收敛成稳定 i18n key +
 * errorId，任何 SQL 原文/绑定参数/表结构都不会到达前台。
 */
export type AdjustUserPointsResult =
    | { ok: true; errorKey: null; errorId: null }
    | { ok: false; errorKey: string; errorId: string }

export async function adjustUserPoints(input: {
    userId: string
    direction: "increase" | "decrease"
    amount: number
    reason: string
}): Promise<AdjustUserPointsResult> {
    const session = await auth()
    try {
        await checkAdmin()

        // userId 缺失时必须在进入账本写入前拦下：否则会插出一条 user_id 为空
        // 的账本记录（外键失败或成为孤儿），错误信息还完全指不到根因。
        const userId = String(input.userId || "").trim()
        if (!userId) {
            await recordAuditEvent({
                eventName: 'admin.points.adjusted',
                result: 'failure',
                actorType: 'admin',
                actorUserId: session?.user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                errorKey: 'admin.users.adjustUserMissing',
                source: 'admin.users',
            })
            return { ok: false, errorKey: "admin.users.adjustUserMissing", errorId: "" }
        }

        await applyUserManualPointAdjustment({
            userId,
            direction: input.direction,
            amount: input.amount,
            reason: input.reason,
            operatorUserId: session?.user?.id ?? null,
            operatorUsername: session?.user?.username ?? null,
            // 业务键必须唯一：同一次点击生成一个键，重复请求由唯一索引拦截并
            // 经 POINT_LEDGER_BUSINESS_KEY_CONFLICT 收敛为可重试文案。
            businessKey: `admin_adjust:${userId}:${Date.now()}`,
        })

        revalidatePath('/admin/users')
        revalidatePath(`/admin/users/${userId}`)
        await recordAuditEvent({
            eventName: 'admin.points.adjusted',
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            targetId: userId,
            source: 'admin.users',
            metadata: {
                direction: input.direction,
                points: input.amount,
                reason: input.reason,
            },
        })
        return { ok: true, errorKey: null, errorId: null }
    } catch (error) {
        const errorKey = resolveClientErrorKey(error, POINT_ADMIN_ERROR_KEY_MAP, 'common.error')
        const errorId = await recordServerError('admin.adjustUserPoints', error, {
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            auditEvent: {
                eventName: 'admin.points.adjusted',
                actorType: 'admin',
                actorUserId: session?.user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: String(input.userId || '').trim() || null,
                errorKey,
                source: 'admin.users',
                metadata: {
                    direction: input.direction,
                    points: input.amount,
                },
            },
        })
        return {
            ok: false,
            errorKey,
            errorId,
        }
    }
}

export async function toggleBlock(userId: string, isBlocked: boolean) {
    try {
        // 延迟导入，避免 Action 初始化阶段加载查询模块。
        const { toggleUserBlock } = await import("@/lib/db/queries")
        await checkAdmin()
        await toggleUserBlock(userId, isBlocked)
        revalidatePath('/admin/users')
        revalidatePath(`/admin/users/${userId}`)
        return { success: true as const }
    } catch (error) {
        const errorId = logServerError('admin.toggleUserBlock', error)
        return { success: false as const, error: 'common.error', errorId }
    }
}
