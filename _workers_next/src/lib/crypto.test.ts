import test from 'node:test'
import assert from 'node:assert/strict'

const cryptoHelpers = await import(new URL('./crypto.ts', import.meta.url).href)
const { secretsEqual } = cryptoHelpers

test('secretsEqual accepts identical values', () => {
    assert.equal(secretsEqual('same-secret', 'same-secret'), true)
    assert.equal(secretsEqual('', ''), true)
})

test('secretsEqual rejects different values without requiring equal lengths', () => {
    assert.equal(secretsEqual('same-prefix', 'same-prefix-extra'), false)
    assert.equal(secretsEqual('secret-a', 'secret-b'), false)
    assert.equal(secretsEqual('', 'non-empty'), false)
})
