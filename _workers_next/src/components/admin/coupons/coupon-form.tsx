'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { AdminPageShell } from '@/components/admin/admin-page-shell'
import { CouponProductPicker, type CouponProductOption } from '@/components/admin/coupons/coupon-product-picker'
import { useI18n } from '@/lib/i18n/context'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react'
import { createCouponAction, updateCouponAction } from '@/actions/coupons'
import { centsToLdcNumber } from '@/lib/coupons/money'
import { generateCouponCode } from '@/lib/coupons/code'
import { resolveClientActionErrorKey } from '@/lib/errors/safe-error'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'
import type { CouponRecord } from '@/lib/coupons/types'

export interface CouponFormInitial {
    id: string
    code: string
    name: string
    description: string
    discountType: 'percent' | 'fixed' | 'threshold_fixed'
    ratePercent: string
    discountValue: string
    minSpendValue: string
    maxDiscountValue: string
    scope: 'all' | 'selected'
    productIds: string[]
    totalUseLimit: string
    perUserLimit: string
    stackableWithCoupons: boolean
    stackableWithPoints: boolean
    refundPolicy: string
    status: string
    startsAtInput: string
    endsAtInput: string
}

export function toCouponFormInitial(coupon: CouponRecord): CouponFormInitial {
    return {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        description: coupon.description || '',
        discountType: coupon.discountType,
        ratePercent: coupon.rateBps ? String(coupon.rateBps / 100) : '',
        discountValue: coupon.discountAmountCents ? String(centsToLdcNumber(coupon.discountAmountCents)) : '',
        minSpendValue: coupon.minSpendCents > 0 ? String(centsToLdcNumber(coupon.minSpendCents)) : '',
        maxDiscountValue: coupon.maxDiscountCents ? String(centsToLdcNumber(coupon.maxDiscountCents)) : '',
        scope: coupon.scope,
        productIds: coupon.productIds,
        totalUseLimit: coupon.totalUseLimit === null ? '' : String(coupon.totalUseLimit),
        perUserLimit: coupon.perUserLimit === null ? '' : String(coupon.perUserLimit),
        stackableWithCoupons: coupon.stackableWithCoupons,
        stackableWithPoints: coupon.stackableWithPoints,
        refundPolicy: coupon.refundPolicy,
        status: coupon.status,
        startsAtInput: msToLocalInput(coupon.startsAt),
        endsAtInput: msToLocalInput(coupon.endsAt),
    }
}

function msToLocalInput(ms: number | null): string {
    if (ms === null) return ''
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localInputToMs(value: string): number | null {
    if (!value) return null
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : null
}

const EMPTY_INITIAL: CouponFormInitial = {
    id: '',
    code: '',
    name: '',
    description: '',
    discountType: 'fixed',
    ratePercent: '',
    discountValue: '',
    minSpendValue: '',
    maxDiscountValue: '',
    scope: 'all',
    productIds: [],
    totalUseLimit: '',
    perUserLimit: '',
    stackableWithCoupons: false,
    stackableWithPoints: true,
    refundPolicy: 'unfulfilled_full_refund',
    status: 'draft',
    startsAtInput: '',
    endsAtInput: '',
}

export function CouponForm({
    mode,
    initial,
    products,
    usageLocked = false,
}: {
    mode: 'create' | 'edit'
    initial?: CouponFormInitial
    products: CouponProductOption[]
    usageLocked?: boolean
}) {
    const { t } = useI18n()
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const [form, setForm] = useState<CouponFormInitial>(initial || EMPTY_INITIAL)
    const [error, setError] = useState<{ key: string; errorId: string } | null>(null)

    /**
     * 提交锁与挂载标记。
     *
     * - submitLock：防止 `pending` 尚未翻转为 true 的极短窗口内重复点击
     *   （useTransition 的 pending 是异步生效的，快速双击会发出两个请求）；
     * - mountedRef：成功分支会先 toast 再 router.push，组件此时可能已卸载，
     *   避免对已卸载组件 setState。
     */
    const submitLock = useRef(false)
    const mountedRef = useRef(true)
    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
    }, [])

    const locked = mode === 'edit' && usageLocked

    const update = <K extends keyof CouponFormInitial>(key: K, value: CouponFormInitial[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }))
    }

    const showError = (key: string, errorId: string) => {
        if (!mountedRef.current) return
        setError({ key, errorId })
        toast.error(errorId ? `${t(key)} · ${t('common.errorIdLabel')} ${errorId}` : t(key))
    }

    const handleSubmit = async () => {
        if (submitLock.current || pending) return
        submitLock.current = true
        setError(null)

        const formData = new FormData()
        if (mode === 'edit') formData.set('id', form.id)
        formData.set('name', form.name)
        formData.set('code', form.code)
        formData.set('description', form.description)
        formData.set('discountType', form.discountType)
        formData.set('ratePercent', form.ratePercent)
        formData.set('discountValue', form.discountValue)
        formData.set('minSpendValue', form.minSpendValue)
        formData.set('maxDiscountValue', form.maxDiscountValue)
        formData.set('scope', form.scope)
        formData.set('productIds', JSON.stringify(form.productIds))
        formData.set('totalUseLimit', form.totalUseLimit)
        formData.set('perUserLimit', form.perUserLimit)
        if (form.stackableWithCoupons) formData.set('stackableWithCoupons', 'on')
        if (form.stackableWithPoints) formData.set('stackableWithPoints', 'on')
        formData.set('refundPolicy', form.refundPolicy)
        formData.set('status', form.status)

        const startsAtMs = localInputToMs(form.startsAtInput)
        const endsAtMs = localInputToMs(form.endsAtInput)
        if (startsAtMs !== null) formData.set('startsAtMs', String(startsAtMs))
        if (endsAtMs !== null) formData.set('endsAtMs', String(endsAtMs))

        startTransition(async () => {
            // 抑制路由级全屏遮罩：保存成功后 router.push + router.refresh
            // 会挂载 loading.tsx fallback，若不抑制会在表单上方闪出全屏遮罩
            const releaseInteraction = pageLoadingStore.beginInteraction()
            try {
                const result = mode === 'create'
                    ? await createCouponAction(formData)
                    : await updateCouponAction(formData)

                if (!result.ok) {
                    // 表单内容不重置：失败后用户可直接修正校验项再提交
                    showError(result.errorKey || 'common.error', result.errorId)
                    return
                }

                toast.success(t('common.success'))
                router.push(`/admin/coupons/${result.id || form.id}`)
                router.refresh()
            } catch (submitError) {
                // 兜底：Server Action 网络层异常（离线、超时、部署切换）
                showError(resolveClientActionErrorKey(submitError), '')
            } finally {
                submitLock.current = false
                releaseInteraction()
            }
        })
    }

    return (
        <AdminPageShell>
            <div className="mx-auto w-full max-w-3xl space-y-5 pb-8">
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                        <h1 className="text-2xl font-bold tracking-tight">
                            {mode === 'create' ? '创建优惠券' : '编辑优惠券'}
                        </h1>
                        <p className="text-xs text-muted-foreground">
                            金额单位为 LDC，折扣比例表示“按原价的百分之多少支付”，例如 90 表示九折。
                        </p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="h-9 gap-1.5">
                        <Link href="/admin/coupons">
                            <ArrowLeft className="h-3.5 w-3.5" />
                            返回列表
                        </Link>
                    </Button>
                </div>

                {locked && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-700 dark:text-amber-300">
                        该优惠券已产生使用记录，优惠码与经济规则已锁定。如需调整规则，请从列表复制为新优惠券。
                    </div>
                )}

                {error && (
                    <div
                        role="alert"
                        className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-xs text-destructive space-y-1"
                    >
                        <p className="font-medium">{t(error.key)}</p>
                        {error.errorId && (
                            <p className="font-mono text-[11px] text-destructive/80">
                                {t('common.errorIdLabel')}: {error.errorId}
                            </p>
                        )}
                    </div>
                )}

                <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-5">
                    <h2 className="text-sm font-semibold text-foreground">基础信息</h2>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-name">名称</Label>
                            <Input
                                id="coupon-name"
                                value={form.name}
                                onChange={(event) => update('name', event.target.value)}
                                placeholder="例如：双十一满减券"
                                className="h-10 text-sm"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-code">优惠码</Label>
                            <div className="flex items-center gap-2">
                                <Input
                                    id="coupon-code"
                                    value={form.code}
                                    onChange={(event) => update('code', event.target.value.toUpperCase())}
                                    placeholder="例如：SAVE20"
                                    className="h-10 font-mono text-sm"
                                    disabled={locked}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-10 shrink-0 gap-1.5"
                                    disabled={locked}
                                    onClick={() => update('code', generateCouponCode(8, 'CP'))}
                                >
                                    <Sparkles className="h-3.5 w-3.5" />
                                    生成
                                </Button>
                            </div>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="coupon-description">说明（可选）</Label>
                        <Textarea
                            id="coupon-description"
                            value={form.description}
                            onChange={(event) => update('description', event.target.value)}
                            placeholder="后台备注或用户可见说明"
                            className="min-h-20 text-sm"
                        />
                    </div>
                </section>

                <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-5">
                    <h2 className="text-sm font-semibold text-foreground">优惠规则</h2>
                    <div className="flex flex-wrap gap-2">
                        {([
                            { value: 'percent', label: '百分比折扣' },
                            { value: 'fixed', label: '固定立减' },
                            { value: 'threshold_fixed', label: '满减' },
                        ] as const).map((option) => (
                            <Button
                                key={option.value}
                                type="button"
                                size="sm"
                                variant={form.discountType === option.value ? 'default' : 'outline'}
                                disabled={locked}
                                onClick={() => update('discountType', option.value)}
                            >
                                {option.label}
                            </Button>
                        ))}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        {form.discountType === 'percent' ? (
                            <div className="space-y-1.5">
                                <Label htmlFor="coupon-rate">折扣比例（按原价百分比支付）</Label>
                                <Input
                                    id="coupon-rate"
                                    inputMode="numeric"
                                    value={form.ratePercent}
                                    onChange={(event) => update('ratePercent', event.target.value.replace(/[^0-9]/g, ''))}
                                    placeholder="90 表示九折"
                                    className="h-10 text-sm"
                                    disabled={locked}
                                />
                            </div>
                        ) : (
                            <div className="space-y-1.5">
                                <Label htmlFor="coupon-discount">优惠金额（LDC）</Label>
                                <Input
                                    id="coupon-discount"
                                    inputMode="decimal"
                                    value={form.discountValue}
                                    onChange={(event) => update('discountValue', event.target.value)}
                                    placeholder="例如：20"
                                    className="h-10 text-sm"
                                    disabled={locked}
                                />
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-min-spend">
                                最低消费（LDC）{form.discountType === 'threshold_fixed' ? '' : '（可选）'}
                            </Label>
                            <Input
                                id="coupon-min-spend"
                                inputMode="decimal"
                                value={form.minSpendValue}
                                onChange={(event) => update('minSpendValue', event.target.value)}
                                placeholder={form.discountType === 'threshold_fixed' ? '例如：100' : '0 表示无门槛'}
                                className="h-10 text-sm"
                                disabled={locked}
                            />
                        </div>

                        {form.discountType === 'percent' && (
                            <div className="space-y-1.5">
                                <Label htmlFor="coupon-max-discount">最高优惠金额（LDC，可选）</Label>
                                <Input
                                    id="coupon-max-discount"
                                    inputMode="decimal"
                                    value={form.maxDiscountValue}
                                    onChange={(event) => update('maxDiscountValue', event.target.value)}
                                    placeholder="留空表示不封顶"
                                    className="h-10 text-sm"
                                    disabled={locked}
                                />
                            </div>
                        )}
                    </div>
                </section>

                <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-5">
                    <h2 className="text-sm font-semibold text-foreground">使用范围</h2>
                    <div className="flex flex-wrap gap-2">
                        {([
                            { value: 'all', label: '所有商品可用' },
                            { value: 'selected', label: '指定商品可用' },
                        ] as const).map((option) => (
                            <Button
                                key={option.value}
                                type="button"
                                size="sm"
                                variant={form.scope === option.value ? 'default' : 'outline'}
                                disabled={locked}
                                onClick={() => update('scope', option.value)}
                            >
                                {option.label}
                            </Button>
                        ))}
                    </div>
                    {form.scope === 'selected' && (
                        <CouponProductPicker
                            products={products}
                            selectedIds={form.productIds}
                            onChange={(ids) => update('productIds', ids)}
                            disabled={locked}
                        />
                    )}
                </section>

                <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-5">
                    <h2 className="text-sm font-semibold text-foreground">次数与叠加</h2>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-total-limit">总使用次数（留空为不限，1 即一次性券）</Label>
                            <Input
                                id="coupon-total-limit"
                                inputMode="numeric"
                                value={form.totalUseLimit}
                                onChange={(event) => update('totalUseLimit', event.target.value.replace(/[^0-9]/g, ''))}
                                placeholder="留空表示不限"
                                className="h-10 text-sm"
                                disabled={locked}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-per-user-limit">每人使用次数（留空为不限，需登录）</Label>
                            <Input
                                id="coupon-per-user-limit"
                                inputMode="numeric"
                                value={form.perUserLimit}
                                onChange={(event) => update('perUserLimit', event.target.value.replace(/[^0-9]/g, ''))}
                                placeholder="留空表示不限"
                                className="h-10 text-sm"
                                disabled={locked}
                            />
                        </div>
                    </div>
                    <div className="space-y-2.5">
                        <label className="flex cursor-pointer items-center gap-2.5 text-xs">
                            <Checkbox
                                checked={form.stackableWithCoupons}
                                disabled={locked}
                                onCheckedChange={(value) => update('stackableWithCoupons', Boolean(value))}
                            />
                            允许与其他优惠券叠加（每单最多 3 张）
                        </label>
                        <label className="flex cursor-pointer items-center gap-2.5 text-xs">
                            <Checkbox
                                checked={form.stackableWithPoints}
                                disabled={locked}
                                onCheckedChange={(value) => update('stackableWithPoints', Boolean(value))}
                            />
                            允许与积分抵扣同时使用
                        </label>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="coupon-refund-policy">退款时是否返还次数</Label>
                        <select
                            id="coupon-refund-policy"
                            className="h-10 w-full rounded-md border border-border/70 bg-background px-3 text-sm"
                            value={form.refundPolicy}
                            disabled={locked}
                            onChange={(event) => update('refundPolicy', event.target.value)}
                        >
                            <option value="unfulfilled_full_refund">未履约全额退款时返还（推荐）</option>
                            <option value="always">退款即返还</option>
                            <option value="never">不返还</option>
                        </select>
                    </div>
                </section>

                <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-5">
                    <h2 className="text-sm font-semibold text-foreground">有效期与状态</h2>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-starts-at">开始时间（可选）</Label>
                            <Input
                                id="coupon-starts-at"
                                type="datetime-local"
                                value={form.startsAtInput}
                                onChange={(event) => update('startsAtInput', event.target.value)}
                                className="h-10 text-sm"
                                disabled={locked}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="coupon-ends-at">结束时间（可选）</Label>
                            <Input
                                id="coupon-ends-at"
                                type="datetime-local"
                                value={form.endsAtInput}
                                onChange={(event) => update('endsAtInput', event.target.value)}
                                className="h-10 text-sm"
                                disabled={locked}
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant={form.status === 'active' ? 'default' : 'outline'} className="text-xs">
                            {form.status === 'active' ? '启用' : form.status === 'disabled' ? '停用' : '草稿'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                            保存后可在列表页启用或停用优惠券
                        </span>
                    </div>
                </section>

                <div className="flex items-center justify-end gap-2">
                    <Button asChild variant="outline" className="h-10">
                        <Link href="/admin/coupons">{t('common.cancel')}</Link>
                    </Button>
                    <Button
                        type="button"
                        className="h-10 min-w-32 gap-1.5"
                        onClick={handleSubmit}
                        disabled={pending}
                    >
                        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                        {mode === 'create' ? '保存为草稿' : '保存修改'}
                    </Button>
                </div>
            </div>
        </AdminPageShell>
    )
}
