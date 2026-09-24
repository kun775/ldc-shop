import test from 'node:test'
import assert from 'node:assert/strict'
import { isSafeFooterHref, sanitizeFooterHtml, toFooterNodes } from './footer-html.ts'

test('page urls are linkified, other tags are dropped as text', () => {
    const nodes = toFooterNodes('See https://example.com/a for details')

    assert.deepEqual(nodes, [
        { kind: 'text', text: 'See ' },
        { kind: 'link', href: 'https://example.com/a', text: 'https://example.com/a' },
        { kind: 'text', text: ' for details' },
    ])
})

test('trailing punctuation stays outside the link', () => {
    const nodes = toFooterNodes('Docs: https://example.com/a. Then read on')

    const link = nodes.find((node) => node.kind === 'link')
    assert.equal(link?.href, 'https://example.com/a')
    assert.equal(nodes[nodes.length - 1].kind, 'text')
})

test('anchors keep only http(s) hrefs', () => {
    const safe = toFooterNodes('<a href="https://example.com">Docs</a>')
    assert.deepEqual(safe, [{ kind: 'link', href: 'https://example.com', text: 'Docs' }])

    const unsafe = toFooterNodes('<a href="javascript:alert(1)">Docs</a>')
    assert.equal(unsafe.some((node) => node.kind === 'link'), false)
    assert.equal(unsafe.map((node) => node.kind === 'text' ? node.text : '').join(''), 'Docs')
})

test('script and event-handler payloads never survive', () => {
    const nodes = toFooterNodes('<script>alert(1)</script>hi<img src=x onerror="alert(2)">')

    // 标签整体被丢弃，内部文本退化成惰性纯文本，不可能被当作标记解析。
    assert.equal(nodes.every((node) => node.kind === 'text'), true)
    const text = nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('')
    assert.equal(text, 'alert(1)hi')
    assert.equal(text.includes('<'), false)
})

test('newlines survive for pre-line rendering', () => {
    const nodes = toFooterNodes('line one\nline two')
    assert.deepEqual(nodes, [{ kind: 'text', text: 'line one\nline two' }])
})

test('write-path sanitizer emits only text and whitelisted anchors', () => {
    const sanitized = sanitizeFooterHtml('<b>Shop</b> <a href="https://example.com">site</a><a href="javascript:alert(1)">x</a>')

    assert.equal(sanitized.includes('<b>'), false)
    assert.equal(sanitized.includes('javascript:'), false)
    assert.match(sanitized, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">site<\/a>/)
})

test('write-path sanitizer escapes html entities in plain text', () => {
    const sanitized = sanitizeFooterHtml('a < b & c > d')
    assert.equal(sanitized, 'a &lt; b &amp; c &gt; d')
})

test('isSafeFooterHref accepts only http(s)', () => {
    assert.equal(isSafeFooterHref('https://example.com'), true)
    assert.equal(isSafeFooterHref('HTTP://example.com'), true)
    assert.equal(isSafeFooterHref('javascript:alert(1)'), false)
    assert.equal(isSafeFooterHref('data:text/html,<script>'), false)
    assert.equal(isSafeFooterHref('//example.com'), false)
})
