'use server'

import { revalidatePath } from 'next/cache'
import { checkAdmin } from '@/actions/admin'
import { getDatabaseUpgradeStatus, runPendingDatabaseUpgrades } from '@/lib/db/queries'
import { logServerError } from '@/lib/errors/safe-error'

export async function refreshDatabaseUpgradeStatusAction() {
    try {
        await checkAdmin()
        return {
            success: true as const,
            status: await getDatabaseUpgradeStatus(),
        }
    } catch (error: unknown) {
        const errorId = logServerError('admin.database.refresh', error)
        return { success: false as const, error: 'common.error', errorId }
    }
}

export async function runDatabaseUpgradesAction() {
    try {
        await checkAdmin()
        const { result, status } = await runPendingDatabaseUpgrades()
        revalidatePath('/admin/database')

        if (result.failed) {
            return {
                success: false as const,
                error: 'common.error',
                errorId: result.failed.errorId,
                status,
            }
        }

        return {
            success: true as const,
            appliedCount: result.appliedIds.length,
            status,
        }
    } catch (error: unknown) {
        const errorId = logServerError('admin.database.run', error)
        return { success: false as const, error: 'common.error', errorId }
    }
}
