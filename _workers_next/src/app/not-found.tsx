import Link from 'next/link'
import { getServerI18n } from '@/lib/i18n/server'
import { Button } from '@/components/ui/button'
import { CompassIcon, HomeIcon } from 'lucide-react'

/**
 * 根级 404 页面。
 *
 * 此前项目没有 `not-found.tsx`，未匹配路由会落到 Next.js 内置的
 * 纯英文、无样式的 404 页面上，用户在当前站点内点开一个坏链接会突然
 * 掉出整套主题。这里提供与站内一致的版式，并跟随当前语言/主题。
 *
 * 用服务端 i18n（`getServerI18n`）而不是客户端 context，保证 404 首屏
 * 就是正确语言，不依赖水合。
 */
export default async function NotFound() {
    const { t } = await getServerI18n()

    return (
        <div className="container flex min-h-[60vh] flex-col items-center justify-center gap-6 py-16 text-center">
            <p
                className="bg-gradient-to-b from-foreground/80 to-foreground/30 bg-clip-text text-6xl font-bold leading-none tracking-tighter text-transparent sm:text-7xl"
                aria-hidden="true"
            >
                404
            </p>
            <div className="space-y-2">
                <h1 className="text-lg font-semibold tracking-tight">{t('common.notFoundTitle')}</h1>
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                    {t('common.notFoundDescription')}
                </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild size="sm">
                    <Link href="/">
                        <HomeIcon aria-hidden="true" />
                        {t('common.goHome')}
                    </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                    <Link href="/search">
                        <CompassIcon aria-hidden="true" />
                        {t('common.browseProducts')}
                    </Link>
                </Button>
            </div>
        </div>
    )
}
