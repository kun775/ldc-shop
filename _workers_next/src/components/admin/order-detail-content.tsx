'use client'

import Link from "next/link"
import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useI18n } from "@/lib/i18n/context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyButton } from "@/components/copy-button"
import { ClientDate } from "@/components/client-date"
import { RefundButton } from "@/components/admin/refund-button"
import { toast } from "sonner"
import { markOrderDelivered, markOrderPaid, cancelOrder, updateOrderEmail, deleteOrder } from "@/actions/admin-orders"
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"
import { parseCheckoutFieldValues } from "@/lib/checkout-fields"
import { isManualFulfillment } from "@/lib/fulfillment"
import { Textarea } from "@/components/ui/textarea"

function statusVariant(status: string | null) {
  switch (status) {
    case 'delivered': return 'default' as const
    case 'paid': return 'secondary' as const
    case 'refunded': return 'destructive' as const
    case 'cancelled': return 'secondary' as const
    default: return 'outline' as const
  }
}

export function AdminOrderDetailContent({ order }: { order: any }) {
  const { t } = useI18n()
  const router = useRouter()
  const paymentBreakdown = getOrderPaymentBreakdown({
    amount: order.amount,
    pointsUsed: order.pointsUsed
  })
  const checkoutFieldValues = parseCheckoutFieldValues(order.checkoutFieldValues)
  const [email, setEmail] = useState(order.email || '')
  const [savingEmail, setSavingEmail] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [deliveryNote, setDeliveryNote] = useState(order.deliveryNote || '')
  const actionLock = useRef(false)
  const deliveryFormRef = useRef<HTMLFormElement | null>(null)
  const isManual = isManualFulfillment(order.fulfillmentMode)
  const deliveryFiles = Array.isArray(order.deliveryFiles) ? order.deliveryFiles : []

  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && (isManual || !!order.cardKey)
  const canCancel = status === 'pending'
  const canDelete = true

  const handleStatus = async (action: 'paid' | 'delivered' | 'cancel') => {
    if (actionLock.current) return
    try {
      actionLock.current = true
      setActionLoading(true)
      if (action === 'paid') {
        if (!confirm(t('admin.orders.confirmMarkPaid'))) return
        await markOrderPaid(order.orderId)
        toast.success(t('common.success'))
        return
      }
      if (action === 'delivered') {
        if (!confirm(t('admin.orders.confirmMarkDelivered'))) return
        const formData = isManual ? new FormData(deliveryFormRef.current || undefined) : undefined
        if (isManual) formData?.set('deliveryNote', deliveryNote)
        await markOrderDelivered(order.orderId, formData)
        toast.success(t('common.success'))
        router.refresh()
        return
      }
      if (action === 'cancel') {
        if (!confirm(t('admin.orders.confirmCancel'))) return
        await cancelOrder(order.orderId)
        toast.success(t('common.success'))
      }
    } catch (e: any) {
      const message = typeof e?.message === 'string' && e.message.startsWith('admin.orders.')
        ? t(e.message)
        : e.message
      toast.error(message)
    } finally {
      setActionLoading(false)
      actionLock.current = false
    }
  }

  const handleSaveEmail = async () => {
    setSavingEmail(true)
    try {
      await updateOrderEmail(order.orderId, email)
      toast.success(t('common.success'))
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSavingEmail(false)
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('admin.orders.detailTitle')}</h1>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{order.orderId}</span>
            <Badge variant={statusVariant(order.status)} className="uppercase text-xs">{t(`order.status.${status}`)}</Badge>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link href="/admin/orders">{t('common.back')}</Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('admin.orders.detail')}</CardTitle>
          <div className="flex items-center gap-2">
            {canMarkPaid && (
              <Button variant="outline" onClick={() => handleStatus('paid')} disabled={actionLoading}>{t('admin.orders.markPaid')}</Button>
            )}
            {canMarkDelivered && !isManual && (
              <Button variant="outline" onClick={() => handleStatus('delivered')} disabled={actionLoading}>{t('admin.orders.markDelivered')}</Button>
            )}
            {canCancel && (
              <Button variant="destructive" onClick={() => handleStatus('cancel')} disabled={actionLoading}>{t('admin.orders.cancel')}</Button>
            )}
            {canDelete && (
              <Button
                variant="destructive"
                onClick={async () => {
                  if (actionLock.current) return
                  if (!confirm(t('admin.orders.confirmDelete'))) return
                  actionLock.current = true
                  setActionLoading(true)
                  try {
                    await deleteOrder(order.orderId)
                    toast.success(t('common.success'))
                    router.push('/admin/orders')
                  } catch (e: any) {
                    toast.error(e.message)
                  } finally {
                    setActionLoading(false)
                    actionLock.current = false
                  }
                }}
                disabled={actionLoading}
              >
                {t('admin.orders.delete')}
              </Button>
            )}
            <RefundButton order={order} />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.product')}</div>
              <div className="font-medium">
                {order.productName}
                {order.productVariantLabel && <span className="text-muted-foreground font-normal"> · {order.productVariantLabel}</span>}
              </div>
              <div className="text-xs text-muted-foreground font-mono">{order.productId}</div>
            </div>

            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">{t('admin.orders.paymentBreakdown')}</div>
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{t('admin.orders.ldcPaid')}</span>
                  <span className="font-medium">{paymentBreakdown.ldcAmount}</span>
                </div>
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{t('admin.orders.pointsDeduction')}</span>
                  <span className="font-medium">{paymentBreakdown.pointsAmount}</span>
                </div>
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{t('admin.orders.orderTotal')}</span>
                  <span className="font-semibold">{paymentBreakdown.totalAmount}</span>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.user')}</div>
              {order.username ? (
                <a
                  href={getExternalProfileUrl(order.username, order.userId) || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-sm hover:underline text-primary"
                >
                  {getDisplayUsername(order.username, order.userId)}
                </a>
              ) : (
                <div className="font-medium text-sm text-muted-foreground">Guest</div>
              )}
              {order.userId && <div className="text-xs text-muted-foreground font-mono">{order.userId}</div>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="order-email">{t('admin.orders.email')}</Label>
              <div className="flex gap-2">
                <Input
                  id="order-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('admin.orders.emailPlaceholder')}
                />
                <Button variant="outline" onClick={handleSaveEmail} disabled={savingEmail}>
                  {savingEmail ? t('common.processing') : t('common.save')}
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.tradeNo')}</div>
              {order.tradeNo ? <CopyButton text={order.tradeNo} /> : <div className="text-muted-foreground">-</div>}
            </div>

            {!isManual && (
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.cardKey')}</div>
              {order.cardKey ? <CopyButton text={order.cardKey} /> : <div className="text-muted-foreground">-</div>}
            </div>
            )}

            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.createdAt')}</div>
              <div className="text-sm"><ClientDate value={order.createdAt} format="dateTime" /></div>
            </div>

            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.paidAt')}</div>
              <div className="text-sm"><ClientDate value={order.paidAt} format="dateTime" /></div>
            </div>

            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('admin.orders.deliveredAt')}</div>
              <div className="text-sm"><ClientDate value={order.deliveredAt} format="dateTime" /></div>
            </div>
          </div>

          {checkoutFieldValues.length > 0 && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <div className="text-sm font-medium">{t('admin.orders.checkoutFieldsTitle')}</div>
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

          <div className="space-y-3 rounded-md border bg-muted/30 p-4">
            <div className="text-sm font-medium">{t('admin.orders.fulfillmentTitle')}</div>
            <div className="text-sm text-muted-foreground">
              {isManual ? t('admin.orders.fulfillmentManual') : t('admin.orders.fulfillmentAuto')}
            </div>
            {isManual && status === 'paid' && (
              <form ref={deliveryFormRef} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="deliveryNote">{t('admin.orders.deliveryNote')}</Label>
                  <Textarea
                    id="deliveryNote"
                    name="deliveryNote"
                    value={deliveryNote}
                    onChange={(event) => setDeliveryNote(event.target.value)}
                    placeholder={t('admin.orders.deliveryNotePlaceholder')}
                    className="min-h-28"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deliveryFiles">{t('admin.orders.deliveryFiles')}</Label>
                  <Input id="deliveryFiles" name="deliveryFiles" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.zip,.7z" />
                  <p className="text-xs text-muted-foreground">{t('admin.orders.deliveryFilesHint')}</p>
                </div>
                <Button type="button" onClick={() => handleStatus('delivered')} disabled={actionLoading}>
                  {t('admin.orders.deliverNow')}
                </Button>
              </form>
            )}
            {(order.deliveryNote || deliveryFiles.length > 0) && (
              <div className="space-y-2">
                {order.deliveryNote && <p className="whitespace-pre-wrap text-sm">{order.deliveryNote}</p>}
                {deliveryFiles.map((file: any) => (
                  <a
                    key={file.id}
                    href={`/order/${order.orderId}/files/${file.id}`}
                    className="block text-sm text-primary hover:underline"
                  >
                    {file.fileName}
                  </a>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
