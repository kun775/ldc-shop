'use client'

import { I18nProvider } from '@/lib/i18n/context'
import { Toaster } from 'sonner'
import { ThemeProvider as NextThemesProvider } from "next-themes"
import { ThemeColorProvider } from './theme-color-provider'
import { ConfirmDialogProvider } from './confirm-dialog-provider'
import type { Locale } from '@/lib/i18n/shared'

interface ProvidersProps {
    children: React.ReactNode
    themeColor?: string | null
    initialLocale?: Locale
    currencyUnit?: string | null
}

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
                        {children}
                        <Toaster position="top-center" richColors />
                    </ConfirmDialogProvider>
                </I18nProvider>
            </ThemeColorProvider>
        </NextThemesProvider>
    )
}
