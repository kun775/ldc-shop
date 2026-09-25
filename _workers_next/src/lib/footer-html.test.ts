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

test('plain text keeps ampersands through saving and rendering', () => {
    const saved = sanitizeFooterHtml('A & B')
    assert.equal(saved, 'A &amp; B')
    assert.deepEqual(toFooterNodes(saved), [{ kind: 'text', text: 'A & B' }])
    assert.equal(sanitizeFooterHtml(saved), saved)
    assert.equal(sanitizeFooterHtml(sanitizeFooterHtml(saved)), saved)

    // 旧库中的原始纯文本和已编码文本都应显示相同的文案。
    assert.deepEqual(toFooterNodes('A & B'), toFooterNodes(saved))
    assert.deepEqual(toFooterNodes('A &amp; B'), toFooterNodes(saved))
})

test('bare and explicit links retain query strings and labels across repeated saves', () => {
    const url = 'https://example.com/?a=1&b=2'
    const bare = `A & B ${url}`
    const savedBare = sanitizeFooterHtml(bare)
    assert.deepEqual(toFooterNodes(savedBare), [
        { kind: 'text', text: 'A & B ' },
        { kind: 'link', href: url, text: url },
    ])
    assert.equal(sanitizeFooterHtml(savedBare), savedBare)
    assert.equal(sanitizeFooterHtml(sanitizeFooterHtml(savedBare)), savedBare)
    assert.deepEqual(toFooterNodes(bare), toFooterNodes(savedBare))

    const rawAnchor = `<a href="${url}">A & B</a>`
    const savedAnchor = sanitizeFooterHtml(rawAnchor)
    assert.equal(savedAnchor, '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noreferrer noopener">A &amp; B</a>')
    assert.deepEqual(toFooterNodes(savedAnchor), [{ kind: 'link', href: url, text: 'A & B' }])
    assert.deepEqual(toFooterNodes(rawAnchor), toFooterNodes(savedAnchor))
    assert.equal(sanitizeFooterHtml(savedAnchor), savedAnchor)
    assert.equal(sanitizeFooterHtml(sanitizeFooterHtml(savedAnchor)), savedAnchor)
})

test('nested entities are stable on repeated saves and never become HTML', () => {
    const saved = sanitizeFooterHtml('A &amp;lt; B &amp;#38; C &amp;amp; D')
    assert.equal(saved, 'A &lt; B &amp; C &amp; D')
    assert.deepEqual(toFooterNodes(saved), [{ kind: 'text', text: 'A < B & C & D' }])
    assert.equal(sanitizeFooterHtml(saved), saved)
    assert.equal(sanitizeFooterHtml(sanitizeFooterHtml(saved)), saved)

    const encodedScript = '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'
    assert.deepEqual(toFooterNodes(encodedScript), [
        { kind: 'text', text: '<script>alert(1)</script>' },
    ])
    const sanitized = sanitizeFooterHtml(encodedScript)
    assert.equal(sanitized.includes('<script>'), false)
    assert.equal(sanitizeFooterHtml(sanitized), sanitized)
})

test('encoded legacy content is decoded as text without becoming executable markup', () => {
    const legacy = 'A &lt; B &amp; C &#38; D <script>alert(1)</script><a href="javascript:alert(2)">bad</a><a href="https://example.com/?a=1&amp;b=2" onclick="alert(3)">safe &amp; sound</a>'
    const nodes = toFooterNodes(legacy)
    assert.deepEqual(nodes, [
        { kind: 'text', text: 'A < B & C & D alert(1)' },
        { kind: 'text', text: 'bad' },
        { kind: 'link', href: 'https://example.com/?a=1&b=2', text: 'safe & sound' },
    ])
    const saved = sanitizeFooterHtml(legacy)
    assert.equal(saved.includes('<script'), false)
    assert.equal(saved.includes('onclick'), false)
    assert.equal(saved.includes('javascript:'), false)
    assert.equal(sanitizeFooterHtml(saved), saved)
    assert.deepEqual(toFooterNodes(saved).filter((node) => node.kind === 'link'), [
        { kind: 'link', href: 'https://example.com/?a=1&b=2', text: 'safe & sound' },
    ])
    assert.deepEqual(toFooterNodes('&lt;img src=x onerror=alert(1)&gt;'), [
        { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ])
    const encodedHref = '<a href="&#106;avascript:alert(1)">unsafe</a>'
    assert.deepEqual(toFooterNodes(encodedHref), [{ kind: 'text', text: 'unsafe' }])
    assert.equal(sanitizeFooterHtml(encodedHref), 'unsafe')
})

test('only a standalone href attribute makes an anchor clickable', () => {
    for (const html of [
        '<a data-href="https://evil.example">go</a>',
        '<a title="href=https://evil.example">go</a>',
        '<a data-note="href=https://evil.example" aria-label="go">go</a>',
    ]) {
        assert.deepEqual(toFooterNodes(html), [{ kind: 'text', text: 'go' }])
        assert.equal(sanitizeFooterHtml(html), 'go')
    }
    assert.deepEqual(
        toFooterNodes('<a data-href="https://evil.example" href="https://good.example/?a=1&amp;b=2">go</a>'),
        [{ kind: 'link', href: 'https://good.example/?a=1&b=2', text: 'go' }],
    )
})

test('isSafeFooterHref accepts only http(s)', () => {
    assert.equal(isSafeFooterHref('https://example.com'), true)
    assert.equal(isSafeFooterHref('HTTP://example.com'), true)
    assert.equal(isSafeFooterHref('javascript:alert(1)'), false)
    assert.equal(isSafeFooterHref('data:text/html,<script>'), false)
    assert.equal(isSafeFooterHref('//example.com'), false)
})
