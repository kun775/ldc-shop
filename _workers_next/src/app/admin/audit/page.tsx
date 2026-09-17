import { unstable_noStore } from 'next/cache'
import { checkAdmin } from '@/actions/admin'
import { AuditContent, type AuditPageFilters, type AuditView } from '@/components/admin/audit-content'
import {
    readAuditEventNameOptions,
    readAuditEvents,
    readAuditSummary,
    readPlatformErrors,
} from '@/lib/audit/repository'
import { recordServerError } from '@/lib/audit/record'

function firstParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] || '') : (value || '')
}

function positiveInt(value: string, fallback: number, max: number) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function parseDateBoundary(value: string, endOfDay = false): number | undefined {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000'
    const parsed = Date.parse(`${value}T${time}+08:00`)
    return Number.isFinite(parsed) ? parsed : undefined
}

function parseFilters(searchParams: Record<string, string | string[] | undefined>): AuditPageFilters {
    const viewInput = firstParam(searchParams.view)
    const view: AuditView = viewInput === 'errors' ? 'errors' : 'events'
    const pageSizeInput = positiveInt(firstParam(searchParams.pageSize), 20, 100)
    const pageSize = [20, 50, 100].includes(pageSizeInput) ? pageSizeInput : 20

    return {
        view,
        query: firstParam(searchParams.query).trim().slice(0, 120),
        eventName: firstParam(searchParams.eventName).trim().slice(0, 120),
        category: firstParam(searchParams.category).trim().slice(0, 40),
        result: firstParam(searchParams.result).trim().slice(0, 20),
        severity: firstParam(searchParams.severity).trim().slice(0, 20),
        status: firstParam(searchParams.status).trim().slice(0, 20),
        scope: firstParam(searchParams.scope).trim().slice(0, 80),
        actorUserId: firstParam(searchParams.actorUserId).trim().slice(0, 120),
        targetId: firstParam(searchParams.targetId).trim().slice(0, 120),
        errorId: firstParam(searchParams.errorId).trim().slice(0, 80),
        from: firstParam(searchParams.from).trim(),
        to: firstParam(searchParams.to).trim(),
        page: positiveInt(firstParam(searchParams.page), 1, 100000),
        pageSize,
    }
}

function isAuditSetupRequired(error: unknown) {
    return String((error as { message?: unknown })?.message || '').includes('AUDIT_INFRASTRUCTURE_NOT_READY')
}

export default async function AdminAuditPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    unstable_noStore()
    await checkAdmin()

    const filters = parseFilters(await props.searchParams)
    let summary = null
    let eventData = null
    let errorData = null
    let eventNames: string[] = []
    let setupRequired = false
    let errorId: string | null = null

    try {
        const common = {
            page: filters.page,
            pageSize: filters.pageSize,
            query: filters.query,
            severity: filters.severity,
            actorUserId: filters.actorUserId,
            errorId: filters.errorId,
            from: parseDateBoundary(filters.from),
            to: parseDateBoundary(filters.to, true),
        }

        if (filters.view === 'events') {
            [summary, eventNames, eventData] = await Promise.all([
                readAuditSummary(),
                readAuditEventNameOptions(),
                readAuditEvents({
                    ...common,
                    eventName: filters.eventName,
                    category: filters.category,
                    result: filters.result,
                    targetId: filters.targetId,
                }),
            ])
        } else {
            [summary, eventNames, errorData] = await Promise.all([
                readAuditSummary(),
                readAuditEventNameOptions(),
                readPlatformErrors({
                    ...common,
                    scope: filters.scope,
                    status: filters.status,
                }),
            ])
        }
    } catch (error) {
        if (isAuditSetupRequired(error)) {
            setupRequired = true
        } else {
            errorId = await recordServerError('admin.audit.list', error, {
                actorType: 'admin',
            })
        }
    }

    return (
        <AuditContent
            filters={filters}
            summary={summary}
            eventData={eventData}
            errorData={errorData}
            eventNames={eventNames}
            setupRequired={setupRequired}
            errorId={errorId}
        />
    )
}
