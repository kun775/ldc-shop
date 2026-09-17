import Link from 'next/link'
import {
    Activity,
    AlertTriangle,
    Bug,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    CircleDot,
    Clock3,
    ExternalLink,
    FilterX,
    Search,
    ShieldCheck,
} from 'lucide-react'
import { AuditErrorStatusButton } from './audit-error-status-button'
import { AdminListPage, AdminListScroll } from './admin-page-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type {
    AuditEventRecord,
    AuditSummary,
    PagedResult,
    PlatformErrorRecord,
} from '@/lib/audit/repository'
import { cn } from '@/lib/utils'

export type AuditView = 'events' | 'errors'

export interface AuditPageFilters {
    view: AuditView
    query: string
    eventName: string
    category: string
    result: string
    severity: string
    status: string
    scope: string
    actorUserId: string
    targetId: string
    errorId: string
    from: string
    to: string
    page: number
    pageSize: number
}

interface AuditContentProps {
    filters: AuditPageFilters
    summary: AuditSummary | null
    eventData: PagedResult<AuditEventRecord> | null
    errorData: PagedResult<PlatformErrorRecord> | null
    eventNames: string[]
    setupRequired?: boolean
    errorId?: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
    auth: '登录认证',
    points: '积分',
    order: '订单',
    refund: '退款',
    coupon: '优惠券',
    admin: '管理员',
}

const RESULT_LABELS: Record<string, string> = {
    success: '成功',
    failure: '失败',
}

const SEVERITY_LABELS: Record<string, string> = {
    info: '信息',
    warning: '警告',
    error: '错误',
    critical: '严重',
}

function formatDateTime(value: number | null) {
    if (!value) return '-'
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(new Date(value))
}

function severityClass(severity: string) {
    switch (severity) {
        case 'critical': return 'border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300'
        case 'error': return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
        case 'warning': return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        default: return 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300'
    }
}

function resultClass(result: string) {
    return result === 'failure'
        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
}

function buildAuditUrl(filters: AuditPageFilters, overrides: Partial<AuditPageFilters> = {}) {
    const next = { ...filters, ...overrides }
    const params = new URLSearchParams()
    params.set('view', next.view)
    const stringFields: Array<keyof AuditPageFilters> = [
        'query', 'eventName', 'category', 'result', 'severity', 'status', 'scope',
        'actorUserId', 'targetId', 'errorId', 'from', 'to',
    ]
    for (const field of stringFields) {
        const value = String(next[field] || '').trim()
        if (value) params.set(field, value)
    }
    if (next.page > 1) params.set('page', String(next.page))
    if (next.pageSize !== 20) params.set('pageSize', String(next.pageSize))
    return `/admin/audit?${params.toString()}`
}

function SummaryMetric({
    icon,
    label,
    value,
    tone,
}: {
    icon: React.ReactNode
    label: string
    value: number
    tone: string
}) {
    return (
        <div className="flex min-w-0 items-center gap-3 px-4 py-3">
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md border', tone)}>{icon}</span>
            <div className="min-w-0">
                <div className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</div>
                <div className="truncate text-[11px] text-muted-foreground">{label}</div>
            </div>
        </div>
    )
}

function AuditFilters({ filters, eventNames }: { filters: AuditPageFilters; eventNames: string[] }) {
    const selectClass = 'h-9 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground'
    return (
        <form action="/admin/audit" method="get" className="space-y-2">
            <input type="hidden" name="view" value={filters.view} />
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-56 flex-1 md:max-w-sm">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        name="query"
                        defaultValue={filters.query}
                        placeholder={filters.view === 'events' ? '搜索用户、目标或错误 ID' : '搜索范围、消息、路径或错误码'}
                        className="h-9 pl-9 text-xs"
                    />
                </div>
                {filters.view === 'events' ? (
                    <>
                        <select name="eventName" defaultValue={filters.eventName} className={selectClass} aria-label="事件类型">
                            <option value="">全部事件</option>
                            {eventNames.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select name="category" defaultValue={filters.category} className={selectClass} aria-label="事件分类">
                            <option value="">全部分类</option>
                            {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <select name="result" defaultValue={filters.result} className={selectClass} aria-label="操作结果">
                            <option value="">全部结果</option>
                            <option value="success">成功</option>
                            <option value="failure">失败</option>
                        </select>
                    </>
                ) : (
                    <>
                        <Input name="scope" defaultValue={filters.scope} placeholder="错误范围" className="h-9 w-40 text-xs" />
                        <select name="status" defaultValue={filters.status} className={selectClass} aria-label="处理状态">
                            <option value="">全部状态</option>
                            <option value="open">未处理</option>
                            <option value="handled">已处理</option>
                        </select>
                    </>
                )}
                <select name="severity" defaultValue={filters.severity} className={selectClass} aria-label="严重级别">
                    <option value="">全部级别</option>
                    {Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select name="pageSize" defaultValue={String(filters.pageSize)} className={selectClass} aria-label="每页条数">
                    <option value="20">20 条/页</option>
                    <option value="50">50 条/页</option>
                    <option value="100">100 条/页</option>
                </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Input name="actorUserId" defaultValue={filters.actorUserId} placeholder="用户 ID" className="h-9 w-44 text-xs" />
                {filters.view === 'events' && (
                    <Input name="targetId" defaultValue={filters.targetId} placeholder="目标 ID" className="h-9 w-44 text-xs" />
                )}
                <Input name="errorId" defaultValue={filters.errorId} placeholder="错误 ID" className="h-9 w-44 text-xs" />
                <Input name="from" type="date" defaultValue={filters.from} aria-label="开始日期" className="h-9 w-40 text-xs" />
                <span className="text-xs text-muted-foreground">至</span>
                <Input name="to" type="date" defaultValue={filters.to} aria-label="结束日期" className="h-9 w-40 text-xs" />
                <Button type="submit" size="sm" className="h-9 gap-1.5 text-xs">
                    <Search className="h-3.5 w-3.5" />
                    筛选
                </Button>
                <Button asChild type="button" variant="ghost" size="sm" className="h-9 gap-1.5 text-xs">
                    <Link href={`/admin/audit?view=${filters.view}`}>
                        <FilterX className="h-3.5 w-3.5" />
                        清除
                    </Link>
                </Button>
            </div>
        </form>
    )
}

function PageFooter({ filters, total }: { filters: AuditPageFilters; total: number }) {
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))
    return total > 0 ? (
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <span>第 {filters.page} / {totalPages} 页 · 共 {total} 条</span>
            <div className="flex items-center gap-2">
                <Button asChild={filters.page > 1} variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={filters.page <= 1}>
                    {filters.page > 1 ? (
                        <Link href={buildAuditUrl(filters, { page: filters.page - 1 })}>
                            <ChevronLeft className="h-3.5 w-3.5" />上一页
                        </Link>
                    ) : <span><ChevronLeft className="mr-1 inline h-3.5 w-3.5" />上一页</span>}
                </Button>
                <span className="rounded-md border border-border/50 bg-muted/40 px-2.5 py-1 font-mono tabular-nums">
                    {filters.page} / {totalPages}
                </span>
                <Button asChild={filters.page < totalPages} variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={filters.page >= totalPages}>
                    {filters.page < totalPages ? (
                        <Link href={buildAuditUrl(filters, { page: filters.page + 1 })}>
                            下一页<ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                    ) : <span>下一页<ChevronRight className="ml-1 inline h-3.5 w-3.5" /></span>}
                </Button>
            </div>
        </div>
    ) : null
}

function EmptyState({ view }: { view: AuditView }) {
    return (
        <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-6 text-center">
            {view === 'events' ? <Activity className="h-8 w-8 text-muted-foreground/50" /> : <ShieldCheck className="h-8 w-8 text-muted-foreground/50" />}
            <p className="text-sm font-medium">当前筛选条件下没有记录</p>
            <p className="max-w-md text-xs text-muted-foreground">调整时间范围或筛选条件后重试。</p>
        </div>
    )
}

function EventTable({ items }: { items: AuditEventRecord[] }) {
    if (!items.length) return <EmptyState view="events" />
    return (
        <Table className="min-w-[1180px] table-fixed">
            <colgroup>
                <col className="w-[170px]" /><col className="w-[210px]" /><col className="w-[90px]" />
                <col className="w-[210px]" /><col className="w-[210px]" /><col className="w-[180px]" />
                <col className="w-[100px]" /><col className="w-[70px]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow>
                    <TableHead>时间</TableHead><TableHead>事件</TableHead><TableHead>结果</TableHead>
                    <TableHead>用户</TableHead><TableHead>目标</TableHead><TableHead>错误 ID</TableHead>
                    <TableHead>级别</TableHead><TableHead className="text-right">详情</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {items.map((item) => (
                    <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{formatDateTime(item.createdAt)}</TableCell>
                        <TableCell>
                            <div className="truncate font-mono text-xs font-medium">{item.eventName}</div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">{CATEGORY_LABELS[item.category] || item.category}</div>
                        </TableCell>
                        <TableCell><Badge variant="outline" className={cn('rounded-md text-[11px]', resultClass(item.result))}>{RESULT_LABELS[item.result] || item.result}</Badge></TableCell>
                        <TableCell>
                            <div className="truncate text-xs">{item.actorUsername || '-'}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{item.actorUserId || item.actorType}</div>
                        </TableCell>
                        <TableCell>
                            <div className="truncate text-xs">{item.targetType || '-'}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{item.targetId || '-'}</div>
                        </TableCell>
                        <TableCell className="truncate font-mono text-[11px] text-muted-foreground">{item.errorId || '-'}</TableCell>
                        <TableCell><Badge variant="outline" className={cn('rounded-md text-[11px]', severityClass(item.severity))}>{SEVERITY_LABELS[item.severity] || item.severity}</Badge></TableCell>
                        <TableCell className="text-right">
                            <Button asChild variant="ghost" size="sm" className="h-8 w-8 p-0" title="查看详情">
                                <Link href={`/admin/audit/events/${encodeURIComponent(item.id)}`} aria-label="查看审计事件详情"><ExternalLink className="h-3.5 w-3.5" /></Link>
                            </Button>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}

function ErrorTable({ items }: { items: PlatformErrorRecord[] }) {
    if (!items.length) return <EmptyState view="errors" />
    return (
        <Table className="min-w-[1320px] table-fixed">
            <colgroup>
                <col className="w-[170px]" /><col className="w-[230px]" /><col className="w-[260px]" />
                <col className="w-[100px]" /><col className="w-[90px]" /><col className="w-[120px]" />
                <col className="w-[200px]" /><col className="w-[150px]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow>
                    <TableHead>最近发生</TableHead><TableHead>范围 / 错误 ID</TableHead><TableHead>错误摘要</TableHead>
                    <TableHead>级别</TableHead><TableHead>次数</TableHead><TableHead>状态</TableHead>
                    <TableHead>请求 / 用户</TableHead><TableHead className="text-right">操作</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {items.map((item) => (
                    <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{formatDateTime(item.lastSeenAt)}</TableCell>
                        <TableCell>
                            <div className="truncate font-mono text-xs font-medium">{item.scope}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{item.errorId || item.id}</div>
                        </TableCell>
                        <TableCell>
                            <div className="line-clamp-2 text-xs leading-5">{item.message || item.errorCode || '无错误摘要'}</div>
                        </TableCell>
                        <TableCell><Badge variant="outline" className={cn('rounded-md text-[11px]', severityClass(item.severity))}>{SEVERITY_LABELS[item.severity] || item.severity}</Badge></TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">{item.occurrenceCount}</TableCell>
                        <TableCell>
                            <Badge variant="outline" className={cn('gap-1 rounded-md text-[11px]', item.status === 'handled' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300')}>
                                {item.status === 'handled' ? <CheckCircle2 className="h-3 w-3" /> : <CircleDot className="h-3 w-3" />}
                                {item.status === 'handled' ? '已处理' : '未处理'}
                            </Badge>
                        </TableCell>
                        <TableCell>
                            <div className="truncate font-mono text-[11px]">{[item.requestMethod, item.requestPath].filter(Boolean).join(' ') || '-'}</div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.actorUsername || item.actorUserId || item.actorType}</div>
                        </TableCell>
                        <TableCell>
                            <div className="flex items-center justify-end gap-1">
                                <AuditErrorStatusButton id={item.id} status={item.status} handleNote={item.handleNote} compact />
                                <Button asChild variant="ghost" size="sm" className="h-8 w-8 p-0" title="查看详情">
                                    <Link href={`/admin/audit/errors/${encodeURIComponent(item.id)}`} aria-label="查看平台错误详情"><ExternalLink className="h-3.5 w-3.5" /></Link>
                                </Button>
                            </div>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}

export function AuditContent({
    filters,
    summary,
    eventData,
    errorData,
    eventNames,
    setupRequired = false,
    errorId = null,
}: AuditContentProps) {
    const currentData = filters.view === 'events' ? eventData : errorData
    const total = currentData?.total || 0
    const paginationFilters = currentData
        ? { ...filters, page: currentData.page, pageSize: currentData.pageSize }
        : filters
    return (
        <AdminListPage
            header={
                <div className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2.5">
                                <ShieldCheck className="h-5 w-5 text-primary" />
                                <h1 className="text-2xl font-bold tracking-tight">审计与错误中心</h1>
                            </div>
                            <p className="text-xs text-muted-foreground">查询用户操作、管理员变更与平台运行错误，原始记录不可修改。</p>
                        </div>
                        <Badge variant="outline" className="rounded-md font-mono text-xs">{total} records</Badge>
                    </div>
                    <div className="grid divide-y divide-border/60 rounded-md border border-border/60 bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
                        <SummaryMetric icon={<Activity className="h-4 w-4" />} label="24 小时操作" value={summary?.eventTotal || 0} tone="border-blue-500/25 bg-blue-500/10 text-blue-600" />
                        <SummaryMetric icon={<AlertTriangle className="h-4 w-4" />} label="24 小时失败" value={summary?.eventFailures || 0} tone="border-amber-500/25 bg-amber-500/10 text-amber-600" />
                        <SummaryMetric icon={<Bug className="h-4 w-4" />} label="未处理错误" value={summary?.openErrors || 0} tone="border-red-500/25 bg-red-500/10 text-red-600" />
                        <SummaryMetric icon={<Clock3 className="h-4 w-4" />} label="错误记录总数" value={summary?.errorTotal || 0} tone="border-border bg-muted/50 text-muted-foreground" />
                    </div>
                    <div className="inline-flex h-9 items-center rounded-md border border-border/70 bg-muted/30 p-1">
                        <Link href={buildAuditUrl(filters, { view: 'events', page: 1 })} className={cn('flex h-7 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors', filters.view === 'events' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                            <Activity className="h-3.5 w-3.5" />用户操作
                        </Link>
                        <Link href={buildAuditUrl(filters, { view: 'errors', page: 1 })} className={cn('flex h-7 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors', filters.view === 'errors' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                            <Bug className="h-3.5 w-3.5" />平台错误
                        </Link>
                    </div>
                </div>
            }
            toolbar={!setupRequired && !errorId ? <AuditFilters filters={filters} eventNames={eventNames} /> : undefined}
            footer={!setupRequired && !errorId ? <PageFooter filters={paginationFilters} total={total} /> : undefined}
        >
            <AdminListScroll>
                {setupRequired ? (
                    <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center">
                        <AlertTriangle className="h-9 w-9 text-amber-500" />
                        <div>
                            <h2 className="text-base font-semibold">审计数据库结构尚未升级</h2>
                            <p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">请先在数据库升级页面执行待升级项。访问审计页面不会自动创建或修改数据库结构。</p>
                        </div>
                        <Button asChild size="sm"><Link href="/admin/database">前往数据库升级</Link></Button>
                    </div>
                ) : errorId ? (
                    <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center">
                        <AlertTriangle className="h-9 w-9 text-red-500" />
                        <div>
                            <h2 className="text-base font-semibold">审计记录加载失败</h2>
                            <p className="mt-1 text-xs text-muted-foreground">错误 ID：<span className="font-mono">{errorId}</span></p>
                        </div>
                        <Button asChild variant="outline" size="sm"><Link href={buildAuditUrl(filters)}>重试</Link></Button>
                    </div>
                ) : filters.view === 'events' ? (
                    <EventTable items={eventData?.items || []} />
                ) : (
                    <ErrorTable items={errorData?.items || []} />
                )}
            </AdminListScroll>
        </AdminListPage>
    )
}
