import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./error-utils.ts', import.meta.url).href)
const { collectErrorText, isDuplicateColumnError } = mod

test('collectErrorText includes nested D1 causes', () => {
    const error = new Error('Failed query: ALTER TABLE products ADD COLUMN compare_at_price TEXT')
    error.cause = new Error('D1_ERROR: duplicate column name: compare_at_price')

    const text = collectErrorText(error).toLowerCase()
    assert.match(text, /failed query/)
    assert.match(text, /d1_error: duplicate column name: compare_at_price/)
    assert.equal(isDuplicateColumnError(error), true)
})

test('collectErrorText stops on cyclic causes', () => {
    const error = new Error('outer')
    error.cause = error

    assert.match(collectErrorText(error), /outer/)
    assert.equal(isDuplicateColumnError(error), false)
})
