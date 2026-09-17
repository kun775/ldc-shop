'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'
import { useI18n } from '@/lib/i18n/context'
import { cn } from '@/lib/utils'
import { Loader2Icon } from 'lucide-react'

/** 读取当前页面级加载状态（订阅式，任意组件可复用） */
export function usePageLoading() {
    return useSyncExternalStore(
        pageLoadingStore.subscribe,
        pageLoadingStore.getSnapshot,
        pageLoadingStore.getServerSnapshot
    )
}

/**
 * PageLoadingOverlay 页面级加载遮罩。
 *
 * 职责边界：只表达「页面/路由正在装载」，绝不接管按钮提交、保存、发货等
 * 业务提交状态。业务提交遮罩仍在自己的业务区域内，不会与本组件叠成全屏双遮罩。
 *
 * 层级约定（全站，写新组件时请遵守）：
 *   - z-10 / z-20  表头与局部吸顶
 *   - z-40         前台顶部导航
 *   - z-50         对话框、弹层、移动端底部导航
 *   - z-[90]       本组件（页面级 Loading 遮罩）
 *   - z-[100]      toast
 *
 * 渲染位置：portal 到 `document.body`。后台根节点是 `100dvh` + `overflow:hidden`
 * 的固定工作台，若遮罩留在 React 树内、且祖先恰好 overflow:hidden 或带
 * backdrop-filter 形成包含块，`fixed` 会被限制在局部而非视口。
 *
 * 主题：只用 `bg-background` / `text-primary` / `text-muted-foreground` 等语义变量，
 * 自动适配浅色、深色与后台主题色，不引入固定色值。
 */
export function PageLoadingOverlay() {
    const { t } = useI18n()
    const snapshot = usePageLoading()

    const isStuck = snapshot.status === 'failed'
    const isActive = snapshot.status === 'loading' || isStuck
    const isFadingOut = snapshot.status === 'completed'
    const labelKey = snapshot.labelKey || 'common.loading'

    // 加载期间锁定文档滚动；卸载或结束时无条件还原，绝不留存滚动锁
    useEffect(() => {
        if (!isActive) return
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = previousOverflow
        }
    }, [isActive])

    if (!snapshot.visible) return null
    if (typeof document === 'undefined') return null

    return createPortal(
        <div
            data-page-loading-overlay="true"
            data-status={snapshot.status}
            role="status"
            aria-live="polite"
            aria-busy={isStuck ? undefined : true}
            aria-label={isStuck ? t('common.loadingSlow') : t(labelKey)}
            className={cn(
                'fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4',
                'bg-background/72 backdrop-blur-[2px]',
                // 移动端安全区域：不遮挡底部导航手势区
                'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
                isFadingOut
                    ? 'pointer-events-none animate-out fade-out duration-200 fill-mode-forwards motion-reduce:animate-none'
                    : 'animate-in fade-in duration-200 motion-reduce:animate-none'
            )}
        >
            {isStuck ? (
                <div className="mx-6 flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border/70 bg-card p-6 text-center shadow-lg">
                    <p className="text-sm text-muted-foreground">{t('common.loadingSlow')}</p>
                    <div className="flex w-full gap-2">
                        <button
                            type="button"
                            onClick={() => pageLoadingStore.retry()}
                            className="inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                            {t('common.retry')}
                        </button>
                        <button
                            type="button"
                            onClick={() => pageLoadingStore.dismiss()}
                            className="inline-flex h-9 flex-1 items-center justify-center rounded-lg border border-border/60 bg-background text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                            {t('common.close')}
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <Loader2Icon
                        aria-hidden="true"
                        className="size-7 animate-spin text-primary motion-reduce:animate-none"
                    />
                    <span className="text-sm text-muted-foreground">{t(labelKey)}</span>
                </>
            )}
        </div>,
        document.body
    )
}
