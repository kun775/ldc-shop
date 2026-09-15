'use client'

import Link from "next/link"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { markOrderDelivered, markOrderPaid, cancelOrder } from "@/actions/admin-orders"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"
import { CheckCircle, Truck, XCircle, ExternalLink } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog-provider"

export function AdminOrderActions({ order }: { order: any }) {
  const { t } = useI18n()
  const { confirm } = useConfirm()
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)

  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && !!order.cardKey
  const canCancel = status === 'pending'

  const handle = async (action: 'paid' | 'delivered' | 'cancel') => {
    if (loadingRef.current) return
    try {
      if (action === 'paid') {
        const ok = await confirm({
          title: t('admin.orders.markPaid') || "标记订单为已支付",
          description: t('admin.orders.confirmMarkPaid'),
          variant: 'default',
          icon: 'check',
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
        })
        if (!ok) return
        loadingRef.current = true
        setLoading(true)
        await markOrderPaid(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'delivered') {
        const ok = await confirm({
          title: t('admin.orders.markDelivered') || "标记订单为已发货",
          description: t('admin.orders.confirmMarkDelivered'),
          variant: 'default',
          icon: 'check',
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
        })
        if (!ok) return
        loadingRef.current = true
        setLoading(true)
        await markOrderDelivered(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'cancel') {
        const ok = await confirm({
          title: t('admin.orders.cancelOrder') || "取消订单",
          description: t('admin.orders.confirmCancel'),
          variant: 'destructive',
          icon: 'alert',
          confirmText: t('common.confirm'),
          cancelText: t('common.cancel'),
        })
        if (!ok) return
        loadingRef.current = true
        setLoading(true)
        await cancelOrder(order.orderId)
        toast.success(t('common.success'))
      }
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/80" title={t('admin.orders.view')}>
        <Link href={`/admin/orders/${order.orderId}`}>
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
      {canMarkPaid && (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/40" onClick={() => handle('paid')} title={t('admin.orders.markPaid')} disabled={loading}>
          <CheckCircle className="h-3.5 w-3.5" />
        </Button>
      )}
      {canMarkDelivered && (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" onClick={() => handle('delivered')} title={t('admin.orders.markDelivered')} disabled={loading}>
          <Truck className="h-3.5 w-3.5" />
        </Button>
      )}
      {canCancel && (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive/80 hover:text-destructive hover:bg-destructive/10" onClick={() => handle('cancel')} title={t('admin.orders.cancel')} disabled={loading}>
          <XCircle className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
