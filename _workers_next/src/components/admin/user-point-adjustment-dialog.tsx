'use client'

import { useEffect, useState } from "react"
import { adjustUserPoints } from "@/actions/admin-users"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/context"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

function getAdjustmentErrorMessage(message: string | undefined, t: (key: string, params?: Record<string, string>) => string) {
    switch (message) {
        case "POINT_BALANCE_NEGATIVE":
            return t("admin.users.adjustNegativeNotAllowed")
        case "POINT_REASON_REQUIRED":
            return t("admin.users.adjustReasonRequired")
        case "POINT_AMOUNT_INVALID":
            return t("admin.users.adjustAmountInvalid")
        default:
            return message || t("common.error")
    }
}

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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("admin.users.adjustPoints")}</DialogTitle>
                </DialogHeader>

                <div className="grid gap-4 py-2">
                    <div className="grid gap-2">
                        <Label>{t("admin.users.username")}</Label>
                        <div className="text-sm font-medium">{props.username || props.userId}</div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t("admin.users.currentPoints")}</Label>
                        <div className="text-sm font-medium">{props.currentPoints}</div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t("admin.users.adjustDirection")}</Label>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant={direction === "increase" ? "default" : "outline"}
                                onClick={() => setDirection("increase")}
                            >
                                {t("admin.users.adjustIncrease")}
                            </Button>
                            <Button
                                type="button"
                                variant={direction === "decrease" ? "default" : "outline"}
                                onClick={() => setDirection("decrease")}
                            >
                                {t("admin.users.adjustDecrease")}
                            </Button>
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="adjust-amount">{t("admin.users.adjustAmount")}</Label>
                        <Input
                            id="adjust-amount"
                            type="number"
                            min="1"
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="adjust-reason">{t("admin.users.adjustReason")}</Label>
                        <Textarea
                            id="adjust-reason"
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                        />
                    </div>

                    <div className="rounded-md border bg-muted/30 p-3 text-sm">
                        {t("admin.users.adjustPreview", {
                            current: String(props.currentPoints),
                            next: String(nextPoints),
                        })}
                    </div>

                    {invalidDecrease ? (
                        <div className="text-sm text-destructive">{t("admin.users.adjustNegativeNotAllowed")}</div>
                    ) : null}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={async () => {
                            if (!canSubmit) return
                            setSaving(true)
                            try {
                                await adjustUserPoints({
                                    userId: props.userId,
                                    direction,
                                    amount: parsedAmount,
                                    reason,
                                })
                                toast.success(t("common.success"))
                                props.onOpenChange(false)
                                props.onSuccess?.()
                            } catch (error: any) {
                                toast.error(getAdjustmentErrorMessage(error?.message, t))
                            } finally {
                                setSaving(false)
                            }
                        }}
                        disabled={!canSubmit}
                    >
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {t("admin.users.submitAdjustment")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
