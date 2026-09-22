import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

const markdownComponents: Components = {
    a(props) {
        const { node, href, ...rest } = props
        void node
        const external = typeof href === 'string' && /^(https?:)?\/\//i.test(href)
        return (
            <a
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer noopener' : undefined}
                {...rest}
            />
        )
    },
    img(props) {
        const { node, alt = '', className, ...rest } = props
        void node
        // Markdown images can use arbitrary remote hosts, so next/image cannot know dimensions or domains ahead of time.
        // eslint-disable-next-line @next/next/no-img-element
        return <img alt={alt} loading="lazy" className={cn('h-auto max-w-full rounded-md', className)} {...rest} />
    },
    table(props) {
        const { node, className, ...rest } = props
        void node
        return (
            <div className="my-4 max-w-full overflow-x-auto rounded-md border border-border/60">
                <table className={cn('my-0 min-w-full', className)} {...rest} />
            </div>
        )
    },
    pre(props) {
        const { node, className, ...rest } = props
        void node
        return <pre className={cn('max-w-full overflow-x-auto', className)} {...rest} />
    },
    input(props) {
        const { node, className, ...rest } = props
        void node
        return <input className={cn('mr-2 accent-primary', className)} {...rest} />
    },
}

export function MarkdownContent({
    content,
    emptyText,
    className,
}: {
    content: string
    emptyText?: string
    className?: string
}) {
    const markdown = content.trim()

    if (!markdown) {
        return emptyText ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null
    }

    return (
        <div
            className={cn(
                'prose prose-sm max-w-none break-words text-foreground/90 dark:prose-invert',
                '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
                '[&_a]:break-all [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
                '[&_input[type=checkbox]]:align-middle',
                className
            )}
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {markdown}
            </ReactMarkdown>
        </div>
    )
}
