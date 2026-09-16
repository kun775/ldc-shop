"use client"

import { useEffect, useState, useCallback } from "react"
import { BellRing, CalendarOff, EyeOff, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n/context"
import ReactMarkdown from "react-markdown"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const DISMISS_TODAY_KEY = "ldc:announcement:dismiss-today"
const DISMISS_FOREVER_KEY = "ldc:announcement:dismiss-forever"

export type AnnouncementPopupData = {
    title?: string | null
    content: string
    signature?: string | null
} | null

function getTodayString(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const date = String(now.getDate()).padStart(2, "0")
    return `${year}-${month}-${date}`
}

function computeSignature(content: string, title?: string | null): string {
    let hash = 0
    const str = `${title || ""}:${content}`
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash |= 0 // Convert to 32bit integer
    }
    return String(hash)
}

export function AnnouncementPopup({ popup }: { popup: AnnouncementPopupData }) {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)

    const content = popup?.content?.trim() || ""
    const title = popup?.title?.trim() || t("announcement.popupDefaultTitle")
    const signature = popup?.signature || (content ? computeSignature(content, title) : "")

    const checkShouldOpen = useCallback(() => {
        if (!content) return false

        try {
            const dismissedToday = localStorage.getItem(DISMISS_TODAY_KEY)
            const today = getTodayString()
            if (dismissedToday === today) {
                return false
            }

            const dismissedForever = localStorage.getItem(DISMISS_FOREVER_KEY)
            if (dismissedForever && dismissedForever === signature) {
                return false
            }

            return true
        } catch {
            return true
        }
    }, [content, signature])

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setOpen(Boolean(content) && checkShouldOpen())
        }, 0)
        return () => window.clearTimeout(timeoutId)
    }, [content, checkShouldOpen])

    useEffect(() => {
        const handleManualOpen = () => {
            if (content) {
                setOpen(true)
            }
        }

        window.addEventListener("ldc:open-announcement", handleManualOpen)
        return () => {
            window.removeEventListener("ldc:open-announcement", handleManualOpen)
        }
    }, [content])

    const handleDismissOnce = () => {
        setOpen(false)
    }

    const handleDismissToday = () => {
        try {
            localStorage.setItem(DISMISS_TODAY_KEY, getTodayString())
            toast.info(t("announcement.dismissTodayNotice"))
        } catch {
            // ignore
        }
        setOpen(false)
    }

    const handleDismissForever = () => {
        try {
            if (signature) {
                localStorage.setItem(DISMISS_FOREVER_KEY, signature)
                toast.info(t("announcement.dismissForeverNotice"))
            }
        } catch {
            // ignore
        }
        setOpen(false)
    }

    if (!content) {
        return null
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-lg rounded-2xl">
                {/* Header with decorative badge */}
                <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-6 py-5 border-b border-border/40">
                    <DialogHeader className="gap-3 text-left">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-xs">
                                <BellRing className="h-5 w-5" />
                            </div>
                            <div className="space-y-0.5 min-w-0 flex-1">
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                                    {t("announcement.popupLabel")}
                                </span>
                                <DialogTitle className="text-lg font-bold tracking-tight text-foreground truncate">
                                    {title}
                                </DialogTitle>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                {/* Content Body */}
                <div className="px-6 py-5 space-y-4">
                    <div className="max-h-[50vh] overflow-y-auto pr-1 no-scrollbar text-sm leading-relaxed text-foreground/90">
                        <div className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline">
                            <ReactMarkdown>{content}</ReactMarkdown>
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="pt-3 border-t border-border/40 flex flex-col sm:flex-row items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5 w-full sm:w-auto justify-start">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={handleDismissToday}
                                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1.5"
                                title="今天内不再自动弹出此公告"
                            >
                                <CalendarOff className="h-3.5 w-3.5 text-muted-foreground/70" />
                                <span>{t("announcement.dismissToday")}</span>
                            </Button>
                            <span className="text-muted-foreground/30 text-xs">|</span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={handleDismissForever}
                                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground gap-1.5"
                                title="本条公告永久不再自动弹出"
                            >
                                <EyeOff className="h-3.5 w-3.5 text-muted-foreground/70" />
                                <span>{t("announcement.dismissForever")}</span>
                            </Button>
                        </div>

                        <Button
                            type="button"
                            onClick={handleDismissOnce}
                            size="sm"
                            className="w-full sm:w-auto h-8 px-4 text-xs font-medium gap-1 shadow-xs"
                        >
                            <Check className="h-3.5 w-3.5" />
                            <span>{t("announcement.dismissOnce")}</span>
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
