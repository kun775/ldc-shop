'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useI18n } from '@/lib/i18n/context'
import { Button } from '@/components/ui/button'
import { pageLoadingStore } from '@/lib/ui/page-loading-store'
import { AlertTriangleIcon, RotateCcwIcon, ArrowLeftIcon } from 'lucide-react'

/**
 * 优惠券模块错误边界。
 *
 * 为什么需要模块级而不只是根级 `/error`：
 *   根级错误边界接管时会替换整棵路由树，后台侧边栏、顶部栏一起消失，
 *   管理员只能跳回首页重新进入 —— 对一个「列表里点了一下删除」的异常
 *   来说代价过大。挂在 `/admin/coupons` 段落上则只替换本模块内容，
 *   后台工作台布局（侧边栏、导航）保持可用，管理员可重试或返回列表。
 *
 * 与页面级 Loading 的关系：错误界面出现时必须确保遮罩已释放，
 * 否则用户只看到旋转遮罩而看不到错误信息，因此挂载时无条件 dismiss。
 */
export default function CouponSegmentError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    const { t } = useI18n()

    useEffect(() => {
        pageLoadingStore.dismiss()
    }, [])

    const errorId = error.digest || ''

    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 py-16 text-center">
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
                <Button asChild variant="outline" size="sm">
                    <Link href="/admin">
                        <ArrowLeftIcon aria-hidden="true" />
                        {t('common.back')}
                    </Link>
                </Button>
            </div>
        </div>
    )
}
