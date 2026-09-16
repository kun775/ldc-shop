'use client'

import Link from "next/link"
import { useI18n } from "@/lib/i18n/context"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { updateDesktopNotifications, updateProfileEmail } from "@/actions/profile"
import { useEffect, useRef, useState } from "react"
import { CheckInButton } from "@/components/checkin-button"
import { clearMyNotifications, getMyNotifications, markAllNotificationsRead, markNotificationRead } from "@/actions/user-notifications"
import { sendUserMessage, clearMyMessages } from "@/actions/user-messages"
import { cn } from "@/lib/utils"
import { signOut } from "next-auth/react"
import {
    Coins,
    Package,
    Clock,
    CheckCircle2,
    ChevronRight,
    User,
    LogOut,
    Bell,
    Mail,
    Send,
    MessageSquarePlus,
    CheckCheck,
    Trash2,
    Inbox,
    Shield,
    Sparkles,
    AlertCircle,
    Check,
    Copy,
    ArrowUpRight,
    LucideIcon
} from "lucide-react"

interface ProfileContentProps {
    user: {
        id: string
        name: string
        username: string | null
        avatar: string | null
        email: string | null
        trustLevel?: number
    }
    points: number
    checkinEnabled: boolean
    orderStats: {
        total: number
        pending: number
        delivered: number
    }
    notifications: Array<{
        id: number
        type: string
        titleKey: string
        contentKey: string
        data: string | null
        isRead: boolean | null
        createdAt: number | null
    }>
    sentMessages: Array<{
        id: number
        title: string
        body: string
        createdAt: number | null
    }>
    desktopNotificationsEnabled: boolean
}

export function ProfileContent({
    user,
    points,
    checkinEnabled,
    orderStats,
    notifications: initialNotifications,
    sentMessages: initialSentMessages,
    desktopNotificationsEnabled
}: ProfileContentProps) {
    const { t } = useI18n()
    const [email, setEmail] = useState(user.email || '')
    const [savedEmail, setSavedEmail] = useState(user.email || '')
    const [savingEmail, setSavingEmail] = useState(false)
    const [copiedId, setCopiedId] = useState(false)
    const [pointsValue, setPointsValue] = useState(points)
    const [notifications, setNotifications] = useState(initialNotifications)
    const [markingAll, setMarkingAll] = useState(false)
    const [markingId, setMarkingId] = useState<number | null>(null)
    const [clearing, setClearing] = useState(false)
    const [expandedIds, setExpandedIds] = useState<number[]>([])
    const [msgTitle, setMsgTitle] = useState("")
    const [msgBody, setMsgBody] = useState("")
    const [msgSending, setMsgSending] = useState(false)
    const [showComposeForm, setShowComposeForm] = useState(false)
    const [desktopEnabled, setDesktopEnabled] = useState(desktopNotificationsEnabled)
    const [desktopSaving, setDesktopSaving] = useState(false)
    const [sentMessages, setSentMessages] = useState(initialSentMessages)
    const [expandedSentIds, setExpandedSentIds] = useState<number[]>([])
    const [clearingSent, setClearingSent] = useState(false)
    const [msgTab, setMsgTab] = useState<'inbox' | 'sent'>('inbox')
    const notifiedIdsRef = useRef<Set<number>>(new Set())

    const unreadCount = notifications.filter((n) => !n.isRead).length

    const parseNotificationData = (data: string | null) => {
        if (!data) return {}
        try {
            return JSON.parse(data) as { params?: Record<string, string | number>; href?: string; title?: string; body?: string }
        } catch {
            return {}
        }
    }

    const emitNotificationUpdate = () => {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ldc:notifications-updated"))
        }
    }

    const handleCopyUserId = async () => {
        if (!user.id) return
        try {
            await navigator.clipboard.writeText(user.id)
            setCopiedId(true)
            toast.success(t('common.copied') || '已复制 ID')
            setTimeout(() => setCopiedId(false), 2000)
        } catch {
            // ignore
        }
    }

    const handleMarkRead = async (id: number) => {
        if (markingId === id) return
        setMarkingId(id)
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)))
        try {
            const res = await markNotificationRead(id)
            if (!res?.success) {
                setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)))
            }
            emitNotificationUpdate()
        } catch {
            setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)))
        } finally {
            setMarkingId(null)
        }
    }

    useEffect(() => {
        const refresh = async () => {
            try {
                const res = await getMyNotifications()
                if (res?.success && res.items) {
                    setNotifications(res.items)
                }
            } catch {
                // ignore refresh failures
            }
        }
        refresh()
    }, [])

    useEffect(() => {
        if (!desktopEnabled) return
        if (typeof window === "undefined" || !("Notification" in window)) return
        if (Notification.permission !== "granted") return

        const unread = notifications.filter((n) => !n.isRead)
        const fresh = unread.filter((n) => !notifiedIdsRef.current.has(n.id))
        if (!fresh.length) return

        fresh.slice(0, 3).forEach((n) => {
            const data = parseNotificationData(n.data)
            const params = data.params || {}
            const title = t(n.titleKey, params)
            const body = t(n.contentKey, params)
            new Notification(title, { body })
            notifiedIdsRef.current.add(n.id)
        })
    }, [desktopEnabled, notifications, t])

    const ensureNotificationPermission = async () => {
        if (typeof window === "undefined" || !("Notification" in window)) {
            toast.error(t('profile.desktopNotifications.unsupported'))
            return false
        }
        if (Notification.permission === "granted") return true
        if (Notification.permission === "denied") {
            toast.error(t('profile.desktopNotifications.permissionDenied'))
            return false
        }
        const permission = await Notification.requestPermission()
        if (permission !== "granted") {
            toast.error(t('profile.desktopNotifications.permissionDenied'))
            return false
        }
        return true
    }

    const handleToggleDesktopNotifications = async () => {
        if (desktopSaving) return
        const next = !desktopEnabled
        if (next) {
            const ok = await ensureNotificationPermission()
            if (!ok) return
        }
        setDesktopSaving(true)
        try {
            const res = await updateDesktopNotifications(next)
            if (res?.success) {
                setDesktopEnabled(next)
                toast.success(next ? t('profile.desktopNotifications.enabledToast') : t('profile.desktopNotifications.disabledToast'))
                if (next) {
                    notifiedIdsRef.current = new Set(notifications.map((n) => n.id))
                }
                if (next && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
                    new Notification(t('profile.desktopNotifications.testTitle'), {
                        body: t('profile.desktopNotifications.testBody')
                    })
                }
            } else {
                toast.error(res?.error ? t(res.error) : t('common.error'))
            }
        } catch {
            toast.error(t('common.error'))
        } finally {
            setDesktopSaving(false)
        }
    }

    const handleSaveEmail = async () => {
        setSavingEmail(true)
        try {
            const result = await updateProfileEmail(email)
            if (result?.success) {
                setSavedEmail(email.trim())
                toast.success(t('profile.emailSaved'))
            } else {
                toast.error(result?.error ? t(result.error) : t('common.error'))
            }
        } catch {
            toast.error(t('common.error'))
        } finally {
            setSavingEmail(false)
        }
    }

    const getNotificationBadge = (type: string): { icon: LucideIcon; color: string; bg: string } => {
        if (type.includes('deliver') || type.includes('order_delivered')) {
            return { icon: Package, color: 'text-emerald-500', bg: 'bg-emerald-500/10' }
        }
        if (type.includes('paid') || type.includes('order_paid')) {
            return { icon: Clock, color: 'text-amber-500', bg: 'bg-amber-500/10' }
        }
        if (type.includes('refund')) {
            return { icon: Shield, color: 'text-sky-500', bg: 'bg-sky-500/10' }
        }
        return { icon: Bell, color: 'text-primary', bg: 'bg-primary/10' }
    }

    return (
        <main className="container mx-auto max-w-6xl py-6 px-4 md:py-10 space-y-6">
            {/* Top Page Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-2 border-b border-border/50">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
                        <User className="h-6 w-6 text-primary" />
                        {user.name}
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        {user.username ? `@${user.username} · ` : ''}
                        {t('profile.settingsTitle')} · {t('common.myOrders')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Link href="/orders">
                        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs font-medium">
                            <Package className="h-3.5 w-3.5 text-muted-foreground" />
                            {t('common.myOrders')}
                            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                    </Link>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 gap-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => signOut({ callbackUrl: "/" })}
                    >
                        <LogOut className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{t('common.logout')}</span>
                    </Button>
                </div>
            </div>

            {/* Main Content Grid: Left 4 cols (User Info, Stats, Settings) + Right 8 cols (Inbox/Messages) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Left Column */}
                <div className="lg:col-span-5 xl:col-span-4 space-y-6">
                    {/* User Identity & Points Card */}
                    <Card className="rounded-2xl border border-border/60 shadow-xs overflow-hidden">
                        {/* Decorative subtle gradient top banner */}
                        <div className="h-16 bg-gradient-to-r from-primary/15 via-primary/5 to-accent/15 border-b border-border/40" />
                        
                        <CardContent className="pt-0 pb-5 px-5 relative">
                            {/* Avatar & Floating Badges */}
                            <div className="flex items-end justify-between -mt-8 mb-3">
                                <Avatar className="h-16 w-16 ring-4 ring-card shadow-sm border border-border/50">
                                    <AvatarImage src={user.avatar || ''} alt={user.name} />
                                    <AvatarFallback className="bg-primary/10 text-primary font-bold text-lg">
                                        {user.name.slice(0, 2).toUpperCase()}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="flex items-center gap-1.5">
                                    <Badge variant="outline" className="text-[11px] font-medium px-2 py-0.5 bg-background/80 backdrop-blur-xs">
                                        {t('profile.trustLevel')} Lv.{Number.isFinite(Number(user.trustLevel)) ? user.trustLevel : 0}
                                    </Badge>
                                </div>
                            </div>

                            {/* Name & ID */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-lg font-bold text-foreground truncate">{user.name}</h2>
                                </div>
                                {user.username && (
                                    <p className="text-xs text-muted-foreground">@{user.username}</p>
                                )}
                                <div className="pt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <span className="font-mono text-[11px] opacity-75">ID: {user.id}</span>
                                    <button
                                        type="button"
                                        onClick={handleCopyUserId}
                                        title={t('common.copy') || "复制"}
                                        className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        {copiedId ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5" />}
                                    </button>
                                </div>
                            </div>

                            {/* Points & Check-in Box */}
                            <div className="mt-4 rounded-xl bg-muted/40 border border-border/50 p-3.5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="h-8 w-8 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                                            <Coins className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <p className="text-[11px] text-muted-foreground font-medium">{t('points.myPoints') || "账户积分"}</p>
                                            <p className="text-lg font-bold tracking-tight text-foreground">{pointsValue}</p>
                                        </div>
                                    </div>
                                    {checkinEnabled && (
                                        <div className="shrink-0">
                                            <CheckInButton
                                                enabled={checkinEnabled}
                                                showPoints={false}
                                                showCheckedInLabel
                                                className="h-8 px-3 text-xs"
                                                onPointsChange={setPointsValue}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Order Statistics Summary */}
                            <div className="mt-4 pt-4 border-t border-border/50">
                                <div className="flex items-center justify-between mb-2.5">
                                    <span className="text-xs font-semibold text-foreground/80">{t('common.myOrders')}</span>
                                    <Link href="/orders" className="text-[11px] text-primary hover:underline flex items-center">
                                        {t('common.viewOrders')} <ChevronRight className="h-3 w-3 ml-0.5" />
                                    </Link>
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <Link
                                        href="/orders"
                                        className="group rounded-xl border border-border/40 bg-background hover:bg-muted/50 p-2.5 transition-all text-center"
                                    >
                                        <div className="h-6 w-6 rounded-md bg-muted/60 text-muted-foreground flex items-center justify-center mx-auto mb-1 group-hover:scale-105 transition-transform">
                                            <Package className="h-3.5 w-3.5" />
                                        </div>
                                        <p className="text-base font-bold text-foreground">{orderStats.total}</p>
                                        <p className="text-[10px] text-muted-foreground">{t('admin.stats.total')}</p>
                                    </Link>
                                    <Link
                                        href="/orders"
                                        className="group rounded-xl border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 p-2.5 transition-all text-center"
                                    >
                                        <div className="h-6 w-6 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-1 group-hover:scale-105 transition-transform">
                                            <Clock className="h-3.5 w-3.5" />
                                        </div>
                                        <p className="text-base font-bold text-amber-600 dark:text-amber-400">{orderStats.pending}</p>
                                        <p className="text-[10px] text-amber-700/80 dark:text-amber-300/80">{t('order.status.pending')}</p>
                                    </Link>
                                    <Link
                                        href="/orders"
                                        className="group rounded-xl border border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10 p-2.5 transition-all text-center"
                                    >
                                        <div className="h-6 w-6 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto mb-1 group-hover:scale-105 transition-transform">
                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                        </div>
                                        <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">{orderStats.delivered}</p>
                                        <p className="text-[10px] text-emerald-700/80 dark:text-emerald-300/80">{t('order.status.delivered')}</p>
                                    </Link>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Notification & Delivery Settings Card */}
                    <Card className="rounded-2xl border border-border/60 shadow-xs">
                        <CardHeader className="pb-3 pt-5 px-5">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2">
                                <Mail className="h-4 w-4 text-primary" />
                                {t('profile.settingsTitle')} · {t('profile.emailTitle')}
                            </CardTitle>
                            <CardDescription className="text-xs">
                                配置接收订单交付与卡密下载的通知设置
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="px-5 pb-5 space-y-4">
                            {/* Email Setting */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label htmlFor="profile-email" className="text-xs font-medium text-foreground">
                                        {t('profile.emailTitle')}
                                    </Label>
                                    {savedEmail ? (
                                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                            已设置
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                            未设置
                                        </span>
                                    )}
                                </div>
                                <div className="flex gap-2">
                                    <div className="relative flex-1">
                                        <Mail className="h-3.5 w-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        <Input
                                            id="profile-email"
                                            type="email"
                                            placeholder={t('profile.emailLabel') || "you@example.com"}
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            disabled={savingEmail}
                                            className="h-9 pl-8 text-xs font-mono"
                                        />
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="h-9 px-3.5 text-xs font-medium shrink-0"
                                        disabled={savingEmail || email.trim() === savedEmail}
                                        onClick={handleSaveEmail}
                                    >
                                        {savingEmail ? t('common.processing') : t('profile.emailSave')}
                                    </Button>
                                </div>
                                <div className="rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground leading-relaxed flex items-start gap-1.5 border border-border/40">
                                    <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                                    <span>{t('profile.emailHint')}</span>
                                </div>
                            </div>

                            {/* Desktop Notifications Toggle */}
                            <div className="pt-3 border-t border-border/50 flex items-center justify-between gap-3">
                                <div className="space-y-0.5 pr-2">
                                    <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                                        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                                        {t('profile.desktopNotifications.title')}
                                    </p>
                                    <p className="text-[11px] text-muted-foreground line-clamp-1">
                                        {t('profile.desktopNotifications.desc')}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant={desktopEnabled ? "default" : "outline"}
                                    size="sm"
                                    className="h-7 text-xs px-2.5 shrink-0"
                                    onClick={handleToggleDesktopNotifications}
                                    disabled={desktopSaving}
                                >
                                    {desktopEnabled ? t('profile.desktopNotifications.enabled') : t('profile.desktopNotifications.disabled')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Right Column: Message & Notification Center */}
                <div className="lg:col-span-7 xl:col-span-8 space-y-6">
                    <Card className="rounded-2xl border border-border/60 shadow-xs">
                        <CardHeader className="pb-3 pt-5 px-5 border-b border-border/50">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                                {/* Segmented Tabs */}
                                <div className="inline-flex p-1 bg-muted/60 rounded-xl border border-border/40 self-start sm:self-auto">
                                    <button
                                        type="button"
                                        onClick={() => setMsgTab('inbox')}
                                        className={cn(
                                            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all",
                                            msgTab === 'inbox'
                                                ? "bg-background text-foreground shadow-xs"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        <Inbox className="h-3.5 w-3.5" />
                                        <span>{t('profile.inboxTitle')}</span>
                                        {unreadCount > 0 && (
                                            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-semibold text-white px-1">
                                                {unreadCount > 99 ? "99+" : unreadCount}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMsgTab('sent')}
                                        className={cn(
                                            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all",
                                            msgTab === 'sent'
                                                ? "bg-background text-foreground shadow-xs"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        <Send className="h-3.5 w-3.5" />
                                        <span>{t('profile.sentTitle')}</span>
                                        {sentMessages.length > 0 && (
                                            <span className="text-[11px] text-muted-foreground opacity-80">
                                                ({sentMessages.length})
                                            </span>
                                        )}
                                    </button>
                                </div>

                                {/* Actions Toolbar */}
                                <div className="flex items-center gap-1.5 self-end sm:self-auto">
                                    {msgTab === 'inbox' && notifications.length > 0 && (
                                        <>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground gap-1"
                                                disabled={markingAll || unreadCount === 0}
                                                onClick={async () => {
                                                    if (markingAll || unreadCount === 0) return
                                                    setMarkingAll(true)
                                                    try {
                                                        const res = await markAllNotificationsRead()
                                                        if (res?.success) {
                                                            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })))
                                                            emitNotificationUpdate()
                                                            toast.success(t('profile.inboxMarked'))
                                                        } else {
                                                            toast.error(t('common.error'))
                                                        }
                                                    } catch {
                                                        toast.error(t('common.error'))
                                                    } finally {
                                                        setMarkingAll(false)
                                                    }
                                                }}
                                            >
                                                <CheckCheck className="h-3.5 w-3.5" />
                                                <span className="hidden sm:inline">{t('profile.markAllRead')}</span>
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-8 text-xs px-2.5 text-muted-foreground hover:text-destructive gap-1"
                                                disabled={clearing}
                                                onClick={async () => {
                                                    if (clearing) return
                                                    setClearing(true)
                                                    try {
                                                        const res = await clearMyNotifications()
                                                        if (res?.success) {
                                                            setNotifications([])
                                                            emitNotificationUpdate()
                                                            toast.success(t('profile.inboxCleared'))
                                                        } else {
                                                            toast.error(t('common.error'))
                                                        }
                                                    } catch {
                                                        toast.error(t('common.error'))
                                                    } finally {
                                                        setClearing(false)
                                                    }
                                                }}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                <span className="hidden sm:inline">{t('profile.clearInbox')}</span>
                                            </Button>
                                        </>
                                    )}

                                    {msgTab === 'sent' && sentMessages.length > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-destructive gap-1"
                                            disabled={clearingSent}
                                            onClick={async () => {
                                                if (clearingSent) return
                                                setClearingSent(true)
                                                try {
                                                    const res = await clearMyMessages()
                                                    if (res?.success) {
                                                        setSentMessages([])
                                                        toast.success(t('profile.sentCleared'))
                                                    } else {
                                                        toast.error(t('common.error'))
                                                    }
                                                } catch {
                                                    toast.error(t('common.error'))
                                                } finally {
                                                    setClearingSent(false)
                                                }
                                            }}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            <span>{t('profile.clearSent')}</span>
                                        </Button>
                                    )}

                                    <Button
                                        variant={showComposeForm ? 'secondary' : 'default'}
                                        size="sm"
                                        className="h-8 text-xs px-3 gap-1.5 shadow-2xs font-medium"
                                        onClick={() => setShowComposeForm(!showComposeForm)}
                                    >
                                        <MessageSquarePlus className="h-3.5 w-3.5" />
                                        <span>{t('profile.messages.compose')}</span>
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>

                        <CardContent className="p-5">
                            {/* Compose Form Modal / Inline Box */}
                            {showComposeForm && (
                                <div className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3.5">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                            <Send className="h-3.5 w-3.5 text-primary" />
                                            {t('profile.messages.title')}
                                        </h3>
                                        <span className="text-[11px] text-muted-foreground">
                                            发送给商城管理员
                                        </span>
                                    </div>
                                    <Input
                                        value={msgTitle}
                                        onChange={(e) => setMsgTitle(e.target.value)}
                                        placeholder={t('profile.messages.titlePlaceholder')}
                                        disabled={msgSending}
                                        className="h-9 text-xs bg-background"
                                    />
                                    <Textarea
                                        className="min-h-[110px] resize-none text-xs bg-background"
                                        placeholder={t('profile.messages.bodyPlaceholder')}
                                        value={msgBody}
                                        onChange={(e) => setMsgBody(e.target.value)}
                                        disabled={msgSending}
                                    />
                                    <div className="flex justify-end gap-2 pt-1">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 text-xs"
                                            onClick={() => setShowComposeForm(false)}
                                        >
                                            {t('common.cancel')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            className="h-8 text-xs px-4"
                                            disabled={msgSending || !msgTitle.trim() || !msgBody.trim()}
                                            onClick={async () => {
                                                if (!msgTitle.trim() || !msgBody.trim()) {
                                                    toast.error(t('profile.messages.missing'))
                                                    return
                                                }
                                                setMsgSending(true)
                                                try {
                                                    const res = await sendUserMessage(msgTitle.trim(), msgBody.trim())
                                                    if (res?.success) {
                                                        toast.success(t('profile.messages.sent'))
                                                        setSentMessages((prev) => [
                                                            {
                                                                id: Date.now(),
                                                                title: msgTitle.trim(),
                                                                body: msgBody.trim(),
                                                                createdAt: Date.now()
                                                            },
                                                            ...prev
                                                        ])
                                                        setMsgTitle("")
                                                        setMsgBody("")
                                                        setShowComposeForm(false)
                                                    } else {
                                                        toast.error(res?.error ? t(res.error) : t('common.error'))
                                                    }
                                                } catch {
                                                    toast.error(t('common.error'))
                                                } finally {
                                                    setMsgSending(false)
                                                }
                                            }}
                                        >
                                            {msgSending ? t('common.processing') : t('profile.messages.send')}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* Tab 1: Notifications Inbox */}
                            {msgTab === 'inbox' && (
                                notifications.length === 0 ? (
                                    <div className="py-12 text-center space-y-2">
                                        <div className="h-12 w-12 rounded-full bg-muted/60 text-muted-foreground/60 flex items-center justify-center mx-auto mb-2">
                                            <Inbox className="h-6 w-6" />
                                        </div>
                                        <p className="text-sm font-medium text-foreground">{t('profile.inboxEmpty')}</p>
                                        <p className="text-xs text-muted-foreground">当有订单交付、发卡通知或系统消息时，将展示在这里。</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2.5">
                                        {notifications.map((n) => {
                                            const meta = parseNotificationData(n.data)
                                            const params = meta.params || {}
                                            const title = typeof meta.title === "string" && meta.title.trim()
                                                ? meta.title
                                                : t(n.titleKey, params)
                                            const content = typeof meta.body === "string" && meta.body.trim()
                                                ? meta.body
                                                : t(n.contentKey, params)
                                            const time = n.createdAt ? new Date(n.createdAt).toLocaleString() : '-'
                                            const isExpanded = expandedIds.includes(n.id)
                                            const badgeStyle = getNotificationBadge(n.type)
                                            const BadgeIcon = badgeStyle.icon

                                            const cardNode = (
                                                <div
                                                    className={cn(
                                                        "group rounded-xl border p-3.5 transition-all",
                                                        !n.isRead
                                                            ? "bg-primary/5 border-primary/30 shadow-2xs hover:border-primary/50"
                                                            : "bg-card hover:bg-muted/30 border-border/60"
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        {/* Notification Type Icon */}
                                                        <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5", badgeStyle.bg, badgeStyle.color)}>
                                                            <BadgeIcon className="h-4 w-4" />
                                                        </div>

                                                        {/* Content area */}
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                                <div className="flex items-center gap-2 min-w-0">
                                                                    <span className={cn("text-xs font-semibold truncate", !n.isRead ? "text-foreground" : "text-foreground/85")}>
                                                                        {title}
                                                                    </span>
                                                                    {!n.isRead && (
                                                                        <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-primary text-primary-foreground shrink-0">
                                                                            {t('profile.unread')}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                                                                    {time}
                                                                </span>
                                                            </div>

                                                            <p
                                                                className={cn(
                                                                    "text-xs text-muted-foreground leading-relaxed break-words whitespace-pre-wrap",
                                                                    !isExpanded ? "line-clamp-2" : ""
                                                                )}
                                                            >
                                                                {content}
                                                            </p>

                                                            {/* Action Link Footer if available */}
                                                            {meta.href && (
                                                                <div className="mt-2 pt-2 border-t border-border/40 flex items-center justify-between text-xs">
                                                                    <span className="text-[11px] text-primary font-medium group-hover:underline flex items-center gap-1">
                                                                        查看订单详情
                                                                        <ChevronRight className="h-3 w-3" />
                                                                    </span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            )

                                            return meta.href ? (
                                                <Link
                                                    key={n.id}
                                                    href={meta.href}
                                                    className="block"
                                                    onClick={() => {
                                                        if (!n.isRead) void handleMarkRead(n.id)
                                                    }}
                                                >
                                                    {cardNode}
                                                </Link>
                                            ) : (
                                                <div
                                                    key={n.id}
                                                    className="cursor-pointer"
                                                    onClick={() => {
                                                        if (!n.isRead) void handleMarkRead(n.id)
                                                        setExpandedIds((prev) =>
                                                            prev.includes(n.id) ? prev.filter((x) => x !== n.id) : [...prev, n.id]
                                                        )
                                                    }}
                                                >
                                                    {cardNode}
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            )}

                            {/* Tab 2: Sent Messages */}
                            {msgTab === 'sent' && (
                                sentMessages.length === 0 ? (
                                    <div className="py-12 text-center space-y-2">
                                        <div className="h-12 w-12 rounded-full bg-muted/60 text-muted-foreground/60 flex items-center justify-center mx-auto mb-2">
                                            <Send className="h-6 w-6" />
                                        </div>
                                        <p className="text-sm font-medium text-foreground">{t('profile.sentEmpty')}</p>
                                        <p className="text-xs text-muted-foreground">您向管理员发送的留言记录将展示在这里。</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2.5">
                                        {sentMessages.map((m) => {
                                            const isExpanded = expandedSentIds.includes(m.id)
                                            return (
                                                <div
                                                    key={m.id}
                                                    className="rounded-xl border border-border/60 bg-card p-3.5 hover:bg-muted/30 transition-colors cursor-pointer"
                                                    onClick={() => {
                                                        setExpandedSentIds((prev) =>
                                                            prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                                                        )
                                                    }}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="h-8 w-8 rounded-lg bg-muted text-muted-foreground flex items-center justify-center shrink-0 mt-0.5">
                                                            <Send className="h-4 w-4" />
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                                <span className="text-xs font-semibold text-foreground truncate">
                                                                    {m.title || t('profile.messages.noTitle')}
                                                                </span>
                                                                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                                                                    {m.createdAt ? new Date(m.createdAt).toLocaleString() : '-'}
                                                                </span>
                                                            </div>
                                                            <p
                                                                className={cn(
                                                                    "text-xs text-muted-foreground leading-relaxed break-words whitespace-pre-wrap",
                                                                    !isExpanded ? "line-clamp-2" : ""
                                                                )}
                                                            >
                                                                {m.body}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </main>
    )
}
