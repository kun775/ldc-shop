'use client'

import { useEffect, useRef, useState } from "react"
import { adjustUserPoints } from "@/actions/admin-users"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/context"
import { pageLoadingStore } from "@/lib/ui/page-loading-store"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"
import { Loader2, Coins } from "lucide-react"
import { toast } from "sonner"

type SubmitPhase = 'idle' | 'submitting' | 'error'

export function UserPointAdjustmentDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    userId: string
    username: string | null
    currentPoints: number
    onSuccess?: () => void
}) {
    const { t } = useI18n()
    const [direction, setDirection] = useState<"increase" | "decrease">("increase")
    const [amount, setAmount] = useState("")
    const [reason, setReason] = useState("")
    const [phase, setPhase] = useState<SubmitPhase>('idle')
    const [submitError, setSubmitError] = useState<{ key: string; errorId: string } | null>(null)
    // 同步互斥锁：setState 是异步的，连续快速点击仍可能穿过 phase 判断，
    // 必须在 ref 上兜住，否则会产生两笔业务键不同的积分变更（各扣一次）。
    const submitLock = useRef(false)
    // 组件卸载 / 弹窗关闭后忽略迟到响应，避免对已关闭界面写状态
    const mountedRef = useRef(true)

    const saving = phase === 'submitting'

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    useEffect(() => {
        if (!props.open) return
        setDirection("increase")
        setAmount("")
        setReason("")
        setPhase('idle')
        setSubmitError(null)
        submitLock.current = false
    }, [props.open, props.userId, props.currentPoints])

    const parsedAmount = Number.parseInt(amount, 10)
    const validAmount = Number.isInteger(parsedAmount) && parsedAmount > 0
    const delta = direction === "increase" ? parsedAmount : -parsedAmount
    const nextPoints = validAmount ? props.currentPoints + delta : props.currentPoints
    const invalidDecrease = direction === "decrease" && nextPoints < 0
    const canSubmit = validAmount && reason.trim().length > 0 && !invalidDecrease && !saving

    const handleSubmit = async () => {
        if (!canSubmit || submitLock.current) return
        submitLock.current = true
        setPhase('submitting')
        setSubmitError(null)

        // 提交期间抑制路由级全屏遮罩：成功后 router.refresh() 会让
        // loading.tsx 的 fallback 挂载，从而点亮 z-[90] 遮罩并拦截点击。
        const release = pageLoadingStore.beginInteraction()
        try {
            const result = await adjustUserPoints({
                userId: props.userId,
                direction,
                amount: parsedAmount,
                reason,
            })
            if (!mountedRef.current) return

            if (!result.ok) {
                // 失败时保留已填写的方向/数量/原因，让管理员能直接改后重试
                setPhase('error')
                setSubmitError({ key: result.errorKey, errorId: result.errorId })
                toast.error(
                    result.errorId
                        ? `${t(result.errorKey)} · ${t('common.errorIdLabel')} ${result.errorId}`
                        : t(result.errorKey),
                )
                return
            }

            setPhase('idle')
            toast.success(t("common.success"))
            props.onOpenChange(false)
            props.onSuccess?.()
        } catch (error) {
            // Server Action 抛出的异常（网络中断等）也必须落到 error 态，
            // 否则遮罩会永久停留、按钮永久禁用。
            if (!mountedRef.current) return
            const errorKey = resolveClientActionErrorKey(error)
            setPhase('error')
            setSubmitError({ key: errorKey, errorId: '' })
            toast.error(t(errorKey))
        } finally {
            submitLock.current = false
            release()
            if (mountedRef.current) {
                setPhase((current) => (current === 'submitting' ? 'idle' : current))
            }
        }
    }

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-md rounded-2xl">
                <div className="bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-6 py-5 border-b border-border/40">
                    <DialogHeader className="gap-3 text-left">
                        <div className="flex items-center gap-3.5">
                            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20 shadow-xs">
                                <Coins className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-0.5">
                                <DialogTitle className="text-base font-bold tracking-tight text-foreground sm:text-lg">
                                    {t("admin.users.adjustPoints")}
                                </DialogTitle>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                <div className="px-6 py-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-muted/40 border border-border/50 text-xs">
                        <div>
                            <span className="text-muted-foreground">{t("admin.users.username")}: </span>
                            <span className="font-semibold text-foreground">{props.username || props.userId}</span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t("admin.users.currentPoints")}: </span>
                            <span className="font-semibold text-primary">{props.currentPoints}</span>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">{t("admin.users.adjustDirection")}</Label>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant={direction === "increase" ? "default" : "outline"}
                                className="h-8 flex-1 rounded-xl text-xs font-medium"
                                onClick={() => setDirection("increase")}
                            >
                                {t("admin.users.adjustIncrease")}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant={direction === "decrease" ? "default" : "outline"}
                                className="h-8 flex-1 rounded-xl text-xs font-medium"
                                onClick={() => setDirection("decrease")}
                            >
                                {t("admin.users.adjustDecrease")}
                            </Button>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="adjust-amount" className="text-xs text-muted-foreground">{t("admin.users.adjustAmount")}</Label>
                        <Input
                            id="adjust-amount"
                            type="number"
                            min="1"
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                            className="h-9 rounded-xl border-border/80 bg-background/80 text-xs focus-visible:ring-primary/40"
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="adjust-reason" className="text-xs text-muted-foreground">{t("admin.users.adjustReason")}</Label>
                        <Textarea
                            id="adjust-reason"
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            rows={2}
                            placeholder="请输入变动原因..."
                            className="rounded-xl border-border/80 bg-background/80 text-xs focus-visible:ring-primary/40 resize-none"
                        />
                    </div>

                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-2.5 text-xs text-foreground/80">
                        {t("admin.users.adjustPreview", {
                            current: String(props.currentPoints),
                            next: String(nextPoints),
                        })}
                    </div>

                    {invalidDecrease ? (
                        <div className="text-xs text-destructive">{t("admin.users.adjustNegativeNotAllowed")}</div>
                    ) : null}

                    {submitError ? (
                        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive space-y-1">
                            <div>{t(submitError.key)}</div>
                            {submitError.errorId ? (
                                <div className="font-mono text-[11px] text-destructive/80">
                                    {t('common.errorIdLabel')}: {submitError.errorId}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2 sm:gap-2">
                    <Button variant="outline" className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60" onClick={() => props.onOpenChange(false)} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="h-9 rounded-xl px-4 text-xs font-medium shadow-xs"
                    >
                        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                        {t("admin.users.submitAdjustment")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
