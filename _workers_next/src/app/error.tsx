'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useI18n } from '@/lib/i18n/context'
import { Button } from '@/components/ui/button'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'
import { AlertTriangleIcon, RotateCcwIcon, HomeIcon } from 'lucide-react'

/**
 * 全局错误边界（前台）。
 *
 * 关键约束：错误界面出现时页面级 Loading 遮罩必须已经释放，
 * 否则用户只能看到旋转遮罩而看不到错误信息。这里在挂载时无条件 dismiss，
 * 属于「错误边界接管 → 释放遮罩」的约定实现。
 *
 * 错误 ID 优先取 Next.js 的 `error.digest`（生产环境错误信息会被脱敏，
 * 但 digest 与服务器日志中的 errorId 对应），无 digest 时退回本地时间戳。
 */
export default function GlobalRouteError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    const { t } = useI18n()
    const router = useRouter()

    useEffect(() => {
        pageLoadingStore.dismiss()
    }, [])

    const errorId = error.digest || ''

    return (
        <div className="container flex min-h-[60vh] flex-col items-center justify-center gap-5 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertTriangleIcon className="size-6" aria-hidden="true" />
            </div>
            <div className="space-y-2">
                <h1 className="text-lg font-semibold tracking-tight">{t('common.errorTitle')}</h1>
                <p className="max-w-sm text-sm text-muted-foreground">{t('common.errorDescription')}</p>
                {errorId && (
                    <p className="font-mono text-xs text-muted-foreground/80">
                        {t('common.errorIdLabel')}: {errorId}
                    </p>
                )}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={reset} size="sm">
                    <RotateCcwIcon aria-hidden="true" />
                    {t('common.retry')}
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        router.push('/')
                    }}
                >
                    <HomeIcon aria-hidden="true" />
                    {t('common.goHome')}
                </Button>
            </div>
        </div>
    )
}
