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
import { Loader2, Search, ArrowLeft, ArrowRight, Edit, Ban, CheckCircle } from "lucide-react"
import { getDisplayUsername } from "@/lib/user-profile-link"
import { UserPointAdjustmentDialog } from "./user-point-adjustment-dialog"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"

interface User {
    userId: string
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
            await toggleBlock(user.userId, !user.isBlocked)
            toast.success(t('common.success'))
            router.refresh()
        } catch (e: any) {
            toast.error(e.message || t('common.error'))
        } finally {
            setBlockingId(null)
            blockLock.current = null
        }
    }

    const totalPages = Math.ceil(data.total / data.pageSize)

    return (
        <AdminListPage
            header={<h1 className="text-2xl font-bold tracking-tight">{t('admin.users.title')}</h1>}
            toolbar={
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
                <Table>
                    <TableHeader className="bg-muted/40">
                        <TableRow className="border-b border-border/60 hover:bg-transparent">
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.users.userId')}</TableHead>
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
                                <TableCell colSpan={7} className="text-center h-24 text-muted-foreground">
                                    {t('search.noResults')}
                                </TableCell>
                            </TableRow>
                        ) : (
                            data.items.map((user) => (
                                <TableRow key={user.userId}>
                                    <TableCell className="font-mono text-xs">{user.userId}</TableCell>
                                    <TableCell>
                                        <Link href={`/admin/users/${user.userId}`} className="font-medium text-sm hover:underline text-primary">
                                            {user.username ? getDisplayUsername(user.username, user.userId) : user.userId}
                                        </Link>
                                    </TableCell>
                                    <TableCell className="font-bold">{user.points}</TableCell>
                                    <TableCell>{user.orderCount}</TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : '-'}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-'}
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
                            ))
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
