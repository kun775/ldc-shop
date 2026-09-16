'use client'

import { useRef, useState, useEffect } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
    CreditCard, 
    Package, 
    Clock, 
    AlertCircle, 
    CheckCircle2, 
    Loader2, 
    User,
    Eye,
    EyeOff,
    Copy,
    Check,
    Download,
    FileArchive,
    FileText,
    File,
    Zap,
    PackageOpen,
    ShieldCheck,
    ChevronRight
} from "lucide-react"
import { CopyButton } from "@/components/copy-button"
import { ClientDate } from "@/components/client-date"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { requestRefund } from "@/actions/refund-requests"
import { toast } from "sonner"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { checkOrderStatus, cancelPendingOrder } from "@/actions/order"
import { useRouter } from "next/navigation"
import { isPaymentOrder } from "@/lib/payment"
import { parseCheckoutFieldValues } from "@/lib/checkout-fields"
import { isManualFulfillment } from "@/lib/fulfillment"
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"
import { cn } from "@/lib/utils"

function formatFileSize(bytes: number) {
    if (!bytes || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function getFileIcon(fileName: string) {
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) {
        return <FileArchive className="h-5 w-5 text-indigo-500" />
    }
    if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(ext)) {
        return <FileText className="h-5 w-5 text-blue-500" />
    }
    return <File className="h-5 w-5 text-muted-foreground" />
}

interface Order {
    orderId: string
    productId?: string | null
    productName: string
    productVariantLabel?: string | null
    amount: string
    pointsUsed?: number | null
    quantity?: number | null
    status: string
    cardKey: string | null
    payee?: string | null
    createdAt: Date | null
    paidAt: Date | null
    deliveredAt?: Date | null
    checkoutFieldValues?: string | null
    fulfillmentMode?: string | null
    deliveryNote?: string | null
    deliveryFiles?: Array<{ id: number; fileName: string; size: number }>
}

interface OrderContentProps {
    order: Order
    canViewKey: boolean
    isOwner: boolean
    refundRequest: { status: string | null; reason: string | null; adminNote?: string | null } | null
}

export function OrderContent({ order, canViewKey, isOwner, refundRequest }: OrderContentProps) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const [reason, setReason] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [showKey, setShowKey] = useState(true)
    const [copiedLineIndex, setCopiedLineIndex] = useState<number | null>(null)
    const submitLock = useRef(false)
    const isPayment = isPaymentOrder(order.productId)
    const checkoutFieldValues = parseCheckoutFieldValues(order.checkoutFieldValues)
    const isManual = isManualFulfillment(order.fulfillmentMode)
    const deliveryFiles = order.deliveryFiles || []
    const paymentBreakdown = getOrderPaymentBreakdown({
        amount: order.amount,
        pointsUsed: order.pointsUsed
    })

    const cardLines = (order.cardKey || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)

    const currentStep = (() => {
        if (order.status === 'delivered') return 4
        if (order.status === 'paid') return 3
        if (order.status === 'pending') return 2
        return 1
    })()

    const transactionSuccessTime = order.deliveredAt || order.paidAt || order.createdAt
    const isRefundExpired = transactionSuccessTime
        ? (Date.now() - new Date(transactionSuccessTime).getTime() > 30 * 24 * 60 * 60 * 1000)
        : false

    const handleRefundConfirm = async () => {
        if (isRefundExpired) {
            toast.error(t('refund.refundExpired'))
            setConfirmOpen(false)
            return
        }
        if (submitLock.current) return
        submitLock.current = true
        setSubmitting(true)
        try {
            await requestRefund(order.orderId, reason)
            toast.success(t('refund.requested'))
            setConfirmOpen(false)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setSubmitting(false)
            submitLock.current = false
        }
    }

    const getStatusBadgeVariant = (status: string) => {
        switch (status) {
            case 'delivered': return 'default'
            case 'paid': return 'secondary'
            case 'refunded': return 'destructive'
            case 'cancelled': return 'secondary'
            default: return 'outline'
        }
    }

    const getStatusText = (status: string) => {
        return t(`order.status.${status}`) || status.toUpperCase()
    }

    const getStatusMessage = (status: string) => {
        switch (status) {
            case 'paid': return isPayment ? t('payment.paidMessage') : (isManual ? t('order.waitingManualDelivery') : t('order.stockDepleted'))
            case 'cancelled': return t('order.cancelledMessage')
            case 'refunded': return t('order.orderRefunded')
            default: return t('order.waitingPayment')
        }
    }

    // Auto-check status if pending
    const router = useRouter()

    // Check status on mount and polling
    useEffect(() => {
        if (order.status !== 'pending') return

        let mounted = true
        const check = async () => {
            try {
                const result = await checkOrderStatus(order.orderId)
                if (result.success && (result.status === 'paid' || result.status === 'delivered') && mounted) {
                    toast.success(t('order.paymentSuccess'))
                    router.refresh()
                }
            } catch (e) {
                console.error("Auto check failed", e)
            }
        }

        // Check immediately, then poll every 3s for 1 minute (20 times).
        void check()
        let attempts = 0
        const intervalId = setInterval(() => {
            if (attempts > 20) {
                clearInterval(intervalId)
                return
            }
            attempts++
            void check()
        }, 3000)

        return () => {
            mounted = false
            clearInterval(intervalId)
        }
    }, [order.status, order.orderId, router, t])

    return (
        <main className="container py-12 max-w-2xl">
            <Card className="tech-card overflow-hidden">
                <CardHeader className="relative">
                    {/* Status glow effect */}
                    {order.status === 'delivered' && (
                        <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-full blur-3xl" />
                    )}

                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="text-xl">{t('order.title')}</CardTitle>
                            <CardDescription className="font-mono text-xs bg-muted/50 px-2 py-1 rounded inline-block">
                                {order.orderId}
                            </CardDescription>
                        </div>
                        <Badge
                            variant={getStatusBadgeVariant(order.status)}
                            className={`uppercase text-xs tracking-wider ${order.status === 'delivered' ? 'bg-green-500/10 text-green-500 border-green-500/30' : ''}`}
                        >
                            {getStatusText(order.status)}
                        </Badge>
                    </div>
                </CardHeader>

                <CardContent className="space-y-6">
                    {/* 4 阶履约状态步进器 */}
                    <div className="rounded-2xl border border-border/50 bg-muted/20 p-4 space-y-3">
                        <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <span>履约流转进度</span>
                            <span className={cn(
                                "font-medium normal-case tracking-normal",
                                order.status === 'delivered' ? "text-emerald-600 dark:text-emerald-400" :
                                order.status === 'paid' ? "text-blue-600 dark:text-blue-400" :
                                order.status === 'pending' ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                            )}>
                                {order.status === 'delivered' ? "全部流程已完成" :
                                 order.status === 'paid' ? (isManual ? "等待商家人工交付" : "自动秒发交付中") :
                                 order.status === 'pending' ? "等待买家完成支付" : getStatusText(order.status)}
                            </span>
                        </div>
                        <div className="grid grid-cols-4 gap-2 pt-1">
                            {[
                                { step: 1, label: "提交订单", desc: "已生成" },
                                { step: 2, label: "支付核验", desc: order.status === 'pending' ? "待支付" : "已支付" },
                                { step: 3, label: isManual ? "人工交付" : "自动秒提", desc: order.status === 'delivered' ? "已完成" : order.status === 'paid' ? "履约中" : "待处理" },
                                { step: 4, label: "交付查验", desc: order.status === 'delivered' ? "已交付" : "待查验" }
                            ].map((s) => {
                                const isDone = currentStep > s.step || (currentStep === 4 && s.step === 4)
                                const isCurrent = currentStep === s.step && order.status !== 'delivered'
                                return (
                                    <div key={s.step} className="flex flex-col items-center text-center space-y-1.5">
                                        <div className={cn(
                                            "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all",
                                            isDone ? "bg-emerald-500 text-white shadow-xs" :
                                            isCurrent ? "bg-primary text-primary-foreground ring-4 ring-primary/20 animate-pulse" :
                                            "bg-muted border border-border/60 text-muted-foreground"
                                        )}>
                                            {isDone ? <Check className="h-3.5 w-3.5" /> : s.step}
                                        </div>
                                        <span className={cn(
                                            "text-xs font-semibold",
                                            isDone || isCurrent ? "text-foreground" : "text-muted-foreground/70"
                                        )}>
                                            {s.label}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground hidden sm:block">
                                            {s.desc}
                                        </span>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Info Cards */}
                    <div className="grid gap-4">
                        {/* Product Info */}
                        <div className="flex justify-between items-center p-4 bg-gradient-to-r from-muted/40 to-muted/20 rounded-xl border border-border/30">
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    {isPayment ? t('payment.itemLabel') : t('order.product')}
                                </p>
                                <p className="font-semibold">
                                    {isPayment ? t('payment.title') : order.productName}
                                    {!isPayment && order.productVariantLabel && (
                                        <span className="font-normal text-muted-foreground"> · {order.productVariantLabel}</span>
                                    )}
                                </p>
                            </div>
                            <div className="h-12 w-12 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
                                {isPayment ? (
                                    <CreditCard className="h-5 w-5 text-primary" />
                                ) : (
                                    <Package className="h-5 w-5 text-primary" />
                                )}
                            </div>
                        </div>

                        {isPayment && order.payee && (
                            <div className="flex justify-between items-center p-4 bg-gradient-to-r from-muted/40 to-muted/20 rounded-xl border border-border/30">
                                <div className="space-y-1">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                        {t('payment.payeeLabel')}
                                    </p>
                                    <p className="font-semibold">{order.payee}</p>
                                </div>
                                <div className="h-12 w-12 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
                                    <User className="h-5 w-5 text-primary" />
                                </div>
                            </div>
                        )}

                        {/* Amount Info */}
                        <div className="flex justify-between items-center p-4 bg-gradient-to-r from-muted/40 to-muted/20 rounded-xl border border-border/30">
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('order.amountPaid')}</p>
                                <p className="font-semibold text-xl">
                                    <span className="gradient-text">{paymentBreakdown.totalAmount}</span>
                                    <span className="text-xs font-normal text-muted-foreground ml-1.5">{t('common.credits')}</span>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t('admin.orders.ldcPaid')} {paymentBreakdown.ldcAmount} · {t('admin.orders.pointsDeduction')} {paymentBreakdown.pointsAmount} · {t('order.quantity')} {Number(order.quantity || 1)}
                                </p>
                            </div>
                            <div className="h-12 w-12 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
                                <CreditCard className="h-5 w-5 text-primary" />
                            </div>
                        </div>

                        {/* Time Info */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-4 bg-muted/20 rounded-xl border border-border/20">
                                <p className="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">{t('order.createdAt')}</p>
                                <p className="text-sm font-medium">
                                    <ClientDate value={order.createdAt} format="dateTime" placeholder="-" />
                                </p>
                            </div>
                            <div className="p-4 bg-muted/20 rounded-xl border border-border/20">
                                <p className="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">{t('order.paidAt')}</p>
                                <p className="text-sm font-medium">
                                    <ClientDate value={order.paidAt} format="dateTime" placeholder="-" />
                                </p>
                            </div>
                            <div className="p-4 bg-muted/20 rounded-xl border border-border/20">
                                <p className="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">{t('order.fulfillment')}</p>
                                <p className="text-sm font-medium">
                                    {isManual ? t('order.fulfillmentManual') : t('order.fulfillmentAuto')}
                                </p>
                            </div>
                            <div className="p-4 bg-muted/20 rounded-xl border border-border/20">
                                <p className="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">{t('order.deliveredAt')}</p>
                                <p className="text-sm font-medium">
                                    <ClientDate value={order.deliveredAt} format="dateTime" placeholder="-" />
                                </p>
                            </div>
                        </div>
                    </div>

                    {checkoutFieldValues.length > 0 && (
                        <div className="space-y-3 rounded-xl border border-border/30 bg-muted/20 p-4">
                            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                {t('order.checkoutFieldsTitle')}
                            </p>
                            <div className="space-y-2">
                                {checkoutFieldValues.map((field) => (
                                    <div key={field.id} className="flex items-start justify-between gap-4 text-sm">
                                        <span className="text-muted-foreground">{field.label}</span>
                                        <span className="font-medium text-right whitespace-pre-wrap">{field.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <Separator className="bg-border/50" />

                    {/* Content Display */}
                    {order.status === 'delivered' && !isPayment ? (
                        canViewKey ? (
                            <div className="space-y-4">
                                {isManual ? (
                                    <div className="space-y-4">
                                        <h3 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                                            <PackageOpen className="h-4 w-4 text-blue-500" />
                                            <span>{t('order.deliveryContent')}</span>
                                        </h3>

                                        {order.deliveryNote && (
                                            <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-2">
                                                <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400">
                                                    <PackageOpen className="h-3.5 w-3.5" />
                                                    <span>商家交付说明</span>
                                                </div>
                                                <p className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed pl-1">
                                                    {order.deliveryNote}
                                                </p>
                                            </div>
                                        )}

                                        {deliveryFiles.length > 0 && (
                                            <div className="space-y-2.5">
                                                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                                    <span>{t('order.deliveryFiles')}</span>
                                                    <span>共 {deliveryFiles.length} 个附件</span>
                                                </div>
                                                <div className="grid gap-2">
                                                    {deliveryFiles.map((file) => (
                                                        <div
                                                            key={file.id}
                                                            className="flex items-center justify-between p-3.5 rounded-xl border border-border/60 bg-muted/20 hover:bg-muted/40 transition-colors"
                                                        >
                                                            <div className="flex items-center gap-3 min-w-0 pr-3">
                                                                <div className="p-2.5 rounded-xl bg-background border border-border/40 shrink-0 shadow-2xs">
                                                                    {getFileIcon(file.fileName)}
                                                                </div>
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-semibold text-foreground truncate">{file.fileName}</p>
                                                                    <p className="text-xs text-muted-foreground font-mono">{formatFileSize(file.size)}</p>
                                                                </div>
                                                            </div>
                                                            <Button asChild size="sm" variant="outline" className="rounded-xl gap-1.5 text-xs shrink-0 font-medium hover:bg-primary hover:text-primary-foreground transition-all">
                                                                <a href={`/order/${order.orderId}/files/${file.id}`} download>
                                                                    <Download className="h-3.5 w-3.5" />
                                                                    <span>下载</span>
                                                                </a>
                                                            </Button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h3 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                                                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                                                <span>{t('order.yourContent')}</span>
                                                <span className="text-[11px] font-normal text-muted-foreground">
                                                    ({cardLines.length > 1 ? `共 ${cardLines.length} 行卡密` : "单行卡密"})
                                                </span>
                                            </h3>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setShowKey(!showKey)}
                                                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
                                                >
                                                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                                    <span>{showKey ? "隐藏" : "显示"}</span>
                                                </Button>
                                                <CopyButton text={order.cardKey || ''} />
                                            </div>
                                        </div>

                                        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 p-4 shadow-xl text-slate-100">
                                            {/* Terminal header */}
                                            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5 mb-3 text-xs">
                                                <div className="flex items-center gap-2">
                                                    <div className="flex gap-1.5">
                                                        <div className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                                                        <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
                                                        <div className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
                                                    </div>
                                                    <span className="font-mono text-[11px] text-slate-400 pl-1">
                                                        secret-terminal · {order.orderId.slice(0, 8)}
                                                    </span>
                                                </div>
                                                <span className="font-mono text-[10px] text-slate-500">
                                                    ENCRYPTED PAYLOAD
                                                </span>
                                            </div>

                                            {/* Terminal body */}
                                            {cardLines.length > 1 ? (
                                                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                                                    {cardLines.map((line, idx) => (
                                                        <div
                                                            key={idx}
                                                            className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/60 bg-slate-900/60 px-3 py-2 font-mono text-xs hover:border-slate-700/80 hover:bg-slate-900/90 transition-colors"
                                                        >
                                                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                                                <span className="text-[11px] font-bold text-slate-500 select-none">
                                                                    #{String(idx + 1).padStart(2, '0')}
                                                                </span>
                                                                <span className="text-slate-200 select-all break-all">
                                                                    {showKey ? line : '••••••••••••••••••••••••'}
                                                                </span>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(line)
                                                                    setCopiedLineIndex(idx)
                                                                    toast.success(`第 ${idx + 1} 行已复制`)
                                                                    setTimeout(() => setCopiedLineIndex(null), 2000)
                                                                }}
                                                                className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                                                                title="复制本行卡密"
                                                            >
                                                                {copiedLineIndex === idx ? (
                                                                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                                                                ) : (
                                                                    <Copy className="h-3.5 w-3.5" />
                                                                )}
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="p-3 font-mono text-sm break-all select-all text-slate-200 leading-relaxed bg-slate-900/50 rounded-xl border border-slate-800/60">
                                                    {showKey ? (order.cardKey || '-') : '••••••••••••••••••••••••••••••••••••••••'}
                                                </div>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
                                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                            <span>{t('order.saveKeySecurely')}</span>
                                        </p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="p-4 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-xl flex gap-3 text-sm border border-yellow-500/20">
                                <AlertCircle className="h-5 w-5 shrink-0" />
                                <p>{t('order.loginToView')}</p>
                            </div>
                        )
                    ) : (
                        <div className={`flex items-center justify-between gap-3 p-4 rounded-xl border ${order.status === 'paid'
                            ? (isPayment || isManual
                                ? 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20'
                                : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20')
                            : 'bg-muted/20 text-muted-foreground border-border/30'
                            }`}>
                            <div className="flex items-center gap-3">
                                {order.status === 'paid' ? (
                                    isPayment || isManual ? <CheckCircle2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />
                                ) : (
                                    <Clock className="h-5 w-5" />
                                )}
                                <p className="text-sm">{getStatusMessage(order.status)}</p>
                            </div>

                            {isOwner && order.status === 'pending' && (
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: t('order.cancelOrder'),
                                                description: t('order.confirmCancel'),
                                                variant: 'destructive',
                                                confirmText: t('order.cancelOrder'),
                                                cancelText: t('common.cancel'),
                                            })
                                            if (!ok) return
                                            if (submitLock.current) return
                                            submitLock.current = true
                                            setSubmitting(true)
                                            try {
                                                const result = await cancelPendingOrder(order.orderId)
                                                if (result.success) {
                                                    toast.success(t('order.cancelled'))
                                                    router.refresh()
                                                } else {
                                                    toast.error(result.error ? t(result.error) : t('common.error'))
                                                }
                                            } catch (e: any) {
                                                toast.error(e.message)
                                            } finally {
                                                setSubmitting(false)
                                                submitLock.current = false
                                            }
                                        }}
                                        disabled={submitting}
                                    >
                                        {t('order.cancelOrder')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={async () => {
                                            if (submitLock.current) return
                                            submitLock.current = true
                                            setSubmitting(true)
                                            try {
                                                const { getRetryPaymentParams } = await import("@/actions/checkout")
                                                const result = await getRetryPaymentParams(order.orderId)
                                                if (result.success && result.params) {
                                                    const form = document.createElement('form')
                                                    form.method = 'POST'
                                                    form.action = '/paying'
                                                    Object.entries(result.params).forEach(([k, v]) => {
                                                        const input = document.createElement('input')
                                                        input.type = 'hidden'
                                                        input.name = k
                                                        input.value = String(v)
                                                        form.appendChild(input)
                                                    })
                                                    document.body.appendChild(form)
                                                    form.submit()
                                                } else {
                                                    toast.error(result.error ? t(result.error) : t('common.error'))
                                                }
                                            } catch (e: any) {
                                                toast.error(e.message)
                                            } finally {
                                                setSubmitting(false)
                                                submitLock.current = false
                                            }
                                        }}
                                        disabled={submitting}
                                    >
                                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.payNow')}
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}

                    {isOwner && (order.status === 'paid' || order.status === 'delivered') && (
                        <>
                            <Separator className="bg-border/50" />
                            {refundRequest?.status && (
                                <div className="space-y-1">
                                    <h3 className="font-semibold">{t('refund.requestTitle')}</h3>
                                    <div className="text-sm text-muted-foreground">
                                        {t('refund.requestStatus', { status: t(`refund.statusValues.${refundRequest.status}`) })}
                                    </div>
                                    {refundRequest.adminNote && (
                                        <div className="text-sm text-muted-foreground">
                                            {t('refund.adminNote')}{refundRequest.adminNote}
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="flex gap-3">
                                {order.productId && !isPayment && (
                                    <Button
                                        variant="outline"
                                        className="flex-1"
                                        onClick={() => {
                                            window.location.href = `/buy/${order.productId}#reviews`
                                        }}
                                    >
                                        {t('order.goReview')}
                                    </Button>
                                )}
                                {Number(order.amount) > 0 && !refundRequest?.status && (
                                    isRefundExpired ? (
                                        <div className={cn(
                                            "flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground",
                                            order.productId && !isPayment ? "flex-1" : "w-full"
                                        )}>
                                            <Clock className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                                            <span>{t('refund.refundExpiredHint')}</span>
                                        </div>
                                    ) : (
                                        <Button
                                            variant="destructive"
                                            className={order.productId && !isPayment ? "flex-1" : "w-full"}
                                            onClick={() => setConfirmOpen(true)}
                                            disabled={submitting}
                                        >
                                            {t('refund.requestTitle')}
                                        </Button>
                                    )
                                )}
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>

            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-[440px] rounded-2xl">
                    <div className="bg-gradient-to-r from-destructive/15 via-destructive/5 to-transparent px-6 py-5 border-b border-border/40">
                        <DialogHeader className="gap-3 text-left">
                            <div className="flex items-center gap-3.5">
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive ring-1 ring-destructive/20 shadow-xs">
                                    <AlertCircle className="h-5 w-5" />
                                </div>
                                <div className="min-w-0 flex-1 space-y-0.5">
                                    <DialogTitle className="text-base font-bold tracking-tight text-foreground sm:text-lg">{t('refund.requestConfirmTitle')}</DialogTitle>
                                    <DialogDescription className="text-xs text-muted-foreground">
                                        {t('refund.requestConfirmMessage')}
                                    </DialogDescription>
                                </div>
                            </div>
                        </DialogHeader>
                    </div>
                    <div className="px-6 py-5 space-y-3">
                        <Textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder={t('refund.reasonPlaceholder')}
                            rows={3}
                            className="rounded-xl border-border/80 bg-background/80 text-sm focus-visible:ring-primary/40 resize-none"
                            disabled={submitting}
                        />
                    </div>
                    <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2 sm:gap-2">
                        <Button variant="outline" className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                            {t('common.cancel')}
                        </Button>
                        <Button variant="destructive" className="h-9 rounded-xl px-4 text-xs font-medium shadow-xs" onClick={handleRefundConfirm} disabled={submitting}>
                            {submitting ? t('common.processing') : t('common.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </main>
    )
}
