'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import {
    Bold,
    Braces,
    Code2,
    Eye,
    Heading2,
    Image as ImageIcon,
    Italic,
    Link,
    List,
    ListChecks,
    ListOrdered,
    Minus,
    Pencil,
    Quote,
    Strikethrough,
    Table2,
    type LucideIcon,
} from 'lucide-react'

import { MarkdownContent } from '@/components/markdown-content'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { applyMarkdownFormat, type MarkdownFormat } from '@/lib/markdown-editor'
import { cn } from '@/lib/utils'

type Translator = (key: string, params?: Record<string, string | number>) => string

type MarkdownEditorProps = {
    id: string
    name: string
    defaultValue?: string | null
    placeholder?: string
    height?: number
    t: Translator
}

type ToolbarItem = {
    format: MarkdownFormat
    icon: LucideIcon
    labelKey: string
    group: number
}

const TOOLBAR_ITEMS: ToolbarItem[] = [
    { format: 'bold', icon: Bold, labelKey: 'bold', group: 0 },
    { format: 'italic', icon: Italic, labelKey: 'italic', group: 0 },
    { format: 'strikethrough', icon: Strikethrough, labelKey: 'strikethrough', group: 0 },
    { format: 'heading', icon: Heading2, labelKey: 'heading', group: 1 },
    { format: 'quote', icon: Quote, labelKey: 'quote', group: 1 },
    { format: 'unordered-list', icon: List, labelKey: 'unorderedList', group: 2 },
    { format: 'ordered-list', icon: ListOrdered, labelKey: 'orderedList', group: 2 },
    { format: 'task-list', icon: ListChecks, labelKey: 'taskList', group: 2 },
    { format: 'inline-code', icon: Braces, labelKey: 'inlineCode', group: 3 },
    { format: 'code-block', icon: Code2, labelKey: 'codeBlock', group: 3 },
    { format: 'link', icon: Link, labelKey: 'link', group: 4 },
    { format: 'image', icon: ImageIcon, labelKey: 'image', group: 4 },
    { format: 'table', icon: Table2, labelKey: 'table', group: 5 },
    { format: 'horizontal-rule', icon: Minus, labelKey: 'horizontalRule', group: 5 },
]

export function MarkdownEditor({
    id,
    name,
    defaultValue,
    placeholder,
    height = 260,
    t,
}: MarkdownEditorProps) {
    const [value, setValue] = useState(defaultValue || '')
    const [mode, setMode] = useState<'edit' | 'preview'>('edit')
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const placeholders = {
        bold: t('admin.productForm.markdown.placeholders.bold'),
        italic: t('admin.productForm.markdown.placeholders.italic'),
        strikethrough: t('admin.productForm.markdown.placeholders.strikethrough'),
        heading: t('admin.productForm.markdown.placeholders.heading'),
        quote: t('admin.productForm.markdown.placeholders.quote'),
        listItem: t('admin.productForm.markdown.placeholders.listItem'),
        task: t('admin.productForm.markdown.placeholders.task'),
        code: t('admin.productForm.markdown.placeholders.code'),
        linkText: t('admin.productForm.markdown.placeholders.linkText'),
        imageAlt: t('admin.productForm.markdown.placeholders.imageAlt'),
        tableHeader1: t('admin.productForm.markdown.placeholders.tableHeader1'),
        tableHeader2: t('admin.productForm.markdown.placeholders.tableHeader2'),
        tableCell1: t('admin.productForm.markdown.placeholders.tableCell1'),
        tableCell2: t('admin.productForm.markdown.placeholders.tableCell2'),
        tableCell3: t('admin.productForm.markdown.placeholders.tableCell3'),
        tableCell4: t('admin.productForm.markdown.placeholders.tableCell4'),
    }

    const applyFormat = (format: MarkdownFormat) => {
        const textarea = textareaRef.current
        if (!textarea) return

        const result = applyMarkdownFormat(
            value,
            textarea.selectionStart,
            textarea.selectionEnd,
            format,
            placeholders
        )
        setValue(result.value)
        window.requestAnimationFrame(() => {
            textarea.focus()
            textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        })
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!(event.ctrlKey || event.metaKey)) return

        const key = event.key.toLowerCase()
        if (key === 'b') {
            event.preventDefault()
            applyFormat('bold')
        } else if (key === 'i') {
            event.preventDefault()
            applyFormat('italic')
        } else if (event.shiftKey && key === 'p') {
            event.preventDefault()
            setMode('preview')
        }
    }

    return (
        <div className="overflow-hidden rounded-md border border-input bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/25 p-1.5">
                <div role="toolbar" aria-label={t('admin.productForm.markdown.toolbar')} className="flex flex-wrap items-center gap-0.5">
                    {TOOLBAR_ITEMS.map(({ format, icon: Icon, labelKey, group }, index) => {
                        const previousGroup = index > 0 ? TOOLBAR_ITEMS[index - 1].group : group
                        const label = t(`admin.productForm.markdown.${labelKey}`)
                        return (
                            <span
                                key={format}
                                className={cn('inline-flex', group !== previousGroup && 'ml-1 border-l border-border/70 pl-1')}
                            >
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                                    onClick={() => applyFormat(format)}
                                    disabled={mode !== 'edit'}
                                    aria-label={label}
                                    title={label}
                                >
                                    <Icon className="h-4 w-4" />
                                </Button>
                            </span>
                        )
                    })}
                </div>

                <div className="flex shrink-0 items-center rounded-md border border-border/70 bg-background p-0.5">
                    <Button
                        type="button"
                        variant={mode === 'edit' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 rounded-sm px-2.5 text-xs"
                        onClick={() => setMode('edit')}
                        aria-pressed={mode === 'edit'}
                    >
                        <Pencil className="h-3.5 w-3.5" />
                        {t('admin.productForm.markdown.edit')}
                    </Button>
                    <Button
                        type="button"
                        variant={mode === 'preview' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 rounded-sm px-2.5 text-xs"
                        onClick={() => setMode('preview')}
                        aria-pressed={mode === 'preview'}
                    >
                        <Eye className="h-3.5 w-3.5" />
                        {t('admin.productForm.markdown.preview')}
                    </Button>
                </div>
            </div>

            <Textarea
                ref={textareaRef}
                id={id}
                name={name}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                style={{ height }}
                className={cn(
                    'field-sizing-fixed resize-none rounded-none border-0 px-3 py-3 font-mono text-sm leading-6 shadow-none focus-visible:border-0 focus-visible:ring-0',
                    mode !== 'edit' && 'hidden'
                )}
            />

            {mode === 'preview' && (
                <div style={{ height }} className="overflow-y-auto px-4 py-3">
                    <MarkdownContent
                        content={value}
                        emptyText={t('admin.productForm.markdown.emptyPreview')}
                    />
                </div>
            )}
        </div>
    )
}
