'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { type Locale } from './shared'
import { resolveCurrencyUnit } from '@/lib/currency-unit'
import { interpolateTranslation } from './interpolate'

type Translations = typeof en

const translations: Record<Locale, Translations> = { en, zh }

interface I18nContextType {
    locale: Locale
    setLocale: (locale: Locale) => void
    t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextType | null>(null)

function getNestedValue(obj: unknown, path: string): string | null {
    let value: unknown = obj
    for (const part of path.split('.')) {
        if (!value || typeof value !== 'object') return null
        value = (value as Record<string, unknown>)[part]
    }
    return typeof value === 'string' ? value : null
}

export function I18nProvider({
    children,
    initialLocale = 'en',
    currencyUnit = null,
}: {
    children: ReactNode
    initialLocale?: Locale
    currencyUnit?: string | null
}) {
    const [locale, setLocaleState] = useState<Locale>(initialLocale)

    useEffect(() => {
        localStorage.setItem('ldc-locale', locale)
        document.cookie = `ldc-locale=${locale}; path=/; max-age=31536000`
        document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    }, [locale])

    const setLocale = (newLocale: Locale) => {
        setLocaleState(newLocale)
        localStorage.setItem('ldc-locale', newLocale)
        document.cookie = `ldc-locale=${newLocale}; path=/; max-age=31536000`
    }

    const t = (key: string, params?: Record<string, string | number>): string => {
        const text = getNestedValue(translations[locale], key) ?? key
        return interpolateTranslation(text, { currencyUnit: resolveCurrencyUnit(locale, currencyUnit), ...params })
    }

    return (
        <I18nContext.Provider value={{ locale, setLocale, t }}>
            {children}
        </I18nContext.Provider>
    )
}

export function useI18n() {
    const context = useContext(I18nContext)
    if (!context) {
        // Return default values for server-side rendering
        return {
            locale: 'en' as Locale,
            setLocale: () => { },
            t: (key: string, params?: Record<string, string | number>) => {
                const text = getNestedValue(en, key) ?? key
                return interpolateTranslation(text, { currencyUnit: resolveCurrencyUnit('en', null), ...params })
            }
        }
    }
    return context
}
