import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

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
    assert.match(component, /typeof item !== 'string' && item\.size > 0/)
    assert.doesNotMatch(component, /instanceof File/)
    assert.doesNotMatch(component, /data-delivery-overlay/)
})

test('已付款自动交付使用通用等待文案，不误报缺货', () => {
    const component = source('../components/order-content.tsx')
    const paidMessage = component.slice(component.indexOf('const getStatusMessage =')).match(/case 'paid': return ([^\n]+)/)?.[1]
    assert.ok(paidMessage)
    assert.doesNotMatch(paidMessage, /stockDepleted/)
    for (const [isPayment, isManual, expected] of [
        [false, false, 'order.waitingAutoDelivery'],
        [false, true, 'order.waitingManualDelivery'],
        [true, false, 'payment.paidMessage'],
        [true, true, 'payment.paidMessage'],
    ] as const) {
        assert.equal(runInNewContext(paidMessage, { isPayment, isManual, t: (key: string) => key }), expected)
    }
})

test('已付款自动交付显示中性等待提示，不改变轮询范围或错误样式', () => {
    const component = source('../components/order-content.tsx')
    const hintStyle = component.match(/className=\{`flex items-center justify-between gap-3 p-4 rounded-xl border \$\{([\s\S]*?)\}`\}/)?.[1]
    assert.ok(hintStyle)
    assert.equal(runInNewContext(hintStyle, { order: { status: 'paid' }, isPayment: false, isManual: false }),
        'bg-muted/20 text-muted-foreground border-border/30')
    for (const [isPayment, isManual] of [[true, false], [false, true]]) {
        assert.equal(runInNewContext(hintStyle, { order: { status: 'paid' }, isPayment, isManual }),
            'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20')
    }
    assert.match(component, /isPayment \|\| isManual \? <CheckCircle2[^\n]+: <Clock/)
    assert.match(component, /if \(order\.status !== 'pending' && order\.status !== 'processing'\) return/)
    assert.match(component, /case 'refunded': return 'destructive'/)
    assert.match(component, /toast\.error\(result\.error \? t\(result\.error\) : t\('common\.error'\)\)/)
})

test('自动交付等待文案的中英文键一致且提示不要重复下单', () => {
    const zh = JSON.parse(source('../locales/zh.json'))
    const en = JSON.parse(source('../locales/en.json'))
    assert.deepEqual(Object.keys(zh.order).sort(), Object.keys(en.order).sort())
    assert.equal(zh.order.waitingAutoDelivery,
        '付款已收到，自动发货尚未完成。请稍后刷新查看；若长时间未发货，请联系管理员处理，请勿重复下单。')
    assert.equal(en.order.waitingAutoDelivery,
        'Payment has been received, but automatic delivery is not yet complete. Please refresh later to check; if delivery remains incomplete for an extended period, contact the administrator for assistance. Please do not place another order.')
})
