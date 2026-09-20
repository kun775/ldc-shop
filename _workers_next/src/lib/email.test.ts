import assert from 'node:assert/strict'
import test from 'node:test'
import { renderOrderEmailHtml } from './order-email-template.ts'

test('automatic delivery email renders card keys before the delivery note', () => {
    const html = renderOrderEmailHtml({
        to: 'buyer@example.com',
        orderId: 'order-1',
        productName: 'Test Product',
        cardKeys: 'CARD-ONE\nCARD-TWO',
        deliveryNote: 'Open the app and redeem the key.',
    }, 'en')

    assert.ok(html.indexOf('CARD-ONE') < html.indexOf('Delivery Note'))
    assert.ok(html.indexOf('Delivery Note') < html.indexOf('Open the app'))
})

test('automatic delivery email escapes card keys and delivery notes', () => {
    const html = renderOrderEmailHtml({
        to: 'buyer@example.com',
        orderId: 'order-2',
        productName: '<Product>',
        cardKeys: '<script>alert(1)</script>',
        deliveryNote: '<b>Do not render HTML</b>',
    })

    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
    assert.doesNotMatch(html, /<b>Do not render HTML<\/b>/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.match(html, /&lt;b&gt;Do not render HTML&lt;\/b&gt;/)
})
