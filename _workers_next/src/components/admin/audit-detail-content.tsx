import Link from 'next/link'
import { ArrowLeft, Bug, ShieldCheck } from 'lucide-react'
import { AuditErrorStatusButton } from './audit-error-status-button'
import { AdminPageShell } from './admin-page-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AuditEventRecord, PlatformErrorRecord } from '@/lib/audit/repository'
import { cn } from '@/lib/utils'

function formatDateTime(value: number | null) {
    if (!value) return '-'
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'medium',
        hour12: false,
    }).format(new Date(value))
}

function DetailField({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div className="grid gap-1 border-b border-border/50 py-3 last:border-b-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className={cn('min-w-0 break-words text-sm text-foreground', mono && 'font-mono text-xs')}>{value || '-'}</dd>
        </div>
    )
}

function PrettyJson({ value }: { value: string | null }) {
    if (!value) return <span>-</span>
    let output = value
    try {
        output = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
        // 已是脱敏文本，直接展示。
    }
    return <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/35 p-3 font-mono text-xs leading-5">{output}</pre>
}

function DetailHeader({
    title,
    description,
    backHref,
    icon,
    action,
}: {
    title: string
    description: string
    backHref: string
    icon: React.ReactNode
    action?: React.ReactNode
}) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
            <div className="flex min-w-0 items-start gap-3">
                <Button asChild variant="ghost" size="sm" className="mt-0.5 h-8 w-8 shrink-0 p-0" title="返回列表">
                    <Link href={backHref} aria-label="返回审计列表"><ArrowLeft className="h-4 w-4" /></Link>
                </Button>
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        {icon}
                        <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
            </div>
            {action}
        </div>
    )
}

export function AuditEventDetailContent({ event }: { event: AuditEventRecord }) {
    return (
        <AdminPageShell className="mx-auto w-full max-w-5xl gap-4">
            <DetailHeader
                title={event.eventName}
                description="只读审计事件详情"
                backHref="/admin/audit?view=events"
                icon={<ShieldCheck className="h-5 w-5 text-primary" />}
            />
            <div className="rounded-md border border-border/60 bg-card px-4 sm:px-5">
                <dl>
                    <DetailField label="事件 ID" value={event.id} mono />
                    <DetailField label="发生时间" value={formatDateTime(event.createdAt)} mono />
                    <DetailField label="分类 / 级别" value={<div className="flex gap-2"><Badge variant="outline">{event.category}</Badge><Badge variant="outline">{event.severity}</Badge></div>} />
                    <DetailField label="结果" value={<Badge variant="outline" className={event.result === 'failure' ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}>{event.result}</Badge>} />
                    <DetailField label="操作人类型" value={event.actorType} />
                    <DetailField label="操作人" value={event.actorUsername || '-'} />
                    <DetailField label="用户 ID" value={event.actorUserId || '-'} mono />
                    <DetailField label="目标类型" value={event.targetType || '-'} />
                    <DetailField label="目标 ID" value={event.targetId || '-'} mono />
                    <DetailField label="错误 ID" value={event.errorId || '-'} mono />
                    <DetailField label="错误键" value={event.errorKey || '-'} mono />
                    <DetailField label="来源" value={event.source || '-'} mono />
                    <DetailField label="脱敏元数据" value={<PrettyJson value={event.metadata} />} />
                </dl>
            </div>
        </AdminPageShell>
    )
}

export function PlatformErrorDetailContent({ error }: { error: PlatformErrorRecord }) {
    return (
        <AdminPageShell className="mx-auto w-full max-w-6xl gap-4">
            <DetailHeader
                title={error.scope}
                description="平台错误详情与处理状态"
                backHref="/admin/audit?view=errors"
                icon={<Bug className="h-5 w-5 text-red-500" />}
                action={<AuditErrorStatusButton id={error.id} status={error.status} handleNote={error.handleNote} />}
            />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
                <div className="rounded-md border border-border/60 bg-card px-4 sm:px-5">
                    <dl>
                        <DetailField label="记录 ID" value={error.id} mono />
                        <DetailField label="用户错误 ID" value={error.errorId || '-'} mono />
                        <DetailField label="错误指纹" value={error.fingerprint} mono />
                        <DetailField label="错误码" value={error.errorCode || '-'} mono />
                        <DetailField label="错误消息" value={error.message || '-'} />
                        <DetailField label="错误链" value={error.errorChain || '-'} mono />
                        <DetailField label="脱敏堆栈" value={error.stack ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/35 p-3 font-mono text-xs leading-5">{error.stack}</pre> : '-'} />
                    </dl>
                </div>
                <div className="rounded-md border border-border/60 bg-card px-4 sm:px-5">
                    <dl>
                        <DetailField label="严重级别" value={<Badge variant="outline">{error.severity}</Badge>} />
                        <DetailField label="处理状态" value={<Badge variant="outline" className={error.status === 'handled' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}>{error.status === 'handled' ? '已处理' : '未处理'}</Badge>} />
                        <DetailField label="发生次数" value={String(error.occurrenceCount)} mono />
                        <DetailField label="首次发生" value={formatDateTime(error.firstSeenAt)} mono />
                        <DetailField label="最近发生" value={formatDateTime(error.lastSeenAt)} mono />
                        <DetailField label="请求" value={[error.requestMethod, error.requestPath].filter(Boolean).join(' ') || '-'} mono />
                        <DetailField label="操作人类型" value={error.actorType} />
                        <DetailField label="操作人" value={error.actorUsername || error.actorUserId || '-'} />
                        <DetailField label="User-Agent" value={error.userAgent || '-'} mono />
                        <DetailField label="处理时间" value={formatDateTime(error.handledAt)} mono />
                        <DetailField label="处理人" value={error.handledBy || '-'} />
                        <DetailField label="处理说明" value={error.handleNote || '-'} />
                    </dl>
                </div>
            </div>
        </AdminPageShell>
    )
}
