'use client'

import { useMemo, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Eye, EyeOff, ArrowUp, ArrowDown, Search } from "lucide-react"
import { deleteProduct, toggleProductStatus, reorderProduct } from "@/actions/admin"
import { INFINITE_STOCK } from "@/lib/constants"
import { toast } from "sonner"
import { useConfirm } from "@/components/confirm-dialog-provider"
import { AdminListPage, AdminListScroll } from "@/components/admin/admin-page-shell"

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
    const busyRef = useRef(false)

    const threshold = lowStockThreshold || 5

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
            toast.error(e.message)
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
            toast.error(e.message)
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
            toast.error(e.message)
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
                <div className="relative max-w-sm">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="搜索商品名称、分类或规格..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-9 h-9 text-xs"
                    />
                </div>
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
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.hot')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.stock')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">{t('admin.products.status')}</TableHead>
                            <TableHead className="sticky top-0 z-10 bg-muted/95 backdrop-blur text-right">{t('admin.products.actions')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filteredProducts.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                                    未找到符合条件的商品
                                </TableCell>
                            </TableRow>
                        ) : (
                            filteredProducts.map((product, idx) => (
                            <TableRow key={product.id} className={!product.isActive ? 'opacity-50' : ''}>
                                <TableCell>
                                    <div className="flex flex-col gap-1">
                                        <Button
                                            variant="ghost"
                                        size="icon"
                                        className="h-6 w-6"
                                        onClick={() => handleReorder(product.id, 'up')}
                                        disabled={busy || idx === 0}
                                    >
                                        <ArrowUp className="h-3 w-3" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6"
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
                                        {product.isActive ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                    <Button asChild variant="outline" size="sm">
                                        <Link href={`/admin/cards/${product.id}`}>
                                            {t('admin.products.manageCards')}
                                        </Link>
                                    </Button>
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
