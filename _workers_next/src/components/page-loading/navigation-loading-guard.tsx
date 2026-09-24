'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'

/**
 * NavigationLoadingGuard 覆盖「路由切换」阶段。
 *
 * 触发方式：点击站内链接 → 目标路由 RSC 请求开始 → 服务端返回 → 新树上屏。
 * 仅靠目标页 `loading.tsx` 的 Suspense fallback 覆盖不到这条链路，因为
 * fallback 只在「RSC 已开始流式返回」时才挂载，点击到首字节之间的等待是空白的。
 *
 * 正确性保障（不依赖任何全局 monkey patch）：
 *   1. 只监听带 `href` 的站内 `<a>` 主键点击，并延迟一个宏任务再判定，
 *      这样业务侧 `preventDefault()` 能被准确识别（同页锚点、被拦截的跳转、
 *      下载、外链、修饰键/中键点击都不会误触发）；
 *   2. 新 pathname 一旦上屏立即结束任务 —— 遮罩消失时机与现状一致，
 *      不会比现在多显示哪怕一帧；
 *   3. 兜底计时器保证任何漏判都在 MAX_NAVIGATION_MS 内释放，绝不留存遮罩。
 *
 * 刻意不 patch `history`：历史上曾有第三方动画库在模块加载阶段调用
 * `history.pushState`（会产生无法与真实导航区分的假信号）。链接点击是
 * 唯一可靠且零副作用的信号源，这条约束与具体依赖无关，继续保持。
 */
const NAVIGATION_TASK_ID = 'route:navigation'
/** RSC 导航超过该时长仍未上屏即放弃遮罩，避免误判造成永久遮罩 */
const MAX_NAVIGATION_MS = 8000

export function NavigationLoadingGuard() {
    const pathname = usePathname()

    // pathname 变化 = 新页面已上屏，立即释放
    useEffect(() => {
        pageLoadingStore.end(NAVIGATION_TASK_ID)
    }, [pathname])

    useEffect(() => {
        let timeoutId: number | null = null
        let watching = false

        const release = () => {
            watching = false
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId)
                timeoutId = null
            }
            pageLoadingStore.end(NAVIGATION_TASK_ID)
        }

        const handleClick = (event: MouseEvent) => {
            // 捕获阶段先记录候选，宏任务后再复核，避免与业务 preventDefault 竞争
            if (event.button !== 0) return
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

            const target = event.target as Element | null
            const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
            if (!anchor) return
            if (anchor.target && anchor.target !== '_self') return
            if (anchor.hasAttribute('download')) return

            let url: URL
            try {
                url = new URL(anchor.href, window.location.href)
            } catch {
                return
            }

            if (url.origin !== window.location.origin) return
            // 同页跳转（锚点、只改 query/hash）不触发页面级加载
            if (url.pathname === window.location.pathname) return

            window.setTimeout(() => {
                if (event.defaultPrevented) return
                // 已被卸载或已判定导航结束
                if (document.readyState === 'loading') return

                watching = true
                pageLoadingStore.begin(NAVIGATION_TASK_ID)

                if (timeoutId !== null) window.clearTimeout(timeoutId)
                timeoutId = window.setTimeout(release, MAX_NAVIGATION_MS)
            }, 0)
        }

        document.addEventListener('click', handleClick, true)
        return () => {
            document.removeEventListener('click', handleClick, true)
            if (watching) release()
            if (timeoutId !== null) window.clearTimeout(timeoutId)
        }
    }, [])

    return null
}
