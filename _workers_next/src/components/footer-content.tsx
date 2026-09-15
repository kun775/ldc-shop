'use client'

import { useI18n } from "@/lib/i18n/context"
import { Users } from "lucide-react"
import type { ReactNode } from "react"

interface FooterContentProps {
    customFooter: string | null
    version: string
    visitorCount?: number
}

export function FooterContent({ customFooter, version, visitorCount }: FooterContentProps) {
    const { t } = useI18n()
    const footerText = customFooter?.trim() || t('footer.disclaimer')

    const linkify = (text: string) => {
        const nodes: ReactNode[] = []
        const urlRegex = /https?:\/\/[^\s]+/g
        let lastIndex = 0
        let match: RegExpExecArray | null
        let linkIndex = 0

        while ((match = urlRegex.exec(text)) !== null) {
            const [raw] = match
            const start = match.index
            if (start > lastIndex) {
                nodes.push(text.slice(lastIndex, start))
            }

            let url = raw
            let trailing = ''
            while (url.length && /[),.!?]/.test(url[url.length - 1])) {
                trailing = url[url.length - 1] + trailing
                url = url.slice(0, -1)
            }

            if (url) {
                nodes.push(
                    <a
                        key={`footer-link-${linkIndex++}`}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground/80 hover:text-primary transition-colors duration-300"
                    >
                        {url}
                    </a>
                )
            }
            if (trailing) nodes.push(trailing)
            lastIndex = start + raw.length
        }

        if (lastIndex < text.length) {
            nodes.push(text.slice(lastIndex))
        }

        return nodes
    }

    return (
        <footer className="border-t border-border/40 py-6 pb-20 md:py-0 md:pb-0 bg-gradient-to-t from-muted/30 to-transparent">
            <div className="container flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row">
                <div className="flex flex-col items-center gap-4 px-4 md:flex-row md:gap-2 md:px-0">
                    <p
                        className="text-center text-xs leading-relaxed text-muted-foreground/80 md:text-left footer-html"
                        dangerouslySetInnerHTML={{ __html: footerText }}
                    />
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground/50">
                    {typeof visitorCount === "number" && visitorCount > 0 && (
                        <div className="inline-flex items-center gap-1.5 font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors" title="全站累计独立访客数">
                            <Users className="h-3.5 w-3.5 text-primary/70" />
                            <span>{t('footer.visitorCount', { count: visitorCount })}</span>
                        </div>
                    )}
                    <span className="text-border/60">·</span>
                    <a
                        href="https://github.com/kun775/ldc-shop"
                        target="_blank"
                        rel="noreferrer"
                        className="text-center text-xs text-muted-foreground/50 hover:text-primary transition-colors duration-300 font-mono"
                    >
                        v{version}
                    </a>
                </div>
            </div>
        </footer>
    )
}
