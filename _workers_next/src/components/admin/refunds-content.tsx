'use client'

import { useEffect, useMemo, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ClientDate } from "@/components/client-date"
import { adminApproveRefund, adminRejectRefund } from "@/actions/refund-requests"
import { RefundButton } from "@/components/admin/refund-button"
import { toast } from "sonner"
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"
import { ChevronLeft, ChevronRight } from "lucide-react"

function statusVariant(status: string | null) {
  switch (status) {
    case 'approved': return 'secondary' as const
    case 'rejected': return 'destructive' as const
    case 'processed': return 'default' as const
    default: return 'outline' as const
  }
}

export function AdminRefundsContent({ requests }: { requests: any[] }) {
  const { t } = useI18n()
  const { prompt } = useConfirm()
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [processingId, setProcessingId] = useState<number | null>(null)
  const processingRef = useRef<number | null>(null)

  useEffect(() => {
    setPage(1)
  }, [query])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return requests
    return requests.filter((r) => {
      const hay = [
        r.orderId,
        r.username || '',
        r.userId || '',
        r.productName || '',
        r.reason || '',
        r.status || ''
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [query, requests])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pagedItems = filtered.slice((page - 1) * pageSize, page * pageSize)

  const handle = async (id: number, action: 'approve' | 'reject') => {
    if (processingRef.current === id) return
    const note = await prompt({
      title: action === 'approve'
        ? `${t('admin.refunds.approve')} - ${t('admin.refunds.adminNote')}`
        : `${t('admin.refunds.reject')} - ${t('admin.refunds.adminNote')}`,
      description: t('admin.refunds.adminNotePrompt'),
      placeholder: "请输入审核处理说明（可选）...",
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    })
    if (note === null) return // user cancelled
    try {
      processingRef.current = id
      setProcessingId(id)
      if (action === 'approve') {
        const result = await adminApproveRefund(id, note)
        if (result?.processed) {
          toast.success(t('admin.refunds.autoRefundSuccess'))
        } else {
          toast.success(t('admin.refunds.autoRefundPending'))
          if (result?.error) {
            toast.error(result.error)
          }
        }
      } else {
        await adminRejectRefund(id, note)
        toast.success(t('common.success'))
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ldc:refunds-updated"))
      }
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setProcessingId(null)
      processingRef.current = null
    }
  }

  return (
    <AdminListPage
      header={<h1 className="text-2xl font-bold tracking-tight">{t('admin.refunds.title')}</h1>}
      toolbar={
        <div className="flex items-center justify-between gap-4">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('admin.refunds.searchPlaceholder')} className="h-9 text-xs md:max-w-sm" />
          <div className="text-xs text-muted-foreground whitespace-nowrap">
            共 {filtered.length} 条申请
          </div>
        </div>
      }
      footer={
        filtered.length > 0 ? (
          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <div>
              {page} / {totalPages} 页 · 共 {filtered.length} 条
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1 border-border/80"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>上一页</span>
              </Button>
              <span className="text-xs font-mono px-2.5 py-1 rounded-md bg-muted/40 border border-border/50">
                {page} / {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1 border-border/80"
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              >
                <span>下一页</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      <AdminListScroll>
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow className="border-b border-border/60 hover:bg-transparent">
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.order')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.user')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.product')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.reason')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.status')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.refunds.date')}</TableHead>
              <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur text-right">{t('admin.refunds.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  未找到相关退款申请
                </TableCell>
              </TableRow>
            ) : (
              pagedItems.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.orderId}</TableCell>
                <TableCell>
                  {r.username ? (
                    <a href={getExternalProfileUrl(r.username, r.userId) || "#"} target="_blank" rel="noreferrer" className="font-medium text-sm hover:underline text-primary">
                      {getDisplayUsername(r.username, r.userId)}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="max-w-[220px] truncate">{r.productName || '-'}</TableCell>
                <TableCell className="max-w-[320px]">
                  <div className="text-sm whitespace-pre-wrap break-words">{r.reason || '-'}</div>
                  {r.adminNote && (
                    <div className="text-xs text-muted-foreground mt-1">{t('admin.refunds.adminNote')}: {r.adminNote}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(r.status)} className="uppercase text-xs">
                    {t(`admin.refunds.statusValues.${r.status || 'pending'}`)}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <ClientDate value={r.createdAt} format="dateTime" />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {(r.status === 'pending' || !r.status) && (
                      <>
                        <Button variant="outline" size="sm" onClick={() => handle(r.id, 'approve')} disabled={processingId === r.id}>{t('admin.refunds.approve')}</Button>
                        <Button variant="destructive" size="sm" onClick={() => handle(r.id, 'reject')} disabled={processingId === r.id}>{t('admin.refunds.reject')}</Button>
                      </>
                    )}
                    {r.status === 'approved' && (
                      <RefundButton order={{
                        orderId: r.orderId,
                        tradeNo: r.tradeNo,
                        amount: r.amount,
                        status: r.orderStatus,
                        cardKey: r.cardKey
                      }} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      </AdminListScroll>
    </AdminListPage>
  )
}
