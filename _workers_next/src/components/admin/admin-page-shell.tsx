'use client'

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function AdminPageShell({
    children,
    className,
    scroll = true,
}: {
    children: ReactNode
    className?: string
    scroll?: boolean
}) {
    return (
        <div className={cn(
            "flex min-h-0 flex-1 flex-col",
            scroll && "overflow-y-auto overscroll-contain",
            className
        )}>
            {children}
        </div>
    )
}

export function AdminListPage({
    header,
    toolbar,
    footer,
    children,
    className,
}: {
    header?: ReactNode
    toolbar?: ReactNode
    footer?: ReactNode
    children: ReactNode
    className?: string
}) {
    return (
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
            {header ? (
                <div className="shrink-0 space-y-3 pb-3">
                    {header}
                </div>
            ) : null}
            {toolbar ? (
                <div className="shrink-0 space-y-3 pb-3">
                    {toolbar}
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {children}
            </div>
            {footer ? (
                <div className="shrink-0 border-t border-border/50 bg-background/95 pt-3">
                    {footer}
                </div>
            ) : null}
        </div>
    )
}

export function AdminListScroll({
    children,
    className,
}: {
    children: ReactNode
    className?: string
}) {
    return (
        <div className={cn(
            "min-h-0 flex-1 overflow-auto overscroll-contain rounded-2xl border border-border/60 bg-card shadow-2xs [&>[data-slot=table-container]]:overflow-visible",
            className
        )}>
            {children}
        </div>
    )
}
