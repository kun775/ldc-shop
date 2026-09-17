import { unstable_noStore } from 'next/cache'
import { notFound, redirect } from 'next/navigation'
import { checkAdmin } from '@/actions/admin'
import { AuditEventDetailContent } from '@/components/admin/audit-detail-content'
import { readAuditEvent } from '@/lib/audit/repository'
import { recordServerError } from '@/lib/audit/record'

export default async function AuditEventDetailPage(props: { params: Promise<{ id: string }> }) {
    unstable_noStore()
    await checkAdmin()
    const { id } = await props.params

    let event
    try {
        event = await readAuditEvent(id)
    } catch (error) {
        if (String((error as { message?: unknown })?.message || '').includes('AUDIT_INFRASTRUCTURE_NOT_READY')) {
            redirect('/admin/audit?view=events')
        }
        const errorId = await recordServerError('admin.audit.eventDetail', error, { actorType: 'admin' })
        throw new Error(`AUDIT_EVENT_DETAIL_LOAD_FAILED:${errorId}`)
    }

    if (!event) notFound()
    return <AuditEventDetailContent event={event} />
}
