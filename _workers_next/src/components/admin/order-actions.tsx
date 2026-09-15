'use client'

import Link from "next/link"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { markOrderDelivered, markOrderPaid, cancelOrder } from "@/actions/admin-orders"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"
import { CheckCircle, Truck, XCircle, ExternalLink } from "lucide-react"

export function AdminOrderActions({ order }: { order: any }) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)

  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && !!order.cardKey
  const canCancel = status === 'pending'

  const handle = async (action: 'paid' | 'delivered' | 'cancel') => {
    if (loadingRef.current) return
    try {
      loadingRef.current = true
      setLoading(true)
      if (action === 'paid') {
        if (!confirm(t('admin.orders.confirmMarkPaid'))) return
        await markOrderPaid(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'delivered') {
        if (!confirm(t('admin.orders.confirmMarkDelivered'))) return
        await markOrderDelivered(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'cancel') {
        if (!confirm(t('admin.orders.confirmCancel'))) return
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
