import test from 'node:test'
import assert from 'node:assert/strict'

import { interpolateTranslation } from './interpolate.ts'

test('没有占位符时不创建正则，替换值里的 $ 原样保留', () => {
    const original = RegExp
    let created = 0
    globalThis.RegExp = new Proxy(original, {
        construct(target, args, newTarget) {
            created += 1
            return Reflect.construct(target, args, newTarget)
        },
    }) as RegExpConstructor
    try {
        assert.equal(interpolateTranslation('plain text', { currencyUnit: 'CNY' }), 'plain text')
        assert.equal(created, 0)
        assert.equal(interpolateTranslation('pay {{amount}}', { amount: '$5', currencyUnit: 'CNY' }), 'pay $5')
    } finally {
        globalThis.RegExp = original
    }
})

test('重复占位符、缺参数、数字 0 与调用方覆盖都保持原顺序', () => {
    assert.equal(interpolateTranslation('{{name}}-{{name}}', { name: '卡' }), '卡-卡')
    assert.equal(interpolateTranslation('{{missing}}', { currencyUnit: 'CNY' }), '{{missing}}')
    assert.equal(interpolateTranslation('left {{count}}', { count: 0 }), 'left 0')
    assert.equal(
        interpolateTranslation('{{currencyUnit}}', { currencyUnit: 'default', ...{ currencyUnit: 'EUR' } }),
        'EUR',
    )
})
