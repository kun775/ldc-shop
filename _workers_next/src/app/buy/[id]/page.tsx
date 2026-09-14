import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { BuyContent } from "@/components/buy-content"
import { BuyRestricted } from "@/components/buy-restricted"
import { getProduct, getProductVisibility, getLiveCardStats, getProductVariants, type ProductVariantRow } from "@/lib/db/queries"
import { INFINITE_STOCK } from "@/lib/constants"

interface BuyPageProps {
    params: Promise<{ id: string }>
}

function mergeLiveStockIntoVariants(
    variants: ProductVariantRow[],
    liveStats: Map<string, { unused: number; available: number; locked: number }>
): (ProductVariantRow & { stockCount: number; lockedCount: number })[] {
    return variants.map((v) => {
        const stat = liveStats.get(v.id) ?? { unused: 0, available: 0, locked: 0 }
        const stockCount = v.fulfillmentMode === 'manual'
            ? INFINITE_STOCK
            : v.isShared
            ? (stat.unused > 0 ? INFINITE_STOCK : 0)
            : stat.available
        return { ...v, stockCount, lockedCount: stat.locked }
    })
}

export default async function BuyPage({ params }: BuyPageProps) {
    const { id } = await params
    const session = await auth()
    const isLoggedIn = !!session?.user
    const trustLevel = Number.isFinite(Number(session?.user?.trustLevel)) ? Number(session?.user?.trustLevel) : 0

    // Keep first render lean: load only critical product data.
    const product = await getProduct(id, { isLoggedIn, trustLevel }).catch(() => null)

    // Return 404 if product doesn't exist or is inactive
    if (!product) {
        const visibility = await getProductVisibility(id).catch(() => null)
        if (!visibility || visibility.isActive === false) {
            notFound()
        }
        const requiredLevel = Number.isFinite(Number(visibility.visibilityLevel))
            ? Number(visibility.visibilityLevel)
            : -1
        if (requiredLevel < 0) {
            notFound()
        }
        return <BuyRestricted requiredLevel={requiredLevel} isLoggedIn={isLoggedIn} />
    }

    const variantGroupId = product.variantGroupId?.trim() || null
    let variantsWithStock: (ProductVariantRow & { stockCount: number; lockedCount: number })[] = []

    if (variantGroupId) {
        const variants = await getProductVariants(variantGroupId, { isLoggedIn, trustLevel }).catch(() => [])
        if (variants.length > 1) {
            const variantIds = variants.map((v) => v.id)
            const liveStats = await getLiveCardStats(variantIds).catch(() => new Map())
            variantsWithStock = mergeLiveStockIntoVariants(variants, liveStats)
        }
    }

    const liveStats = await getLiveCardStats([product.id]).catch(() => new Map())
    const stat = liveStats.get(product.id) ?? { unused: 0, available: 0, locked: 0 }
    const liveAvailable = product.fulfillmentMode === 'manual'
        ? INFINITE_STOCK
        : product.isShared
        ? (stat.unused > 0 ? INFINITE_STOCK : 0)
        : stat.available
    const liveLocked = stat.locked

    return (
        <BuyContent
            product={product}
            stockCount={liveAvailable}
            lockedStockCount={liveLocked}
            isLoggedIn={!!session?.user}
            reviews={[]}
            averageRating={Number(product.rating || 0)}
            reviewCount={Number(product.reviewCount || 0)}
            canReview={false}
            reviewOrderId={undefined}
            emailConfigured={false}
            variants={variantsWithStock.length > 1 ? variantsWithStock : undefined}
        />
    )
}
