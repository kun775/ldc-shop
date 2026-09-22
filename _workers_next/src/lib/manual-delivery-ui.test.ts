import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('manual delivery validates content before confirmation without a blocking overlay', () => {
    const component = source('../components/admin/order-detail-content.tsx')
    const deliveredBranch = component.indexOf("if (action === 'delivered')")
    const validation = component.indexOf("if (!deliveryNote.trim() && !hasDeliveryFiles)", deliveredBranch)
    const confirmation = component.indexOf('const ok = await confirm({', deliveredBranch)

    assert.ok(deliveredBranch >= 0)
    assert.ok(validation > deliveredBranch)
    assert.ok(confirmation > validation)
    assert.match(component, /confirmMarkDeliveredWithoutFiles/)
    assert.doesNotMatch(component, /data-delivery-overlay/)
})
