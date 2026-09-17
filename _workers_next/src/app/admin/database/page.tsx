import { unstable_noStore } from 'next/cache'
import { DatabaseUpgradeContent } from '@/components/admin/database-upgrade-content'
import { ensureDatabaseInitialized, getDatabaseUpgradeStatus } from '@/lib/db/queries'
import { logServerError } from '@/lib/errors/safe-error'

export default async function AdminDatabasePage() {
    unstable_noStore()

    let initialStatus = null
    let initialErrorId: string | null = null

    try {
        await ensureDatabaseInitialized()
    } catch (error: unknown) {
        initialErrorId = logServerError('admin.database.page', error)
    }

    try {
        initialStatus = await getDatabaseUpgradeStatus()
    } catch (error: unknown) {
        initialErrorId ||= logServerError('admin.database.status', error)
    }

    return <DatabaseUpgradeContent initialStatus={initialStatus} initialErrorId={initialErrorId} />
}
