'use client'

import { useEffect, useMemo, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, ArrowUp, ArrowDown, Search, ChevronLeft, ChevronRight } from "lucide-react"
import { deleteProduct, toggleProductStatus, reorderProduct } from "@/actions/admin"
import { INFINITE_STOCK } from "@/lib/constants"
import { toast } from "sonner"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"

interface Product {
    id: string
    name: string
    price: string
    compareAtPrice: string | null
    category: string | null
    stockCount: number
    isActive: boolean
    isHot: boolean
    sortOrder: number
    pointDiscountEnabled?: boolean | null
    pointDiscountPercent?: number | null
    fulfillmentMode: 'auto' | 'manual'
    variantGroupId?: string | null
    variantLabel?: string | null
}

interface AdminProductsContentProps {
    products: Product[]
    lowStockThreshold: number
}

export function AdminProductsContent({ products, lowStockThreshold }: AdminProductsContentProps) {
    const { t } = useI18n()
    const { confirm } = useConfirm()
    const router = useRouter()
    const [busy, setBusy] = useState(false)
    const [search, setSearch] = useState("")
    const [page, setPage] = useState(1)
    const busyRef = useRef(false)

    const threshold = lowStockThreshold || 5
    const pageSize = 20

    const filteredProducts = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return products
        return products.filter((p) => {
            const nameMatch = p.name.toLowerCase().includes(q)
            const catMatch = (p.category || '').toLowerCase().includes(q)
            const variantMatch = [p.variantGroupId, p.variantLabel].filter(Boolean).join(" ").toLowerCase().includes(q)
            return nameMatch || catMatch || variantMatch
        })
    }, [products, search])

    // 搜索条件变化时回到第一页
    useEffect(() => {
        setPage(1)
    }, [search])

    const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize))
    const safePage = Math.min(page, totalPages)
    const pagedProducts = useMemo(
        () => filteredProducts.slice((safePage - 1) * pageSize, safePage * pageSize),
        [filteredProducts, safePage]
    )
    const showingFrom = filteredProducts.length === 0 ? 0 : (safePage - 1) * pageSize + 1
    const showingTo = Math.min(safePage * pageSize, filteredProducts.length)

    const handleDelete = async (id: string) => {
        if (busyRef.current) return
        const ok = await confirm({
            title: t('admin.products.confirmDelete'),
            description: "删除后商品及其关联数据将无法恢复，确认要删除此商品吗？",
            variant: "destructive",
            icon: "trash",
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        })
        if (!ok) return
        busyRef.current = true
        setBusy(true)
        try {
            await deleteProduct(id)
            toast.success(t('common.success'))
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setBusy(false)
            busyRef.current = false
        }
    }

    const handleToggle = async (id: string, currentStatus: boolean) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        try {
            await toggleProductStatus(id, !currentStatus)
            toast.success(t('common.success'))
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setBusy(false)
            busyRef.current = false
        }
    }

    const handleReorder = async (id: string, direction: 'up' | 'down') => {
        if (busyRef.current) return
        const idx = products.findIndex(p => p.id === id)
        if (idx === -1) return

        // Swap with neighbor
        const targetIdx = direction === 'up' ? idx - 1 : idx + 1
        if (targetIdx < 0 || targetIdx >= products.length) return

        const current = products[idx]
        const target = products[targetIdx]

        busyRef.current = true
        setBusy(true)
        try {
            // Use index as sortOrder to ensure unique values
            await reorderProduct(current.id, targetIdx)
            await reorderProduct(target.id, idx)
            toast.success(t('common.success'))
            router.refresh()
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setBusy(false)
            busyRef.current = false
        }
    }

    return (
        <AdminListPage
            header={
                <div className="flex items-center justify-between">
                    <h1 className="text-2xl font-bold tracking-tight">{t('common.productManagement')}</h1>
                    <Button asChild size="sm" className="rounded-xl">
                        <Link href="/admin/product/new">
                            <Plus className="h-4 w-4 mr-2" />
                            {t('admin.products.addNew')}
                        </Link>
                    </Button>
                </div>
            }
            toolbar={
                <div className="flex items-center justify-between gap-4">
                    <div className="relative w-full max-w-sm">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            type="search"
                            aria-label="搜索商品名称、分类或规格"
                            placeholder="搜索商品名称、分类或规格..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="pl-9 h-9 text-xs"
                        />
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                        共 {filteredProducts.length} 个商品
                    </div>
                </div>
            }
            footer={
                filteredProducts.length > 0 ? (
                    <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                        <div>
                            显示 {showingFrom}-{showingTo} / 共 {filteredProducts.length} 条
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs gap-1 border-border/80"
                                disabled={safePage <= 1}
                                onClick={() => setPage(Math.max(1, safePage - 1))}
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                <span>上一页</span>
                            </Button>
                            <span className="text-xs font-mono px-2.5 py-1 rounded-md bg-muted/40 border border-border/50">
                                {safePage} / {totalPages}
                            </span>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs gap-1 border-border/80"
                                disabled={safePage >= totalPages}
                                onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                            >
                                <span>下一页</span>
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    </div>
                ) : null
            }
        >
            <AdminListScroll>
                <Table>
                    <TableHeader className="bg-muted/40">
                        <TableRow className="border-b border-border/60 hover:bg-transparent">
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur w-[50px]">{t('admin.products.order')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.name')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.price')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.category')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.fulfillment')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.hot')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.stock')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.status')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur text-right">{t('admin.products.actions')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filteredProducts.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                                    未找到符合条件的商品
                                </TableCell>
                            </TableRow>
                        ) : (
                            pagedProducts.map((product, idx) => (
                            <TableRow key={product.id} className={!product.isActive ? 'opacity-50' : ''}>
                                <TableCell>
                                    <div className="flex flex-col gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6"
                                            aria-label="上移"
                                            title="上移"
                                            onClick={() => handleReorder(product.id, 'up')}
                                            disabled={busy || ((safePage - 1) * pageSize + idx) === 0}
                                        >
                                            <ArrowUp className="h-3 w-3" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6"
                                            aria-label="下移"
                                            title="下移"
                                            onClick={() => handleReorder(product.id, 'down')}
                                            disabled={busy || idx === products.length - 1}
                                        >
                                            <ArrowDown className="h-3 w-3" />
                                        </Button>
                                </div>
                                </TableCell>
                                <TableCell className="font-medium">
                                    <div className="flex flex-col gap-1">
                                        <span>{product.name}</span>
                                        {(product.variantGroupId || product.variantLabel) && (
                                            <span className="text-xs text-muted-foreground">
                                                {[product.variantGroupId, product.variantLabel].filter(Boolean).join(" · ")}
                                            </span>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-2">
                                            <span>{Number(product.price)}</span>
                                            {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
                                                <span className="text-xs text-muted-foreground line-through">
                                                    {Number(product.compareAtPrice)}
                                                </span>
                                            )}
                                        </div>
                                        {product.pointDiscountEnabled && Number(product.pointDiscountPercent || 0) > 0 && (
                                            <Badge variant="secondary" className="w-fit text-[10px]">
                                                {t('common.pointDiscountBadge', { percent: Number(product.pointDiscountPercent || 0) })}
                                            </Badge>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="capitalize">{product.category || 'general'}</TableCell>
                                <TableCell>
                                    <Badge variant="outline" className={product.fulfillmentMode === 'manual'
                                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                                        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}>
                                        {product.fulfillmentMode === 'manual'
                                            ? t('admin.products.fulfillmentManual')
                                            : t('admin.products.fulfillmentAuto')}
                                    </Badge>
                                </TableCell>
                                <TableCell>
                                    {product.isHot ? (
                                        <Badge variant="secondary">{t('common.yes')}</Badge>
                                    ) : (
                                        <span className="text-muted-foreground">-</span>
                                    )}
                                </TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <span>{product.stockCount >= INFINITE_STOCK ? "∞" : product.stockCount}</span>
                                        {product.stockCount <= threshold && (
                                            <Badge variant="destructive" className="text-[10px]">{t('admin.products.lowStock')}</Badge>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={product.isActive ? 'default' : 'secondary'}>
                                        {product.isActive ? t('admin.products.active') : t('admin.products.inactive')}
                                    </Badge>
                                </TableCell>
                                <TableCell className="text-right space-x-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => handleToggle(product.id, product.isActive)}
                                        title={product.isActive ? t('admin.products.hide') : t('admin.products.show')}
                                        disabled={busy}
                                    >
                                        {product.isActive ? t('admin.products.hide') : t('admin.products.show')}
                                    </Button>
                                    {product.fulfillmentMode !== 'manual' && (
                                        <Button asChild variant="outline" size="sm">
                                            <Link href={`/admin/cards/${product.id}`}>
                                                {t('admin.products.manageCards')}
                                            </Link>
                                        </Button>
                                    )}
                                    <Button asChild variant="outline" size="sm">
                                        <Link href={`/admin/product/edit/${product.id}`} prefetch={false}>
                                            {t('common.edit')}
                                        </Link>
                                    </Button>
                                    <Button variant="destructive" size="sm" onClick={() => handleDelete(product.id)} disabled={busy}>
                                        {t('common.delete')}
                                    </Button>
                                </TableCell>
                            </TableRow>
                        )))}
                    </TableBody>
                </Table>
            </AdminListScroll>
        </AdminListPage>
    )
}
