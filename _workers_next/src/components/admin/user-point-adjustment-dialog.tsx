'use client'

import { useEffect, useState } from "react"
import { adjustUserPoints } from "@/actions/admin-users"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/context"
import { Loader2, Coins } from "lucide-react"
import { toast } from "sonner"

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
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!props.open) return
        setDirection("increase")
        setAmount("")
        setReason("")
    }, [props.open, props.userId, props.currentPoints])

    const parsedAmount = Number.parseInt(amount, 10)
    const validAmount = Number.isInteger(parsedAmount) && parsedAmount > 0
    const delta = direction === "increase" ? parsedAmount : -parsedAmount
    const nextPoints = validAmount ? props.currentPoints + delta : props.currentPoints
    const invalidDecrease = direction === "decrease" && nextPoints < 0
    const canSubmit = validAmount && reason.trim().length > 0 && !invalidDecrease && !saving

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
                </div>

                <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2 sm:gap-2">
                    <Button variant="outline" className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60" onClick={() => props.onOpenChange(false)}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={async () => {
                            if (!canSubmit) return
                            setSaving(true)
                            try {
                                const result = await adjustUserPoints({
                                    userId: props.userId,
                                    direction,
                                    amount: parsedAmount,
                                    reason,
                                })
                                if (!result.success) {
                                    toast.error(t(result.error))
                                    return
                                }
                                toast.success(t("common.success"))
                                props.onOpenChange(false)
                                props.onSuccess?.()
                            } catch {
                                toast.error(t("common.error"))
                            } finally {
                                setSaving(false)
                            }
                        }}
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
