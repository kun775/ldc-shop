'use server'

import { auth } from "@/lib/auth"
import { updateLoginUserEmail, updateLoginUserDesktopNotificationsEnabled, updateLoginUserNickname } from "@/lib/db/queries"
import { validateNickname } from "@/lib/nickname"
import { revalidatePath } from "next/cache"

function isValidEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function updateProfileEmail(emailInput: string) {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: 'common.error' }
    }

    const email = (emailInput || '').trim()
    if (email && !isValidEmail(email)) {
        return { success: false, error: 'profile.emailInvalid' }
    }

    try {
        await updateLoginUserEmail(userId, email || null)
        revalidatePath('/profile')
        return { success: true }
    } catch (error) {
        console.error('[Profile] updateProfileEmail failed:', error)
        return { success: false, error: 'common.error' }
    }
}

export async function updateProfileNickname(nicknameInput: string) {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) return { success: false, error: 'common.error' }

    const validation = validateNickname(nicknameInput)
    if (!validation.ok) return { success: false, error: validation.error }

    try {
        await updateLoginUserNickname(userId, validation.nickname)
        revalidatePath('/profile')
        revalidatePath('/')
        revalidatePath('/wishlist')
        return { success: true, nickname: validation.nickname }
    } catch (error) {
        console.error('[Profile] updateProfileNickname failed:', error)
        return { success: false, error: 'common.error' }
    }
}

export async function updateDesktopNotifications(enabled: boolean) {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: 'common.error' }
    }
    try {
        await updateLoginUserDesktopNotificationsEnabled(userId, Boolean(enabled))
        return { success: true }
    } catch {
        return { success: false, error: 'common.error' }
    }
}
