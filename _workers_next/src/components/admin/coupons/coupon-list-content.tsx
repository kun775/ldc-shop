'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AdminListPage, AdminListScroll } from '@/components/admin/admin-page-shell'
import { useI18n } from '@/lib/i18n/context'
import { useConfirm } from '@/components/confirm-dialog-provider'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, Power, Trash2 } from 'lucide-react'
import {
    deleteCouponAction,
    duplicateCouponAction,
    setCouponFeatureFlag,
    setCouponStatusAction,
} from '@/actions/coupons'
import { centsToLdcNumber } from '@/lib/coupons/money'
import type { CouponListRow } from '@/lib/coupons/repository'

type DerivedStatus = 'draft' | 'scheduled' | 'active' | 'expired' | 'exhausted' | 'disabled'

const DERIVED_STATUS_LABELS: Record<DerivedStatus, string> = {
    draft: '草稿',
    scheduled: '待生效',
    active: '使用中',
    expired: '已过期',
    exhausted: '已用完',
    disabled: '已停用',
}

function resolveDerivedStatus(coupon: CouponListRow, now: number): DerivedStatus {
    if (coupon.status === 'draft') return 'draft'
    if (coupon.status === 'disabled') return 'disabled'
    if (coupon.endsAt !== null && coupon.endsAt < now) return 'expired'
    if (
        coupon.totalUseLimit !== null &&
        coupon.reservedCount + coupon.consumedCount >= coupon.totalUseLimit
    ) {
        return 'exhausted'
    }
    if (coupon.startsAt !== null && coupon.startsAt > now) return 'scheduled'
    return 'active'
}

function statusVariant(status: DerivedStatus) {
    switch (status) {
        case 'active': return 'default' as const
        case 'scheduled': return 'secondary' as const
        case 'exhausted': return 'destructive' as const
        case 'expired': return 'outline' as const
        case 'disabled': return 'outline' as const
        default: return 'outline' as const
    }
}

function describeRule(coupon: CouponListRow) {
    if (coupon.discountType === 'percent') {
        const ratePercent = coupon.rateBps ? coupon.rateBps / 100 : 0
        const base = `按 ${ratePercent}% 支付`
        const cap = coupon.maxDiscountCents ? `，最高优惠 ${centsToLdcNumber(coupon.maxDiscountCents)}` : ''
        const min = coupon.minSpendCents > 0 ? `，满 ${centsToLdcNumber(coupon.minSpendCents)} 可用` : ''
        return `${base}${cap}${min}`
    }
    const amount = centsToLdcNumber(coupon.discountAmountCents || 0)
    if (coupon.discountType === 'threshold_fixed') {
        return `满 ${centsToLdcNumber(coupon.minSpendCents)} 减 ${amount}`
    }
    return `立减 ${amount}`
}

function describeLimits(coupon: CouponListRow) {
    const total = coupon.totalUseLimit === null ? '不限' : `${coupon.totalUseLimit} 次`
    const perUser = coupon.perUserLimit === null ? '不限' : `${coupon.perUserLimit} 次`
    return `总量 ${total} / 每人 ${perUser}`
}

function formatWindow(coupon: CouponListRow) {
    const format = (value: number | null) => {
        if (value === null) return null
        const date = new Date(value)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const start = format(coupon.startsAt)
    const end = format(coupon.endsAt)
    if (!start && !end) return '长期有效'
    return `${start || '立即'} ~ ${end || '不限'}`
}

export function AdminCouponsContent({
    coupons,
    total,
    page,
    pageSize,
    query,
    status,
    discountType,
    scope,
    featureEnabled,
}: {
    coupons: CouponListRow[]
    total: number
    page: number
    pageSize: number
    query: string
    status: string
    discountType: string
    scope: string
    featureEnabled: boolean
}) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const [search, setSearch] = useState(query)
    const [actionId, setActionId] = useState<string | null>(null)
    const now = Date.now()

    const totalPages = Math.max(1, Math.ceil(total / pageSize))

    const pushFilters = (next: Record<string, string>) => {
        const params = new URLSearchParams()
        const merged = {
            q: query,
            status,
            discountType,
            scope,
            page: '1',
            ...next,
        }
        Object.entries(merged).forEach(([key, value]) => {
            if (value) params.set(key, value)
        })
        const queryString = params.toString()
        router.push(queryString ? `/admin/coupons?${queryString}` : '/admin/coupons')
    }

    const runAction = async (id: string, task: () => Promise<{ success?: boolean; error?: string }>) => {
        if (actionId) return
        setActionId(id)
        try {
            const result = await task()
            if (result?.success) {
                toast.success(t('common.success'))
                startTransition(() => router.refresh())
            } else {
                toast.error(result?.error ? t(result.error) : t('common.error'))
            }
        } catch (error: any) {
            toast.error(error?.message || t('common.error'))
        } finally {
            setActionId(null)
        }
    }

    const handleToggleFeature = () => {
        startTransition(async () => {
            try {
                await setCouponFeatureFlag(!featureEnabled)
                toast.success(t('common.success'))
                router.refresh()
            } catch (error: any) {
                toast.error(error?.message || t('common.error'))
            }
        })
    }

    const handleDelete = async (coupon: CouponListRow) => {
        const ok = await confirm({
            title: '删除优惠券',
            description: `确认删除「${coupon.name}」吗？存在使用记录的优惠券无法删除。`,
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel'),
            variant: 'destructive',
            icon: 'trash',
        })
        if (!ok) return
        await runAction(coupon.id, () => deleteCouponAction(coupon.id))
    }

    return (
        <AdminListPage
            header={
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                        <h1 className="text-2xl font-bold tracking-tight">优惠券管理</h1>
                        <p className="text-xs text-muted-foreground">
                            共 {total} 张优惠券 · 前台状态：{featureEnabled ? '已启用' : '已关闭'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant={featureEnabled ? 'outline' : 'default'}
                            size="sm"
                            className="h-9 gap-1.5"
                            onClick={handleToggleFeature}
                            disabled={pending}
                        >
                            <Power className="h-3.5 w-3.5" />
                            {featureEnabled ? '关闭前台优惠券' : '启用前台优惠券'}
                        </Button>
                        <Button asChild size="sm" className="h-9 gap-1.5">
                            <Link href="/admin/coupons/new">
                                <Plus className="h-3.5 w-3.5" />
                                创建优惠券
                            </Link>
                        </Button>
                    </div>
                </div>
            }
            toolbar={
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        type="search"
                        aria-label="搜索优惠券"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') pushFilters({ q: search.trim() })
                        }}
                        placeholder="搜索优惠码或名称"
                        className="h-9 text-xs md:max-w-xs"
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 text-xs"
                        onClick={() => pushFilters({ q: search.trim() })}
                    >
                        搜索
                    </Button>
                    <select
                        aria-label="按状态筛选"
                        className="h-9 rounded-md border border-border/70 bg-background px-2 text-xs"
                        value={status}
                        onChange={(event) => pushFilters({ status: event.target.value })}
                    >
                        <option value="">全部状态</option>
                        <option value="active">使用中</option>
                        <option value="scheduled">待生效</option>
                        <option value="exhausted">已用完</option>
                        <option value="expired">已过期</option>
                        <option value="draft">草稿</option>
                        <option value="disabled">已停用</option>
                    </select>
                    <select
                        aria-label="按类型筛选"
                        className="h-9 rounded-md border border-border/70 bg-background px-2 text-xs"
                        value={discountType}
                        onChange={(event) => pushFilters({ discountType: event.target.value })}
                    >
                        <option value="">全部类型</option>
                        <option value="percent">百分比折扣</option>
                        <option value="fixed">固定立减</option>
                        <option value="threshold_fixed">满减</option>
                    </select>
                    <select
                        aria-label="按范围筛选"
                        className="h-9 rounded-md border border-border/70 bg-background px-2 text-xs"
                        value={scope}
                        onChange={(event) => pushFilters({ scope: event.target.value })}
                    >
                        <option value="">全部范围</option>
                        <option value="all">所有商品</option>
                        <option value="selected">指定商品</option>
                    </select>
                    {(query || status || discountType || scope) && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-9 text-xs"
                            onClick={() => {
                                setSearch('')
                                router.push('/admin/coupons')
                            }}
                        >
                            清除筛选
                        </Button>
                    )}
                </div>
            }
            footer={
                total > 0 ? (
                    <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                        <div>
                            {page} / {totalPages} 页 · 共 {total} 张
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1 text-xs"
                                disabled={page <= 1 || pending}
                                onClick={() => pushFilters({ page: String(page - 1) })}
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                上一页
                            </Button>
                            <span className="rounded-md border border-border/50 bg-muted/40 px-2.5 py-1 font-mono text-xs">
                                {page} / {totalPages}
                            </span>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1 text-xs"
                                disabled={page >= totalPages || pending}
                                onClick={() => pushFilters({ page: String(page + 1) })}
                            >
                                下一页
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    </div>
                ) : null
            }
        >
            <AdminListScroll>
                <Table className="min-w-[1080px] table-fixed">
                    <TableHeader className="bg-muted/40">
                        <TableRow className="border-b border-border/60 hover:bg-transparent">
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">优惠券</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">优惠规则</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">适用范围</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">次数限制</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">有效期</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">使用情况</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">叠加</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 backdrop-blur">状态</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 px-3 text-right backdrop-blur">操作</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {coupons.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                                    暂无优惠券，点击右上角「创建优惠券」开始配置
                                </TableCell>
                            </TableRow>
                        ) : (
                            coupons.map((coupon) => {
                                const derived = resolveDerivedStatus(coupon, now)
                                const busy = actionId === coupon.id
                                const isActive = coupon.status === 'active'
                                return (
                                    <TableRow key={coupon.id} className="align-middle">
                                        <TableCell className="px-3 align-top">
                                            <div className="flex flex-col gap-1">
                                                <span className="font-mono text-xs font-semibold text-foreground">
                                                    {coupon.code}
                                                </span>
                                                <span className="truncate text-xs text-muted-foreground" title={coupon.name}>
                                                    {coupon.name}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <span className="text-xs text-foreground">{describeRule(coupon)}</span>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <span className="text-xs text-muted-foreground">
                                                {coupon.scope === 'all'
                                                    ? '所有商品'
                                                    : `指定商品（${coupon.productIds.length}）`}
                                            </span>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <span className="text-xs text-muted-foreground">{describeLimits(coupon)}</span>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <span className="text-xs text-muted-foreground">{formatWindow(coupon)}</span>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <div className="flex flex-col gap-0.5 text-xs">
                                                <span className="tabular-nums text-foreground">
                                                    已核销 {coupon.consumedCount}
                                                    {coupon.totalUseLimit !== null ? ` / ${coupon.totalUseLimit}` : ''}
                                                </span>
                                                <span className="tabular-nums text-muted-foreground">
                                                    预占 {coupon.reservedCount} · 使用人 {coupon.userCount}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                                                <span>{coupon.stackableWithCoupons ? '可叠加券' : '不叠加券'}</span>
                                                <span>{coupon.stackableWithPoints ? '可用积分' : '禁与积分'}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <Badge variant={statusVariant(derived)} className="text-xs">
                                                {DERIVED_STATUS_LABELS[derived]}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="px-3 align-top">
                                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                                                <Button asChild variant="outline" size="sm" className="h-8 px-2 text-xs">
                                                    <Link href={`/admin/coupons/${coupon.id}`}>详情</Link>
                                                </Button>
                                                <Button asChild variant="outline" size="sm" className="h-8 px-2 text-xs">
                                                    <Link href={`/admin/coupons/${coupon.id}/edit`}>
                                                        <Pencil className="h-3.5 w-3.5" />
                                                    </Link>
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-8 px-2"
                                                    disabled={busy || pending}
                                                    aria-label="复制优惠券"
                                                    onClick={() => runAction(coupon.id, () => duplicateCouponAction(coupon.id))}
                                                >
                                                    <Copy className="h-3.5 w-3.5" />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant={isActive ? 'outline' : 'default'}
                                                    size="sm"
                                                    className="h-8 px-2 text-xs"
                                                    disabled={busy || pending}
                                                    onClick={() =>
                                                        runAction(coupon.id, () =>
                                                            setCouponStatusAction(coupon.id, isActive ? 'disabled' : 'active')
                                                        )
                                                    }
                                                >
                                                    {isActive ? '停用' : '启用'}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 px-2 text-destructive"
                                                    disabled={busy || pending}
                                                    aria-label="删除优惠券"
                                                    onClick={() => handleDelete(coupon)}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
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
