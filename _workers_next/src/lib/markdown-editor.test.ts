import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mod = await import(new URL('./markdown-editor.ts', import.meta.url).href)
const { applyMarkdownFormat } = mod

test('inline formatting wraps a selection and keeps it selected', () => {
    const result = applyMarkdownFormat('hello world', 6, 11, 'bold')
    assert.deepEqual(result, {
        value: 'hello **world**',
        selectionStart: 8,
        selectionEnd: 13,
    })
})

test('inline formatting inserts a selected placeholder without a selection', () => {
    const result = applyMarkdownFormat('', 0, 0, 'italic')
    assert.equal(result.value, '*斜体文字*')
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '斜体文字')
})

test('formatting accepts localized placeholders', () => {
    const result = applyMarkdownFormat('', 0, 0, 'bold', { bold: 'bold text' })
    assert.equal(result.value, '**bold text**')
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), 'bold text')
})

test('ordered lists number every selected line', () => {
    const result = applyMarkdownFormat('第一项\n第二项', 0, 7, 'ordered-list')
    assert.equal(result.value, '1. 第一项\n2. 第二项')
})

test('links preserve selected text and select the URL for replacement', () => {
    const result = applyMarkdownFormat('文档', 0, 2, 'link')
    assert.equal(result.value, '[文档](https://example.com)')
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), 'https://example.com')
})

test('block templates add safe spacing and select the first editable cell', () => {
    const result = applyMarkdownFormat('前文', 2, 2, 'table')
    assert.match(result.value, /^前文\n\n\| 标题 1 \| 标题 2 \|/)
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '标题 1')
})

test('image templates select the URL while preserving selected alt text', () => {
    const result = applyMarkdownFormat('封面', 0, 2, 'image')
    assert.equal(result.value, '![封面](https://example.com/image.png)')
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), 'https://example.com/image.png')
})

test('product preview and storefront use the shared GFM renderer', () => {
    const renderer = readFileSync(new URL('../components/markdown-content.tsx', import.meta.url), 'utf8')
    const editor = readFileSync(new URL('../components/admin/markdown-editor.tsx', import.meta.url), 'utf8')
    const storefront = readFileSync(new URL('../components/buy-content.tsx', import.meta.url), 'utf8')

    assert.match(renderer, /remarkPlugins=\{\[remarkGfm\]\}/)
    assert.match(editor, /<MarkdownContent/)
    assert.equal((storefront.match(/<MarkdownContent/g) || []).length, 2)
})
