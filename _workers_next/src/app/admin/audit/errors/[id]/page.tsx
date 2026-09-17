import { unstable_noStore } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { checkAdmin } from '@/actions/admin'
import { PlatformErrorDetailContent } from '@/components/admin/audit-detail-content'
import { readPlatformError } from '@/lib/audit/repository'
import { recordServerError } from '@/lib/audit/record'

export default async function PlatformErrorDetailPage(props: { params: Promise<{ id: string }> }) {
    unstable_noStore()
    await checkAdmin()
    const { id } = await props.params

    let errorRecord
    try {
        errorRecord = await readPlatformError(id)
    } catch (error) {
        if (String((error as { message?: unknown })?.message || '').includes('AUDIT_INFRASTRUCTURE_NOT_READY')) {
            redirect('/admin/audit?view=errors')
        }
        const errorId = await recordServerError('admin.audit.errorDetail', error, { actorType: 'admin' })
        throw new Error(`AUDIT_ERROR_DETAIL_LOAD_FAILED:${errorId}`)
    }

    if (!errorRecord) notFound()
    return <PlatformErrorDetailContent error={errorRecord} />
}
