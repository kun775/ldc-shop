export type MarkdownFormat =
    | 'bold'
    | 'italic'
    | 'strikethrough'
    | 'heading'
    | 'quote'
    | 'unordered-list'
    | 'ordered-list'
    | 'task-list'
    | 'inline-code'
    | 'code-block'
    | 'link'
    | 'image'
    | 'table'
    | 'horizontal-rule'

export type MarkdownTransformResult = {
    value: string
    selectionStart: number
    selectionEnd: number
}

export type MarkdownPlaceholders = Partial<{
    bold: string
    italic: string
    strikethrough: string
    heading: string
    quote: string
    listItem: string
    task: string
    code: string
    linkText: string
    imageAlt: string
    tableHeader1: string
    tableHeader2: string
    tableCell1: string
    tableCell2: string
    tableCell3: string
    tableCell4: string
}>

const DEFAULT_PLACEHOLDERS: Required<MarkdownPlaceholders> = {
    bold: '加粗文字',
    italic: '斜体文字',
    strikethrough: '删除线文字',
    heading: '标题',
    quote: '引用内容',
    listItem: '列表项',
    task: '待办事项',
    code: 'code',
    linkText: '链接文字',
    imageAlt: '图片说明',
    tableHeader1: '标题 1',
    tableHeader2: '标题 2',
    tableCell1: '内容 1',
    tableCell2: '内容 2',
    tableCell3: '内容 3',
    tableCell4: '内容 4',
}

function normalizeSelection(value: string, selectionStart: number, selectionEnd: number) {
    const start = Math.max(0, Math.min(selectionStart, value.length))
    const end = Math.max(start, Math.min(selectionEnd, value.length))
    return { start, end }
}

function replaceRange(
    value: string,
    start: number,
    end: number,
    replacement: string,
    selectionStart: number,
    selectionEnd: number
): MarkdownTransformResult {
    return {
        value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
        selectionStart: start + selectionStart,
        selectionEnd: start + selectionEnd,
    }
}

function wrapInline(
    value: string,
    start: number,
    end: number,
    prefix: string,
    suffix: string,
    placeholder: string
) {
    const selected = value.slice(start, end) || placeholder
    const replacement = `${prefix}${selected}${suffix}`
    return replaceRange(
        value,
        start,
        end,
        replacement,
        prefix.length,
        prefix.length + selected.length
    )
}

function prefixSelectedLines(
    value: string,
    start: number,
    end: number,
    prefix: (lineIndex: number) => string,
    placeholder: string
) {
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
    const nextLineBreak = value.indexOf('\n', end)
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak
    const source = value.slice(lineStart, lineEnd) || placeholder
    const replacement = source
        .split('\n')
        .map((line, index) => `${prefix(index)}${line || placeholder}`)
        .join('\n')

    return replaceRange(value, lineStart, lineEnd, replacement, 0, replacement.length)
}

function blockPadding(value: string, start: number, end: number) {
    const before = value.slice(0, start)
    const after = value.slice(end)
    const leading = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const trailing = !after ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    return { leading, trailing }
}

function insertTemplate(
    value: string,
    start: number,
    end: number,
    template: string,
    selectedText?: string
) {
    const { leading, trailing } = blockPadding(value, start, end)
    const replacement = `${leading}${template}${trailing}`
    const selectedOffset = selectedText ? replacement.indexOf(selectedText) : replacement.length - trailing.length
    const selectionStart = selectedOffset >= 0 ? selectedOffset : replacement.length - trailing.length
    const selectionEnd = selectedOffset >= 0 && selectedText
        ? selectedOffset + selectedText.length
        : selectionStart
    return replaceRange(value, start, end, replacement, selectionStart, selectionEnd)
}

export function applyMarkdownFormat(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    format: MarkdownFormat,
    placeholders: MarkdownPlaceholders = {}
): MarkdownTransformResult {
    const { start, end } = normalizeSelection(value, selectionStart, selectionEnd)
    const text = { ...DEFAULT_PLACEHOLDERS, ...placeholders }

    switch (format) {
        case 'bold':
            return wrapInline(value, start, end, '**', '**', text.bold)
        case 'italic':
            return wrapInline(value, start, end, '*', '*', text.italic)
        case 'strikethrough':
            return wrapInline(value, start, end, '~~', '~~', text.strikethrough)
        case 'inline-code':
            return wrapInline(value, start, end, '`', '`', text.code)
        case 'heading':
            return prefixSelectedLines(value, start, end, () => '## ', text.heading)
        case 'quote':
            return prefixSelectedLines(value, start, end, () => '> ', text.quote)
        case 'unordered-list':
            return prefixSelectedLines(value, start, end, () => '- ', text.listItem)
        case 'ordered-list':
            return prefixSelectedLines(value, start, end, (index) => `${index + 1}. `, text.listItem)
        case 'task-list':
            return prefixSelectedLines(value, start, end, () => '- [ ] ', text.task)
        case 'code-block': {
            const selected = value.slice(start, end) || text.code
            const template = `\`\`\`\n${selected}\n\`\`\``
            return insertTemplate(value, start, end, template, selected)
        }
        case 'link': {
            const selected = value.slice(start, end)
            const label = selected || text.linkText
            const url = 'https://example.com'
            const replacement = `[${label}](${url})`
            const target = selected ? url : label
            const targetOffset = replacement.indexOf(target)
            return replaceRange(value, start, end, replacement, targetOffset, targetOffset + target.length)
        }
        case 'image': {
            const alt = value.slice(start, end) || text.imageAlt
            const url = 'https://example.com/image.png'
            const replacement = `![${alt}](${url})`
            const targetOffset = replacement.indexOf(url)
            return replaceRange(value, start, end, replacement, targetOffset, targetOffset + url.length)
        }
        case 'table': {
            const template = [
                `| ${text.tableHeader1} | ${text.tableHeader2} |`,
                '| --- | --- |',
                `| ${text.tableCell1} | ${text.tableCell2} |`,
                `| ${text.tableCell3} | ${text.tableCell4} |`,
            ].join('\n')
            return insertTemplate(value, start, end, template, text.tableHeader1)
        }
        case 'horizontal-rule':
            return insertTemplate(value, start, end, '---')
    }
}
