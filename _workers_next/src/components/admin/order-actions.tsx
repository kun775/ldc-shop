'use client'

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { markOrderDelivered, markOrderPaid, cancelOrder } from "@/actions/admin-orders"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"
import { CheckCircle, Truck, XCircle, ExternalLink } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"

export function AdminOrderActions({ order }: { order: any }) {
  const { t } = useI18n()
  const { confirm } = useConfirm()
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const mountedRef = useRef(true)
  const router = useRouter()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && !!order.cardKey
  const canCancel = status === 'pending'

  const handle = async (action: 'paid' | 'delivered' | 'cancel') => {
    if (loadingRef.current) return

    const confirmed = await confirm(
      action === 'paid'
        ? {
            title: t('admin.orders.markPaid') || "标记订单为已支付",
            description: t('admin.orders.confirmMarkPaid'),
            variant: 'default',
            icon: 'check',
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel'),
          }
        : action === 'delivered'
          ? {
              title: t('admin.orders.markDelivered') || "标记订单为已发货",
              description: t('admin.orders.confirmMarkDelivered'),
              variant: 'default',
              icon: 'check',
              confirmText: t('common.confirm'),
              cancelText: t('common.cancel'),
            }
          : {
              title: t('admin.orders.cancelOrder') || "取消订单",
              description: t('admin.orders.confirmCancel'),
              variant: 'destructive',
              icon: 'alert',
              confirmText: t('common.confirm'),
              cancelText: t('common.cancel'),
            }
    )
    if (!confirmed) return

    loadingRef.current = true
    setLoading(true)
    try {
      const result =
        action === 'paid'
          ? await markOrderPaid(order.orderId)
          : action === 'delivered'
            ? await markOrderDelivered(order.orderId)
            : await cancelOrder(order.orderId)

      if (!mountedRef.current) return
      if (result.ok) {
        toast.success(t('common.success'))
        router.refresh()
      } else if (result.errorId) {
        toast.error(`${t(result.errorKey)} · ${t('common.errorIdLabel')} ${result.errorId}`)
      } else {
        toast.error(t(result.errorKey))
      }
    } catch (error) {
      // Action 抛出的异常（网络中断等）同样必须释放按钮状态
      if (!mountedRef.current) return
      toast.error(t(resolveClientActionErrorKey(error)))
    } finally {
      loadingRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="sm" className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/80" title={t('admin.orders.view')}>
        <Link href={`/admin/orders/${order.orderId}`} aria-label={t('admin.orders.view')}>
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
      {canMarkPaid && (
        <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/40" onClick={() => handle('paid')} title={t('admin.orders.markPaid')} aria-label={t('admin.orders.markPaid')} disabled={loading}>
          <CheckCircle className="h-3.5 w-3.5" />
        </Button>
      )}
      {canMarkDelivered && (
        <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" onClick={() => handle('delivered')} title={t('admin.orders.markDelivered')} aria-label={t('admin.orders.markDelivered')} disabled={loading}>
          <Truck className="h-3.5 w-3.5" />
        </Button>
      )}
      {canCancel && (
        <Button variant="ghost" size="sm" className="h-9 w-9 p-0 text-destructive/80 hover:text-destructive hover:bg-destructive/10" onClick={() => handle('cancel')} title={t('admin.orders.cancel')} aria-label={t('admin.orders.cancel')} disabled={loading}>
          <XCircle className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
