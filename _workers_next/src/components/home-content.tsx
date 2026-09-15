"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { ArrowRight, Search, Zap, PackageOpen, X, Check, Clock, ChevronRight, Inbox } from "lucide-react"
import { ProductImagePlaceholder } from "@/components/product-image-placeholder"
import { AnnouncementPopup, type AnnouncementPopupData } from "@/components/announcement-popup"
import { CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { StarRatingStatic } from "@/components/star-rating-static"
import { NavigationPill } from "@/components/navigation-pill"
import { useI18n } from "@/lib/i18n/context"
import { INFINITE_STOCK } from "@/lib/constants"
import { getProductPointDiscountBadge } from "@/lib/points/product-point-discount"

interface Product {
    id: string
    name: string
    description: string | null
    descriptionPlain?: string | null
    price: string
    compareAtPrice?: string | null
    pointDiscountEnabled?: boolean | null
    pointDiscountPercent?: number | null
    image: string | null
    category: string | null
    stockCount: number
    soldCount: number
    isHot?: boolean | null
    rating?: number
    reviewCount?: number
    variantCount?: number
    priceMin?: number
    priceMax?: number
    fulfillmentMode?: string | null
    groupManual?: boolean | null
}

interface HomeContentProps {
    products: Product[]
    announcement?: {
        banner: string | null
        popup: {
            title: string | null
            content: string
            signature: string
        } | null
    } | null
    visitorCount?: number
    categories?: string[]
    categoryConfig?: Array<{ name: string; icon: string | null; sortOrder: number }>
    pendingOrders?: Array<{ orderId: string; createdAt: Date; productName: string; amount: string }>
    wishlistEnabled?: boolean
    isLoggedIn?: boolean
    checkinEnabled?: boolean
    filters: { q?: string; category?: string | null; sort?: string }
    pagination: { page: number; pageSize: number; total: number }
}

export function HomeContent({
    products,
    announcement,
    categories = [],
    categoryConfig,
    pendingOrders,
    filters,
    pagination,
}: HomeContentProps) {
    const { t } = useI18n()
    const [selectedCategory, setSelectedCategory] = useState<string | null>(filters.category || null)
    const [searchTerm, setSearchTerm] = useState(filters.q || "")
    const [sortKey, setSortKey] = useState(filters.sort || "default")
    const [fulfillmentFilter, setFulfillmentFilter] = useState<'all' | 'auto' | 'manual' | 'inStock'>('all')
    const [page, setPage] = useState(pagination.page || 1)
    const deferredSearch = useDeferredValue(searchTerm)

    useEffect(() => {
        setPage(1)
    }, [selectedCategory, sortKey, deferredSearch, fulfillmentFilter])

    // Convert any active announcement (popup or banner) into modal popup
    const popupData = useMemo<AnnouncementPopupData>(() => {
        if (announcement?.popup?.content?.trim()) {
            return announcement.popup
        }
        if (announcement?.banner?.trim()) {
            return {
                title: t("announcement.popupDefaultTitle") || "站点公告",
                content: announcement.banner,
                signature: announcement.banner,
            }
        }
        return null
    }, [announcement, t])

    const filteredProducts = useMemo(() => {
        const keyword = deferredSearch.trim().toLowerCase()
        return products.filter((product) => {
            if (selectedCategory && product.category !== selectedCategory) return false
            const isManual = product.fulfillmentMode === 'manual' || product.groupManual
            if (fulfillmentFilter === 'auto' && isManual) return false
            if (fulfillmentFilter === 'manual' && !isManual) return false
            if (fulfillmentFilter === 'inStock' && product.stockCount <= 0) return false
            if (!keyword) return true
            const name = (product.name || "").toLowerCase()
            const desc = (product.descriptionPlain || product.description || "").toLowerCase()
            return name.includes(keyword) || desc.includes(keyword)
        })
    }, [products, selectedCategory, deferredSearch, fulfillmentFilter])

    const sortedProducts = useMemo(() => {
        const list = [...filteredProducts]
        switch (sortKey) {
            case "priceAsc":
                return list.sort((a, b) => Number(a.price) - Number(b.price))
            case "priceDesc":
                return list.sort((a, b) => Number(b.price) - Number(a.price))
            case "stockDesc":
                return list.sort((a, b) => (b.stockCount || 0) - (a.stockCount || 0))
            case "soldDesc":
                return list.sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0))
            case "hot":
                return list.sort((a, b) => Number(!!b.isHot) - Number(!!a.isHot))
            default:
                return list
        }
    }, [filteredProducts, sortKey])

    const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pagination.pageSize))
    const currentPage = Math.min(Math.max(1, page), totalPages)
    const startIndex = (currentPage - 1) * pagination.pageSize
    const pageItems = sortedProducts.slice(startIndex, startIndex + pagination.pageSize)
    const hasMore = currentPage < totalPages
    const hasPendingOrders = Boolean(pendingOrders && pendingOrders.length > 0)

    const sortOptions = [
        { key: "default", label: t("home.sort.default") },
        { key: "stockDesc", label: t("home.sort.stock") },
        { key: "soldDesc", label: t("home.sort.sold") },
        { key: "priceAsc", label: t("home.sort.priceAsc") },
        { key: "priceDesc", label: t("home.sort.priceDesc") },
    ] as const

    return (
        <main className="container relative overflow-hidden py-4 md:py-6">
            {/* Announcement Modal (shown on load with 1-day/forever suppress options) */}
            <AnnouncementPopup popup={popupData} />

            {/* Subtle background gradient glow */}
            <div className="pointer-events-none absolute inset-0 -z-10">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(59,130,246,0.08),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(96,165,250,0.1),transparent)]" />
            </div>

            {/* Ultra-compact Pending Order Notice (if user has unpaid orders) */}
            {hasPendingOrders && (
                <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-100 shadow-2xs">
                    <div className="flex items-center gap-2 min-w-0">
                        <Clock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 animate-pulse" />
                        <span className="font-medium truncate">
                            {pendingOrders?.length === 1
                                ? t("home.pendingOrder.single", { orderId: pendingOrders[0].orderId })
                                : t("home.pendingOrder.multiple", { count: pendingOrders?.length || 0 })}
                        </span>
                    </div>
                    <Link
                        href={pendingOrders?.length === 1 ? `/order/${pendingOrders[0].orderId}` : "/orders"}
                        className="inline-flex items-center gap-1 self-end sm:self-auto font-semibold text-amber-700 dark:text-amber-300 hover:underline"
                    >
                        <span>{pendingOrders?.length === 1 ? t("common.payNow") : t("common.viewOrders")}</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                </div>
            )}

            {/* Compact Storefront Toolbar (Linear x Stripe style) */}
            <section className="mb-5 space-y-2.5">
                <div className="rounded-2xl border border-border/60 bg-card/80 p-3 md:p-3.5 shadow-2xs backdrop-blur-md space-y-2.5">
                    {/* Top Row: Search Input + Categories */}
                    <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2.5">
                        {/* Search Bar with quick clear */}
                        <div className="relative w-full md:w-72 shrink-0">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
                            <Input
                                placeholder={t("common.searchPlaceholder")}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="h-9 rounded-xl border-border/60 bg-background/90 pl-9 pr-8 text-xs shadow-none transition-colors focus-visible:ring-1"
                            />
                            {searchTerm && (
                                <button
                                    type="button"
                                    onClick={() => setSearchTerm("")}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                                    title="清空搜索"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>

                        {/* Category Navigation Pills */}
                        <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
                            <NavigationPill
                                items={[
                                    { key: "", label: t("common.all") },
                                    ...categories.map((cat) => {
                                        const categoryIcon = categoryConfig?.find((c) => c.name === cat)?.icon
                                        return {
                                            key: cat,
                                            label: categoryIcon ? `${categoryIcon} ${cat}` : cat,
                                        }
                                    }),
                                ]}
                                selectedKey={selectedCategory || ""}
                                onSelect={(key) => setSelectedCategory(key || null)}
                            />
                        </div>
                    </div>

                    {/* Bottom Row: Fulfillment Filters + Sort + Product Count */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 text-xs">
                        {/* Left: Fulfillment and Stock Quick Filter Chips */}
                        <div className="flex flex-wrap items-center gap-1">
                            <button
                                type="button"
                                onClick={() => setFulfillmentFilter('all')}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                                    fulfillmentFilter === 'all'
                                        ? "bg-foreground text-background shadow-2xs"
                                        : "bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                )}
                            >
                                全部
                            </button>
                            <button
                                type="button"
                                onClick={() => setFulfillmentFilter('auto')}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                                    fulfillmentFilter === 'auto'
                                        ? "bg-primary text-primary-foreground shadow-2xs"
                                        : "bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                )}
                            >
                                <Zap className="h-3 w-3" />
                                <span>秒发</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setFulfillmentFilter('manual')}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                                    fulfillmentFilter === 'manual'
                                        ? "bg-blue-600 text-white shadow-2xs dark:bg-blue-500"
                                        : "bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                )}
                            >
                                <PackageOpen className="h-3 w-3" />
                                <span>手工</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setFulfillmentFilter(f => f === 'inStock' ? 'all' : 'inStock')}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                                    fulfillmentFilter === 'inStock'
                                        ? "bg-emerald-600 text-white shadow-2xs dark:bg-emerald-500"
                                        : "bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                )}
                            >
                                <Check className="h-3 w-3" />
                                <span>仅现货</span>
                            </button>
                        </div>

                        {/* Right: Sort Buttons & Product Counter */}
                        <div className="flex items-center gap-2 ml-auto">
                            <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                                {sortOptions.map((opt) => (
                                    <button
                                        key={opt.key}
                                        type="button"
                                        className={cn(
                                            "h-7 rounded-md px-2 text-xs transition-all",
                                            sortKey === opt.key
                                                ? "bg-muted font-semibold text-foreground border border-border/60 shadow-2xs"
                                                : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                        )}
                                        onClick={() => setSortKey(opt.key)}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>

                            <div className="hidden sm:inline-flex items-center pl-2 border-l border-border/50 text-[11px] text-muted-foreground font-mono">
                                <span>{sortedProducts.length} 件</span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Main Product Grid - Directly visible above the fold */}
            <section>
                {sortedProducts.length === 0 ? (
                    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border/60 bg-muted/20 px-6 py-16 text-center">
                        <div className="relative mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-background shadow-xs text-muted-foreground">
                            <Inbox className="h-6 w-6 text-muted-foreground/60" />
                        </div>
                        <p className="font-medium text-sm text-foreground">{t("home.noProducts")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("home.checkBackLater")}</p>
                        {(selectedCategory || searchTerm || fulfillmentFilter !== 'all') && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-4 h-8 text-xs rounded-lg"
                                onClick={() => {
                                    setSelectedCategory(null)
                                    setSearchTerm("")
                                    setFulfillmentFilter('all')
                                }}
                            >
                                {t("common.all")}
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {pageItems.map((product, index) => {
                            const pointDiscountBadge = getProductPointDiscountBadge({
                                pointDiscountEnabled: product.pointDiscountEnabled,
                                pointDiscountPercent: product.pointDiscountPercent,
                            })
                            const isManual = product.fulfillmentMode === 'manual' || product.groupManual

                            return (
                                <Link
                                    key={product.id}
                                    href={`/buy/${product.id}`}
                                    prefetch={false}
                                    aria-label={t("common.viewDetails")}
                                    className={cn(
                                        "group tech-card relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-2xs transition-all duration-300 hover:border-primary/50 hover:shadow-md animate-in fade-in motion-reduce:animate-none",
                                        product.stockCount <= 0 && "opacity-85"
                                    )}
                                    style={{ animationDelay: `${index * 40}ms` }}
                                >
                                    <div className="absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

                                    <div className="relative m-3 aspect-[16/10] overflow-hidden rounded-xl bg-muted/30">
                                        {product.image ? (
                                            <Image
                                                src={product.image}
                                                alt={product.name}
                                                fill
                                                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                                                priority={index < 4}
                                                className="object-contain p-2 transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                                            />
                                        ) : (
                                            <div className="flex h-full items-center justify-center p-2 transition-transform duration-500 ease-out group-hover:scale-[1.03]">
                                                <ProductImagePlaceholder productId={product.id} productName={product.name} size="sm" fill />
                                            </div>
                                        )}
                                        <div className="absolute left-2.5 right-2.5 top-2.5 flex items-start justify-between gap-1.5">
                                            <div className="flex flex-wrap items-center gap-1">
                                                {isManual ? (
                                                    <Badge className="h-5 rounded-md border-0 bg-blue-600/90 px-1.5 text-[10px] font-medium text-white shadow-xs backdrop-blur-xs dark:bg-blue-500/90">
                                                        <PackageOpen className="mr-1 h-3 w-3" />
                                                        手工交付
                                                    </Badge>
                                                ) : (
                                                    <Badge className="h-5 rounded-md border-0 bg-primary/90 px-1.5 text-[10px] font-medium text-primary-foreground shadow-xs backdrop-blur-xs">
                                                        <Zap className="mr-1 h-3 w-3" />
                                                        秒发
                                                    </Badge>
                                                )}
                                                {product.category && product.category !== "general" && (
                                                    <Badge className="h-5 rounded-md border border-border/50 bg-background/90 px-1.5 text-[10px] font-medium capitalize text-foreground shadow-xs">
                                                        {product.category}
                                                    </Badge>
                                                )}
                                            </div>
                                            <Badge
                                                className={cn(
                                                    "h-5 rounded-md border px-1.5 text-[10px] font-medium shadow-xs",
                                                    product.stockCount > 0
                                                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                                        : "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                                                )}
                                            >
                                                {product.stockCount > 0 ? t("common.inStock") : t("common.outOfStock")}
                                            </Badge>
                                        </div>
                                        {product.isHot && (
                                            <Badge className="absolute bottom-2.5 left-2.5 h-5 rounded-md border-0 bg-orange-500 px-1.5 text-[10px] font-semibold text-white shadow-xs">
                                                🔥 {t("buy.hot")}
                                            </Badge>
                                        )}
                                    </div>

                                    <CardContent className="relative z-20 flex flex-1 flex-col px-4 pb-4 pt-0">
                                        <div className="mb-1.5">
                                            <h3
                                                className="line-clamp-1 text-sm font-semibold tracking-tight text-foreground transition-colors duration-200 group-hover:text-primary"
                                                title={product.name}
                                            >
                                                {product.name}
                                            </h3>
                                            {product.reviewCount !== undefined && product.reviewCount > 0 && (
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    <StarRatingStatic rating={Math.round(product.rating || 0)} size="xs" />
                                                    <span className="text-[10px] text-muted-foreground font-mono">
                                                        ({product.reviewCount})
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        <p className="mb-3 line-clamp-2 text-xs leading-4.5 text-muted-foreground">
                                            {product.descriptionPlain || product.description || t("buy.noDescription")}
                                        </p>

                                        {/* Stripe-style Price & Stock Footer */}
                                        <div className="mt-auto rounded-xl border border-border/40 bg-muted/20 px-3 py-2">
                                            <div className="flex items-end justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-baseline gap-1">
                                                        {product.variantCount != null && product.variantCount > 1 && product.priceMin != null && product.priceMax != null ? (
                                                            <>
                                                                <span className="text-xs font-semibold text-primary">¥</span>
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {product.priceMin} - {product.priceMax}
                                                                </span>
                                                            </>
                                                        ) : product.variantCount != null && product.variantCount > 1 && product.priceMin != null ? (
                                                            <>
                                                                <span className="text-xs font-semibold text-primary">¥</span>
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {product.priceMin} 起
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <span className="text-xs font-semibold text-primary">¥</span>
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {Number(product.price).toFixed(2)}
                                                                </span>
                                                                {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
                                                                    <>
                                                                        <span className="text-[11px] tabular-nums text-muted-foreground/60 line-through ml-1">
                                                                            ¥{Number(product.compareAtPrice).toFixed(2)}
                                                                        </span>
                                                                        <span className="rounded bg-rose-500/10 px-1 py-0.2 text-[9px] font-semibold text-rose-600 dark:text-rose-400">
                                                                            -{Math.round((1 - Number(product.price) / Number(product.compareAtPrice)) * 100)}%
                                                                        </span>
                                                                    </>
                                                                )}
                                                            </>
                                                        )}
                                                        {pointDiscountBadge && (
                                                            <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                                                抵{pointDiscountBadge.percent}%
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                                                        <span>库存 {product.stockCount >= INFINITE_STOCK ? "充足" : product.stockCount}</span>
                                                        <span>·</span>
                                                        <span>已售 {product.soldCount}</span>
                                                    </div>
                                                </div>

                                                <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground transition-all duration-200 group-hover:border-primary/40 group-hover:bg-primary group-hover:text-primary-foreground group-hover:scale-105 shadow-2xs">
                                                    <ArrowRight className="h-3.5 w-3.5" />
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Link>
                            )
                        })}
                    </div>
                )}
            </section>

            {/* Pagination */}
            {sortedProducts.length > 0 && (
                <nav className="mt-8 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                    <div>
                        {t("search.page", { page: currentPage, totalPages })}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-lg px-3 text-xs"
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={currentPage <= 1}
                        >
                            {t("search.prev")}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-lg px-3 text-xs"
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={!hasMore}
                        >
                            {t("search.next")}
                        </Button>
                        {hasMore && (
                            <Button variant="secondary" size="sm" className="h-8 rounded-lg px-3.5 text-xs font-medium" onClick={() => setPage(currentPage + 1)}>
                                {t("common.loadMore")}
                            </Button>
                        )}
                    </div>
                </nav>
            )}
        </main>
    )
}
