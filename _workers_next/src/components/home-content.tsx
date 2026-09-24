"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import Image from "next/image"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { ArrowRight, Search, Zap, PackageOpen, X, Check, Clock, ChevronRight, Inbox } from "lucide-react"
import { ProductImagePlaceholder } from "@/components/product-image-placeholder"
import { KCurrencySymbol } from "@/components/k-currency-symbol"
import type { AnnouncementPopupData } from "@/components/announcement-popup"
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

// 公告弹窗内部依赖 react-markdown（+ micromark 全家桶，未压缩约 113KB）。
// 它只在「配置了公告且用户未忽略」时才会真正上屏，因此必须走动态加载，
// 否则这 113KB 会无条件计入首页首屏。
const AnnouncementPopup = dynamic(
    () => import("@/components/announcement-popup").then((mod) => mod.AnnouncementPopup),
    { ssr: false }
)

interface Product {
    id: string
    name: string
    /** 服务端 stripMarkdown 后的纯文本摘要（列表不渲染 Markdown 原文） */
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

export interface HomeFilters {
    q: string
    category: string
    sort: string
    fulfillment: string
}

interface HomeContentProps {
    /** 当前页商品（服务端已按 filters 完成筛选/排序/分页） */
    products: Product[]
    /** 命中 filters 的商品总数（变体已归组） */
    total: number
    page: number
    pageSize: number
    filters: HomeFilters
    announcement?: {
        banner: string | null
        popup: {
            title: string | null
            content: string
            signature: string
        } | null
    } | null
    categories?: string[]
    categoryConfig?: Array<{ name: string; icon: string | null; sortOrder: number }>
    pendingOrders?: Array<{ orderId: string; createdAt: Date; productName: string; amount: string }>
}

/**
 * 首页筛选状态全部落在 URL 上。
 *
 * 需求背景（D1 读放大）：过去首页把**全量商品**塞进 RSC payload，再由浏览器
 * 做 filter/sort/slice。商品数一涨，每个 PV（含爬虫与预取）都要传输整张商品表，
 * 单次响应体达到数百 KB。现在筛选/排序/分页全部下推到 SQL，客户端只接收
 * 当前这一页的数据，URL 同时承担「可分享、可后退」的职责。
 */
function buildHomeUrl(params: HomeFilters & { page?: number; pageSize?: number }) {
    const search = new URLSearchParams()
    const put = (key: string, value: string | number | undefined | null) => {
        const text = value === undefined || value === null ? '' : String(value).trim()
        if (!text || text === 'all' || text === 'default') return
        search.set(key, text)
    }

    put('q', params.q)
    put('category', params.category)
    put('sort', params.sort)
    put('fulfillment', params.fulfillment)
    if (params.page && params.page > 1) put('page', params.page)
    if (params.pageSize && params.pageSize !== 24) put('pageSize', params.pageSize)

    const qs = search.toString()
    return qs ? `/?${qs}` : '/'
}

export function HomeContent({
    products,
    total,
    page,
    pageSize,
    filters,
    announcement,
    categories = [],
    categoryConfig,
    pendingOrders,
}: HomeContentProps) {
    const { t } = useI18n()
    const router = useRouter()
    const [isPending, startTransition] = useTransition()

    // 搜索框保留本地草稿以获得即时反馈；其余筛选直接改 URL（无草稿）。
    // 只有当 props.filters.q 真的变化（路由前进/后退）时才把 props 回灌到草稿，
    // 否则会把用户正在输入的值覆盖掉。
    //
    // 用「渲染期同步 props」而不是 useEffect：effect 里 setState 会多提交一轮，
    // 且被 react-hooks/set-state-in-effect 判定为错误（React 官方也不推荐）。
    const [query, setQuery] = useState(filters.q)
    const [committedQuery, setCommittedQuery] = useState(filters.q)
    const [syncedPropQuery, setSyncedPropQuery] = useState(filters.q)
    if (syncedPropQuery !== filters.q) {
        setSyncedPropQuery(filters.q)
        setQuery(filters.q)
        setCommittedQuery(filters.q)
    }

    const pushFilters = useCallback((overrides: Partial<HomeFilters & { page: number }>) => {
        const url = buildHomeUrl({ ...filters, ...overrides })
        startTransition(() => {
            router.push(url)
        })
    }, [filters, router])

    // 输入停顿 350ms 后再发起一次 RSC 导航，避免逐键打服务端。
    useEffect(() => {
        if (query === committedQuery) return
        const timer = window.setTimeout(() => {
            setCommittedQuery(query)
            const url = buildHomeUrl({ ...filters, q: query, page: 1 })
            startTransition(() => {
                router.push(url)
            })
        }, 350)
        return () => window.clearTimeout(timer)
    }, [query, committedQuery, filters, router])

    // Convert any active announcement (popup or banner) into modal popup
    const popupData = useMemo<AnnouncementPopupData>(() => {
        if (announcement?.popup?.content?.trim()) {
            return announcement.popup
        }
        if (announcement?.banner?.trim()) {
            return {
                title: t("announcement.popupDefaultTitle"),
                content: announcement.banner,
                signature: announcement.banner,
            }
        }
        return null
    }, [announcement, t])

    // 引用稳定 —— NavigationPill 的测量 effect 依赖 items，父组件每次渲染都
    // 新建数组会让它反复 setState（渲染抖动）。
    const pillItems = useMemo(() => [
        { key: '', label: t('common.all') },
        ...categories.map((cat) => {
            const categoryIcon = categoryConfig?.find((c) => c.name === cat)?.icon
            return {
                key: cat,
                label: categoryIcon ? `${categoryIcon} ${cat}` : cat,
            }
        }),
    ], [categories, categoryConfig, t])

    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(Math.max(1, page), totalPages)
    const hasMore = currentPage < totalPages
    const hasPendingOrders = Boolean(pendingOrders && pendingOrders.length > 0)
    const hasActiveFilters = Boolean(filters.category || filters.q || filters.fulfillment !== 'all')

    const sortOptions = [
        { key: "default", label: t("home.sort.default") },
        { key: "stockDesc", label: t("home.sort.stock") },
        { key: "soldDesc", label: t("home.sort.sold") },
        { key: "priceAsc", label: t("home.sort.priceAsc") },
        { key: "priceDesc", label: t("home.sort.priceDesc") },
    ] as const

    const fulfillmentOptions = [
        { key: 'all', label: t("home.filter.all"), icon: null },
        { key: 'auto', label: t("home.filter.instant"), icon: Zap, activeClass: "bg-primary text-primary-foreground shadow-2xs" },
        { key: 'manual', label: t("home.filter.manual"), icon: PackageOpen, activeClass: "bg-blue-600 text-white shadow-2xs dark:bg-blue-500" },
        { key: 'inStock', label: t("home.filter.inStock"), icon: Check, activeClass: "bg-emerald-600 text-white shadow-2xs dark:bg-emerald-500" },
    ] as const

    const resetFilters = () => {
        setQuery("")
        setCommittedQuery("")
        pushFilters({ q: "", category: "", sort: "default", fulfillment: "all", page: 1 })
    }

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
                                type="search"
                                aria-label={t("common.searchPlaceholder")}
                                placeholder={t("common.searchPlaceholder")}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                className="h-9 rounded-xl border-border/60 bg-background/90 pl-9 pr-8 text-xs shadow-none transition-colors focus-visible:ring-1"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setQuery("")
                                        setCommittedQuery("")
                                        pushFilters({ q: "", page: 1 })
                                    }}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                                    aria-label={t("common.clearSearch")}
                                    title={t("common.clearSearch")}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>

                        {/* Category Navigation Pills */}
                        <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
                            <NavigationPill
                                items={pillItems}
                                selectedKey={filters.category || ""}
                                onSelect={(key) => pushFilters({ category: key, page: 1 })}
                            />
                        </div>
                    </div>

                    {/* Bottom Row: Fulfillment Filters + Sort + Product Count */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 text-xs">
                        {/* Left: Fulfillment and Stock Quick Filter Chips */}
                        <div className="flex flex-wrap items-center gap-1">
                            {fulfillmentOptions.map((option) => {
                                const Icon = option.icon
                                const isActive = filters.fulfillment === option.key
                                return (
                                    <button
                                        key={option.key}
                                        type="button"
                                        aria-pressed={isActive}
                                        onClick={() => pushFilters({ fulfillment: option.key, page: 1 })}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-all",
                                            isActive
                                                ? ("activeClass" in option && option.activeClass
                                                    ? option.activeClass
                                                    : "bg-foreground text-background shadow-2xs")
                                                : "bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                        )}
                                    >
                                        {Icon && <Icon className="h-3 w-3" />}
                                        <span>{option.label}</span>
                                    </button>
                                )
                            })}
                        </div>

                        {/* Right: Sort Buttons & Product Counter */}
                        <div className="flex items-center gap-2 ml-auto">
                            <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                                {sortOptions.map((opt) => (
                                    <button
                                        key={opt.key}
                                        type="button"
                                        aria-pressed={filters.sort === opt.key}
                                        className={cn(
                                            "h-7 rounded-md px-2 text-xs transition-all",
                                            filters.sort === opt.key
                                                ? "bg-muted font-semibold text-foreground border border-border/60 shadow-2xs"
                                                : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                        )}
                                        onClick={() => pushFilters({ sort: opt.key, page: 1 })}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>

                            <div className="hidden sm:inline-flex items-center pl-2 border-l border-border/50 text-[11px] text-muted-foreground font-mono">
                                <span>{t("home.itemCount", { count: total })}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Main Product Grid - Directly visible above the fold */}
            <section
                aria-busy={isPending}
                className={cn("transition-opacity duration-200", isPending && "opacity-60")}
            >
                {total === 0 ? (
                    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border/60 bg-muted/20 px-6 py-16 text-center">
                        <div className="relative mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-background shadow-xs text-muted-foreground">
                            <Inbox className="h-6 w-6 text-muted-foreground/60" />
                        </div>
                        <p className="font-medium text-sm text-foreground">{t("home.noProducts")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("home.checkBackLater")}</p>
                        {hasActiveFilters && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-4 h-8 text-xs rounded-lg"
                                onClick={resetFilters}
                            >
                                {t("home.resetFilters")}
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {products.map((product, index) => {
                            const pointDiscountBadge = getProductPointDiscountBadge({
                                pointDiscountEnabled: product.pointDiscountEnabled,
                                pointDiscountPercent: product.pointDiscountPercent,
                            })
                            const isManual = product.fulfillmentMode === 'manual' || product.groupManual
                            const isSoldOut = product.stockCount <= 0

                            return (
                                <Link
                                    key={product.id}
                                    href={`/buy/${product.id}`}
                                    prefetch={false}
                                    className={cn(
                                        "group tech-card relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-2xs transition-all duration-300 hover:border-primary/50 hover:shadow-md animate-in fade-in motion-reduce:animate-none",
                                        isSoldOut && "grayscale"
                                    )}
                                    style={{ animationDelay: `${index * 40}ms` }}
                                >
                                    <div className="absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                                    {isSoldOut && (
                                        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/20" aria-hidden="true">
                                            <span className="-rotate-12 rounded-md border border-white/50 bg-neutral-700/80 px-4 py-2 text-base font-bold text-white shadow-lg backdrop-blur-[1px]">
                                                {t("common.soldOut")}
                                            </span>
                                        </div>
                                    )}

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
                                                        {t("home.badge.manualDelivery")}
                                                    </Badge>
                                                ) : (
                                                    <Badge className="h-5 rounded-md border-0 bg-primary/90 px-1.5 text-[10px] font-medium text-primary-foreground shadow-xs backdrop-blur-xs">
                                                        <Zap className="mr-1 h-3 w-3" />
                                                        {t("home.badge.instantDelivery")}
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
                                            {product.descriptionPlain || t("buy.noDescription")}
                                        </p>

                                        {/* Stripe-style Price & Stock Footer */}
                                        <div className="mt-auto rounded-xl border border-border/40 bg-muted/20 px-3 py-2">
                                            <div className="flex items-end justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-baseline gap-1">
                                                        {product.variantCount != null && product.variantCount > 1 && product.priceMin != null && product.priceMax != null ? (
                                                            <>
                                                                <KCurrencySymbol className="h-3.5 w-3.5 self-center text-primary" />
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {product.priceMin} - {product.priceMax}
                                                                </span>
                                                            </>
                                                        ) : product.variantCount != null && product.variantCount > 1 && product.priceMin != null ? (
                                                            <>
                                                                <KCurrencySymbol className="h-3.5 w-3.5 self-center text-primary" />
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {product.priceMin}{t("home.priceFromSuffix")}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <KCurrencySymbol className="h-3.5 w-3.5 self-center text-primary" />
                                                                <span className="whitespace-nowrap text-lg font-bold tracking-tight text-primary tabular-nums">
                                                                    {Number(product.price).toFixed(2)}
                                                                </span>
                                                                {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
                                                                    <>
                                                                        <span className="inline-flex items-center text-[11px] tabular-nums text-muted-foreground/60 line-through ml-1">
                                                                            <KCurrencySymbol className="h-3 w-3" />{Number(product.compareAtPrice).toFixed(2)}
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
                                                                {t("common.pointDiscountBadge", { percent: pointDiscountBadge.percent })}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                                                        <span>{t("home.stockShort", { count: product.stockCount >= INFINITE_STOCK ? t("home.stockPlenty") : product.stockCount })}</span>
                                                        <span>·</span>
                                                        <span>{t("home.soldShort", { count: product.soldCount })}</span>
                                                    </div>
                                                </div>

                                                <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground transition-all duration-200 group-hover:border-primary/40 group-hover:bg-primary group-hover:text-primary-foreground group-hover:scale-105 shadow-2xs">
                                                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
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
            {total > 0 && (
                <nav className="mt-8 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                    <div>
                        {t("search.page", { page: currentPage, totalPages })}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-lg px-3 text-xs"
                            onClick={() => pushFilters({ page: Math.max(1, currentPage - 1) })}
                            disabled={currentPage <= 1 || isPending}
                        >
                            {t("search.prev")}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-lg px-3 text-xs"
                            onClick={() => pushFilters({ page: Math.min(totalPages, currentPage + 1) })}
                            disabled={!hasMore || isPending}
                        >
                            {t("search.next")}
                        </Button>
                        {hasMore && (
                            <Button variant="secondary" size="sm" className="h-8 rounded-lg px-3.5 text-xs font-medium" onClick={() => pushFilters({ page: currentPage + 1 })} disabled={isPending}>
                                {t("common.loadMore")}
                            </Button>
                        )}
                    </div>
                </nav>
            )}
        </main>
    )
}
