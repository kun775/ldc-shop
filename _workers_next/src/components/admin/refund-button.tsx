'use client'

import { Button } from "@/components/ui/button"
import { markOrderRefunded, proxyRefund } from "@/actions/refund"
import { verifyOrderRefundStatus } from "@/actions/admin-orders"
import { useState } from "react"
import { toast } from "sonner"
import { Loader2, ExternalLink, CheckCircle, RefreshCcw, AlertTriangle } from "lucide-react"
import { useI18n } from "@/lib/i18n/context"
import { cn } from "@/lib/utils"
import { useConfirm } from "@/components/confirm-dialog-provider"

export function RefundButton({ order }: { order: any }) {
    const [loading, setLoading] = useState(false)
    const [showMarkDone, setShowMarkDone] = useState(false)
    const { t } = useI18n()
    const { confirm } = useConfirm()

    if (order.status !== 'delivered' && order.status !== 'paid') return null
    if (!order.tradeNo) return null
    if (Number(order.amount) <= 0) return null // No refund for orders paid entirely with points

    const completionTime = order.deliveredAt || order.paidAt || order.createdAt
    const isOver30Days = completionTime ? (Date.now() - new Date(completionTime).getTime() > 30 * 24 * 60 * 60 * 1000) : false

    const handleRefund = async () => {
        const confirmMsg = isOver30Days
            ? `${t('admin.orders.refundProxyConfirm')}\n\n⚠️ 提示：该订单交易成功已超过 30 天售后窗口，确认仍要执行退款吗？`
            : t('admin.orders.refundProxyConfirm')
        const ok = await confirm({
            title: t('admin.orders.refund') || "执行订单退款",
            description: confirmMsg,
            variant: isOver30Days ? 'warning' : 'destructive',
            confirmText: t('admin.orders.refund'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return
        setLoading(true)
        try {
            const result = await proxyRefund(order.orderId)
            if (result.processed) {
                toast.success(t('admin.orders.verifySuccessRefunded'))
            } else {
                toast.error(t('admin.orders.refundProxyNotProcessed'), { duration: 8000 })
                setShowMarkDone(true)
            }
        } catch (e: any) {
            toast.error(e.message || "Refund failed", { duration: 8000 })
            setShowMarkDone(true)
        } finally {
            setLoading(false)
        }
    }

    const handleMarkDone = async () => {
        const ok = await confirm({
            title: t('admin.orders.markRefunded') || "标记已退款",
            description: t('admin.orders.refundVerifyPlatform'),
            variant: 'default',
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return

        setLoading(true)
        try {
            await markOrderRefunded(order.orderId)
            toast.success(t('admin.orders.refundSuccess'))
            setShowMarkDone(false)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setLoading(false)
        }
    }

    const handleVerify = async () => {
        setLoading(true)
        try {
            const result = await verifyOrderRefundStatus(order.orderId)
            if (result.success) {
                if (result.status === 0) { // Refunded
                    toast.success(t('admin.orders.verifySuccessRefunded'))
                } else if (result.status === 1) { // Paid
                    toast.info(t('admin.orders.verifyInfoPaid'))
                    setShowMarkDone(true)
                } else {
                    toast.info(`${t('admin.orders.verifyStatus')}: ${result.msg}`)
                }
            } else {
                toast.error(result.error || t('common.error'))
            }
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex items-center gap-1">
            <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/80"
                onClick={handleVerify}
                disabled={loading}
                title={t('admin.orders.checkStatus')}
            >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            </Button>
            <Button
                variant="outline"
                size="sm"
                className={cn(
                    "h-7 px-2 text-xs gap-1 transition-colors",
                    isOver30Days
                        ? "text-muted-foreground/70 hover:text-foreground hover:bg-muted/60"
                        : "text-destructive/90 hover:text-destructive hover:bg-destructive/10 border-border/80"
                )}
                onClick={handleRefund}
                disabled={loading || showMarkDone}
                title={isOver30Days ? "⚠️ 交易成功已超 30 天售后时效" : undefined}
            >
                {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                    <>
                        {isOver30Days ? <AlertTriangle className="h-3 w-3 text-amber-500" /> : <ExternalLink className="h-3 w-3" />}
                        <span>{t('admin.orders.refund')}</span>
                    </>
                )}
            </Button>
            {showMarkDone && (
                <Button
                    variant="default"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs"
                    onClick={handleMarkDone}
                    disabled={loading}
                >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <><CheckCircle className="h-3 w-3" /><span>{t('admin.orders.markRefunded')}</span></>}
                </Button>
            )}
        </div>
    )
}
