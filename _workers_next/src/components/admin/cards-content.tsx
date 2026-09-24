'use client'

import { useI18n } from "@/lib/i18n/context"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { addCards, deleteCard, deleteCards, pullCardFromApi, saveCardDeliveryNote, saveCardsApiConfig, setCardsApiEnabled } from "@/actions/admin"
import { Checkbox } from "@/components/ui/checkbox"
import { useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { CopyButton } from "@/components/copy-button"
import { ArrowLeft, Trash2, PlusCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AdminPageShell } from "@/components/admin/admin-page-shell"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"

interface CardData {
    id: number
    cardKey: string
}

interface CardsContentProps {
    productId: string
    productName: string
    unusedCards: CardData[]
    apiConfig: {
        enabled: boolean
        url: string
        token: string
    }
    deliveryNote: string
    deliveryNoteMaxLength: number
}

export function CardsContent({ productId, productName, unusedCards, apiConfig, deliveryNote, deliveryNoteMaxLength }: CardsContentProps) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const router = useRouter()
    const [selectedIds, setSelectedIds] = useState<number[]>([])
    const [submitting, setSubmitting] = useState(false)
    const [batchDeleting, setBatchDeleting] = useState(false)
    const [deletingId, setDeletingId] = useState<number | null>(null)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [pendingCount, setPendingCount] = useState(0)
    const [pendingHasExpiry, setPendingHasExpiry] = useState(false)
    const [apiEnabled, setApiEnabled] = useState(apiConfig.enabled)
    const [apiUrl, setApiUrl] = useState(apiConfig.url)
    const [apiToken, setApiToken] = useState(apiConfig.token)
    const [savingApi, setSavingApi] = useState(false)
    const [togglingApiEnabled, setTogglingApiEnabled] = useState(false)
    const [pullingApi, setPullingApi] = useState(false)
    const [deliveryNoteValue, setDeliveryNoteValue] = useState(deliveryNote)
    const [savingDeliveryNote, setSavingDeliveryNote] = useState(false)
    const submitLock = useRef(false)
    const batchDeleteLock = useRef(false)
    const deleteLock = useRef<number | null>(null)
    const formRef = useRef<HTMLFormElement | null>(null)
    const pendingFormRef = useRef<FormData | null>(null)

    const toggleSelectAll = () => {
        if (selectedIds.length === unusedCards.length) {
            setSelectedIds([])
        } else {
            setSelectedIds(unusedCards.map(c => c.id))
        }
    }

    const toggleSelect = (id: number) => {
        setSelectedIds(prev =>
            prev.includes(id)
                ? prev.filter(pid => pid !== id)
                : [...prev, id]
        )
    }

    const handleBatchDelete = async () => {
        if (!selectedIds.length || batchDeleteLock.current) return

        const ok = await confirm({
            title: t('admin.cards.batchDelete') || "批量删除卡密",
            description: t('admin.cards.confirmBatchDelete', { count: selectedIds.length }),
            variant: "destructive",
            icon: "trash",
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return

        batchDeleteLock.current = true
        setBatchDeleting(true)
        try {
            await deleteCards(selectedIds)
            toast.success(t('common.success'))
            setSelectedIds([])
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setBatchDeleting(false)
            batchDeleteLock.current = false
        }
    }

    const handleSubmit = async (formData: FormData) => {
        if (submitLock.current) return
        submitLock.current = true
        setSubmitting(true)
        try {
            const result = await addCards(formData)
            if (result && result.success === false) {
                toast.error(t(result.error || 'common.error'))
                return
            }
            toast.success(t('common.success'))
            router.refresh()
            formRef.current?.reset()
            setPendingCount(0)
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setSubmitting(false)
            submitLock.current = false
        }
    }

    const handleConfirmSubmit = async () => {
        const formData = pendingFormRef.current
        if (!formData) {
            setConfirmOpen(false)
            setPendingHasExpiry(false)
            return
        }
        setConfirmOpen(false)
        pendingFormRef.current = null
        await handleSubmit(formData)
    }

    const handleOpenConfirm = (formData: FormData) => {
        const raw = String(formData.get('cards') || '')
        const hoursRaw = String(formData.get('expires_hours') || '').trim()
        const minutesRaw = String(formData.get('expires_minutes') || '').trim()
        const count = raw
            .split(/\r?\n|,/)
            .map((item) => item.trim())
            .filter(Boolean).length
        const hours = hoursRaw === '' ? 0 : Number(hoursRaw)
        const minutes = minutesRaw === '' ? 0 : Number(minutesRaw)
        const hasExpiry =
            Number.isInteger(hours) &&
            Number.isInteger(minutes) &&
            hours >= 0 &&
            minutes >= 0 &&
            minutes <= 59 &&
            hours * 60 + minutes > 0
        setPendingCount(count)
        setPendingHasExpiry(hasExpiry)
        pendingFormRef.current = formData
        setConfirmOpen(true)
    }

    const handleSaveApiConfig = async () => {
        if (savingApi) return
        setSavingApi(true)
        try {
            const result = await saveCardsApiConfig(productId, apiUrl, apiToken, apiEnabled)
            toast.success(t('common.success'))
            if (result.autoPulled) {
                toast.success(t('admin.cards.apiAutoPulled'))
            } else if (result.autoPullError) {
                toast.error(`${t('admin.cards.apiAutoPullFailed')}: ${result.autoPullError}`)
            }
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setSavingApi(false)
        }
    }

    const handleToggleApiEnabled = async () => {
        if (togglingApiEnabled || savingApi || pullingApi) return
        const nextEnabled = !apiEnabled
        setTogglingApiEnabled(true)
        try {
            const result = await setCardsApiEnabled(productId, nextEnabled, apiUrl, apiToken)
            setApiEnabled(nextEnabled)
            toast.success(t('common.success'))
            if (result.autoPulled) {
                toast.success(t('admin.cards.apiAutoPulled'))
            } else if (result.autoPullError) {
                toast.error(`${t('admin.cards.apiAutoPullFailed')}: ${result.autoPullError}`)
            }
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setTogglingApiEnabled(false)
        }
    }

    const handlePullOneCard = async () => {
        if (pullingApi) return
        setPullingApi(true)
        try {
            await pullCardFromApi(productId)
            toast.success(t('admin.cards.apiPullSuccess'))
            router.refresh()
        } catch (e: any) {
            toast.error(`${t('admin.cards.apiPullFailed')}: ${t(resolveClientActionErrorKey(e))}`)
        } finally {
            setPullingApi(false)
        }
    }

    const handleSaveDeliveryNote = async () => {
        if (savingDeliveryNote) return
        setSavingDeliveryNote(true)
        try {
            const result = await saveCardDeliveryNote(productId, deliveryNoteValue)
            setDeliveryNoteValue(result.deliveryNote)
            toast.success(t('common.success'))
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setSavingDeliveryNote(false)
        }
    }

    return (
        <AdminPageShell className="mx-auto max-w-4xl space-y-8 p-0.5">
            <div className="flex flex-wrap items-start justify-between gap-4 sm:items-center">
                <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
                    <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5 whitespace-nowrap">
                        <Link href="/admin/products">
                            <ArrowLeft className="h-4 w-4" />
                            {t('admin.cards.backToProducts')}
                        </Link>
                    </Button>
                    <div className="min-w-0">
                        <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">{t('admin.cards.title')}: {productName}</h1>
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-2xl font-bold">{unusedCards.length}</div>
                    <div className="text-xs text-muted-foreground">{t('admin.cards.available')}</div>
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
                <div className="space-y-8">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.cards.deliveryNoteTitle')}</CardTitle>
                            <CardDescription>{t('admin.cards.deliveryNoteHint')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <Textarea
                                value={deliveryNoteValue}
                                onChange={(event) => setDeliveryNoteValue(event.target.value)}
                                placeholder={t('admin.cards.deliveryNotePlaceholder')}
                                rows={6}
                                maxLength={deliveryNoteMaxLength}
                                disabled={savingDeliveryNote}
                            />
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-muted-foreground">
                                    {deliveryNoteValue.length} / {deliveryNoteMaxLength}
                                </span>
                                <Button onClick={handleSaveDeliveryNote} disabled={savingDeliveryNote}>
                                    {savingDeliveryNote ? t('common.processing') : t('admin.cards.saveDeliveryNote')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.cards.addCards')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form
                                ref={formRef}
                                onSubmit={(event) => {
                                    event.preventDefault()
                                    if (submitting) return
                                    const formData = new FormData(event.currentTarget)
                                    handleOpenConfirm(formData)
                                }}
                                className="space-y-4"
                            >
                                <input type="hidden" name="product_id" value={productId} />
                                <Textarea name="cards" placeholder={t('admin.cards.placeholder')} rows={10} className="font-mono text-sm" required disabled={submitting} />
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">{t('admin.cards.expiryLabel')}</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">{t('admin.cards.expiryHours')}</label>
                                            <Input
                                                name="expires_hours"
                                                type="number"
                                                min="0"
                                                step="1"
                                                onWheel={(event) => event.currentTarget.blur()}
                                                disabled={submitting}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">{t('admin.cards.expiryMinutes')}</label>
                                            <Input
                                                name="expires_minutes"
                                                type="number"
                                                min="0"
                                                max="59"
                                                step="1"
                                                onWheel={(event) => event.currentTarget.blur()}
                                                disabled={submitting}
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{t('admin.cards.expiryHint')}</p>
                                </div>
                                <Button type="submit" className="w-full" disabled={submitting}>
                                    {submitting ? t('common.processing') : t('common.add')}
                                </Button>
                            </form>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.cards.apiTitle')}</CardTitle>
                            <CardDescription>{t('admin.cards.apiHint')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-2">
                                <label className="text-sm font-medium">{t('admin.cards.apiUrl')}</label>
                                <Input
                                    value={apiUrl}
                                    onChange={(e) => setApiUrl(e.target.value)}
                                    placeholder="https://example.com/api/card"
                                    disabled={savingApi || pullingApi}
                                />
                            </div>
                            <div className="grid gap-2">
                                <label className="text-sm font-medium">{t('admin.cards.apiToken')}</label>
                                <Input
                                    type="password"
                                    value={apiToken}
                                    onChange={(e) => setApiToken(e.target.value)}
                                    placeholder={t('admin.cards.apiTokenPlaceholder')}
                                    disabled={savingApi || pullingApi}
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    variant={apiEnabled ? "default" : "outline"}
                                    size="sm"
                                    onClick={handleToggleApiEnabled}
                                    disabled={savingApi || pullingApi || togglingApiEnabled}
                                >
                                    {apiEnabled ? t('admin.cards.apiEnabled') : t('admin.cards.apiDisabled')}
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={handleSaveApiConfig}
                                    disabled={savingApi || pullingApi || togglingApiEnabled}
                                >
                                    {savingApi ? t('common.processing') : t('common.save')}
                                </Button>
                                <Button
                                    onClick={handlePullOneCard}
                                    disabled={pullingApi || savingApi || togglingApiEnabled || !apiEnabled}
                                >
                                    {pullingApi ? t('common.processing') : t('admin.cards.apiPullOne')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.cards.available')}</CardTitle>
                    </CardHeader>
                    <CardContent className="max-h-[400px] overflow-y-auto space-y-2">
                        {unusedCards.length > 0 && (
                            <div className="flex items-center justify-between pb-2 mb-2 border-b sticky top-0 bg-background z-10">
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        checked={selectedIds.length === unusedCards.length && unusedCards.length > 0}
                                        onCheckedChange={toggleSelectAll}
                                        id="select-all"
                                    />
                                    <label htmlFor="select-all" className="text-sm cursor-pointer select-none">
                                        {t('admin.cards.selectAll')}
                                        {selectedIds.length > 0 && <span className="ml-2 text-muted-foreground text-xs">({t('admin.cards.selectedCount', { count: selectedIds.length })})</span>}
                                    </label>
                                </div>
                                {selectedIds.length > 0 && (
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        className="h-7 text-xs"
                                        onClick={handleBatchDelete}
                                        disabled={batchDeleting}
                                    >
                                        {t('admin.cards.batchDelete')}
                                    </Button>
                                )}
                            </div>
                        )}
                        {unusedCards.length === 0 ? (
                            <div className="text-center py-10 text-muted-foreground text-sm">{t('admin.cards.noCards')}</div>
                        ) : (
                            unusedCards.map(c => (
                                <div key={c.id} className="flex items-center justify-between p-2 rounded bg-muted/40 text-sm font-mono gap-2 animate-in fade-in transition-colors hover:bg-muted/60">
                                    <div className="flex items-center gap-3">
                                        <Checkbox
                                            checked={selectedIds.includes(c.id)}
                                            onCheckedChange={() => toggleSelect(c.id)}
                                        />
                                        <CopyButton text={c.cardKey} truncate maxLength={30} />
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                        aria-label={t('common.delete')}
                                        title={t('common.delete')}
                                        onClick={async () => {
                                            if (deleteLock.current === c.id) return
                                            const ok = await confirm({
                                                title: t('common.confirmDelete'),
                                                description: "确定要删除这条卡密吗？",
                                                variant: "destructive",
                                                icon: "trash",
                                                confirmText: t('common.delete'),
                                                cancelText: t('common.cancel'),
                                            })
                                            if (!ok) return
                                            deleteLock.current = c.id
                                            setDeletingId(c.id)
                                            try {
                                                await deleteCard(c.id)
                                                toast.success(t('common.success'))
                                                router.refresh()
                                            } catch (e: any) {
                                                toast.error(t(resolveClientActionErrorKey(e)))
                                            } finally {
                                                setDeletingId(null)
                                                deleteLock.current = null
                                            }
                                        }}
                                        disabled={deletingId === c.id}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>

            <Dialog
                open={confirmOpen}
                onOpenChange={(open) => {
                    setConfirmOpen(open)
                    if (!open) {
                        pendingFormRef.current = null
                        setPendingHasExpiry(false)
                    }
                }}
            >
                <DialogContent className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-md rounded-2xl">
                    <div className="bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-6 py-5 border-b border-border/40">
                        <DialogHeader className="gap-3 text-left">
                            <div className="flex items-center gap-3.5">
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20 shadow-xs">
                                    <PlusCircle className="h-5 w-5" />
                                </div>
                                <div className="min-w-0 flex-1 space-y-0.5">
                                    <DialogTitle className="text-base font-bold tracking-tight text-foreground sm:text-lg">
                                        {t('admin.cards.confirmAddTitle')}
                                    </DialogTitle>
                                </div>
                            </div>
                        </DialogHeader>
                    </div>
                    <div className="px-6 py-5 space-y-3 text-sm leading-relaxed text-muted-foreground">
                        <p>{t('admin.cards.confirmAddDescription', { count: pendingCount })}</p>
                        {pendingHasExpiry ? (
                            <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                                {t('admin.cards.confirmAddExpiryNotice')}
                            </p>
                        ) : null}
                    </div>
                    <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2 sm:gap-2">
                        <Button variant="outline" className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60" onClick={() => setConfirmOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button className="h-9 rounded-xl px-4 text-xs font-medium shadow-xs" onClick={handleConfirmSubmit} disabled={submitting}>
                            {t('common.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AdminPageShell>
    )
}
