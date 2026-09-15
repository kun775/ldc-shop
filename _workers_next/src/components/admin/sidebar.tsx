'use client'

import type { ReactNode } from "react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTrigger, SheetClose } from "@/components/ui/sheet"
import { Package, CreditCard, Megaphone, Star, Download, Tags, RotateCcw, Users, Settings, QrCode, Bell, Menu, MessageSquare } from "lucide-react"
import { useI18n } from "@/lib/i18n/context"
import { getPendingRefundRequestCount } from "@/actions/refund-requests"
import { getUnreadUserMessageCount } from "@/actions/user-messages"
import { cn } from "@/lib/utils"

interface NavLinkProps {
    href: string
    icon: ReactNode
    label: ReactNode
    badge?: ReactNode
    closeOnNavigate?: boolean
}

function NavLink({ href, icon, label, badge, closeOnNavigate }: NavLinkProps) {
    const pathname = usePathname()
    const isActive = pathname === href || (href !== '/admin/settings' && pathname.startsWith(href))

    const content = (
        <span className="flex w-full items-center justify-between">
            <span className="flex items-center gap-2.5 min-w-0">
                <span className={cn(
                    "transition-colors shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )}>
                    {icon}
                </span>
                <span className="truncate">{label}</span>
            </span>
            {badge}
        </span>
    )
    const linkClass = cn(
        "group flex h-9 w-full items-center justify-between rounded-xl px-3 text-xs font-medium transition-all select-none",
        isActive
            ? "bg-primary/10 text-primary font-semibold shadow-2xs border border-primary/20"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    )

    if (closeOnNavigate) {
        return (
            <SheetClose asChild>
                <Link href={href} className={linkClass}>{content}</Link>
            </SheetClose>
        )
    }
    return (
        <Link href={href} className={linkClass}>{content}</Link>
    )
}

interface SidebarContentProps {
    closeOnNavigate?: boolean
    showTitle?: boolean
    username?: string
    t: (key: string) => string
}

function SidebarContent({ closeOnNavigate = false, showTitle = true, username, t }: SidebarContentProps) {
    const pathname = usePathname()
    const [pendingRefunds, setPendingRefunds] = useState(0)
    const [unreadMessages, setUnreadMessages] = useState(0)

    useEffect(() => {
        let active = true
        const refresh = async () => {
            try {
                const res = await getPendingRefundRequestCount()
                if (active && res?.success) {
                    setPendingRefunds(res.count || 0)
                }
                const msgRes = await getUnreadUserMessageCount()
                if (active && msgRes?.success) {
                    setUnreadMessages(msgRes.count || 0)
                }
            } catch {
                // ignore
            }
        }
        refresh()
        return () => {
            active = false
        }
    }, [pathname])

    useEffect(() => {
        const handler = () => {
            void (async () => {
                try {
                    const res = await getPendingRefundRequestCount()
                    if (res?.success) {
                        setPendingRefunds(res.count || 0)
                    }
                    const msgRes = await getUnreadUserMessageCount()
                    if (msgRes?.success) {
                        setUnreadMessages(msgRes.count || 0)
                    }
                } catch {
                    // ignore
                }
            })()
        }
        if (typeof window !== "undefined") {
            window.addEventListener("ldc:refunds-updated", handler)
            window.addEventListener("ldc:user-messages-updated", handler)
        }
        return () => {
            if (typeof window !== "undefined") {
                window.removeEventListener("ldc:refunds-updated", handler)
                window.removeEventListener("ldc:user-messages-updated", handler)
            }
        }
    }, [])

    const refundBadge = pendingRefunds > 0 ? (
        <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {pendingRefunds > 99 ? "99+" : pendingRefunds}
        </span>
    ) : null

    const messageBadge = unreadMessages > 0 ? (
        <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unreadMessages > 99 ? "99+" : unreadMessages}
        </span>
    ) : null

    return (
        <div className="space-y-4">
            {showTitle && (
                <div className="flex items-center justify-between px-2 mb-4">
                    <span className="font-bold text-base tracking-tight text-foreground">{t('common.adminTitle')}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">Admin</span>
                </div>
            )}
            
            <nav className="space-y-4">
                <div className="space-y-1">
                    <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/60">
                        店铺运营
                    </div>
                    <NavLink href="/admin/settings" icon={<Settings className="h-4 w-4" />} label={t('common.storeSettings')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/products" icon={<Package className="h-4 w-4" />} label={t('common.productManagement')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/orders" icon={<CreditCard className="h-4 w-4" />} label={t('common.ordersRefunds')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/categories" icon={<Tags className="h-4 w-4" />} label={t('common.categoriesManage')} closeOnNavigate={closeOnNavigate} />
                </div>

                <div className="space-y-1">
                    <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/60">
                        客户与售后
                    </div>
                    <NavLink href="/admin/refunds" icon={<RotateCcw className="h-4 w-4" />} label={t('common.refundRequests')} badge={refundBadge} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/messages" icon={<MessageSquare className="h-4 w-4" />} label={t('common.adminMessages')} badge={messageBadge} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/users" icon={<Users className="h-4 w-4" />} label={t('common.customers')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/reviews" icon={<Star className="h-4 w-4" />} label={t('common.reviews')} closeOnNavigate={closeOnNavigate} />
                </div>

                <div className="space-y-1">
                    <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/60">
                        系统与工具
                    </div>
                    <NavLink href="/admin/announcement" icon={<Megaphone className="h-4 w-4" />} label={t('announcement.title')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/data" icon={<Download className="h-4 w-4" />} label={t('common.dataExport')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/collect" icon={<QrCode className="h-4 w-4" />} label={t('payment.adminMenu')} closeOnNavigate={closeOnNavigate} />
                    <NavLink href="/admin/notifications" icon={<Bell className="h-4 w-4" />} label={t('admin.settings.notifications.title')} closeOnNavigate={closeOnNavigate} />
                </div>
            </nav>
        </div>
    )
}

export function AdminSidebar({ username }: { username: string }) {
    const { t } = useI18n()

    return (
        <>
            {/* Mobile header */}
            <div className="md:hidden sticky top-0 z-40 w-full border-b bg-background/90 backdrop-blur">
                <div className="flex items-center justify-between px-4 py-3">
                    <span className="font-bold">{t('common.adminTitle')}</span>
                    <Sheet>
                        <SheetTrigger asChild>
                            <Button variant="outline" size="sm">
                                <Menu className="h-4 w-4 mr-2" />
                                {t('common.menu')}
                            </Button>
                        </SheetTrigger>
                        <SheetContent side="left" className="w-4/5 max-w-sm">
                            <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-6">
                                <SidebarContent closeOnNavigate showTitle={false} username={username} t={t} />
                            </div>
                        </SheetContent>
                    </Sheet>
                </div>
            </div>

            {/* Desktop sidebar */}
            <aside className="hidden border-r bg-muted/40 md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col">
                <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
                    <SidebarContent username={username} t={t} />
                </div>
            </aside>
        </>
    )
}
