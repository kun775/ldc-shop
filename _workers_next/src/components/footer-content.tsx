'use client'

import { useI18n } from "@/lib/i18n/context"
import { Users } from "lucide-react"
import { Fragment } from "react"
import { toFooterNodes } from "@/lib/footer-html"

interface FooterContentProps {
    customFooter: string | null
    version: string
    visitorCount?: number
}

export function FooterContent({ customFooter, version, visitorCount }: FooterContentProps) {
    const { t } = useI18n()
    const footerText = customFooter?.trim() || t('footer.disclaimer')

    // 页脚文案来自管理员设置，渲染在任何位置都不能走 innerHTML。
    // 这里只把解析结果映射成 React 节点（纯文本 + 白名单 http(s) 链接），
    // 解析与净化规则见 src/lib/footer-html.ts（写入侧复用同一套规则）。
    const footerNodes = toFooterNodes(footerText)

    return (
        <footer className="shrink-0 border-t border-border/40 bg-background/90 py-3 pb-20 backdrop-blur md:py-0 md:pb-0">
            <div className="container flex flex-col items-center justify-between gap-4 md:h-16 md:flex-row">
                <div className="flex flex-col items-center gap-4 px-4 md:flex-row md:gap-2 md:px-0">
                    <p className="whitespace-pre-line text-center text-xs leading-relaxed text-muted-foreground/80 md:text-left footer-html">
                        {footerNodes.map((node, index) => (
                            node.kind === 'link' ? (
                                <a
                                    key={`footer-link-${index}`}
                                    href={node.href}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-muted-foreground/80 hover:text-primary transition-colors duration-300"
                                >
                                    {node.text}
                                </a>
                            ) : (
                                <Fragment key={`footer-text-${index}`}>{node.text}</Fragment>
                            )
                        ))}
                    </p>
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
