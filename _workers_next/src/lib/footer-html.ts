/**
 * 页脚富文本的唯一解析/净化口。
 *
 * 背景：`settings.shop_footer` 由管理员填写，历史上直接经
 * `dangerouslySetInnerHTML` 渲染到**全站每个页面**。写入侧只校验了 500 字长度，
 * 没有任何净化 —— 一旦管理员账号被钓、或通过 SQL 导入写进任意 setting，
 * 就升级为普通用户可见的存储型 XSS。
 *
 * 这里把「允许的内容」收窄成一种可枚举的模型：**纯文本 + http(s) 链接**。
 * 其余所有标签、事件属性、非 http(s) 协议（`javascript:`、`data:`）都会被丢弃。
 * 渲染侧只把解析结果映射成 React 节点，永远不再走 innerHTML。
 */
export type FooterNode =
    | { kind: 'text'; text: string }
    | { kind: 'link'; href: string; text: string }

const ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
// 只把「真的像标签」的片段去掉：`<` 后面必须紧跟标签名（或 / ? !）。
// 这样 `a < b & c > d` 这类纯文本不会被误吞，交给转义处理。
const ANY_TAG_PATTERN = /<(?:!--[\s\S]*?-->|\/?[a-zA-Z][^>]*|\?[^>]*|![^>]*)>/g
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"']+/g
const TRAILING_PUNCTUATION = /[),.!?]/

/** 只接受 http/https，挡掉 javascript:、data:、vbscript: 等协议 */
export function isSafeFooterHref(href: string): boolean {
    return /^https?:\/\//i.test((href || '').trim())
}

function stripTags(input: string): string {
    return input.replace(ANY_TAG_PATTERN, '')
}

/** 把一段纯文本按裸 URL 切成 text / link 节点 */
function pushTextNodes(nodes: FooterNode[], text: string) {
    if (!text) return

    let lastIndex = 0
    let match: RegExpExecArray | null
    BARE_URL_PATTERN.lastIndex = 0

    while ((match = BARE_URL_PATTERN.exec(text)) !== null) {
        const raw = match[0]
        let url = raw
        let trailing = ''
        while (url.length && TRAILING_PUNCTUATION.test(url[url.length - 1])) {
            trailing = url[url.length - 1] + trailing
            url = url.slice(0, -1)
        }

        if (match.index > lastIndex) {
            nodes.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
        }
        if (url) {
            nodes.push({ kind: 'link', href: url, text: url })
        }
        if (trailing) {
            nodes.push({ kind: 'text', text: trailing })
        }
        lastIndex = match.index + raw.length
    }

    if (lastIndex < text.length) {
        nodes.push({ kind: 'text', text: text.slice(lastIndex) })
    }
}

/**
 * 把页脚内容解析为安全节点。
 * 允许 `<a href="http(s)://...">label</a>`，其它标签一律按纯文本处理。
 */
export function toFooterNodes(input: string): FooterNode[] {
    const source = typeof input === 'string' ? input : ''
    const nodes: FooterNode[] = []

    let lastIndex = 0
    let match: RegExpExecArray | null
    ANCHOR_PATTERN.lastIndex = 0

    while ((match = ANCHOR_PATTERN.exec(source)) !== null) {
        const raw = match[0]
        const href = (match[1] ?? match[2] ?? match[3] ?? '').trim()
        const label = stripTags(match[4] ?? '').replace(/\s+/g, ' ').trim()

        if (match.index > lastIndex) {
            pushTextNodes(nodes, stripTags(source.slice(lastIndex, match.index)))
        }

        if (isSafeFooterHref(href)) {
            nodes.push({ kind: 'link', href, text: label || href })
        } else if (label) {
            // 非 http(s) 链接降级为纯文本，链接本身丢弃
            pushTextNodes(nodes, label)
        }

        lastIndex = match.index + raw.length
    }

    if (lastIndex < source.length) {
        pushTextNodes(nodes, stripTags(source.slice(lastIndex)))
    }

    return nodes.filter((node) => (node.kind === 'link' ? Boolean(node.href) : node.text.length > 0))
}

function escapeText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
    return escapeText(value).replace(/"/g, '&quot;')
}

/**
 * 写入侧净化：把任意输入规范化成「纯文本 + 白名单链接」的最小 HTML 串。
 * 与渲染侧共用同一套解析规则，保证写入与展示永远一致。
 */
export function sanitizeFooterHtml(input: string): string {
    return toFooterNodes(input)
        .map((node) => (
            node.kind === 'link'
                ? `<a href="${escapeAttribute(node.href)}" target="_blank" rel="noreferrer noopener">${escapeText(node.text)}</a>`
                : escapeText(node.text)
        ))
        .join('')
}
