'use client'

import { I18nProvider } from '@/lib/i18n/context'
import { Toaster } from 'sonner'
import { ThemeProvider as NextThemesProvider } from "next-themes"
import { ThemeColorProvider } from './theme-color-provider'
import { ConfirmDialogProvider } from './confirm-dialog-provider'
import { PageLoadingOverlay } from './page-loading/page-loading-overlay'
import { NavigationLoadingGuard } from './page-loading/navigation-loading-guard'
import type { Locale } from '@/lib/i18n/shared'

interface ProvidersProps {
    children: React.ReactNode
    themeColor?: string | null
    initialLocale?: Locale
    currencyUnit?: string | null
}

/**
 * 注意：Providers 链上所有组件都只渲染 children（不额外包裹 DOM 元素），
 * 这是后台 flex 高度链路的一部分 —— 一旦某个 Provider 插入包裹层，
 * `[data-admin-root]` 的父层就会变成非 flex 容器，整页将无法滚动。
 * 新增 Provider 时请保持「仅返回 children」或在 globals.css 兜底规则中补上。
 */
export function Providers({ children, themeColor, initialLocale = 'en', currencyUnit }: ProvidersProps) {
    return (
        <NextThemesProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
        >
            <ThemeColorProvider color={themeColor || null}>
                <I18nProvider initialLocale={initialLocale} currencyUnit={currencyUnit}>
                    <ConfirmDialogProvider>
                        <NavigationLoadingGuard />
                        {children}
                        <PageLoadingOverlay />
                        <Toaster position="top-center" richColors />
                    </ConfirmDialogProvider>
                </I18nProvider>
            </ThemeColorProvider>
        </NextThemesProvider>
    )
}
