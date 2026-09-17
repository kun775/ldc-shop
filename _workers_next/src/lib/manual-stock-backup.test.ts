import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./manual-stock-backup.ts', import.meta.url).href)
const { prepareManualStockProductsForSqlBackup } = mod

test('SQL backup restores the pre-reservation stock base for active manual orders', () => {
    const products = prepareManualStockProductsForSqlBackup([
        { id: 'manual-1', fulfillmentMode: 'manual', manualStockCount: 3, stockCount: 3, lockedCount: 0 },
        { id: 'auto-1', fulfillmentMode: 'auto', manualStockCount: 0, stockCount: 4, lockedCount: 1 },
    ], [
        { productId: 'manual-1', status: 'pending', manualStockQuantity: 2 },
        { productId: 'manual-1', status: 'delivered', manualStockQuantity: 1 },
        { productId: 'manual-1', status: 'cancelled', manualStockQuantity: 5 },
    ])

    assert.deepEqual(products[0], {
        id: 'manual-1',
        fulfillmentMode: 'manual',
        manualStockCount: 6,
        stockCount: 6,
        lockedCount: 0,
    })
    assert.deepEqual(products[1], {
        id: 'auto-1',
        fulfillmentMode: 'auto',
        manualStockCount: 0,
        stockCount: 4,
        lockedCount: 1,
    })
})
