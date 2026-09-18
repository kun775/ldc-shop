'use client'

import Link from "next/link"
import { AlertCircle, ArrowUpRight } from "lucide-react"
import { useI18n } from "@/lib/i18n/context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ClientDate } from "@/components/client-date"
import { CopyButton } from "@/components/copy-button"
import { parseCheckoutFieldValues } from "@/lib/checkout-fields"
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"
import { getAdminUserProfileUrl, getDisplayUsername } from "@/lib/user-profile-link"

export interface RefundOrderDetail {
  orderId: string
  orderRecordId: string | null
  orderStatus: string | null
  orderProductId: string | null
  productName: string | null
  orderUserId: string | null
  orderUsername: string | null
  email: string | null
  tradeNo: string | null
  cardKey: string | null
  amount: string | null
  pointsUsed: number | null
  quantity: number | null
  subtotalAmountCents: number | null
  couponDiscountAmountCents: number | null
  pointsDiscountAmountCents: number | null
  checkoutFieldValues: string | null
  fulfillmentMode: string | null
  deliveryNote: string | null
  orderCreatedAt: Date | null
  paidAt: Date | null
  deliveredAt: Date | null
}

function statusVariant(status: string | null) {
  switch (status) {
    case 'delivered': return 'default' as const
    case 'paid': return 'secondary' as const
    case 'refunded': return 'destructive' as const
    case 'cancelled': return 'secondary' as const
    default: return 'outline' as const
  }
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 border-b border-border/50 py-3 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{children}</dd>
    </div>
  )
}

export function RefundOrderDetailDialog({
  order,
  open,
  onOpenChange,
}: {
  order: RefundOrderDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const paymentBreakdown = order
    ? getOrderPaymentBreakdown({
        amount: order.amount,
        pointsUsed: order.pointsUsed,
        subtotalAmountCents: order.subtotalAmountCents,
        couponDiscountAmountCents: order.couponDiscountAmountCents,
        pointsDiscountAmountCents: order.pointsDiscountAmountCents,
      })
    : null
  const checkoutFieldValues = order ? parseCheckoutFieldValues(order.checkoutFieldValues) : []
  const userProfileUrl = getAdminUserProfileUrl(order?.orderUserId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('admin.refunds.orderDetailTitle')}</DialogTitle>
          <DialogDescription>{t('admin.refunds.orderDetailDescription')}</DialogDescription>
        </DialogHeader>

        {order && !order.orderRecordId ? (
          <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('admin.refunds.orderUnavailable')}</span>
          </div>
        ) : order && paymentBreakdown ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/60 py-3">
              <div className="min-w-0">
                <div className="font-mono text-sm font-semibold break-all">{order.orderId}</div>
                <div className="mt-1 text-xs text-muted-foreground">{order.productName || '-'}</div>
              </div>
              <Badge variant={statusVariant(order.orderStatus)} className="uppercase">
                {t(`order.status.${order.orderStatus || 'pending'}`)}
              </Badge>
            </div>

            <dl className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
              <DetailItem label={t('admin.orders.product')}>
                <div>{order.productName || '-'}</div>
                <div className="mt-0.5 font-mono text-xs font-normal text-muted-foreground">
                  {order.orderProductId || '-'}
                </div>
              </DetailItem>
              <DetailItem label={t('admin.refunds.quantity')}>
                {order.quantity || 1}
              </DetailItem>
              <DetailItem label={t('admin.orders.user')}>
                {order.orderUsername && userProfileUrl ? (
                  <Link href={userProfileUrl} className="text-primary hover:underline">
                    {getDisplayUsername(order.orderUsername, order.orderUserId)}
                  </Link>
                ) : order.orderUsername ? (
                  getDisplayUsername(order.orderUsername, order.orderUserId)
                ) : (
                  t('admin.orders.guest')
                )}
                {order.orderUserId && (
                  <div className="mt-0.5 font-mono text-xs font-normal text-muted-foreground break-all">
                    {order.orderUserId}
                  </div>
                )}
              </DetailItem>
              <DetailItem label={t('admin.orders.email')}>
                <span className="break-all">{order.email || '-'}</span>
              </DetailItem>
              <DetailItem label={t('admin.orders.tradeNo')}>
                {order.tradeNo ? <CopyButton text={order.tradeNo} compact /> : '-'}
              </DetailItem>
              <DetailItem label={t('admin.orders.fulfillmentTitle')}>
                {order.fulfillmentMode === 'manual'
                  ? t('admin.orders.fulfillmentManual')
                  : t('admin.orders.fulfillmentAuto')}
              </DetailItem>
            </dl>

            <section className="space-y-3 border-t border-border/60 pt-4">
              <h3 className="text-sm font-semibold">{t('admin.orders.paymentBreakdown')}</h3>
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2">
                {paymentBreakdown.hasCouponBreakdown && paymentBreakdown.subtotalAmount !== null && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">{t('admin.refunds.subtotal')}</span>
                    <span className="font-medium tabular-nums">{paymentBreakdown.subtotalAmount.toFixed(2)}</span>
                  </div>
                )}
                {paymentBreakdown.couponDiscountAmount > 0 && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">{t('admin.refunds.couponDiscount')}</span>
                    <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                      -{paymentBreakdown.couponDiscountAmount.toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.orders.ldcPaid')}</span>
                  <span className="font-medium tabular-nums">{paymentBreakdown.ldcAmount}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.orders.pointsDeduction')}</span>
                  <span className="font-medium tabular-nums">{paymentBreakdown.pointsAmount}</span>
                </div>
                <div className="flex items-center justify-between gap-4 sm:col-span-2 sm:border-t sm:border-border/50 sm:pt-2">
                  <span className="font-medium">{t('admin.orders.orderTotal')}</span>
                  <span className="font-semibold tabular-nums">{paymentBreakdown.totalAmount}</span>
                </div>
              </div>
            </section>

            {checkoutFieldValues.length > 0 && (
              <section className="space-y-3 border-t border-border/60 pt-4">
                <h3 className="text-sm font-semibold">{t('admin.orders.checkoutFieldsTitle')}</h3>
                <dl className="space-y-2 rounded-md border bg-muted/20 p-3">
                  {checkoutFieldValues.map((field) => (
                    <div key={field.id} className="flex items-start justify-between gap-4 text-sm">
                      <dt className="text-muted-foreground">{field.label}</dt>
                      <dd className="max-w-[65%] whitespace-pre-wrap text-right font-medium break-words">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {(order.deliveryNote || order.cardKey) && (
              <section className="space-y-3 border-t border-border/60 pt-4">
                <h3 className="text-sm font-semibold">{t('admin.orders.fulfillmentTitle')}</h3>
                {order.cardKey && (
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">{t('admin.orders.cardKey')}</span>
                    <CopyButton text={order.cardKey} compact />
                  </div>
                )}
                {order.deliveryNote && (
                  <p className="rounded-md border bg-muted/20 p-3 text-sm whitespace-pre-wrap break-words">
                    {order.deliveryNote}
                  </p>
                )}
              </section>
            )}

            <dl className="grid gap-x-6 border-t border-border/60 pt-4 sm:grid-cols-3">
              <DetailItem label={t('admin.orders.createdAt')}>
                <ClientDate value={order.orderCreatedAt} format="dateTime" placeholder="-" />
              </DetailItem>
              <DetailItem label={t('admin.orders.paidAt')}>
                <ClientDate value={order.paidAt} format="dateTime" placeholder="-" />
              </DetailItem>
              <DetailItem label={t('admin.orders.deliveredAt')}>
                <ClientDate value={order.deliveredAt} format="dateTime" placeholder="-" />
              </DetailItem>
            </dl>

            <DialogFooter>
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/orders/${order.orderId}`}>
                  {t('admin.refunds.viewFullOrder')}
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
