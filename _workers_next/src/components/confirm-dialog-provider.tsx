'use client'

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { AlertTriangle, Trash2, Info, CheckCircle2, HelpCircle, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export type DialogVariant = 'default' | 'destructive' | 'warning' | 'info' | 'success'

export interface ConfirmOptions {
    title?: string
    description?: string
    confirmText?: string
    cancelText?: string
    variant?: DialogVariant
    icon?: 'alert' | 'trash' | 'info' | 'check' | 'help'
}

export interface PromptOptions {
    title?: string
    description?: string
    placeholder?: string
    defaultValue?: string
    confirmText?: string
    cancelText?: string
    required?: boolean
    multiline?: boolean
}

export interface AlertOptions {
    title?: string
    description?: string
    confirmText?: string
    variant?: DialogVariant
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions | string) => Promise<boolean>
    prompt: (options: PromptOptions | string) => Promise<string | null>
    alert: (options: AlertOptions | string) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextType | null>(null)

type ActiveDialogState =
    | {
          type: 'confirm'
          options: ConfirmOptions
          resolve: (val: boolean) => void
      }
    | {
          type: 'prompt'
          options: PromptOptions
          resolve: (val: string | null) => void
      }
    | {
          type: 'alert'
          options: AlertOptions
          resolve: () => void
      }

const CONFIRM_EVENT = "ldc:confirm-dialog-event"

/**
 * Standalone helper for use anywhere (even outside React tree or inside callbacks).
 * Relies on ConfirmDialogProvider being mounted in root Providers.
 */
export function confirmModal(options: ConfirmOptions | string): Promise<boolean> {
    if (typeof window === "undefined") return Promise.resolve(false)
    return new Promise((resolve) => {
        window.dispatchEvent(
            new CustomEvent(CONFIRM_EVENT, {
                detail: {
                    type: 'confirm',
                    options: typeof options === "string" ? { description: options } : options,
                    resolve,
                },
            })
        )
    })
}

export function promptModal(options: PromptOptions | string): Promise<string | null> {
    if (typeof window === "undefined") return Promise.resolve(null)
    return new Promise((resolve) => {
        window.dispatchEvent(
            new CustomEvent(CONFIRM_EVENT, {
                detail: {
                    type: 'prompt',
                    options: typeof options === "string" ? { description: options } : options,
                    resolve,
                },
            })
        )
    })
}

export function alertModal(options: AlertOptions | string): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve()
    return new Promise((resolve) => {
        window.dispatchEvent(
            new CustomEvent(CONFIRM_EVENT, {
                detail: {
                    type: 'alert',
                    options: typeof options === "string" ? { description: options } : options,
                    resolve,
                },
            })
        )
    })
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
    const [dialogState, setDialogState] = useState<ActiveDialogState | null>(null)
    const [promptValue, setPromptValue] = useState("")
    const promptInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

    // Intercept native window.alert so no default browser popups ever occur
    useEffect(() => {
        if (typeof window !== "undefined") {
            const originalAlert = window.alert
            window.alert = (msg?: any) => {
                toast.info(String(msg ?? ""))
            }
            return () => {
                window.alert = originalAlert
            }
        }
    }, [])

    const openConfirm = useCallback((options: ConfirmOptions | string): Promise<boolean> => {
        return new Promise((resolve) => {
            const opts = typeof options === "string" ? { description: options } : options
            setDialogState({
                type: 'confirm',
                options: opts,
                resolve,
            })
        })
    }, [])

    const openPrompt = useCallback((options: PromptOptions | string): Promise<string | null> => {
        return new Promise((resolve) => {
            const opts = typeof options === "string" ? { description: options } : options
            setPromptValue(opts.defaultValue || "")
            setDialogState({
                type: 'prompt',
                options: opts,
                resolve,
            })
        })
    }, [])

    const openAlert = useCallback((options: AlertOptions | string): Promise<void> => {
        return new Promise((resolve) => {
            const opts = typeof options === "string" ? { description: options } : options
            setDialogState({
                type: 'alert',
                options: opts,
                resolve,
            })
        })
    }, [])

    // Listen for custom events triggered via standalone helpers
    useEffect(() => {
        const handleCustomEvent = (e: Event) => {
            const customEvent = e as CustomEvent<ActiveDialogState>
            if (!customEvent.detail) return
            if (customEvent.detail.type === 'prompt') {
                setPromptValue((customEvent.detail.options as PromptOptions).defaultValue || "")
            }
            setDialogState(customEvent.detail)
        }

        window.addEventListener(CONFIRM_EVENT, handleCustomEvent)
        return () => {
            window.removeEventListener(CONFIRM_EVENT, handleCustomEvent)
        }
    }, [])

    // Focus input when prompt dialog opens
    useEffect(() => {
        if (dialogState?.type === 'prompt') {
            const timer = setTimeout(() => {
                promptInputRef.current?.focus()
            }, 50)
            return () => clearTimeout(timer)
        }
    }, [dialogState])

    const handleClose = (confirmed: boolean) => {
        if (!dialogState) return

        if (dialogState.type === 'confirm') {
            dialogState.resolve(confirmed)
        } else if (dialogState.type === 'prompt') {
            if (confirmed) {
                dialogState.resolve(promptValue)
            } else {
                dialogState.resolve(null)
            }
        } else if (dialogState.type === 'alert') {
            dialogState.resolve()
        }

        setDialogState(null)
    }

    const renderIcon = (variant: DialogVariant = 'default', customIcon?: string) => {
        if (customIcon === 'trash') return <Trash2 className="h-5 w-5" />
        if (customIcon === 'alert') return <AlertTriangle className="h-5 w-5" />
        if (customIcon === 'info') return <Info className="h-5 w-5" />
        if (customIcon === 'check') return <CheckCircle2 className="h-5 w-5" />
        if (customIcon === 'help') return <HelpCircle className="h-5 w-5" />

        switch (variant) {
            case 'destructive':
                return <AlertTriangle className="h-5 w-5" />
            case 'warning':
                return <AlertCircle className="h-5 w-5" />
            case 'success':
                return <CheckCircle2 className="h-5 w-5" />
            case 'info':
                return <Info className="h-5 w-5" />
            default:
                return <HelpCircle className="h-5 w-5" />
        }
    }

    const getVariantStyles = (variant: DialogVariant = 'default') => {
        switch (variant) {
            case 'destructive':
                return {
                    headerBg: "bg-gradient-to-r from-destructive/15 via-destructive/5 to-transparent border-destructive/20",
                    iconBadge: "bg-destructive/15 text-destructive border-destructive/20 ring-1 ring-destructive/20",
                    confirmBtn: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm shadow-destructive/20",
                }
            case 'warning':
                return {
                    headerBg: "bg-gradient-to-r from-amber-500/15 via-amber-500/5 to-transparent border-amber-500/20",
                    iconBadge: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20 ring-1 ring-amber-500/20",
                    confirmBtn: "bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600 shadow-sm shadow-amber-500/20",
                }
            case 'success':
                return {
                    headerBg: "bg-gradient-to-r from-emerald-500/15 via-emerald-500/5 to-transparent border-emerald-500/20",
                    iconBadge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 ring-1 ring-emerald-500/20",
                    confirmBtn: "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 shadow-sm shadow-emerald-500/20",
                }
            case 'info':
                return {
                    headerBg: "bg-gradient-to-r from-blue-500/15 via-blue-500/5 to-transparent border-blue-500/20",
                    iconBadge: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20 ring-1 ring-blue-500/20",
                    confirmBtn: "bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 shadow-sm shadow-blue-500/20",
                }
            default:
                return {
                    headerBg: "bg-gradient-to-r from-primary/15 via-primary/5 to-transparent border-primary/20",
                    iconBadge: "bg-primary/15 text-primary border-primary/20 ring-1 ring-primary/20",
                    confirmBtn: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm shadow-primary/20",
                }
        }
    }

    const currentVariant: DialogVariant =
        dialogState?.type === 'confirm'
            ? dialogState.options.variant || 'default'
            : dialogState?.type === 'alert'
            ? dialogState.options.variant || 'default'
            : 'default'

    const variantStyles = getVariantStyles(currentVariant)

    return (
        <ConfirmContext.Provider value={{ confirm: openConfirm, prompt: openPrompt, alert: openAlert }}>
            {children}

            <Dialog
                open={Boolean(dialogState)}
                onOpenChange={(open) => {
                    if (!open) handleClose(false)
                }}
            >
                <DialogContent
                    showCloseButton={true}
                    className="overflow-hidden border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-md rounded-2xl"
                >
                    {/* Header with decorative badge and colored subtle glow */}
                    <div className={cn("px-6 py-5 border-b transition-colors", variantStyles.headerBg)}>
                        <DialogHeader className="gap-3 text-left">
                            <div className="flex items-center gap-3.5">
                                <div
                                    className={cn(
                                        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-transform duration-200",
                                        variantStyles.iconBadge
                                    )}
                                >
                                    {dialogState?.type === 'confirm'
                                        ? renderIcon(currentVariant, dialogState.options.icon)
                                        : dialogState?.type === 'prompt'
                                        ? <HelpCircle className="h-5 w-5 text-primary" />
                                        : renderIcon(currentVariant)}
                                </div>
                                <div className="min-w-0 flex-1 space-y-0.5">
                                    <DialogTitle className="text-base font-bold tracking-tight text-foreground sm:text-lg">
                                        {dialogState?.type === 'confirm'
                                            ? dialogState.options.title || (currentVariant === 'destructive' ? "确认删除" : "请确认操作")
                                            : dialogState?.type === 'prompt'
                                            ? dialogState.options.title || "请输入内容"
                                            : dialogState?.options.title || "系统提示"}
                                    </DialogTitle>
                                </div>
                            </div>
                        </DialogHeader>
                    </div>

                    {/* Content Body */}
                    <div className="px-6 py-5 space-y-4">
                        {dialogState?.options.description && (
                            <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                                {dialogState.options.description}
                            </p>
                        )}

                        {/* Prompt Input Mode */}
                        {dialogState?.type === 'prompt' && (
                            <div className="pt-1">
                                {dialogState.options.multiline ? (
                                    <Textarea
                                        ref={promptInputRef as any}
                                        value={promptValue}
                                        onChange={(e) => setPromptValue(e.target.value)}
                                        placeholder={dialogState.options.placeholder || "请输入..."}
                                        rows={3}
                                        className="rounded-xl border-border/80 bg-background/80 text-sm focus-visible:ring-primary/40 resize-none"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                                e.preventDefault()
                                                handleClose(true)
                                            }
                                        }}
                                    />
                                ) : (
                                    <Input
                                        ref={promptInputRef as any}
                                        value={promptValue}
                                        onChange={(e) => setPromptValue(e.target.value)}
                                        placeholder={dialogState.options.placeholder || "请输入..."}
                                        className="h-10 rounded-xl border-border/80 bg-background/80 text-sm focus-visible:ring-primary/40"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault()
                                                handleClose(true)
                                            }
                                        }}
                                    />
                                )}
                            </div>
                        )}
                    </div>

                    {/* Footer Actions */}
                    <DialogFooter className="px-6 py-4 bg-muted/20 border-t border-border/40 flex items-center justify-end gap-2.5 sm:gap-2">
                        {dialogState?.type !== 'alert' && (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleClose(false)}
                                className="h-9 rounded-xl px-4 text-xs font-medium border-border/60 hover:bg-muted/60 transition-colors"
                            >
                                {dialogState?.type === 'confirm'
                                    ? dialogState.options.cancelText || "取消"
                                    : dialogState?.type === 'prompt'
                                    ? dialogState.options.cancelText || "取消"
                                    : "取消"}
                            </Button>
                        )}

                        <Button
                            type="button"
                            onClick={() => handleClose(true)}
                            className={cn(
                                "h-9 rounded-xl px-4 text-xs font-medium transition-all active:scale-[0.98]",
                                variantStyles.confirmBtn
                            )}
                        >
                            {dialogState?.type === 'confirm'
                                ? dialogState.options.confirmText || "确认"
                                : dialogState?.type === 'prompt'
                                ? dialogState.options.confirmText || "确认提交"
                                : dialogState?.options.confirmText || "我知道了"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </ConfirmContext.Provider>
    )
}

export function useConfirm() {
    const ctx = useContext(ConfirmContext)
    if (!ctx) {
        // Fallback to standalone helpers if hook called outside provider
        return {
            confirm: confirmModal,
            prompt: promptModal,
            alert: alertModal,
        }
    }
    return ctx
}
