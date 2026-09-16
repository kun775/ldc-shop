'use client'

import Link from "next/link"
import { useMemo } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdminPageShell } from "@/components/admin/admin-page-shell"
import { cn } from "@/lib/utils"
import {
    ArrowRight,
    Clock,
    Coins,
    LayoutDashboard,
    MessageSquare,
    Package,
    PackageOpen,
    RotateCcw,
    ShoppingCart,
    TrendingUp,
    Users,
    Wallet,
} from "lucide-react"

export interface OverviewPeriodPoint {
    date: string
    orders: number
    revenue: number
    refunds: number
}

export interface OverviewData {
    kpis: {
        todayRevenue: number
        yesterdayRevenue: number
        todayOrders: number
        yesterdayOrders: number
        monthRevenue: number
        totalRevenue: number
        todayRefunds: number
        monthRefunds: number
        todayPointsConsumed: number
        todayPointsProduced: number
        visitorCount: number
    }
    ops: {
        pendingOrders: number
        awaitingDelivery: number
        pendingRefunds: number
        unreadMessages: number
        lowStockProducts: number
        activeProducts: number
    }
    trend: OverviewPeriodPoint[]
    topProducts: Array<{ productId: string; productName: string; orders: number; revenue: number }>
    recentOrders: Array<{
        orderId: string
        productName: string
        username: string | null
        amount: string
        pointsUsed: number
        status: string | null
        createdAt: Date | null
        paidAt: Date | null
    }>
    lowStockItems: Array<{ id: string; name: string; stock: number }>
}

function formatAmount(value: number) {
    return Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })
}

function deltaPercent(current: number, previous: number) {
    if (!previous && !current) return 0
    if (!previous) return 100
    return ((current - previous) / previous) * 100
}

function statusClass(status: string | null) {
    switch (status) {
        case 'delivered':
            return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        case 'paid':
            return "bg-sky-500/10 text-sky-700 dark:text-sky-300"
        case 'pending':
            return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
        case 'refunded':
            return "bg-rose-500/10 text-rose-700 dark:text-rose-300"
        case 'cancelled':
            return "bg-muted text-muted-foreground"
        default:
            return "bg-muted text-muted-foreground"
    }
}

export function AdminOverviewContent({ data }: { data: OverviewData }) {
    const { t } = useI18n()
    const revenueDelta = deltaPercent(data.kpis.todayRevenue, data.kpis.yesterdayRevenue)
    const orderDelta = deltaPercent(data.kpis.todayOrders, data.kpis.yesterdayOrders)
    const maxTrend = Math.max(1, ...data.trend.map((item) => item.revenue))
    const netToday = data.kpis.todayRevenue - data.kpis.todayRefunds
    const netMonth = data.kpis.monthRevenue - data.kpis.monthRefunds

    const kpiCards = useMemo(() => ([
        {
            key: 'todayRevenue',
            title: t('admin.overview.todayRevenue'),
            value: formatAmount(data.kpis.todayRevenue),
            hint: t('admin.overview.vsYesterday', { value: `${revenueDelta >= 0 ? '+' : ''}${revenueDelta.toFixed(1)}%` }),
            icon: Wallet,
            accent: "from-emerald-500/15 via-emerald-500/5 to-transparent",
        },
        {
            key: 'todayOrders',
            title: t('admin.overview.todayOrders'),
            value: String(data.kpis.todayOrders),
            hint: t('admin.overview.vsYesterday', { value: `${orderDelta >= 0 ? '+' : ''}${orderDelta.toFixed(1)}%` }),
            icon: ShoppingCart,
            accent: "from-primary/15 via-primary/5 to-transparent",
        },
        {
            key: 'monthRevenue',
            title: t('admin.overview.monthRevenue'),
            value: formatAmount(data.kpis.monthRevenue),
            hint: t('admin.overview.netIncome', { value: formatAmount(netMonth) }),
            icon: TrendingUp,
            accent: "from-indigo-500/15 via-indigo-500/5 to-transparent",
        },
        {
            key: 'refunds',
            title: t('admin.overview.todayRefunds'),
            value: formatAmount(data.kpis.todayRefunds),
            hint: t('admin.overview.monthRefunds', { value: formatAmount(data.kpis.monthRefunds) }),
            icon: RotateCcw,
            accent: "from-rose-500/15 via-rose-500/5 to-transparent",
        },
    ]), [data, netMonth, orderDelta, revenueDelta, t])

    const opsCards = [
        { href: '/admin/orders?status=pending', label: t('admin.overview.pendingOrders'), value: data.ops.pendingOrders, icon: Clock, tone: 'text-amber-600 dark:text-amber-400' },
        { href: '/admin/orders?status=paid', label: t('admin.overview.awaitingDelivery'), value: data.ops.awaitingDelivery, icon: PackageOpen, tone: 'text-blue-600 dark:text-blue-400' },
        { href: '/admin/refunds', label: t('admin.overview.pendingRefunds'), value: data.ops.pendingRefunds, icon: RotateCcw, tone: 'text-rose-600 dark:text-rose-400' },
        { href: '/admin/messages', label: t('admin.overview.unreadMessages'), value: data.ops.unreadMessages, icon: MessageSquare, tone: 'text-violet-600 dark:text-violet-400' },
        { href: '/admin/products', label: t('admin.overview.lowStock'), value: data.ops.lowStockProducts, icon: Package, tone: 'text-orange-600 dark:text-orange-400' },
        { href: '/admin/users', label: t('admin.stats.visitors'), value: data.kpis.visitorCount, icon: Users, tone: 'text-sky-600 dark:text-sky-400' },
    ]

    return (
        <AdminPageShell className="space-y-6 p-0.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                        <LayoutDashboard className="h-3.5 w-3.5 text-primary" />
                        {t('admin.overview.badge')}
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight">{t('admin.overview.title')}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t('admin.overview.subtitle')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button asChild variant="outline" size="sm" className="rounded-xl">
                        <Link href="/admin/orders">{t('common.ordersRefunds')}</Link>
                    </Button>
                    <Button asChild size="sm" className="rounded-xl">
                        <Link href="/admin/settings">{t('common.storeSettings')}</Link>
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {kpiCards.map((card) => (
                    <Card key={card.key} className="overflow-hidden rounded-2xl border-border/60">
                        <div className={cn("h-16 bg-gradient-to-r", card.accent)} />
                        <CardHeader className="-mt-10 flex flex-row items-start justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-background/90 text-primary shadow-xs">
                                <card.icon className="h-4 w-4" />
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold tabular-nums tracking-tight">{card.value}</div>
                            <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                {opsCards.map((item) => (
                    <Link key={item.href + item.label} href={item.href}>
                        <Card className="h-full rounded-2xl border-border/60 transition-colors hover:bg-muted/40">
                            <CardContent className="flex items-center justify-between gap-3 p-4">
                                <div>
                                    <p className="text-[11px] font-medium text-muted-foreground">{item.label}</p>
                                    <p className="mt-1 text-xl font-bold tabular-nums">{item.value}</p>
                                </div>
                                <item.icon className={cn("h-4 w-4", item.tone)} />
                            </CardContent>
                        </Card>
                    </Link>
                ))}
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.4fr_0.8fr]">
                <Card className="rounded-2xl border-border/60">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle className="text-base">{t('admin.overview.trendTitle')}</CardTitle>
                            <p className="text-xs text-muted-foreground">{t('admin.overview.trendHint')}</p>
                        </div>
                        <Badge variant="secondary" className="rounded-full">{t('admin.overview.last7Days')}</Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex h-40 items-end gap-2">
                            {data.trend.map((point) => (
                                <div key={point.date} className="flex flex-1 flex-col items-center gap-2">
                                    <div className="flex h-28 w-full items-end rounded-lg bg-muted/40 p-1">
                                        <div
                                            className="w-full rounded-md bg-primary/80"
                                            style={{ height: `${Math.max(6, (point.revenue / maxTrend) * 100)}%` }}
                                            title={`${point.date}: ${formatAmount(point.revenue)}`}
                                        />
                                    </div>
                                    <span className="text-[10px] text-muted-foreground">{point.date.slice(5)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                                <p className="text-[11px] text-muted-foreground">{t('admin.overview.netToday')}</p>
                                <p className="text-sm font-semibold tabular-nums">{formatAmount(netToday)}</p>
                            </div>
                            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                                <p className="text-[11px] text-muted-foreground">{t('admin.stats.pointsConsumed')}</p>
                                <p className="text-sm font-semibold tabular-nums">{data.kpis.todayPointsConsumed}</p>
                            </div>
                            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                                <p className="text-[11px] text-muted-foreground">{t('admin.stats.pointsProduced')}</p>
                                <p className="text-sm font-semibold tabular-nums">{data.kpis.todayPointsProduced}</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="rounded-2xl border-border/60">
                    <CardHeader>
                        <CardTitle className="text-base">{t('admin.overview.cashflowTitle')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="flex items-center justify-between rounded-xl bg-emerald-500/8 px-3 py-2.5">
                            <span className="text-muted-foreground">{t('admin.overview.income')}</span>
                            <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">+{formatAmount(data.kpis.todayRevenue)}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl bg-rose-500/8 px-3 py-2.5">
                            <span className="text-muted-foreground">{t('admin.overview.expense')}</span>
                            <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-300">-{formatAmount(data.kpis.todayRefunds)}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5">
                            <span className="text-muted-foreground">{t('admin.overview.netToday')}</span>
                            <span className="font-semibold tabular-nums">{formatAmount(netToday)}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5">
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Coins className="h-3.5 w-3.5" />{t('admin.overview.pointsNet')}</span>
                            <span className="font-semibold tabular-nums">{data.kpis.todayPointsProduced - data.kpis.todayPointsConsumed}</span>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <Card className="rounded-2xl border-border/60">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="text-base">{t('admin.stats.recentOrders')}</CardTitle>
                        <Button asChild variant="ghost" size="sm" className="h-8 rounded-lg px-2 text-xs">
                            <Link href="/admin/orders">{t('common.viewDetails')}<ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {data.recentOrders.length === 0 ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">{t('admin.overview.emptyOrders')}</p>
                        ) : data.recentOrders.map((order) => (
                            <Link key={order.orderId} href={`/admin/orders/${order.orderId}`} className="flex items-center justify-between gap-3 rounded-xl border border-border/50 px-3 py-2.5 transition-colors hover:bg-muted/40">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{order.productName}</p>
                                    <p className="truncate text-[11px] text-muted-foreground">
                                        {order.username ? `@${order.username}` : t('admin.orders.guest')} · {order.orderId.slice(0, 10)}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-semibold tabular-nums">{formatAmount(Number(order.amount || 0))}</p>
                                    <Badge className={cn("mt-1 h-5 rounded-md px-1.5 text-[10px]", statusClass(order.status))}>
                                        {t(`order.status.${order.status || 'pending'}`)}
                                    </Badge>
                                </div>
                            </Link>
                        ))}
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <Card className="rounded-2xl border-border/60">
                        <CardHeader>
                            <CardTitle className="text-base">{t('admin.overview.topProducts')}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {data.topProducts.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">{t('admin.overview.emptyProducts')}</p>
                            ) : data.topProducts.map((product, index) => (
                                <div key={product.productId} className="flex items-center justify-between gap-3 rounded-xl border border-border/50 px-3 py-2.5">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{index + 1}. {product.productName}</p>
                                        <p className="text-[11px] text-muted-foreground">{t('admin.overview.soldCount', { count: product.orders })}</p>
                                    </div>
                                    <p className="text-sm font-semibold tabular-nums">{formatAmount(product.revenue)}</p>
                                </div>
                            ))}
                        </CardContent>
                    </Card>

                    <Card className="rounded-2xl border-border/60">
                        <CardHeader>
                            <CardTitle className="text-base">{t('admin.stats.lowStock')}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {data.lowStockItems.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">{t('admin.overview.emptyLowStock')}</p>
                            ) : data.lowStockItems.map((item) => (
                                <Link key={item.id} href={`/admin/product/edit/${item.id}`} className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2.5 hover:bg-muted/40">
                                    <span className="truncate text-sm">{item.name}</span>
                                    <span className="text-xs font-semibold tabular-nums text-orange-600 dark:text-orange-400">{item.stock}</span>
                                </Link>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </AdminPageShell>
    )
}
