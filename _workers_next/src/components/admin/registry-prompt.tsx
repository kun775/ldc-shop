"use client"

import { useEffect, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { joinRegistry, dismissRegistryPrompt } from "@/actions/registry"
import { toast } from "sonner"
import { Globe, Loader2 } from "lucide-react"

interface RegistryPromptProps {
    shouldPrompt: boolean
    registryEnabled: boolean
}

export function RegistryPrompt({ shouldPrompt, registryEnabled }: RegistryPromptProps) {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (registryEnabled && shouldPrompt) {
            setOpen(true)
        }
    }, [registryEnabled, shouldPrompt])

    if (!registryEnabled) return null

    const handleSkip = async () => {
        if (loading) return
        setLoading(true)
        try {
            await dismissRegistryPrompt()
            setOpen(false)
        } catch {
            toast.error(t("registry.submitFailed"))
        } finally {
            setLoading(false)
        }
    }

    const handleJoin = async () => {
        if (loading) return
        setLoading(true)
        try {
            const result = await joinRegistry(window.location.origin)
            if (!result.ok) {
                throw new Error(result.error || "submit_failed")
            }
            toast.success(t("registry.submitSuccess"))
            setOpen(false)
        } catch {
            toast.error(t("registry.submitFailed"))
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                if (!v) {
                    handleSkip()
                } else {
                    setOpen(true)
                }
            }}
        >
            <DialogContent className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-md rounded-2xl">
                <div className="bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-6 py-5 border-b border-border/40">
                    <DialogHeader className="gap-3 text-left">
                        <div className="flex items-center gap-3.5">
                            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20 shadow-xs">
                                <Globe className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-0.5">
                                <DialogTitle className="text-base font-bold tracking-tight text-foreground sm:text-lg">
                                    {t("registry.promptTitle")}
                                </DialogTitle>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                <div className="px-6 py-5 space-y-3">
                    <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                        {t("registry.promptDescription")}
                    </DialogDescription>
                </div>

                <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2 sm:gap-2">
                    <Button variant="outline" className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60" onClick={handleSkip} disabled={loading}>
                        {t("registry.notNow")}
                    </Button>
                    <Button className="h-9 rounded-xl px-4 text-xs font-medium shadow-xs" onClick={handleJoin} disabled={loading}>
                        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                        {t("registry.joinNow")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
