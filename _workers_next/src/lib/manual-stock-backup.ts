type BackupProductRow = Record<string, unknown> & {
    id?: unknown
    fulfillmentMode?: unknown
    manualStockCount?: unknown
    stockCount?: unknown
    lockedCount?: unknown
}

type BackupOrderRow = Record<string, unknown> & {
    productId?: unknown
    status?: unknown
    manualStockQuantity?: unknown
}

const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'failed', 'refunded'])

function toPositiveInteger(value: unknown): number {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function toAvailableStock(value: unknown): number {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export function prepareManualStockProductsForSqlBackup(
    productRows: BackupProductRow[],
    orderRows: BackupOrderRow[],
): BackupProductRow[] {
    const reservedByProduct = new Map<string, number>()

    for (const order of orderRows) {
        const productId = String(order.productId || '').trim()
        const quantity = toPositiveInteger(order.manualStockQuantity)
        const status = String(order.status || 'pending').trim().toLowerCase()
        if (!productId || !quantity || TERMINAL_ORDER_STATUSES.has(status)) continue
        reservedByProduct.set(productId, (reservedByProduct.get(productId) || 0) + quantity)
    }

    return productRows.map((product) => {
        const productId = String(product.id || '').trim()
        const reserved = reservedByProduct.get(productId) || 0
        if (product.fulfillmentMode !== 'manual' || reserved === 0) return product

        const available = toAvailableStock(product.manualStockCount ?? product.stockCount)
        const stockBeforeOrderReservations = available + reserved
        return {
            ...product,
            manualStockCount: stockBeforeOrderReservations,
            stockCount: stockBeforeOrderReservations,
            lockedCount: 0,
        }
    })
}
