'use client'

import { useState, useTransition } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Copy, Database, Play, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { refreshDatabaseUpgradeStatusAction, runDatabaseUpgradesAction } from '@/actions/database-upgrades'
import { AdminPageShell } from '@/components/admin/admin-page-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { DatabaseUpgradeItem, DatabaseUpgradeStatus } from '@/lib/db/database-upgrade-registry'
import { cn } from '@/lib/utils'

function formatDateTime(value: number | null) {
    if (!value) return '-'
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(new Date(value))
}

function statusPresentation(item: DatabaseUpgradeItem) {
    if (item.status === 'applied') {
        return { label: '已执行', icon: CheckCircle2, className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
    }
    if (item.status === 'running') {
        return { label: '执行中', icon: Clock3, className: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300' }
    }
    if (item.status === 'failed') {
        return { label: '执行失败', icon: AlertTriangle, className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300' }
    }
    return { label: item.repairRequired ? '需要修复' : '待执行', icon: Clock3, className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' }
}

function ErrorId({ value }: { value: string }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <span className="truncate">{value}</span>
            <button
                type="button"
                className="shrink-0 text-foreground/70 transition-colors hover:text-foreground"
                aria-label="复制错误 ID"
                title="复制错误 ID"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(value)
                        toast.success('错误 ID 已复制')
                    } catch {
                        toast.error('复制失败，请手动选择错误 ID')
                    }
                }}
            >
                <Copy className="h-3.5 w-3.5" />
            </button>
        </span>
    )
}

export function DatabaseUpgradeContent({
    initialStatus,
    initialErrorId = null,
}: {
    initialStatus: DatabaseUpgradeStatus | null
    initialErrorId?: string | null
}) {
    const [status, setStatus] = useState(initialStatus)
    const [pageErrorId, setPageErrorId] = useState(initialErrorId)
    const [refreshing, startRefresh] = useTransition()
    const [running, startRun] = useTransition()

    const refresh = () => {
        startRefresh(async () => {
            const result = await refreshDatabaseUpgradeStatusAction()
            if (!result.success) {
                setPageErrorId(result.errorId)
                toast.error(`刷新失败，错误 ID：${result.errorId}`)
                return
            }
            setStatus(result.status)
            setPageErrorId(null)
            toast.success('数据库升级状态已刷新')
        })
    }

    const run = () => {
        startRun(async () => {
            const result = await runDatabaseUpgradesAction()
            if ('status' in result && result.status) setStatus(result.status)
            if (!result.success) {
                setPageErrorId(result.errorId)
                toast.error(`数据库升级失败，错误 ID：${result.errorId}`)
                return
            }
            setPageErrorId(null)
            toast.success(result.appliedCount > 0 ? `已完成 ${result.appliedCount} 个数据库升级` : '数据库已是最新状态')
        })
    }

    const busy = refreshing || running
    const canRun = !!status && status.pending > 0 && status.running === 0

    return (
        <AdminPageShell className="space-y-5 pb-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                        <Database className="h-5 w-5 text-primary" />
                        <h1 className="text-xl font-bold text-foreground">数据库升级管理</h1>
                    </div>
                    <p className="max-w-3xl text-sm text-muted-foreground">
                        数据库升级仅在管理员点击执行后运行；首页和普通业务请求不会自动迁移。请先检查状态，再手动执行待升级或修复项。
                    </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
                        <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                        刷新状态
                    </Button>
                    <Button size="sm" onClick={run} disabled={!canRun || busy}>
                        <Play className="h-4 w-4" />
                        {running ? '正在升级' : canRun ? '执行待升级项' : '没有待升级项'}
                    </Button>
                </div>
            </div>

            {pageErrorId ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2 text-red-700 dark:text-red-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>数据库状态读取或升级失败，请根据错误 ID 查看 Worker 日志。</span>
                    </div>
                    <ErrorId value={pageErrorId} />
                </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
                {[
                    { label: '总升级数', value: status?.total ?? '-', tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300' },
                    { label: '已执行', value: status?.applied ?? '-', tone: 'border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300' },
                    { label: '待执行', value: status?.pending ?? '-', tone: 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300' },
                ].map((metric) => (
                    <div key={metric.label} className={cn('rounded-lg border px-5 py-4', metric.tone)}>
                        <div className="text-3xl font-bold tabular-nums">{metric.value}</div>
                        <div className="mt-1 text-xs font-medium opacity-75">{metric.label}</div>
                    </div>
                ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/50 py-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    {status?.structureHealthy ? (
                        <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                    )}
                    <span>{status?.structureHealthy ? '结构校验通过' : '结构校验未通过，存在待修复项'}</span>
                </div>
                <span>检查时间：{status ? formatDateTime(status.checkedAt) : '-'}</span>
            </div>

            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-foreground">升级记录</h2>
                    {status && status.failed > 0 ? (
                        <span className="text-xs text-red-600">{status.failed} 个升级执行失败</span>
                    ) : null}
                </div>

                <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                    {!status ? (
                        <div className="px-4 py-12 text-center text-sm text-muted-foreground">数据库升级状态暂不可用</div>
                    ) : status.items.length === 0 ? (
                        <div className="px-4 py-12 text-center text-sm text-muted-foreground">暂无数据库升级记录</div>
                    ) : (
                        status.items.map((item) => {
                            const presentation = statusPresentation(item)
                            const StatusIcon = presentation.icon
                            return (
                                <div key={item.id} className="flex flex-col gap-3 border-b border-border/50 px-4 py-4 last:border-b-0 md:flex-row md:items-start md:justify-between">
                                    <div className="min-w-0 space-y-1.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <code className="max-w-full break-all rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground">
                                                {item.id}
                                            </code>
                                            <span className="text-sm font-semibold text-foreground">{item.name}</span>
                                        </div>
                                        <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{item.description}</p>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                                            <span>执行时间：{formatDateTime(item.executedAt || item.startedAt)}</span>
                                            {item.durationMs !== null ? <span>耗时：{item.durationMs} ms</span> : null}
                                            {item.errorId ? <ErrorId value={item.errorId} /> : null}
                                        </div>
                                        {item.errorMessage ? <p className="text-xs text-red-600 dark:text-red-300">{item.errorMessage}</p> : null}
                                    </div>
                                    <Badge variant="outline" className={cn('gap-1.5 self-start', presentation.className)}>
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {presentation.label}
                                    </Badge>
                                </div>
                            )
                        })
                    )}
                </div>
            </section>
        </AdminPageShell>
    )
}
