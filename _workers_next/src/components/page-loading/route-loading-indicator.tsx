'use client'

import { useId } from 'react'
import { usePageLoadTask } from './use-page-load-task'

/**
 * RouteLoadingIndicator 把所在位置（通常是 `loading.tsx` 的 Suspense fallback）
 * 的挂载期上报为一次页面级加载任务，自身不渲染任何节点。
 *
 * 为什么用 useId 作为 taskId：
 *   - Suspense fallback 反复挂载/卸载时，同一位置的 useId 保持稳定，
 *     因此 begin 与 end 严格配对，不会泄漏引用计数。
 *   - 不同位置（根级与后台级 loading）拿到不同 id，可并发计数。
 */
export function RouteLoadingIndicator({ labelKey = 'common.loading' }: { labelKey?: string }) {
    const id = useId()
    usePageLoadTask(`route:${id}`, labelKey)
    return null
}
