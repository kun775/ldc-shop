import Link from 'next/link'
import { notFound } from 'next/navigation'
import { unstable_noStore } from 'next/cache'
import { ArrowLeft, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ClientDate } from '@/components/client-date'
import { AdminListPage, AdminListScroll } from '@/components/admin/admin-page-shell'
import { getCouponById, getCouponUsageSummary, listCouponUsages, getProductNamesByIds } from '@/lib/coupons/repository'
import { centsToLdcNumber } from '@/lib/coupons/money'
import { getDisplayUsername, getExternalProfileUrl } from '@/lib/user-profile-link'

const USAGE_PAGE_SIZE = 20

const USAGE_STATUS_LABELS: Record<string, string> = {
    reserved: '已预占',
    consumed: '已核销',
    released: '已释放',
    reversed: '已返还',
}

function usageStatusVariant(status: string) {
    switch (status) {
        case 'consumed': return 'default' as const
        case 'reserved': return 'secondary' as const
        case 'reversed': return 'destructive' as const
        default: return 'outline' as const
    }
}

function describeRule(coupon: NonNullable<Awaited<ReturnType<typeof getCouponById>>>) {
    if (coupon.discountType === 'percent') {
        const parts = [`按 ${coupon.rateBps ? coupon.rateBps / 100 : 0}% 支付`]
        if (coupon.maxDiscountCents) parts.push(`最高优惠 ${centsToLdcNumber(coupon.maxDiscountCents)}`)
        if (coupon.minSpendCents > 0) parts.push(`满 ${centsToLdcNumber(coupon.minSpendCents)} 可用`)
        return parts.join(' · ')
    }
    const amount = centsToLdcNumber(coupon.discountAmountCents || 0)
    if (coupon.discountType === 'threshold_fixed') {
        return `满 ${centsToLdcNumber(coupon.minSpendCents)} 减 ${amount}`
    }
    return `立减 ${amount}`
}

function firstParam(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined
    return Array.isArray(value) ? value[0] : value
}

function parseIntParam(value: unknown, fallback: number) {
    const num = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
    return Number.isFinite(num) && num > 0 ? num : fallback
}

export default async function AdminCouponDetailPage(props: {
    params: Promise<{ id: string }>
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    unstable_noStore()
    const { id } = await props.params
    const searchParams = await props.searchParams

    const usagesPage = parseIntParam(firstParam(searchParams.upage), 1)
    const usagesStatus = (firstParam(searchParams.ustatus) || '').trim()

    // getCouponById 只在「记录确实不存在」时返回 null，结构与查询异常一律抛出。
    // 因此这里不能再用 .catch(() => null) 兜底 —— 那会把数据库故障伪装成 404，
    // 管理员看到「优惠券不存在」而真正的原因被完全隐藏。异常交给本段落的
    // error.tsx 呈现（安全文案 + errorId），后台布局保持可用。
    const coupon = await getCouponById(id)
    if (!coupon) return notFound()

    const [summary, usages, productNames] = await Promise.all([
        getCouponUsageSummary(id).catch(() => null),
        listCouponUsages({ couponId: id, page: usagesPage, pageSize: USAGE_PAGE_SIZE, status: usagesStatus })
            .catch(() => ({ items: [], total: 0, page: usagesPage, pageSize: USAGE_PAGE_SIZE })),
        coupon.productIds.length > 0
            ? getProductNamesByIds(coupon.productIds).catch(() => new Map<string, string>())
            : Promise.resolve(new Map<string, string>()),
    ])

    const totalUsagePages = Math.max(1, Math.ceil(usages.total / USAGE_PAGE_SIZE))
    const buildUsageHref = (nextPage: number, nextStatus = usagesStatus) => {
        const params = new URLSearchParams()
        if (nextPage > 1) params.set('upage', String(nextPage))
        if (nextStatus) params.set('ustatus', nextStatus)
        const queryString = params.toString()
        return queryString ? `/admin/coupons/${id}?${queryString}` : `/admin/coupons/${id}`
    }

    const stats = summary || {
        consumedCount: 0,
        reservedCount: 0,
        releasedCount: 0,
        reversedCount: 0,
        userCount: 0,
        discountTotalCents: 0,
        orderAmountTotalCents: 0,
    }

    return (
        <AdminListPage
            header={
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <h1 className="font-mono text-2xl font-bold tracking-tight">{coupon.code}</h1>
                            <Badge variant={coupon.status === 'active' ? 'default' : 'outline'} className="text-xs">
                                {coupon.status === 'active' ? '启用' : coupon.status === 'disabled' ? '停用' : '草稿'}
                            </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {coupon.name} · {describeRule(coupon)}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button asChild variant="outline" size="sm" className="h-9 gap-1.5">
                            <Link href="/admin/coupons">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                返回列表
                            </Link>
                        </Button>
                        <Button asChild size="sm" className="h-9 gap-1.5">
                            <Link href={`/admin/coupons/${id}/edit`}>
                                <Pencil className="h-3.5 w-3.5" />
                                编辑
                            </Link>
                        </Button>
                    </div>
                </div>
            }
            toolbar={
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-xl border border-border/60 bg-card p-3.5">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">已核销</div>
                        <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                            {stats.consumedCount}
                            {coupon.totalUseLimit !== null ? (
                                <span className="text-sm font-normal text-muted-foreground"> / {coupon.totalUseLimit}</span>
                            ) : null}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">预占 {stats.reservedCount}</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-card p-3.5">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">使用人数</div>
                        <div className="mt-1 text-xl font-bold tabular-nums text-foreground">{stats.userCount}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                            释放 {stats.releasedCount} · 返还 {stats.reversedCount}
                        </div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-card p-3.5">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">累计优惠</div>
                        <div className="mt-1 text-xl font-bold tabular-nums text-foreground">
                            {centsToLdcNumber(stats.discountTotalCents)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">LDC</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-card p-3.5">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">规则</div>
                        <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                            <div>范围：{coupon.scope === 'all' ? '所有商品' : `指定商品（${coupon.productIds.length}）`}</div>
                            <div>每人限次：{coupon.perUserLimit === null ? '不限' : coupon.perUserLimit}</div>
                            <div>叠加：{coupon.stackableWithCoupons ? '可叠券' : '不叠券'} · {coupon.stackableWithPoints ? '可用积分' : '禁与积分'}</div>
                        </div>
                    </div>
                </div>
            }
            footer={
                usages.total > 0 ? (
                    <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                        <div>
                            {usages.page} / {totalUsagePages} 页 · 共 {usages.total} 条记录
                        </div>
                        <div className="flex items-center gap-2">
                            <Button asChild variant="outline" size="sm" className="h-8 text-xs" disabled={usages.page <= 1}>
                                <Link href={buildUsageHref(Math.max(1, usages.page - 1))}>上一页</Link>
                            </Button>
                            <span className="rounded-md border border-border/50 bg-muted/40 px-2.5 py-1 font-mono text-xs">
                                {usages.page} / {totalUsagePages}
                            </span>
                            <Button
                                asChild
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={usages.page >= totalUsagePages}
                            >
                                <Link href={buildUsageHref(Math.min(totalUsagePages, usages.page + 1))}>下一页</Link>
                            </Button>
                        </div>
                    </div>
                ) : null
            }
        >
            <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
                <span className="text-xs text-muted-foreground">使用记录</span>
                {[
                    { value: '', label: '全部' },
                    { value: 'consumed', label: '已核销' },
                    { value: 'reserved', label: '已预占' },
                    { value: 'released', label: '已释放' },
                    { value: 'reversed', label: '已返还' },
                ].map((option) => (
                    <Button
                        key={option.value || 'all'}
                        asChild
                        size="sm"
                        variant={usagesStatus === option.value ? 'default' : 'outline'}
                        className="h-8 text-xs"
                    >
                        <Link href={buildUsageHref(1, option.value)}>{option.label}</Link>
                    </Button>
                ))}
            </div>

            {coupon.scope === 'selected' && coupon.productIds.length > 0 && (
                <div className="shrink-0 pb-3 text-[11px] text-muted-foreground">
                    指定商品：
                    {coupon.productIds
                        .map((productId) => productNames.get(productId) || productId)
                        .join('、')}
                </div>
            )}

            <AdminListScroll>
                <Table className="min-w-[1000px] table-fixed">
                    <TableHeader className="bg-muted/40">
                        <TableRow className="border-b border-border/60 hover:bg-transparent">
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">状态</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">使用人</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">关联订单</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">商品</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">优惠金额</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">时间</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">备注</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {usages.items.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                                    暂无使用记录
                                </TableCell>
                            </TableRow>
                        ) : (
                            usages.items.map((usage) => (
                                <TableRow key={usage.id} className="align-middle">
                                    <TableCell className="px-3">
                                        <Badge variant={usageStatusVariant(usage.status)} className="text-xs">
                                            {USAGE_STATUS_LABELS[usage.status] || usage.status}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="px-3">
                                        {usage.username ? (
                                            <a
                                                href={getExternalProfileUrl(usage.username, usage.userId) || '#'}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-xs font-medium text-primary hover:underline"
                                            >
                                                {getDisplayUsername(usage.username, usage.userId)}
                                            </a>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">未登录用户</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="px-3">
                                        <Link
                                            href={`/admin/orders/${usage.orderId}`}
                                            className="font-mono text-xs text-primary hover:underline"
                                        >
                                            {usage.orderId}
                                        </Link>
                                        {usage.orderStatus && (
                                            <div className="text-[11px] text-muted-foreground">
                                                订单状态：{usage.orderStatus}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="px-3">
                                        <span className="line-clamp-2 text-xs text-foreground">
                                            {usage.orderProductName || '-'}
                                        </span>
                                    </TableCell>
                                    <TableCell className="px-3">
                                        <div className="flex flex-col text-xs tabular-nums">
                                            <span className="font-medium text-foreground">
                                                -{centsToLdcNumber(usage.discountAmountCents)}
                                            </span>
                                            <span className="text-[11px] text-muted-foreground">
                                                适用金额 {centsToLdcNumber(usage.eligibleAmountCents)}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="px-3 text-[11px] text-muted-foreground">
                                        <div className="flex flex-col gap-0.5">
                                            {usage.reservedAt !== null && (
                                                <span>
                                                    预占 <ClientDate value={new Date(usage.reservedAt)} format="dateTime" />
                                                </span>
                                            )}
                                            {usage.consumedAt !== null && (
                                                <span>
                                                    核销 <ClientDate value={new Date(usage.consumedAt)} format="dateTime" />
                                                </span>
                                            )}
                                            {usage.releasedAt !== null && (
                                                <span>
                                                    释放 <ClientDate value={new Date(usage.releasedAt)} format="dateTime" />
                                                </span>
                                            )}
                                            {usage.reversedAt !== null && (
                                                <span>
                                                    返还 <ClientDate value={new Date(usage.reversedAt)} format="dateTime" />
                                                </span>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell className="px-3 text-[11px] text-muted-foreground">
                                        {usage.reason || '-'}
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </AdminListScroll>
        </AdminListPage>
    )
}
