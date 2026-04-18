'use server'

import { auth } from "@/lib/auth"
import { checkAdmin } from "./admin"
import { applyUserManualPointAdjustment } from "@/lib/points/ledger-db"
import { revalidatePath } from "next/cache"

export async function adjustUserPoints(input: {
    userId: string
    direction: "increase" | "decrease"
    amount: number
    reason: string
}) {
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
}

export async function toggleBlock(userId: string, isBlocked: boolean) {
    // Lazy import to avoid circular dependency if possible, but queries is fine
    const { toggleUserBlock } = await import("@/lib/db/queries")
    await checkAdmin()
    await toggleUserBlock(userId, isBlocked)
    revalidatePath('/admin/users')
    revalidatePath(`/admin/users/${userId}`)
}
