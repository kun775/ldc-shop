'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { checkAdmin } from '@/actions/admin'
import { recordAuditEvent, recordServerError } from '@/lib/audit/record'
import { markPlatformErrorHandled, reopenPlatformError } from '@/lib/audit/repository'

export type AuditStatusActionResult =
    | { ok: true }
    | { ok: false; errorKey: string; errorId: string }

function revalidateAuditPaths(id: string) {
    revalidatePath('/admin/audit')
    revalidatePath(`/admin/audit/errors/${id}`)
}

export async function markPlatformErrorHandledAction(
    idInput: string,
    noteInput?: string,
): Promise<AuditStatusActionResult> {
    const session = await auth()
    const id = String(idInput || '').trim()
    const note = String(noteInput || '').trim().slice(0, 1000)

    try {
        await checkAdmin()
        if (!id) return { ok: false, errorKey: 'common.error', errorId: '' }

        const changed = await markPlatformErrorHandled({
            id,
            handledBy: session?.user?.username || session?.user?.id || 'admin',
            note: note || null,
        })
        if (!changed) return { ok: false, errorKey: 'common.error', errorId: '' }

        await recordAuditEvent({
            eventName: 'admin.error.handled',
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            targetId: id,
            source: 'admin.audit',
            metadata: { status: 'handled', noteLength: note.length },
        })
        revalidateAuditPaths(id)
        return { ok: true }
    } catch (error) {
        const errorId = await recordServerError('admin.audit.handleError', error, {
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            auditEvent: {
                eventName: 'admin.error.handled',
                actorType: 'admin',
                actorUserId: session?.user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: id || null,
                source: 'admin.audit',
            },
        })
        return { ok: false, errorKey: 'common.error', errorId }
    }
}

export async function reopenPlatformErrorAction(idInput: string): Promise<AuditStatusActionResult> {
    const session = await auth()
    const id = String(idInput || '').trim()

    try {
        await checkAdmin()
        if (!id) return { ok: false, errorKey: 'common.error', errorId: '' }

        const changed = await reopenPlatformError({
            id,
            handledBy: session?.user?.username || session?.user?.id || 'admin',
        })
        if (!changed) return { ok: false, errorKey: 'common.error', errorId: '' }

        await recordAuditEvent({
            eventName: 'admin.error.reopened',
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            targetId: id,
            source: 'admin.audit',
            metadata: { status: 'open' },
        })
        revalidateAuditPaths(id)
        return { ok: true }
    } catch (error) {
        const errorId = await recordServerError('admin.audit.reopenError', error, {
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            auditEvent: {
                eventName: 'admin.error.reopened',
                actorType: 'admin',
                actorUserId: session?.user?.id ?? null,
                actorUsername: session?.user?.username ?? null,
                targetId: id || null,
                source: 'admin.audit',
            },
        })
        return { ok: false, errorKey: 'common.error', errorId }
    }
}
