'use client'

import { useEffect, useMemo, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { RefundButton } from "@/components/admin/refund-button"
import { CopyButton } from "@/components/copy-button"
import { ClientDate } from "@/components/client-date"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { AdminOrderActions } from "@/components/admin/order-actions"
import { deleteOrders } from "@/actions/admin-orders"
import { toast } from "sonner"
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"
import { parseCheckoutFieldValues } from "@/lib/checkout-fields"
import { isManualFulfillment } from "@/lib/fulfillment"
import { cn } from "@/lib/utils"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"
import {
    Search,
    RotateCcw,
    CheckCircle2,
    Clock,
    XCircle,
    PackageCheck,
    Zap,
    Download,
    Trash2,
    ArrowUpRight,
    RefreshCw,
    Inbox,
    User,
    FileSpreadsheet,
    FileText,
    ChevronLeft,
    ChevronRight,
    PackageOpen,
    Loader2,
} from "lucide-react"

interface Order {
    orderId: string
    productId?: string | null
    userId: string | null
    username: string | null
    email: string | null
    productName: string
    amount: string
    pointsUsed: number
    status: string | null
    cardKey: string | null
    tradeNo: string | null
    createdAt: Date | null
    paidAt?: Date | null
    deliveredAt?: Date | null
    checkoutFieldValues?: string | null
    fulfillmentMode?: string | null
}

function buildUrl(params: Record<string, string | number | undefined | null>) {
    const sp = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
        if (v === undefined || v === null) return
        const str = String(v).trim()
        if (!str) return
        sp.set(k, str)
    })
    const qs = sp.toString()
    return qs ? `/admin/orders?${qs}` : '/admin/orders'
}

function exportUrl(params: Record<string, string | number | undefined | null>) {
    const sp = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
        if (v === undefined || v === null) return
        const str = String(v).trim()
        if (!str) return
        sp.set(k, str)
    })
    return `/admin/data/download?${sp.toString()}`
}

export function AdminOrdersContent({
    orders,
    total,
    page,
    pageSize,
    query,
    status,
    productVariantLabels = {},
}: {
    orders: Order[]
    total: number
    page: number
    pageSize: number
    query: string
    status: string
    productVariantLabels?: Record<string, string | null>
}) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const router = useRouter()
    const [queryValue, setQueryValue] = useState(query || "")
    const [statusValue, setStatusValue] = useState<string>(status || "all")
    const [selected, setSelected] = useState<Record<string, boolean>>({})
    const [deleting, setDeleting] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const deleteLock = useRef(false)

    useEffect(() => {
        setQueryValue(query || "")
    }, [query])

    useEffect(() => {
        setStatusValue(status || "all")
    }, [status])

    useEffect(() => {
        setSelected({})
    }, [orders, page, status, query])

    const statusOptions = [
        { key: 'all', label: t('common.all'), icon: <Inbox className="h-3.5 w-3.5" /> },
        { key: 'pending', label: t('order.status.pending'), icon: <Clock className="h-3.5 w-3.5 text-amber-500" /> },
        { key: 'paid', label: t('order.status.paid'), icon: <PackageCheck className="h-3.5 w-3.5 text-blue-500" /> },
        { key: 'delivered', label: t('order.status.delivered'), icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> },
        { key: 'refunded', label: t('order.status.refunded'), icon: <RotateCcw className="h-3.5 w-3.5 text-purple-500" /> },
        { key: 'cancelled', label: t('order.status.cancelled'), icon: <XCircle className="h-3.5 w-3.5 text-muted-foreground" /> },
    ]

    const getStatusConfig = (status: string | null) => {
        switch (status) {
            case 'delivered':
                return {
                    label: t('order.status.delivered'),
                    badgeClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
                    icon: <CheckCircle2 className="h-3 w-3" />
                }
            case 'paid':
                return {
                    label: t('order.status.paid'),
                    badgeClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
                    icon: <PackageCheck className="h-3 w-3" />
                }
            case 'refunded':
                return {
                    label: t('order.status.refunded'),
                    badgeClass: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
                    icon: <RotateCcw className="h-3 w-3" />
                }
            case 'cancelled':
                return {
                    label: t('order.status.cancelled'),
                    badgeClass: "bg-muted text-muted-foreground border-border/50",
                    icon: <XCircle className="h-3 w-3" />
                }
            case 'pending':
            default:
                return {
                    label: t('order.status.pending'),
                    badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
                    icon: <Clock className="h-3 w-3" />
                }
        }
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const canPrev = page > 1
    const canNext = page < totalPages
    const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1
    const showingTo = Math.min(page * pageSize, total)

    const applyFilters = (next: { q?: string; status?: string; page?: number }) => {
        router.push(buildUrl({
            q: next.q ?? queryValue,
            status: next.status ?? statusValue,
            page: next.page ?? 1,
            pageSize,
        }))
    }

    const applyAllFilters = (next: { q?: string; status?: string; page?: number; pageSize?: number }) => {
        const nextStatus = next.status ?? statusValue
        router.push(buildUrl({
            q: next.q ?? queryValue,
            status: nextStatus,
            page: next.page ?? 1,
            pageSize: next.pageSize ?? pageSize,
        }))
    }

    const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected])
    const allOnPageSelected = orders.length > 0 && selectedIds.length === orders.length

    const handleBatchDelete = async () => {
        if (deleteLock.current || !selectedIds.length) return
        const ok = await confirm({
            title: t('admin.orders.batchDelete') || "批量删除订单",
            description: t('admin.orders.confirmDeleteSelected'),
            variant: "destructive",
            icon: "trash",
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return
        deleteLock.current = true
        setDeleting(true)
        try {
            await deleteOrders(selectedIds)
            toast.success(t('common.success'))
            setSelected({})
            router.refresh()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setDeleting(false)
            deleteLock.current = false
        }
    }

    const handleRefresh = async () => {
        setRefreshing(true)
        router.refresh()
        setTimeout(() => setRefreshing(false), 500)
    }

    return (
        <AdminListPage
            header={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('admin.orders.title')}</h1>
                        <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5 rounded-md font-normal text-muted-foreground bg-muted/80 border border-border/40">
                            {total}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        全站订单流水、支付状态核验、卡密与人工交付管理
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground border-border/80"
                        title="刷新订单列表"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                        <span>{t('admin.orders.refresh') || '刷新'}</span>
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs border-border/80">
                                <Download className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>{t('admin.orders.exportCsv')}</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem asChild>
                                <a href={exportUrl({ type: 'orders', format: 'csv', q: query, status })} className="flex items-center gap-2 cursor-pointer text-xs">
                                    <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                                    <span>{t('admin.orders.exportStandard') || '导出当前筛选（标准）'}</span>
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <a href={exportUrl({ type: 'orders', format: 'csv', includeSecrets: 1, q: query, status })} className="flex items-center gap-2 cursor-pointer text-xs text-amber-600 dark:text-amber-400">
                                    <FileText className="h-4 w-4" />
                                    <span>{t('admin.orders.exportSecretsDropdown') || '导出敏感数据（含卡密/字段）'}</span>
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
            }
            toolbar={
            <>
            <div className="rounded-2xl border border-border/60 bg-card p-3 shadow-2xs space-y-3">
                {/* Segmented Status Tabs */}
                <div className="flex flex-wrap items-center gap-1 border-b border-border/40 pb-3">
                    {statusOptions.map((s) => {
                        const isActive = statusValue === s.key
                        return (
                            <button
                                key={s.key}
                                type="button"
                                onClick={() => {
                                    setStatusValue(s.key)
                                    applyAllFilters({ status: s.key, page: 1 })
                                }}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                                    isActive
                                        ? "bg-primary text-primary-foreground shadow-xs"
                                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                )}
                            >
                                {s.icon}
                                <span>{s.label}</span>
                            </button>
                        )
                    })}
                </div>

                {/* Search Bar & Actions */}
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="relative flex-1 max-w-xl">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
                        <Input
                            value={queryValue}
                            onChange={(e) => setQueryValue(e.target.value)}
                            placeholder={t('admin.orders.searchPlaceholder')}
                            className="pl-9 pr-8 h-9 text-xs"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') applyFilters({ q: queryValue, page: 1 })
                            }}
                        />
                        {queryValue && (
                            <button
                                type="button"
                                onClick={() => {
                                    setQueryValue("")
                                    applyFilters({ q: "", page: 1 })
                                }}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <XCircle className="h-4 w-4" />
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {(queryValue.trim() || statusValue !== 'all') && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-9 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                    setQueryValue("")
                                    setStatusValue("all")
                                    router.push(buildUrl({ page: 1, pageSize }))
                                }}
                            >
                                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                {t('admin.orders.clearFilters')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="h-9 px-3.5 text-xs gap-1.5"
                            disabled={!queryValue.trim() || queryValue.trim() === query}
                            onClick={() => applyFilters({ q: queryValue, page: 1 })}
                        >
                            <Search className="h-3.5 w-3.5" />
                            {t('admin.orders.search')}
                        </Button>
                    </div>
                </div>
            </div>
            {selectedIds.length > 0 ? (
                <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 transition-all">
                    <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-primary">
                            {t('admin.orders.selectedCount', { count: selectedIds.length })}
                        </span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
                            onClick={() => setSelected({})}
                        >
                            {t('admin.orders.clearSelection') || '取消选择'}
                        </Button>
                    </div>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="h-8 text-xs gap-1.5 shadow-xs"
                        disabled={deleting}
                        onClick={handleBatchDelete}
                    >
                        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        <span>{t('admin.orders.deleteSelected')} ({selectedIds.length})</span>
                    </Button>
                </div>
            ) : (
                <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                    <div>
                        {t('admin.orders.showing', { from: showingFrom, to: showingTo, total })}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground/80">{t('admin.orders.pageSize')}:</span>
                        {[20, 50, 100].map((n) => (
                            <button
                                key={n}
                                type="button"
                                onClick={() => applyAllFilters({ page: 1, pageSize: n })}
                                className={cn(
                                    "px-2 py-0.5 rounded text-xs transition-colors",
                                    pageSize === n
                                        ? "bg-muted font-semibold text-foreground border border-border/60"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {n}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            </>
            }
            footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-1 text-xs text-muted-foreground">
                <div>
                    {t('admin.orders.showing', { from: showingFrom, to: showingTo, total })}
                    <span className="mx-2 text-border">|</span>
                    {t('admin.orders.page', { page, totalPages })}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1 border-border/80"
                        disabled={!canPrev}
                        onClick={() => applyAllFilters({ page: page - 1 })}
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        <span>{t('admin.orders.prev')}</span>
                    </Button>
                    <span className="text-xs font-mono px-2.5 py-1 rounded-md bg-muted/40 border border-border/50">
                        {page} / {totalPages}
                    </span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1 border-border/80"
                        disabled={!canNext}
                        onClick={() => applyAllFilters({ page: page + 1 })}
                    >
                        <span>{t('admin.orders.next')}</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>
            }
        >
            <AdminListScroll>
                    <Table>
                        <TableHeader className="bg-muted/40">
                            <TableRow className="border-b border-border/60 hover:bg-transparent text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[44px] text-center">
                                    <input
                                        type="checkbox"
                                        checked={allOnPageSelected}
                                        onChange={(e) => {
                                            const checked = e.target.checked
                                            const next: Record<string, boolean> = {}
                                            for (const o of orders) next[o.orderId] = checked
                                            setSelected(next)
                                        }}
                                        aria-label={t('admin.orders.selectAll')}
                                        className="h-4 w-4 rounded border-border/80 accent-primary cursor-pointer align-middle"
                                    />
                                </TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[210px]">{t('admin.orders.orderId')}</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur min-w-[240px]">{t('admin.orders.product')}</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[140px]">{t('admin.orders.user')}</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[110px]">{t('admin.orders.paymentBreakdown')}</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[96px]">{t('admin.orders.status')}</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[120px] text-right">{t('admin.orders.actions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody className="divide-y divide-border/40">
                            {orders.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="h-48 text-center text-muted-foreground">
                                        <div className="flex flex-col items-center justify-center gap-2">
                                            <Inbox className="h-8 w-8 text-muted-foreground/40" />
                                            <span className="text-sm">{t('admin.orders.emptyOrders') || '未找到符合条件的订单'}</span>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                orders.map((order) => {
                                    const paymentBreakdown = getOrderPaymentBreakdown({
                                        amount: order.amount,
                                        pointsUsed: order.pointsUsed,
                                    })
                                    const checkoutFieldValues = parseCheckoutFieldValues(order.checkoutFieldValues)
                                    const statusConfig = getStatusConfig(order.status)
                                    const isSelected = !!selected[order.orderId]

                                    return (
                                        <TableRow
                                            key={order.orderId}
                                            className={cn(
                                                "transition-colors hover:bg-muted/30",
                                                isSelected && "bg-primary/5 hover:bg-primary/8"
                                            )}
                                        >
                                            {/* Checkbox */}
                                            <TableCell className="align-top py-3.5 text-center">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={(e) => setSelected((prev) => ({ ...prev, [order.orderId]: e.target.checked }))}
                                                    aria-label={t('admin.orders.selectOne')}
                                                    className="h-4 w-4 rounded border-border/80 accent-primary cursor-pointer align-middle"
                                                />
                                            </TableCell>

                                            <TableCell className="align-top py-3.5">
                                                <div className="space-y-1">
                                                    <Link
                                                        href={`/admin/orders/${order.orderId}`}
                                                        className="font-mono text-xs font-semibold text-foreground hover:text-primary transition-colors hover:underline inline-flex items-center gap-1 group"
                                                        title="查看订单详情"
                                                    >
                                                        <span>{order.orderId}</span>
                                                        <ArrowUpRight className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary transition-colors" />
                                                    </Link>
                                                    <div className="text-[11px] text-muted-foreground/80 font-mono">
                                                        <ClientDate value={order.createdAt} format="dateTime" />
                                                    </div>
                                                    {order.tradeNo ? (
                                                        <div className="font-mono text-[11px] text-muted-foreground">
                                                            <CopyButton text={order.tradeNo} truncate maxLength={14} />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </TableCell>

                                            <TableCell className="align-top py-3.5">
                                                <div className="space-y-1.5">
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <span className="font-medium text-xs text-foreground">{order.productName}</span>
                                                        {order.productId && productVariantLabels[order.productId] && (
                                                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal bg-muted/60 text-muted-foreground">
                                                                {productVariantLabels[order.productId]}
                                                            </Badge>
                                                        )}
                                                    </div>

                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        {isManualFulfillment(order.fulfillmentMode) ? (
                                                            <span className="inline-flex items-center gap-1 rounded border border-blue-500/20 bg-blue-500/5 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                                                                <PackageOpen className="h-3 w-3" />
                                                                <span>{t('admin.orders.fulfillmentManual')}</span>
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 rounded border border-indigo-500/20 bg-indigo-500/5 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-400">
                                                                <Zap className="h-3 w-3" />
                                                                <span>{t('admin.orders.fulfillmentAuto')}</span>
                                                            </span>
                                                        )}

                                                        {order.status === 'paid' && isManualFulfillment(order.fulfillmentMode) && (
                                                            <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400 animate-pulse">
                                                                <Clock className="h-3 w-3" />
                                                                <span>{t('admin.orders.needsDelivery')}</span>
                                                            </span>
                                                        )}
                                                    </div>

                                                    {checkoutFieldValues.length > 0 && (
                                                        <div className="flex flex-wrap gap-1 pt-0.5">
                                                            {checkoutFieldValues.map((field) => (
                                                                <span
                                                                    key={field.id}
                                                                    className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border/40 font-normal max-w-[220px] truncate"
                                                                    title={`${field.label}: ${field.value}`}
                                                                >
                                                                    <span className="text-muted-foreground/70">{field.label}:</span>
                                                                    <span className="font-mono text-foreground truncate">{field.value}</span>
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {order.cardKey ? (
                                                        <div className="font-mono text-[11px] text-muted-foreground">
                                                            <CopyButton text={order.cardKey} truncate maxLength={16} />
                                                        </div>
                                                    ) : isManualFulfillment(order.fulfillmentMode) ? (
                                                        <span className="text-[10px] text-blue-600/70 dark:text-blue-400/70 font-medium">人工交付</span>
                                                    ) : null}
                                                </div>
                                            </TableCell>

                                            <TableCell className="align-top py-3.5">
                                                {order.username ? (
                                                    <div className="space-y-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                                                                {order.username[0]?.toUpperCase()}
                                                            </div>
                                                            <a
                                                                href={getExternalProfileUrl(order.username, order.userId) || "#"}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="font-medium text-xs text-foreground hover:text-primary transition-colors hover:underline truncate max-w-[110px]"
                                                                title={order.username}
                                                            >
                                                                {getDisplayUsername(order.username, order.userId)}
                                                            </a>
                                                        </div>
                                                        {order.email && (
                                                            <div className="text-[11px] text-muted-foreground font-mono">
                                                                <CopyButton text={order.email} truncate maxLength={16} />
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                                                        <User className="h-3.5 w-3.5 text-muted-foreground/50" />
                                                        <span>{t('admin.orders.guest') || '游客'}</span>
                                                    </div>
                                                )}
                                            </TableCell>

                                            {/* Payment Breakdown */}
                                            <TableCell className="align-top py-3.5">
                                                <div className="space-y-0.5 font-mono">
                                                    <div className="font-semibold text-xs text-foreground tabular-nums flex items-baseline gap-1">
                                                        <span className="text-[10px] text-muted-foreground font-sans">实付</span>
                                                        <span>¥{paymentBreakdown.ldcAmount}</span>
                                                    </div>
                                                    {Number(paymentBreakdown.pointsAmount) > 0 && (
                                                        <div className="text-[10px] text-amber-600 dark:text-amber-400 font-medium tabular-nums flex items-baseline gap-1">
                                                            <span className="text-[10px] text-muted-foreground font-sans">积分</span>
                                                            <span>-{paymentBreakdown.pointsAmount}</span>
                                                        </div>
                                                    )}
                                                    {paymentBreakdown.totalAmount !== paymentBreakdown.ldcAmount && (
                                                        <div className="text-[10px] text-muted-foreground/80 tabular-nums flex items-baseline gap-1">
                                                            <span className="text-[10px] text-muted-foreground/60 font-sans">合计</span>
                                                            <span>¥{paymentBreakdown.totalAmount}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </TableCell>

                                            {/* Status */}
                                            <TableCell className="align-top py-3.5">
                                                <Badge variant="outline" className={cn("text-xs font-medium inline-flex items-center gap-1 px-2 py-0.5", statusConfig.badgeClass)}>
                                                    {statusConfig.icon}
                                                    <span>{statusConfig.label}</span>
                                                </Badge>
                                            </TableCell>

                                            {/* Actions */}
                                            <TableCell className="align-top py-3.5 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    {order.status === 'paid' && isManualFulfillment(order.fulfillmentMode) && (
                                                        <Button asChild size="sm" className="h-7 px-2 text-xs bg-blue-600 hover:bg-blue-700 text-white gap-1 shadow-xs">
                                                            <Link href={`/admin/orders/${order.orderId}#fulfillment`}>
                                                                <PackageOpen className="h-3 w-3" />
                                                                <span>发货</span>
                                                            </Link>
                                                        </Button>
                                                    )}
                                                    <AdminOrderActions order={order} />
                                                    <RefundButton order={order} />
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                })
                            )}
                        </TableBody>
                    </Table>
            </AdminListScroll>
        </AdminListPage>
    )
}
