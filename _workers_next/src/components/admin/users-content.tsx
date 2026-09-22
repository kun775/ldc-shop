'use client'

import Link from "next/link"
import { useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "sonner"
import { toggleBlock } from "@/actions/admin-users"
import { Loader2, Search, ArrowLeft, ArrowRight, Edit, Ban, CheckCircle, UserRoundCheck, CalendarDays, CalendarRange } from "lucide-react"
import { getAdminUserProfileUrl, getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { UserPointAdjustmentDialog } from "./user-point-adjustment-dialog"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"
import { ClientDate } from "@/components/client-date"

interface User {
    userId: string
    nickname: string | null
    username: string | null
    points: number
    lastLoginAt: Date | null
    createdAt: Date | null
    orderCount: number
    isBlocked: boolean
}

interface UsersContentProps {
    data: {
        items: User[]
        total: number
        page: number
        pageSize: number
        activity: {
            today: number
            last7Days: number
            last30Days: number
        }
    }
}

export function UsersContent({ data }: UsersContentProps) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const router = useRouter()
    const searchParams = useSearchParams()

    // Search state
    const [searchTerm, setSearchTerm] = useState(searchParams.get('q') || '')
    const [isSearching, setIsSearching] = useState(false)

    // Edit state
    const [editingUser, setEditingUser] = useState<User | null>(null)
    const [blockingId, setBlockingId] = useState<string | null>(null)
    const blockLock = useRef<string | null>(null)

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        setIsSearching(true)
        const params = new URLSearchParams(searchParams)
        if (searchTerm) {
            params.set('q', searchTerm)
        } else {
            params.delete('q')
        }
        params.set('page', '1') // Reset to page 1
        router.push(`/admin/users?${params.toString()}`)
        setIsSearching(false)
    }

    const handlePageChange = (newPage: number) => {
        const params = new URLSearchParams(searchParams)
        params.set('page', String(newPage))
        router.push(`/admin/users?${params.toString()}`)
    }

    const openEditDialog = (user: User) => {
        setEditingUser(user)
    }

    const handleToggleBlock = async (user: User) => {
        if (blockLock.current === user.userId) return
        const action = user.isBlocked ? 'unblock' : 'block'
        const isBlock = !user.isBlocked
        const ok = await confirm({
            title: isBlock ? "封禁用户" : "解封用户",
            description: t(`admin.users.confirm${action.charAt(0).toUpperCase() + action.slice(1)}`),
            variant: isBlock ? "destructive" : "default",
            icon: isBlock ? "alert" : "check",
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return

        try {
            blockLock.current = user.userId
            setBlockingId(user.userId)
            const result = await toggleBlock(user.userId, !user.isBlocked)
            if (!result.success) {
                toast.error(t(result.error))
                return
            }
            toast.success(t('common.success'))
            router.refresh()
        } catch {
            toast.error(t('common.error'))
        } finally {
            setBlockingId(null)
            blockLock.current = null
        }
    }

    const totalPages = Math.ceil(data.total / data.pageSize)
    const activityMetrics = [
        {
            label: t('admin.users.activeToday'),
            value: data.activity.today,
            icon: <UserRoundCheck className="h-4 w-4" />,
            tone: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        },
        {
            label: t('admin.users.activeLast7Days'),
            value: data.activity.last7Days,
            icon: <CalendarDays className="h-4 w-4" />,
            tone: 'border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400',
        },
        {
            label: t('admin.users.activeLast30Days'),
            value: data.activity.last30Days,
            icon: <CalendarRange className="h-4 w-4" />,
            tone: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        },
    ]

    return (
        <AdminListPage
            header={<h1 className="text-2xl font-bold tracking-tight">{t('admin.users.title')}</h1>}
            toolbar={
                <div className="space-y-3">
                    <div
                        className="grid grid-cols-3 divide-x divide-border/60 rounded-md border border-border/60 bg-card"
                        role="group"
                        aria-label={t('admin.users.activityStats')}
                    >
                        {activityMetrics.map((metric) => (
                            <div key={metric.label} className="min-w-0 px-3 py-3 sm:px-4">
                                <div className="flex items-center gap-2">
                                    <span className={`hidden h-8 w-8 shrink-0 items-center justify-center rounded-md border sm:flex ${metric.tone}`}>
                                        {metric.icon}
                                    </span>
                                    <span className="font-mono text-lg font-semibold tabular-nums text-foreground sm:text-xl">
                                        {metric.value}
                                    </span>
                                </div>
                                <div className="mt-1 text-[11px] leading-4 text-muted-foreground sm:text-xs">
                                    {metric.label}
                                </div>
                            </div>
                        ))}
                    </div>
                    <form onSubmit={handleSearch} className="flex max-w-xl gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                type="search"
                                aria-label={t('admin.users.search')}
                                placeholder={t('admin.users.search')}
                                className="pl-9"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <Button type="submit" disabled={isSearching}>
                            {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : t('admin.users.search')}
                        </Button>
                    </form>
                </div>
            }
            footer={
                data.total > 0 ? (
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(data.page - 1)}
                            disabled={data.page <= 1}
                        >
                            <ArrowLeft className="h-4 w-4 mr-2" />
                            {t('search.prev')}
                        </Button>
                        <div className="flex items-center text-sm text-muted-foreground">
                            {t('search.page', { page: data.page, totalPages: totalPages })}
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(data.page + 1)}
                            disabled={data.page >= totalPages}
                        >
                            {t('search.next')}
                            <ArrowRight className="h-4 w-4 ml-2" />
                        </Button>
                    </div>
                ) : null
            }
        >
            <AdminListScroll>
                <Table className="min-w-[1080px]">
                    <TableHeader className="bg-muted/40">
                        <TableRow className="border-b border-border/60 hover:bg-transparent">
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.userId')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.nickname')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.username')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.points')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.orders')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.lastLogin')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.createdAt')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur text-right">{t('common.actions')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.items.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="text-center h-24 text-muted-foreground">
                                    {t('search.noResults')}
                                </TableCell>
                            </TableRow>
                        ) : (
                            data.items.map((user) => {
                                const externalProfileUrl = getExternalProfileUrl(user.username, user.userId)
                                const adminProfileUrl = getAdminUserProfileUrl(user.userId)

                                return (
                                <TableRow key={user.userId}>
                                    <TableCell className="font-mono text-xs">
                                        {externalProfileUrl ? (
                                            <a
                                                href={externalProfileUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-primary hover:underline"
                                                title="查看授权平台用户主页"
                                            >
                                                {user.userId}
                                            </a>
                                        ) : user.userId}
                                    </TableCell>
                                    <TableCell>
                                        {adminProfileUrl ? (
                                            <Link href={adminProfileUrl} className="font-medium text-sm hover:underline text-primary">
                                                {user.nickname?.trim() || '-'}
                                            </Link>
                                        ) : user.nickname?.trim() || '-'}
                                    </TableCell>
                                    <TableCell>
                                        {adminProfileUrl ? (
                                            <Link href={adminProfileUrl} className="font-medium text-sm hover:underline text-primary">
                                                {user.username ? getDisplayUsername(user.username, user.userId) : user.userId}
                                            </Link>
                                        ) : user.username ? getDisplayUsername(user.username, user.userId) : user.userId}
                                    </TableCell>
                                    <TableCell className="font-bold">{user.points}</TableCell>
                                    <TableCell>{user.orderCount}</TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        <ClientDate value={user.lastLoginAt} format="dateTime" placeholder="-" />
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        <ClientDate value={user.createdAt} format="dateTime" placeholder="-" />
                                    </TableCell>
                                    <TableCell className="text-right flex justify-end gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => openEditDialog(user)}
                                        >
                                            <Edit className="h-4 w-4 mr-2" />
                                            {t('admin.users.adjustPoints')}
                                        </Button>
                                        <Button
                                            variant={user.isBlocked ? "default" : "destructive"}
                                            size="sm"
                                            onClick={() => handleToggleBlock(user)}
                                            title={user.isBlocked ? t('admin.users.unblock') : t('admin.users.block')}
                                            disabled={blockingId === user.userId}
                                        >
                                            {user.isBlocked ? <CheckCircle className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                                )
                            })
                        )}
                    </TableBody>
                </Table>
            </AdminListScroll>
            <UserPointAdjustmentDialog
                open={!!editingUser}
                onOpenChange={(open) => {
                    if (!open) {
                        setEditingUser(null)
                    }
                }}
                userId={editingUser?.userId || ""}
                username={editingUser?.username || null}
                currentPoints={editingUser?.points || 0}
                onSuccess={() => {
                    setEditingUser(null)
                    router.refresh()
                }}
            />
        </AdminListPage>
    )
}
