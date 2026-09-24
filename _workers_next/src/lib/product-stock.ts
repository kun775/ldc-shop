import { INFINITE_STOCK } from '@/lib/constants'

/**
 * 商品可售库存的唯一解析口。
 *
 * 商品库存有三个来源，且变体组需要按组聚合：
 *   1. 卡密库存（`stock_count` / `locked_count`，自动发货）
 *   2. 手动发货库存（`manual_stock_count`，手动发货）
 *   3. 共享卡（`is_shared`，只要有货即视为无限）
 *
 * 此前首页与搜索页各复制了一份同样的实现，任何一处改动都会让两个页面
 * 显示的库存口径分叉；列表查询（`searchActiveProducts`）也需要同一口径
 * 才能做「仅现货」筛选，因此统一收敛到这里。
 */
export interface StockResolvableProduct {
    allVariantIds?: string[] | null
    totalStock?: number | string | null
    totalLocked?: number | string | null
    groupShared?: boolean | null
    stock?: number | string | null
    locked?: number | string | null
    fulfillmentMode?: string | null
    isShared?: boolean | null
}

export function resolveProductStockCount(product: StockResolvableProduct): number {
    const isGroup = Array.isArray(product.allVariantIds) && product.allVariantIds.length > 1
    if (isGroup) {
        const totalStock = Number(product.totalStock || 0)
        const totalLocked = Number(product.totalLocked || 0)
        if ((product.groupShared && totalStock > 0) || totalStock >= INFINITE_STOCK) {
            return INFINITE_STOCK
        }
        return totalStock + totalLocked
    }

    const stock = Number(product.stock || 0)
    const locked = Number(product.locked || 0)
    if (product.fulfillmentMode === 'manual') return stock
    if (product.isShared) return stock > 0 ? INFINITE_STOCK : 0
    return stock >= INFINITE_STOCK ? INFINITE_STOCK : stock + locked
}

/** 该商品（或变体组）是否走人工交付 */
export function isManualFulfillment(product: {
    fulfillmentMode?: string | null
    groupManual?: boolean | null
}): boolean {
    return product.fulfillmentMode === 'manual' || Boolean(product.groupManual)
}
