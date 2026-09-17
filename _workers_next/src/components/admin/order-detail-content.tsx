'use client'

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
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
import { AdminPageShell } from "@/components/admin/admin-page-shell"
import { toast } from "sonner"
import { markOrderDelivered, markOrderPaid, cancelOrder, updateOrderEmail, deleteOrder, type OrderActionResult } from "@/actions/admin-orders"
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"
import { parseCheckoutFieldValues } from "@/lib/checkout-fields"
import { isManualFulfillment } from "@/lib/fulfillment"
import { Textarea } from "@/components/ui/textarea"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { 
  Zap, 
  PackageOpen, 
  Download, 
  FileArchive, 
  FileText, 
  File, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Trash2, 
  Check, 
  ArrowLeft, 
  Send,
  Loader2
} from "lucide-react"
import { cn } from "@/lib/utils"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"

/**
 * 提交状态机：同一时刻只允许一个显式状态，禁止再用多个互不关联的布尔值
 * 控制同一个遮罩（历史上并存的 loading/disabled 布尔值正是遮罩卡死的成因）。
 *
 *   idle → submitting → success | error → idle
 *
 * success 只是瞬时状态，用于播报成功反馈后立即回到 idle；
 * error 会保留在界面上直到管理员处理（重试或修改输入），因此必须同时
 * 解除按钮禁用与遮罩，保证页面可以继续操作。
 */
type SubmitPhase = 'idle' | 'submitting' | 'success' | 'error'

function formatFileSize(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) {
    return <FileArchive className="h-4 w-4 text-indigo-500" />
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(ext)) {
    return <FileText className="h-4 w-4 text-blue-500" />
  }
  return <File className="h-4 w-4 text-muted-foreground" />
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

export function AdminOrderDetailContent({ order }: { order: any }) {
  const { t } = useI18n()
  const { confirm } = useConfirm()
  const router = useRouter()
  const paymentBreakdown = getOrderPaymentBreakdown({
    amount: order.amount,
    pointsUsed: order.pointsUsed,
    subtotalAmountCents: order.subtotalAmountCents,
    couponDiscountAmountCents: order.couponDiscountAmountCents,
    pointsDiscountAmountCents: order.pointsDiscountAmountCents
  })
  const checkoutFieldValues = parseCheckoutFieldValues(order.checkoutFieldValues)
  const [email, setEmail] = useState(order.email || '')
  const [savingEmail, setSavingEmail] = useState(false)
  const [phase, setPhase] = useState<SubmitPhase>('idle')
  const [submitError, setSubmitError] = useState<{ key: string; errorId: string } | null>(null)
  const [deliveryNote, setDeliveryNote] = useState(order.deliveryNote || '')
  // 同步锁：setState 是异步的，连续快速点击仍可能穿过 phase 判断，必须用 ref 兜住
  const submitLock = useRef(false)
  // 组件卸载后忽略迟到响应，避免对已卸载界面写状态
  const mountedRef = useRef(true)
  const deliveryFormRef = useRef<HTMLFormElement | null>(null)
  const isManual = isManualFulfillment(order.fulfillmentMode)
  const deliveryFiles = Array.isArray(order.deliveryFiles) ? order.deliveryFiles : []

  const isSubmitting = phase === 'submitting'
  const status = order.status || 'pending'
  const canMarkPaid = status === 'pending'
  const canMarkDelivered = status === 'paid' && (isManual || !!order.cardKey)
  const canCancel = status === 'pending'
  const canDelete = true

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 统一的提交执行器：成功、业务失败、网络失败、异常抛出后都必须释放状态 */
  const runSubmit = async (runner: () => Promise<OrderActionResult>) => {
    if (submitLock.current) return
    submitLock.current = true
    setSubmitError(null)
    setPhase('submitting')
    try {
      const result = await runner()
      if (!mountedRef.current) return
      if (result.ok) {
        setPhase('success')
      } else {
        setPhase('error')
        setSubmitError({ key: result.errorKey, errorId: result.errorId })
        if (result.errorId) {
          toast.error(`${t(result.errorKey)} · ${t('common.errorIdLabel')} ${result.errorId}`)
        } else {
          toast.error(t(result.errorKey))
        }
      }
    } catch (error) {
      // Server Action 抛出的异常（网络中断、Action 未捕获的异常）也必须落到 error 态，
      // 否则遮罩会永久停留。
      if (!mountedRef.current) return
      const errorKey = resolveClientActionErrorKey(error)
      setPhase('error')
      setSubmitError({ key: errorKey, errorId: '' })
      toast.error(t(errorKey))
    } finally {
      submitLock.current = false
      if (mountedRef.current) {
        setPhase((current) => (current === 'submitting' ? 'idle' : current))
      }
    }
  }

  const handleStatus = async (action: 'paid' | 'delivered' | 'cancel') => {
    if (submitLock.current) return

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
      await runSubmit(async () => {
        const result = await markOrderPaid(order.orderId)
        if (result.ok) {
          toast.success(t('common.success'))
          router.refresh()
        }
        return result
      })
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
      await runSubmit(async () => {
        // 手动发货必须带上正文与附件；失败时保留 deliveryNote state，不清空输入
        const formData = isManual ? new FormData(deliveryFormRef.current || undefined) : undefined
        if (isManual) formData?.set('deliveryNote', deliveryNote)
        const result = await markOrderDelivered(order.orderId, formData)
        if (result.ok) {
          toast.success(t('admin.orders.deliverySuccess'))
          router.refresh()
        }
        return result
      })
      return
    }

    const ok = await confirm({
      title: t('admin.orders.cancelOrder') || "取消订单",
      description: t('admin.orders.confirmCancel'),
      variant: 'destructive',
      icon: 'alert',
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
    await runSubmit(async () => {
      const result = await cancelOrder(order.orderId)
      if (result.ok) {
        toast.success(t('common.success'))
        router.refresh()
      }
      return result
    })
  }

  const handleSaveEmail = async () => {
    if (savingEmail) return
    setSavingEmail(true)
    try {
      const result = await updateOrderEmail(order.orderId, email)
      if (!mountedRef.current) return
      if (result.ok) {
        toast.success(t('common.success'))
      } else {
        toast.error(result.errorId ? `${t(result.errorKey)} · ${result.errorId}` : t(result.errorKey))
      }
    } catch (error) {
      if (!mountedRef.current) return
      toast.error(t(resolveClientActionErrorKey(error)))
    } finally {
      if (mountedRef.current) setSavingEmail(false)
    }
  }

  const handleDelete = async () => {
    if (submitLock.current) return
    const ok = await confirm({
      title: t('admin.orders.delete') || "删除订单",
      description: t('admin.orders.confirmDelete'),
      variant: 'destructive',
      icon: 'trash',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
    await runSubmit(async () => {
      const result = await deleteOrder(order.orderId)
      if (result.ok) {
        toast.success(t('common.success'))
        router.push('/admin/orders')
      }
      return result
    })
  }

  return (
    <AdminPageShell className="space-y-6 p-0.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin.orders.detailTitle')}</h1>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-md">{order.orderId}</span>
            <Badge variant={statusVariant(order.status)} className="uppercase text-xs font-semibold gap-1">
              {order.status === 'delivered' ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> :
               order.status === 'paid' ? <Clock className="h-3 w-3 text-blue-500" /> :
               <AlertCircle className="h-3 w-3" />}
              <span>{t(`order.status.${status}`)}</span>
            </Badge>
          </div>
        </div>
        <Button asChild variant="outline" className="rounded-xl gap-1.5 text-xs">
          <Link href="/admin/orders">
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{t('common.back')}</span>
          </Link>
        </Button>
      </div>

      <Card className="tech-card border-border/50">
        <CardHeader className="flex flex-row items-center justify-between border-b border-border/40 pb-4">
          <CardTitle className="text-base font-semibold">{t('admin.orders.detail')}</CardTitle>
          <div className="flex items-center gap-2">
            {canMarkPaid && (
              <Button 
                variant="default" 
                size="sm" 
                className="rounded-xl gap-1.5 text-xs font-medium" 
                onClick={() => handleStatus('paid')} 
                disabled={isSubmitting}
              >
                {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                <span>{t('admin.orders.markPaid')}</span>
              </Button>
            )}
            {canMarkDelivered && !isManual && (
              <Button 
                variant="outline" 
                size="sm" 
                className="rounded-xl gap-1.5 text-xs font-medium" 
                onClick={() => handleStatus('delivered')} 
                disabled={isSubmitting}
              >
                <Zap className="h-3.5 w-3.5 text-primary" />
                <span>{t('admin.orders.markDelivered')}</span>
              </Button>
            )}
            {canCancel && (
              <Button 
                variant="outline" 
                size="sm" 
                className="rounded-xl text-destructive hover:bg-destructive/10 text-xs font-medium" 
                onClick={() => handleStatus('cancel')} 
                disabled={isSubmitting}
              >
                {t('admin.orders.cancel')}
              </Button>
            )}
            <RefundButton order={order} />
            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs"
                onClick={handleDelete}
                disabled={isSubmitting}
                title={t('admin.orders.delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
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
                {paymentBreakdown.hasCouponBreakdown && paymentBreakdown.subtotalAmount !== null && (
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">商品小计</span>
                    <span className="font-medium tabular-nums">{paymentBreakdown.subtotalAmount.toFixed(2)}</span>
                  </div>
                )}
                {paymentBreakdown.couponDiscountAmount > 0 && (
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">优惠券优惠</span>
                    <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                      -{paymentBreakdown.couponDiscountAmount.toFixed(2)}
                    </span>
                  </div>
                )}
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

          <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isManual ? (
                  <PackageOpen className="h-4 w-4 text-blue-500" />
                ) : (
                  <Zap className="h-4 w-4 text-primary" />
                )}
                <span className="font-semibold text-sm text-foreground">{t('admin.orders.fulfillmentTitle')}</span>
              </div>
              <Badge variant="outline" className={cn(
                "rounded-md text-xs font-medium",
                isManual ? "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400" : "border-primary/30 bg-primary/10 text-primary"
              )}>
                {isManual ? t('admin.orders.fulfillmentManual') : t('admin.orders.fulfillmentAuto')}
              </Badge>
            </div>

            {isManual && status === 'paid' && (
              <div className="relative rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-4">
                {/* 提交遮罩限定在当前业务卡片内，使用 absolute 而非 fixed：
                    不会盖住页面级 Loading（z-[90]），也不会在视觉消失后残留拦截点击。
                    错误态下自动收起，管理员可以立即修改内容重试。 */}
                {isSubmitting && (
                  <div
                    data-delivery-overlay="true"
                    role="status"
                    aria-live="polite"
                    aria-busy="true"
                    className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/80 backdrop-blur-[2px] motion-reduce:backdrop-blur-none"
                  >
                    <Loader2 className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none" />
                    <span className="text-xs text-muted-foreground">{t('admin.orders.delivering')}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-700 dark:text-blue-300">
                  <PackageOpen className="h-4 w-4" />
                  <span>手动发货履约工作台 · 待商家交付</span>
                </div>
                <form ref={deliveryFormRef} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="deliveryNote" className="text-xs font-medium text-foreground">
                      {t('admin.orders.deliveryNote')}
                    </Label>
                    <Textarea
                      id="deliveryNote"
                      name="deliveryNote"
                      value={deliveryNote}
                      onChange={(event) => setDeliveryNote(event.target.value)}
                      placeholder={t('admin.orders.deliveryNotePlaceholder')}
                      className="min-h-24 rounded-xl text-sm"
                      disabled={isSubmitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="deliveryFiles" className="text-xs font-medium text-foreground">
                      {t('admin.orders.deliveryFiles')}
                    </Label>
                    <div className="rounded-xl border border-dashed border-border/80 bg-background/50 p-4 text-center space-y-2">
                      <Input 
                        id="deliveryFiles" 
                        name="deliveryFiles" 
                        type="file" 
                        multiple 
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.zip,.7z" 
                        className="cursor-pointer file:cursor-pointer rounded-lg text-xs"
                        disabled={isSubmitting}
                      />
                      <p className="text-xs text-muted-foreground">{t('admin.orders.deliveryFilesHint')}</p>
                    </div>
                  </div>
                  {submitError && (
                    <div
                      role="alert"
                      className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive space-y-1"
                    >
                      <p className="font-medium">{t(submitError.key)}</p>
                      {submitError.errorId && (
                        <p className="font-mono text-[11px] text-destructive/80">
                          {t('common.errorIdLabel')}: {submitError.errorId}
                        </p>
                      )}
                    </div>
                  )}
                  <Button 
                    type="button" 
                    onClick={() => handleStatus('delivered')} 
                    disabled={isSubmitting}
                    className="rounded-xl bg-primary font-semibold text-primary-foreground hover:bg-primary/90 gap-1.5"
                  >
                    {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span>{isSubmitting ? t('admin.orders.delivering') : t('admin.orders.deliverNow')}</span>
                  </Button>
                </form>
              </div>
            )}

            {(order.deliveryNote || deliveryFiles.length > 0) && (
              <div className="space-y-3 pt-1">
                {order.deliveryNote && (
                  <div className="rounded-xl border border-border/60 bg-background/60 p-3.5 space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">已发说明：</span>
                    <p className="whitespace-pre-wrap text-sm text-foreground/90 leading-relaxed pl-1">{order.deliveryNote}</p>
                  </div>
                )}
                {deliveryFiles.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">交付附件清单 ({deliveryFiles.length})：</span>
                    <div className="grid gap-2">
                      {deliveryFiles.map((file: any) => (
                        <div key={file.id} className="flex items-center justify-between p-3 rounded-xl border border-border/60 bg-background/60">
                          <div className="flex items-center gap-2.5 min-w-0 pr-2">
                            <div className="p-2 rounded-lg bg-muted border border-border/40 shrink-0">
                              {getFileIcon(file.fileName)}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{file.fileName}</p>
                              {file.size && <p className="text-xs text-muted-foreground font-mono">{formatFileSize(file.size)}</p>}
                            </div>
                          </div>
                          <Button asChild size="sm" variant="outline" className="rounded-xl gap-1.5 text-xs shrink-0 font-medium">
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
            )}
          </div>
        </CardContent>
      </Card>
    </AdminPageShell>
  )
}
