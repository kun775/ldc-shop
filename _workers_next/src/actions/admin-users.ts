'use server'

import { auth } from "@/lib/auth"
import { checkAdmin } from "./admin"
import { applyUserManualPointAdjustment } from "@/lib/points/ledger-db"
import { revalidatePath } from "next/cache"
import { logServerError, resolveClientErrorKey } from "@/lib/errors/safe-error"

const ADMIN_USER_POINT_ERROR_KEY_MAP: Record<string, string> = {
    POINT_REASON_REQUIRED: "admin.users.adjustReasonRequired",
    POINT_AMOUNT_INVALID: "admin.users.adjustAmountInvalid",
    POINT_BALANCE_NEGATIVE: "admin.users.adjustNegativeNotAllowed",
    POINT_LEDGER_CLAIM_FAILED: "common.error",
    POINT_LEDGER_CLAIM_LOST: "common.error",
    POINT_LEDGER_BUSINESS_KEY_CONFLICT: "common.error",
    POINT_LEDGER_EVENT_IN_PROGRESS: "common.error",
}

export async function adjustUserPoints(input: {
    userId: string
    direction: "increase" | "decrease"
    amount: number
    reason: string
}) {
    try {
        const session = await auth()
        await checkAdmin()

        await applyUserManualPointAdjustment({
            userId: input.userId,
            direction: input.direction,
            amount: input.amount,
            reason: input.reason,
            operatorUserId: session?.user?.id ?? null,
            operatorUsername: session?.user?.username ?? null,
            businessKey: `admin_adjust:${input.userId}:${Date.now()}`,
        })

        revalidatePath('/admin/users')
        revalidatePath(`/admin/users/${input.userId}`)
        return { success: true as const }
    } catch (error) {
        const errorId = logServerError('admin.adjustUserPoints', error)
        return {
            success: false as const,
            error: resolveClientErrorKey(error, ADMIN_USER_POINT_ERROR_KEY_MAP, 'common.error'),
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
