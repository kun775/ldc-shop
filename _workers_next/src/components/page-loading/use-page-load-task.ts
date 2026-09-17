'use client'

import { useEffect } from 'react'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'

/**
 * usePageLoadTask 把一个组件的「挂载期」声明为一次页面级加载任务。
 *
 * 用于 `loading.tsx` 这类 Suspense fallback：fallback 挂载即加载开始，
 * fallback 卸载（真实内容就绪）即加载结束。引用计数由 store 统一维护，
 * 因此多个并发的 fallback 不会互相提前关闭遮罩。
 */
export function usePageLoadTask(taskId: string, labelKey: string = 'common.loading'): void {
    useEffect(() => {
        pageLoadingStore.begin(taskId, labelKey)
        return () => {
            pageLoadingStore.end(taskId)
        }
    }, [taskId, labelKey])
}
