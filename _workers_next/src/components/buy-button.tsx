'use client'

import { useState, useEffect, useRef } from "react"
import { createOrder } from "@/actions/checkout"
import { getCouponFeatureFlag, previewCoupons } from "@/actions/coupons"
import type { CouponPreviewPayload } from "@/actions/coupons"
import { getUserPoints } from "@/actions/points"
import { calculatePointDiscountPreview } from "@/lib/points/product-point-discount"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Loader2, Coins, Mail, ShoppingBag, ShieldCheck, Ticket, X } from "lucide-react"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"
import { cn } from "@/lib/utils"

const MAX_COUPONS_PER_ORDER = 3

interface BuyButtonProps {
    productId: string
    price: string | number
    productName: string
    disabled?: boolean
    quantity?: number
    autoOpen?: boolean
    emailConfigured?: boolean
    answers?: string[]
    checkoutFieldValues?: Record<string, string>
    checkoutFieldsIncomplete?: boolean
    pointDiscountEnabled?: boolean
    pointDiscountPercent?: number
    className?: string
}

export function BuyButton({
    productId,
    price,
    productName,
    disabled,
    quantity = 1,
    autoOpen = false,
    emailConfigured = false,
    answers,
    checkoutFieldValues,
    checkoutFieldsIncomplete = false,
    pointDiscountEnabled = false,
    pointDiscountPercent = 0,
    className,
}: BuyButtonProps) {
    const [loading, setLoading] = useState(false)
    const [open, setOpen] = useState(false)
    const [points, setPoints] = useState(0)
    const [usePoints, setUsePoints] = useState(false)
    const [pointsLoading, setPointsLoading] = useState(false)
    const [hasAutoOpened, setHasAutoOpened] = useState(false)
    const [email, setEmail] = useState('')
    const [couponsEnabled, setCouponsEnabled] = useState(false)
    const [couponInput, setCouponInput] = useState('')
    const [appliedCodes, setAppliedCodes] = useState<string[]>([])
    const [couponPreview, setCouponPreview] = useState<CouponPreviewPayload | null>(null)
    const [couponError, setCouponError] = useState<string | null>(null)
    const [couponLoading, setCouponLoading] = useState(false)
    const isNavigatingRef = useRef(false)
    const { t } = useI18n()

    const numericalPrice = Number(price) * quantity
    const preview = calculatePointDiscountPreview({
        orderAmount: numericalPrice,
        availablePoints: points,
        usePoints: couponPreview ? couponPreview.pointsToUse > 0 : usePoints,
        pointDiscountEnabled,
        pointDiscountPercent,
    })

    const subtotalDisplay = couponPreview ? couponPreview.subtotalCents / 100 : numericalPrice
    const couponDiscountDisplay = couponPreview ? couponPreview.couponDiscountLdc : 0
    const pointsDiscountDisplay = couponPreview
        ? couponPreview.pointsDiscountLdc
        : (usePoints && preview.pointsToUse > 0 ? numericalPrice - preview.finalAmount : 0)
    const finalPrice = couponPreview ? couponPreview.finalAmountLdc : preview.finalAmount
    const pointsStackingBlocked = couponPreview ? !couponPreview.stackableWithPoints : false

    const openDialog = async () => {
        if (disabled) return
        setOpen(true)
        setPoints(0)
        setUsePoints(false)
        setPointsLoading(true)
        setCouponInput('')
        setAppliedCodes([])
        setCouponPreview(null)
        setCouponError(null)
        try {
            const [p, couponsOn] = await Promise.all([
                getUserPoints(),
                getCouponFeatureFlag(),
            ])
            setPoints(p)
            setCouponsEnabled(Boolean(couponsOn))
            setUsePoints(false)
        } catch (e) {
            console.error(e)
            setUsePoints(false)
        } finally {
            setPointsLoading(false)
        }
    }

    // Auto-open dialog when autoOpen is true (after warning confirmation)
    useEffect(() => {
        if (autoOpen && !hasAutoOpened && !disabled) {
            setHasAutoOpened(true)
            openDialog()
        }
    }, [autoOpen, hasAutoOpened, disabled])

    const handleInitialClick = async () => {
        if (checkoutFieldsIncomplete) {
            toast.error(t('buy.checkoutFieldsRequired'))
            const el = document.getElementById('checkout-fields-container')
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                el.classList.add('ring-2', 'ring-destructive', 'ring-offset-2')
                setTimeout(() => el.classList.remove('ring-2', 'ring-destructive', 'ring-offset-2'), 2500)
                const firstInput = el.querySelector('input, textarea, select') as HTMLElement | null
                if (firstInput) firstInput.focus()
            }
            return
        }
        await openDialog()
    }

    const refreshCouponPreview = async (codes: string[], usePointsValue: boolean): Promise<boolean> => {
        if (codes.length === 0) {
            setAppliedCodes([])
            setCouponPreview(null)
            setCouponError(null)
            return true
        }

        setCouponLoading(true)
        try {
            let result = await previewCoupons({
                productId,
                quantity,
                codes,
                usePoints: usePointsValue,
            })

            // 券不允许与积分叠加时，自动关闭积分再试一次，避免用户被迫手动取消
            let effectiveUsePoints = usePointsValue
            if (!result.success && result.error === 'coupon.errors.pointsConflict' && usePointsValue) {
                effectiveUsePoints = false
                result = await previewCoupons({
                    productId,
                    quantity,
                    codes,
                    usePoints: false,
                })
            }

            if (!result.success) {
                setCouponError(t(result.error))
                return false
            }

            setAppliedCodes(codes)
            setCouponPreview(result)
            setCouponError(null)
            if (!effectiveUsePoints || !result.stackableWithPoints) {
                setUsePoints(false)
            }
            return true
        } catch (couponPreviewError: any) {
            setCouponError(couponPreviewError?.message || t('common.error'))
            return false
        } finally {
            setCouponLoading(false)
        }
    }

    const handleApplyCoupon = async () => {
        const code = couponInput.trim().toUpperCase()
        if (!code) return
        if (appliedCodes.includes(code)) {
            setCouponError(t('coupon.errors.duplicateCode'))
            return
        }
        if (appliedCodes.length >= MAX_COUPONS_PER_ORDER) {
            setCouponError(t('coupon.errors.tooMany'))
            return
        }
        const applied = await refreshCouponPreview([...appliedCodes, code], usePoints)
        if (applied) {
            setCouponInput('')
        }
    }

    const handleRemoveCoupon = async (code: string) => {
        await refreshCouponPreview(appliedCodes.filter((item) => item !== code), usePoints)
    }

    const handleTogglePoints = async (next: boolean) => {
        if (appliedCodes.length === 0) {
            setUsePoints(next)
            return
        }
        const applied = await refreshCouponPreview(appliedCodes, next)
        if (applied && next) {
            setUsePoints(true)
        }
    }

    const handleBuy = async () => {
        if (isNavigatingRef.current) return

        try {
            setLoading(true)
            if (checkoutFieldsIncomplete) {
                toast.error(t('buy.checkoutFieldsRequired'))
                setLoading(false)
                return
            }
            const result = await createOrder(productId, quantity, email, usePoints, answers, checkoutFieldValues, appliedCodes)

            if (!result?.success) {
                const message = result?.error ? t(result.error) : t('common.error')
                toast.error(message)
                if (!isNavigatingRef.current) setLoading(false)
                return
            }

            if (result.isZeroPrice && result.url) {
                // Mark as navigating to prevent further state updates
                isNavigatingRef.current = true
                toast.success(t('buy.paymentSuccessPoints'))
                window.location.href = result.url
                return
            }

            const { params } = result

            if (!params) {
                toast.error(t('common.error'))
                if (!isNavigatingRef.current) setLoading(false)
                return
            }

            if (params) {
                // Mark as navigating to prevent React errors on Safari
                isNavigatingRef.current = true

                // Submit Form immediately without closing dialog
                const form = document.createElement('form')
                form.method = 'POST'
                form.action = '/paying'

                Object.entries(params as Record<string, any>).forEach(([k, v]) => {
                    const input = document.createElement('input')
                    input.type = 'hidden'
                    input.name = k
                    input.value = String(v)
                    form.appendChild(input)
                })

                document.body.appendChild(form)
                form.submit()
                return
            }

        } catch (e: any) {
            if (!isNavigatingRef.current) {
                toast.error(e.message || "Failed to create order")
                setLoading(false)
            }
        }
    }

    return (
        <>
            <Button
                size="lg"
                className={cn(
                    "h-12 w-full rounded-xl bg-primary px-6 font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/25 active:scale-[0.99] disabled:opacity-50",
                    className
                )}
                onClick={handleInitialClick}
                disabled={disabled}
            >
                {t('common.buyNow')}
            </Button>

            <Dialog open={open} onOpenChange={(v) => !isNavigatingRef.current && setOpen(v)}>
                <DialogContent className="rounded-2xl sm:max-w-md p-6">
                    <DialogHeader className="space-y-2.5">
                        <div className="flex items-center justify-between">
                            <DialogTitle className="text-xl font-bold tracking-tight text-foreground">
                                {t('common.buyNow')}
                            </DialogTitle>
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
                                <ShieldCheck className="h-3 w-3" />
                                安全收银台
                            </span>
                        </div>
                        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 p-3 text-sm">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                    <ShoppingBag className="h-4 w-4" />
                                </div>
                                <span className="font-semibold text-foreground truncate">{productName}</span>
                            </div>
                            <span className="shrink-0 rounded-md border border-border/50 bg-background/80 px-2 py-0.5 text-xs font-bold tabular-nums text-foreground/80">
                                x {quantity}
                            </span>
                        </div>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        {/* 邮箱信息 */}
                        <div className="space-y-1.5">
                            <Label htmlFor="checkout-email" className="flex items-center justify-between text-xs font-medium text-foreground">
                                <span>{emailConfigured ? t('buy.modal.emailLabelConfigured') : t('buy.modal.emailLabelUnconfigured')}</span>
                                <span className="text-[11px] text-muted-foreground">用于接收卡密/交付通知</span>
                            </Label>
                            <div className="relative">
                                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    id="checkout-email"
                                    type="email"
                                    placeholder="name@example.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="h-10 rounded-xl pl-9 text-sm"
                                />
                            </div>
                        </div>

                        {/* 优惠券 */}
                        {couponsEnabled && (
                            <div className="space-y-2 rounded-xl border border-border/60 bg-card/60 p-3.5">
                                <div className="flex items-center gap-2">
                                    <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
                                        <Ticket className="h-3.5 w-3.5" />
                                    </div>
                                    <span className="text-sm font-semibold text-foreground">{t('coupon.modal.title')}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        aria-label={t('coupon.modal.title')}
                                        placeholder={t('coupon.modal.placeholder')}
                                        value={couponInput}
                                        onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault()
                                                void handleApplyCoupon()
                                            }
                                        }}
                                        className="h-10 rounded-xl font-mono text-sm uppercase"
                                        disabled={couponLoading || appliedCodes.length >= MAX_COUPONS_PER_ORDER}
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="h-10 shrink-0 rounded-xl px-4 text-sm"
                                        onClick={() => void handleApplyCoupon()}
                                        disabled={couponLoading || !couponInput.trim()}
                                    >
                                        {couponLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('coupon.modal.apply')}
                                    </Button>
                                </div>
                                {appliedCodes.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {appliedCodes.map((code) => (
                                            <span
                                                key={code}
                                                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary"
                                            >
                                                {code}
                                                <button
                                                    type="button"
                                                    aria-label={`${t('coupon.modal.remove')} ${code}`}
                                                    className="rounded-full p-0.5 transition-colors hover:bg-primary/20"
                                                    onClick={() => void handleRemoveCoupon(code)}
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {pointsStackingBlocked && (
                                    <p className="text-[11px] leading-normal text-amber-600 dark:text-amber-400">
                                        {t('coupon.modal.pointsDisabled')}
                                    </p>
                                )}
                                {couponError && (
                                    <p className="text-[11px] leading-normal text-destructive">{couponError}</p>
                                )}
                            </div>
                        )}

                        {/* 积分抵扣卡片 */}
                        {preview.shouldShowPointOption && !pointsStackingBlocked && (
                            <div 
                                onClick={() => void handleTogglePoints(!usePoints)}
                                className={cn(
                                    "flex items-start gap-3 rounded-xl border p-3.5 cursor-pointer transition-all select-none",
                                    usePoints 
                                        ? "border-amber-500/40 bg-amber-500/10 shadow-2xs" 
                                        : "border-border/60 bg-card/60 hover:border-border hover:bg-muted/30"
                                )}
                            >
                                <div className={cn(
                                    "mt-0.5 shrink-0 rounded-lg p-2",
                                    usePoints ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground"
                                )}>
                                    <Coins className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex items-center justify-between">
                                        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                            {t('buy.modal.usePoints')}
                                            {usePoints && pointsDiscountDisplay > 0 && (
                                                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                                                    -¥{pointsDiscountDisplay.toFixed(2)}
                                                </span>
                                            )}
                                        </span>
                                        <input
                                            type="checkbox"
                                            id="use-points"
                                            checked={usePoints}
                                            onChange={(e) => {
                                                e.stopPropagation()
                                                void handleTogglePoints(e.target.checked)
                                            }}
                                            className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary focus:ring-primary"
                                        />
                                    </div>
                                    <p className="text-xs leading-normal text-muted-foreground">
                                        {t('buy.modal.pointDiscountSummary', {
                                            maxPoints: preview.maxDiscountPoints,
                                            percent: preview.pointDiscountPercent,
                                            available: points,
                                        })}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Stripe 风格费用明细账卡 */}
                        <div className="rounded-xl border border-border/60 bg-muted/20 p-3.5 space-y-2 text-sm">
                            <div className="flex justify-between items-center text-xs text-muted-foreground">
                                <span>{t('buy.modal.price')}</span>
                                <span className="tabular-nums font-medium text-foreground">¥{subtotalDisplay.toFixed(2)}</span>
                            </div>
                            {couponDiscountDisplay > 0 && (
                                <div className="flex justify-between items-center text-xs">
                                    <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                                        <Ticket className="h-3 w-3" />
                                        <span>{t('coupon.modal.discountLabel')}</span>
                                    </span>
                                    <span className="tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                                        -¥{couponDiscountDisplay.toFixed(2)}
                                    </span>
                                </div>
                            )}
                            {usePoints && pointsDiscountDisplay > 0 && (
                                <div className="flex justify-between items-center text-xs">
                                    <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                                        <Coins className="h-3 w-3" />
                                        <span>积分抵扣 ({couponPreview ? couponPreview.pointsToUse : preview.pointsToUse} 积分)</span>
                                    </span>
                                    <span className="tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                                        -¥{pointsDiscountDisplay.toFixed(2)}
                                    </span>
                                </div>
                            )}
                            <div className="pt-2 border-t border-border/50 flex justify-between items-baseline">
                                <span className="text-sm font-semibold text-foreground">{t('buy.modal.total')}</span>
                                <div className="flex items-baseline gap-1 text-primary">
                                    <span className="text-sm font-semibold">¥</span>
                                    <span className="text-2xl font-extrabold tabular-nums tracking-tight">
                                        {finalPrice.toFixed(2)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="gap-2 sm:gap-2 sm:justify-between pt-2">
                        <Button 
                            variant="outline" 
                            className="rounded-xl font-medium" 
                            onClick={() => setOpen(false)} 
                            disabled={loading}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button 
                            onClick={handleBuy} 
                            disabled={loading} 
                            className="rounded-xl bg-primary px-5 font-semibold text-primary-foreground shadow-md hover:bg-primary/90 flex items-center gap-1.5"
                        >
                            {loading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ShieldCheck className="h-4 w-4" />
                            )}
                            <span>{finalPrice === 0 ? t('buy.modal.payWithPoints') : t('buy.modal.proceedPayment')}</span>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
