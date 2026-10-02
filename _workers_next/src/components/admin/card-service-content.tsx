'use client'

import { CARD_SERVICE_MAX_OPERATION_ATTEMPTS } from '@/lib/license-service/operation-queue'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
    AlertTriangle,
    CheckCircle2,
    Copy,
    KeyRound,
    Loader2,
    PackagePlus,
    PlugZap,
    RefreshCw,
    RotateCcw,
    Truck,
    Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
    discardCardServiceFailedAllocationAction,
    loadCardServiceSnapshotAction,
    restockCardServiceProductAction,
    retryCardServiceDeliveryAction,
    retryCardServiceRevokeAction,
    saveCardServiceProgramAction,
    type CardServiceActionResult,
    type CardServiceSnapshot,
} from '@/actions/card-service'
import { AdminPageShell } from '@/components/admin/admin-page-shell'
import { Badge } from '@/components/ui/badge'
import { useConfirm } from '@/components/confirm-dialog-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/lib/i18n/context'
import type {
    CardServiceProductStatus,
    ExpiringAllocationRow,
    PendingOperationDetail,
} from '@/lib/license-service'
import { cn } from '@/lib/utils'

const SELECT_CLASS = 'h-9 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground'

/** 草稿里「接入新商品」这一条用的哨兵键，商品此时还未选择。 */
const NEW_PRODUCT_KEY = '__new__'
const EMPTY_DRAFT: ProductDraft = { productId: '', supplyMode: 'license_service', programKey: '', apiKey: '', targetStock: '' }

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

function formatRemaining(remainingMs: number, overdueLabel: string) {
    const overdue = remainingMs <= 0
    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    const text = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
    return { overdue, text: overdue ? overdueLabel : text, className: overdue ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300' }
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

function MetricCard({ label, value, tone }: { label: string; value: number | string; tone: string }) {
    return (
        <div className={cn('rounded-lg border px-4 py-3', tone)}>
            <div className="text-2xl font-bold tabular-nums">{value}</div>
            <div className="mt-1 text-xs font-medium opacity-75">{label}</div>
        </div>
    )
}

interface ProductDraft {
    productId: string
    supplyMode: string
    programKey: string
    apiKey: string
    targetStock: string
}

function draftForProduct(product: CardServiceProductStatus): ProductDraft {
    return {
        productId: product.productId,
        supplyMode: product.supplyMode,
        programKey: product.programKey ?? '',
        apiKey: '',
        targetStock: product.targetStock === null ? '' : String(product.targetStock),
    }
}

export function CardServiceContent({
    initialSnapshot,
    initialErrorId = null,
}: {
    initialSnapshot: CardServiceSnapshot | null
    initialErrorId?: string | null
}) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const [snapshot, setSnapshot] = useState(initialSnapshot)
    const [pageErrorId, setPageErrorId] = useState(initialErrorId)
    const [refreshing, startRefresh] = useTransition()
    const [taskPending, startTask] = useTransition()
    const [busyKey, setBusyKey] = useState<string | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<Record<string, ProductDraft>>({})
    const [manualOrderId, setManualOrderId] = useState('')

    const overview = snapshot?.overview ?? null
    const review = snapshot?.review ?? null
    const configStatus = snapshot?.configStatus ?? null
    const enabled = (overview?.enabled ?? false) && (snapshot?.credentialStorageReady ?? false)

    const refresh = () => {
        startRefresh(async () => {
            try {
                const next = await loadCardServiceSnapshotAction()
                setSnapshot(next)
                setDrafts({})
                setEditingId(null)
                setPageErrorId(null)
                toast.success(t('admin.cardService.refreshSuccess'))
            } catch (error) {
                console.error('[CardService] refresh failed:', error)
                setPageErrorId('card-service-refresh')
                toast.error(t('admin.cardService.refreshFailed'))
            }
        })
    }

    const runTask = (
        key: string,
        task: () => Promise<CardServiceActionResult>,
        successKey: string,
    ) => {
        setBusyKey(key)
        startTask(async () => {
            try {
                const result = await task()
                if (result.ok) {
                    toast.success(t(successKey))
                } else {
                    toast.error(result.errorId
                        ? `${t(result.errorKey)} · ${result.errorId}`
                        : t(result.errorKey))
                }
                const next = await loadCardServiceSnapshotAction()
                setSnapshot(next)
                if (result.ok) {
                    setDrafts({})
                    setEditingId(null)
                }
            } catch (error) {
                console.error('[CardService] action failed:', error)
                toast.error(t('common.error'))
            } finally {
                setBusyKey(null)
            }
        })
    }

    const startEdit = (product: CardServiceProductStatus) => {
        setDrafts((prev) => ({
            ...prev,
            [product.productId]: prev[product.productId] ?? draftForProduct(product),
        }))
        setEditingId(product.productId)
    }

    const patchDraft = (productId: string, patch: Partial<ProductDraft>) => {
        const product = snapshot?.products.find((item) => item.productId === productId)
        const base = product ? draftForProduct(product) : EMPTY_DRAFT
        setDrafts((prev) => ({
            ...prev,
            [productId]: { ...(prev[productId] ?? base), ...patch },
        }))
    }

    const busy = refreshing || taskPending
    const newDraft: ProductDraft = drafts[NEW_PRODUCT_KEY] ?? EMPTY_DRAFT
    const productOptions = snapshot?.productOptions ?? []
    const selectedProductAvailable = productOptions.some((product) => product.id === newDraft.productId)

    const driftRows: Array<{ key: string; labelKey: string; count: number; mustBeZero: boolean }> = overview
        ? [
            { key: 'sellableRemoteCards', labelKey: 'admin.cardService.drift.sellableRemoteCards', count: overview.drift.sellableRemoteCards, mustBeZero: false },
            { key: 'soldWithoutDeliveredOrder', labelKey: 'admin.cardService.drift.soldWithoutDeliveredOrder', count: overview.drift.soldWithoutDeliveredOrder, mustBeZero: true },
            { key: 'deliveredWithoutRemoteSold', labelKey: 'admin.cardService.drift.deliveredWithoutRemoteSold', count: overview.drift.deliveredWithoutRemoteSold, mustBeZero: true },
            { key: 'expiredWithSellableCards', labelKey: 'admin.cardService.drift.expiredWithSellableCards', count: overview.drift.expiredWithSellableCards, mustBeZero: true },
            { key: 'orphanMappings', labelKey: 'admin.cardService.drift.orphanMappings', count: overview.drift.orphanMappings, mustBeZero: true },
            { key: 'stagedWithoutActiveAllocation', labelKey: 'admin.cardService.drift.stagedWithoutActiveAllocation', count: overview.drift.stagedWithoutActiveAllocation, mustBeZero: true },
        ]
        : []

    return (
        <AdminPageShell className="space-y-5 pb-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                        <PlugZap className="h-5 w-5 text-primary" />
                        <h1 className="text-xl font-bold text-foreground">{t('admin.cardService.title')}</h1>
                    </div>
                    <p className="max-w-3xl text-sm text-muted-foreground">
                        {t('admin.cardService.description')}
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
                    <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                    {t('admin.cardService.refresh')}
                </Button>
            </div>

            {pageErrorId ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2 text-red-700 dark:text-red-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{t('admin.cardService.unavailable')}</span>
                    </div>
                    {pageErrorId === 'card-service-refresh' ? null : <ErrorId value={pageErrorId} />}
                </div>
            ) : null}

            {/* 连接状态：只展示「配没配」，不读取、不展示任何密钥明文。 */}
            <section className="space-y-3 rounded-lg border border-border/60 bg-card px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                        <h2 className="text-sm font-semibold text-foreground">{t('admin.cardService.config.title')}</h2>
                    </div>
                    <Badge
                        variant="outline"
                        className={cn('gap-1.5',
                            !configStatus
                                ? 'text-muted-foreground'
                                : configStatus.configured
                                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300')}
                    >
                        {configStatus?.configured ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                        {!configStatus ? t('admin.cardService.config.unknown') : configStatus.configured ? t('admin.cardService.config.present') : t('admin.cardService.config.missing')}
                    </Badge>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t('admin.cardService.config.description')}</p>

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-border/50 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">{t('admin.cardService.config.baseUrl')}</div>
                        <div className="mt-0.5 break-all font-mono text-xs text-foreground">{!configStatus ? t('admin.cardService.config.unknown') : configStatus.baseUrl ?? t('admin.cardService.config.notSet')}</div>
                    </div>
                    <div className="rounded-md border border-border/50 px-3 py-2">
                        <div className="text-[11px] text-muted-foreground">{t('admin.cardService.config.encryption')}</div>
                        <div className="mt-0.5 text-xs font-medium text-foreground">
                            {!configStatus ? t('admin.cardService.config.unknown') : configStatus.encryptionReady ? t('admin.cardService.config.present') : t('admin.cardService.config.missing')}
                        </div>
                    </div>
                </div>

                {configStatus && configStatus.missing.length > 0 ? (
                    <p className="text-xs text-red-600 dark:text-red-300">
                        {t('admin.cardService.config.missingItems', { items: configStatus.missing.join(', ') })}
                    </p>
                ) : null}
                <p className="text-[11px] text-muted-foreground">{t('admin.cardService.config.secretNote')}</p>
            </section>

            {overview && !overview.enabled ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                    {t('admin.cardService.config.disabled')}
                </div>
            ) : null}

            {/* 待办计数：Ack / Sell / Revoke 三条链路的 pending 与 failed。 */}
            <section className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    <MetricCard
                        label={t('admin.cardService.metrics.pendingAck')}
                        value={overview?.operations.ack.pending ?? '-'}
                        tone="border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                    />
                    <MetricCard
                        label={t('admin.cardService.metrics.pendingSell')}
                        value={overview?.operations.sell.pending ?? '-'}
                        tone="border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300"
                    />
                    <MetricCard
                        label={t('admin.cardService.metrics.pendingRevoke')}
                        value={overview?.operations.revoke.pending ?? '-'}
                        tone="border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300"
                    />
                    <MetricCard
                        label={t('admin.cardService.metrics.failed')}
                        value={overview
                            ? overview.operations.ack.failed + overview.operations.sell.failed + overview.operations.revoke.failed
                            : '-'}
                        tone="border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                    />
                    <MetricCard
                        label={t('admin.cardService.metrics.review')}
                        value={overview?.reviewCount ?? '-'}
                        tone="border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                    />
                </div>
            </section>

            {/* 一致性口径：把「应为 0」与「正常库存」分开呈现。 */}
            <section className="space-y-3">
                <div className="space-y-1">
                    <h2 className="text-sm font-semibold text-foreground">{t('admin.cardService.drift.title')}</h2>
                    <p className="text-xs text-muted-foreground">{t('admin.cardService.drift.description')}</p>
                </div>
                <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                    {driftRows.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t(overview ? 'admin.cardService.config.disabled' : 'admin.cardService.unavailable')}</div>
                    ) : driftRows.map((row) => {
                        const alert = row.mustBeZero && row.count > 0
                        return (
                            <div key={row.key} className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3 last:border-b-0">
                                <div className="min-w-0">
                                    <div className="text-xs font-medium text-foreground">{t(row.labelKey)}</div>
                                    <div className="text-[11px] text-muted-foreground">
                                        {row.mustBeZero ? t('admin.cardService.drift.mustBeZero') : t('admin.cardService.drift.other')}
                                    </div>
                                </div>
                                <Badge
                                    variant="outline"
                                    className={cn('tabular-nums',
                                        alert
                                            ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}
                                >
                                    {row.count}
                                </Badge>
                            </div>
                        )
                    })}
                </div>
            </section>

            {/* 临近 Ack 超窗的分配（本地 expires_at）。 */}
            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-foreground">{t('admin.cardService.expiring.title')}</h2>
                    {overview && overview.overdue.length > 0 ? (
                        <span className="text-xs text-red-600 dark:text-red-300">{overview.overdue.length}</span>
                    ) : null}
                </div>
                <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                    {!overview || overview.expiring.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('admin.cardService.expiring.empty')}</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[640px] text-left text-xs">
                                <thead className="border-b border-border/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                                    <tr>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.allocation')}</th>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.product')}</th>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.program')}</th>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.quantity')}</th>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.expiresAt')}</th>
                                        <th className="px-4 py-2 font-medium">{t('admin.cardService.expiring.remaining')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {overview.expiring.map((row: ExpiringAllocationRow) => {
                                        const remaining = formatRemaining(row.remainingMs, t('admin.cardService.expiring.overdue'))
                                        return (
                                            <tr key={row.allocationId} className="border-b border-border/40 last:border-b-0">
                                                <td className="px-4 py-2 font-mono text-[11px] text-foreground">{row.allocationId}</td>
                                                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">{row.productId}</td>
                                                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">{row.programKey}</td>
                                                <td className="px-4 py-2 tabular-nums text-foreground">{row.quantity}</td>
                                                <td className="px-4 py-2 text-muted-foreground">{formatDateTime(row.expiresAtMs)}</td>
                                                <td className={cn('px-4 py-2 font-medium', remaining.className)}>{remaining.text}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>

            {/* 对账失败清单 + 重试入口。 */}
            <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-foreground">{t('admin.cardService.review.title')}</h2>
                    {review?.truncated ? (
                        <span className="text-xs text-amber-600 dark:text-amber-300">{t('admin.cardService.review.truncated')}</span>
                    ) : null}
                </div>

                <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                    <div className="border-b border-border/50 px-4 py-2 text-xs font-semibold text-foreground">
                        {t('admin.cardService.review.failedOperations')}
                    </div>
                    {!review || !review.enabled ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('admin.cardService.config.disabled')}</div>
                    ) : review.failedOperations.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('admin.cardService.review.empty')}</div>
                    ) : review.failedOperations.map((row: PendingOperationDetail) => {
                        const isSell = row.operation === 'sell'
                        const isRevoke = row.operation === 'revoke'
                        const canDiscard = (isSell || row.operation === 'ack')
                            && row.lastErrorCode === 'not_found'
                            && (row.state === 'failed' || row.state === 'abandoned')
                        const taskKey = `${row.operationKey}`
                        return (
                            <div key={row.operationKey} className="flex flex-col gap-3 border-b border-border/50 px-4 py-3 last:border-b-0 md:flex-row md:items-start md:justify-between">
                                <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300">
                                            {row.operation}
                                        </Badge>
                                        <span className="text-xs font-semibold text-foreground">
                                            {t('admin.cardService.review.state')}：{row.state}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground">
                                            {t('admin.cardService.review.attempts')}：{row.attempts}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                                        <span className="font-mono">{t('admin.cardService.review.resource')}：{row.resourceId}</span>
                                        {row.orderId ? (
                                            <Link href={`/admin/orders/${row.orderId}`} className="font-mono underline-offset-2 hover:underline">
                                                {t('admin.cardService.review.order')}：{row.orderId}
                                            </Link>
                                        ) : null}
                                        {row.lastErrorCode ? <span className="font-mono">{t('admin.cardService.review.lastError')}：{row.lastErrorCode}</span> : null}
                                        {row.requestId ? <span className="font-mono">{t('admin.cardService.review.requestId')}：{row.requestId}</span> : null}
                                    </div>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                    {isSell && row.orderId && row.state !== 'abandoned' && row.lastErrorCode !== 'not_found' && row.attempts < CARD_SERVICE_MAX_OPERATION_ATTEMPTS ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => runTask(
                                                `deliver:${taskKey}`,
                                                () => retryCardServiceDeliveryAction(row.orderId as string),
                                                'admin.cardService.review.retryDeliveryDone',
                                            )}
                                        >
                                            {busyKey === `deliver:${taskKey}`
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <Truck className="h-4 w-4" />}
                                            {t('admin.cardService.review.retryDelivery')}
                                        </Button>
                                    ) : null}
                                    {canDiscard ? (
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            disabled={busy}
                                            onClick={async () => {
                                                const accepted = await confirm({
                                                    title: t('admin.cardService.review.discardTitle'),
                                                    description: t('admin.cardService.review.discardDescription', { allocationId: row.resourceId }),
                                                    variant: 'destructive',
                                                    icon: 'trash',
                                                    confirmText: t('admin.cardService.review.discard'),
                                                    cancelText: t('common.cancel'),
                                                })
                                                if (!accepted) return
                                                runTask(
                                                    `discard:${taskKey}`,
                                                    () => discardCardServiceFailedAllocationAction(row.operationKey),
                                                    'admin.cardService.review.discardDone',
                                                )
                                            }}
                                        >
                                            {busyKey === `discard:${taskKey}`
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <Trash2 className="h-4 w-4" />}
                                            {t('admin.cardService.review.discard')}
                                        </Button>
                                    ) : null}
                                    {isRevoke && row.orderId ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => runTask(
                                                `revoke:${taskKey}`,
                                                () => retryCardServiceRevokeAction({ orderId: row.orderId as string, remoteCardIds: [row.resourceId] }),
                                                'admin.cardService.review.retryRevokeDone',
                                            )}
                                        >
                                            {busyKey === `revoke:${taskKey}`
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <RotateCcw className="h-4 w-4" />}
                                            {t('admin.cardService.review.retryRevoke')}
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* 未出现在失败清单里的待履约订单（Sell 仍是 pending）也能在这里推进。 */}
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card px-4 py-3">
                    <div className="min-w-[240px] flex-1 space-y-1">
                        <div className="text-xs font-medium text-foreground">{t('admin.cardService.retryByOrder.title')}</div>
                        <div className="text-[11px] text-muted-foreground">{t('admin.cardService.retryByOrder.description')}</div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            value={manualOrderId}
                            onChange={(event) => setManualOrderId(event.target.value)}
                            placeholder={t('admin.cardService.retryByOrder.placeholder')}
                            className="h-9 w-56 font-mono text-xs"
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !manualOrderId.trim()}
                            onClick={() => runTask(
                                'manual-deliver',
                                () => retryCardServiceDeliveryAction(manualOrderId.trim()),
                                'admin.cardService.retryByOrder.done',
                            )}
                        >
                            {busyKey === 'manual-deliver' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                            {t('admin.cardService.retryByOrder.submit')}
                        </Button>
                    </div>
                </div>

                {review && review.enabled && (review.staleAllocations.length > 0 || review.orphanMappings.length > 0) ? (
                    <div className="grid gap-3 lg:grid-cols-2">
                        <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                            <div className="border-b border-border/50 px-4 py-2 text-xs font-semibold text-foreground">
                                {t('admin.cardService.review.staleAllocations')}
                            </div>
                            {review.staleAllocations.length === 0 ? (
                                <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t('admin.cardService.review.empty')}</div>
                            ) : review.staleAllocations.map((row: ExpiringAllocationRow) => (
                                <div key={row.allocationId} className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2 text-[11px] last:border-b-0">
                                    <span className="font-mono text-foreground">{row.allocationId}</span>
                                    <span className="font-mono text-muted-foreground">{row.productId}</span>
                                    <span className="tabular-nums text-muted-foreground">{row.quantity}</span>
                                    <span className="text-red-600 dark:text-red-300">{formatDateTime(row.expiresAtMs)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                            <div className="border-b border-border/50 px-4 py-2 text-xs font-semibold text-foreground">
                                {t('admin.cardService.review.orphanMappings')}
                            </div>
                            {review.orphanMappings.length === 0 ? (
                                <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t('admin.cardService.review.empty')}</div>
                            ) : review.orphanMappings.map((row) => (
                                <div key={`${row.localCardId}:${row.remoteCardId}`} className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2 text-[11px] last:border-b-0">
                                    <span className="font-mono text-foreground">{row.localCardId}</span>
                                    <span className="font-mono text-muted-foreground">{row.remoteCardId}</span>
                                    <span className="font-mono text-muted-foreground">{row.state}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </section>

            {snapshot && !snapshot.credentialStorageReady ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                    {t('admin.cardService.errorCredentialStorage')}
                </p>
            ) : null}

            {/* 商品维度：Program 映射、目标库存、库存水位与补货入口。 */}
            <section className="space-y-3">
                <div className="space-y-1">
                    <h2 className="text-sm font-semibold text-foreground">{t('admin.cardService.products.title')}</h2>
                    <p className="text-xs text-muted-foreground">{t('admin.cardService.products.description')}</p>
                    <p className="text-xs text-muted-foreground">{t('admin.cardService.products.salesHint')}</p>
                </div>

                {/* 接入新商品：没有配置行的商品不会出现在下面的列表里，这是唯一的入口。 */}
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card px-4 py-3">
                    <div className="min-w-[220px] flex-1 space-y-1">
                        <div className="text-xs font-medium text-foreground">{t('admin.cardService.products.addTitle')}</div>
                        <div className="text-[11px] text-muted-foreground">{t('admin.cardService.products.addDescription')}</div>
                    </div>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                        <span className="block">{t('admin.cardService.products.selectProduct')}</span>
                        <select
                            className={cn(SELECT_CLASS, 'w-full sm:w-72')}
                            value={newDraft.productId}
                            disabled={busy || !enabled || productOptions.length === 0}
                            onChange={(event) => patchDraft(NEW_PRODUCT_KEY, { productId: event.target.value })}
                        >
                            <option value="">
                                {t(!snapshot
                                    ? 'admin.cardService.products.optionsUnavailable'
                                    : productOptions.length === 0
                                        ? 'admin.cardService.products.noAvailableProducts'
                                        : 'admin.cardService.products.selectProductPlaceholder')}
                            </option>
                            {productOptions.map((product) => (
                                <option key={product.id} value={product.id}>
                                    {product.name} ({product.id})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                        <span className="block">{t('admin.cardService.products.programKey')}</span>
                        <Input
                            className="h-9 w-44 font-mono text-xs"
                            value={newDraft.programKey}
                            placeholder={t('admin.cardService.products.programKeyPlaceholder')}
                            onChange={(event) => patchDraft(NEW_PRODUCT_KEY, { programKey: event.target.value })}
                        />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                        <span className="block">{t('admin.cardService.products.apiKey')}</span>
                        <Input
                            className="h-9 w-52 font-mono text-xs"
                            type="password"
                            autoComplete="new-password"
                            maxLength={4096}
                            value={newDraft.apiKey}
                            placeholder={t('admin.cardService.products.apiKeyPlaceholder')}
                            disabled={busy}
                            onChange={(event) => patchDraft(NEW_PRODUCT_KEY, { apiKey: event.target.value })}
                        />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                        <span className="block">{t('admin.cardService.products.targetStock')}</span>
                        <Input
                            className="h-9 w-28 tabular-nums"
                            value={newDraft.targetStock}
                            placeholder={t('admin.cardService.products.targetStockPlaceholder')}
                            type="number"
                            min={0}
                            max={10000}
                            step={1}
                            onChange={(event) => patchDraft(NEW_PRODUCT_KEY, { targetStock: event.target.value })}
                        />
                    </label>
                    <Button
                        size="sm"
                        disabled={busy || !enabled || !selectedProductAvailable || !newDraft.programKey.trim() || !newDraft.apiKey.trim()}
                        onClick={() => runTask(
                            `save:${NEW_PRODUCT_KEY}`,
                            () => saveCardServiceProgramAction({
                                productId: newDraft.productId.trim(),
                                supplyMode: 'license_service',
                                programKey: newDraft.programKey,
                                apiKey: newDraft.apiKey,
                                targetStock: newDraft.targetStock,
                            }),
                            'admin.cardService.products.added',
                        )}
                    >
                        {busyKey === `save:${NEW_PRODUCT_KEY}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {t('admin.cardService.products.addSubmit')}
                    </Button>
                </div>

                <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
                    {!snapshot || snapshot.products.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t('admin.cardService.products.empty')}</div>
                    ) : snapshot.products.map((product) => {
                        const draft = drafts[product.productId]
                        const isEditing = editingId === product.productId
                        const savedTargetStock = product.targetStock === null ? '' : String(product.targetStock)
                        const targetStock = draft?.targetStock ?? savedTargetStock
                        return (
                            <div key={product.productId} className="border-b border-border/50 px-4 py-3 last:border-b-0">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            {product.productName ? (
                                                <span className="break-words text-sm font-semibold text-foreground">{product.productName}</span>
                                            ) : null}
                                            <span className="break-all font-mono text-xs text-muted-foreground">{t('admin.cardService.products.productId')}：{product.productId}</span>
                                            <Badge variant="outline" className="border-border/60 text-muted-foreground">
                                                {product.supplyMode === 'license_service'
                                                    ? t('admin.cardService.products.supplyModeRemote')
                                                    : t('admin.cardService.products.supplyModeLocal')}
                                            </Badge>
                                            {product.stockExhausted ? (
                                                <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300">
                                                    {t('admin.cardService.products.stockExhausted')}
                                                </Badge>
                                            ) : null}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                                            <span>{t('admin.cardService.products.programKey')}：<span className="font-mono">{product.programKey ?? '-'}</span></span>
                                            <span>{t('admin.cardService.products.apiKey')}：{t(product.apiKeyPresent ? 'admin.cardService.config.present' : 'admin.cardService.config.missing')}</span>
                                            <span>{t('admin.cardService.products.targetStock')}：<span className="tabular-nums">{product.targetStock ?? t('admin.cardService.products.defaultTargetStock')}</span></span>
                                            <span>{t('admin.cardService.products.sold')}：<span className="tabular-nums">{product.soldCount}</span></span>
                                            <span>{t('admin.cardService.products.localSellable')}：<span className="tabular-nums">{product.localSellableCards}</span></span>
                                            <span>{t('admin.cardService.products.remoteSellable')}：<span className="tabular-nums">{product.remoteSellableCards}</span></span>
                                            <span>{t('admin.cardService.products.inFlight')}：<span className="tabular-nums">{product.inFlightAllocations}</span></span>
                                            <span>{t('admin.cardService.metrics.pendingAck')}：<span className="tabular-nums">{product.pendingAck}</span></span>
                                            <span>{t('admin.cardService.metrics.pendingSell')}：<span className="tabular-nums">{product.pendingSell}</span></span>
                                            <span>{t('admin.cardService.metrics.pendingRevoke')}：<span className="tabular-nums">{product.pendingRevoke}</span></span>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap gap-2">
                                        <Button variant="outline" size="sm" disabled={busy} onClick={() => startEdit(product)}>
                                            {t('admin.cardService.products.edit')}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || !enabled || !product.apiKeyPresent}
                                            onClick={() => runTask(
                                                `restock:${product.productId}`,
                                                () => restockCardServiceProductAction(product.productId),
                                                'admin.cardService.products.restocked',
                                            )}
                                        >
                                            {busyKey === `restock:${product.productId}`
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <PackagePlus className="h-4 w-4" />}
                                            {t('admin.cardService.products.restock')}
                                        </Button>
                                    </div>
                                </div>

                                {!isEditing ? (
                                    <div className="mt-3 flex flex-wrap items-end gap-3">
                                        <label className="space-y-1 text-[11px] text-muted-foreground">
                                            <span className="block">{t('admin.cardService.products.targetStock')}</span>
                                            <Input
                                                className="h-9 w-36 tabular-nums"
                                                type="number"
                                                min={0}
                                                max={10000}
                                                step={1}
                                                value={targetStock}
                                                placeholder={t('admin.cardService.products.targetStockPlaceholder')}
                                                disabled={busy}
                                                onChange={(event) => patchDraft(product.productId, { targetStock: event.target.value })}
                                            />
                                        </label>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={busy || targetStock === savedTargetStock}
                                            onClick={() => runTask(
                                                `save-target:${product.productId}`,
                                                () => saveCardServiceProgramAction({
                                                    productId: product.productId,
                                                    supplyMode: product.supplyMode,
                                                    programKey: product.programKey ?? '',
                                                    targetStock,
                                                }),
                                                'admin.cardService.products.saved',
                                            )}
                                        >
                                            {busyKey === `save-target:${product.productId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                            {t('admin.cardService.products.saveTargetStock')}
                                        </Button>
                                        <p className="pb-1 text-[11px] text-muted-foreground">
                                            {t('admin.cardService.products.targetStockHint')}
                                        </p>
                                    </div>
                                ) : null}

                                {isEditing && draft ? (
                                    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-3">
                                        <label className="space-y-1 text-[11px] text-muted-foreground">
                                            <span className="block">{t('admin.cardService.products.supplyMode')}</span>
                                            <select
                                                className={SELECT_CLASS}
                                                value={draft.supplyMode}
                                                onChange={(event) => patchDraft(product.productId, { supplyMode: event.target.value })}
                                            >
                                                <option value="license_service">{t('admin.cardService.products.supplyModeRemote')}</option>
                                                <option value="local">{t('admin.cardService.products.supplyModeLocal')}</option>
                                            </select>
                                        </label>
                                        <label className="space-y-1 text-[11px] text-muted-foreground">
                                            <span className="block">{t('admin.cardService.products.programKey')}</span>
                                            <Input
                                                className="h-9 w-48 font-mono text-xs"
                                                value={draft.programKey}
                                                placeholder={t('admin.cardService.products.programKeyPlaceholder')}
                                                onChange={(event) => patchDraft(product.productId, { programKey: event.target.value })}
                                            />
                                        </label>
                                        <label className="space-y-1 text-[11px] text-muted-foreground">
                                            <span className="block">{t('admin.cardService.products.apiKey')}</span>
                                            <Input
                                                className="h-9 w-52 font-mono text-xs"
                                                type="password"
                                                autoComplete="new-password"
                                                maxLength={4096}
                                                value={draft.apiKey}
                                                placeholder={t(draft.programKey === product.programKey && product.apiKeyPresent
                                                    ? 'admin.cardService.products.apiKeyKeepPlaceholder'
                                                    : 'admin.cardService.products.apiKeyPlaceholder')}
                                                disabled={busy}
                                                onChange={(event) => patchDraft(product.productId, { apiKey: event.target.value })}
                                            />
                                        </label>
                                        <p className="max-w-sm pb-1 text-[11px] text-muted-foreground">{t('admin.cardService.products.apiKeyHint')}</p>
                                        <label className="space-y-1 text-[11px] text-muted-foreground">
                                            <span className="block">{t('admin.cardService.products.targetStock')}</span>
                                            <Input
                                                className="h-9 w-28 tabular-nums"
                                                value={draft.targetStock}
                                                placeholder={t('admin.cardService.products.targetStockPlaceholder')}
                                                type="number"
                                                min={0}
                                                max={10000}
                                                step={1}
                                                onChange={(event) => patchDraft(product.productId, { targetStock: event.target.value })}
                                            />
                                        </label>
                                        <div className="flex gap-2">
                                            <Button
                                                size="sm"
                                                disabled={busy}
                                                onClick={() => runTask(
                                                    `save:${product.productId}`,
                                                    () => saveCardServiceProgramAction({
                                                        productId: product.productId,
                                                        supplyMode: draft.supplyMode,
                                                        programKey: draft.programKey,
                                                        apiKey: draft.apiKey,
                                                        targetStock: draft.targetStock,
                                                    }),
                                                    'admin.cardService.products.saved',
                                                )}
                                            >
                                                {busyKey === `save:${product.productId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                                {t('admin.cardService.products.save')}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={busy}
                                                onClick={() => {
                                                    setEditingId(null)
                                                    setDrafts((prev) => {
                                                        const next = { ...prev }
                                                        delete next[product.productId]
                                                        return next
                                                    })
                                                }}
                                            >
                                                {t('admin.cardService.products.cancel')}
                                            </Button>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}
                </div>
            </section>
        </AdminPageShell>
    )
}
