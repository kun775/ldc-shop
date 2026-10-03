import { cookies, headers } from "next/headers"
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { detectLocaleFromAcceptLanguage, isLocale, type Locale } from "./shared"
import { getSetting } from "@/lib/db/queries"
import { resolveCurrencyUnit } from "@/lib/currency-unit"
import { interpolateTranslation } from "./interpolate"

type Translations = typeof en

const translations: Record<Locale, Translations> = { en, zh }

function getNestedValue(obj: any, path: string): string | null {
  const value = path.split('.').reduce((acc, part) => acc?.[part], obj)
  return typeof value === 'string' ? value : null
}

export async function detectServerLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get('ldc-locale')?.value
  if (isLocale(cookieLocale)) return cookieLocale

  const headerList = await headers()
  return detectLocaleFromAcceptLanguage(headerList.get('accept-language'))
}

export async function getServerI18n() {
  const [locale, currencyUnit] = await Promise.all([
    detectServerLocale(),
    getSetting('currency_unit').catch(() => null),
  ])
  const t = (key: string, params?: Record<string, string | number>): string => {
    const text = getNestedValue(translations[locale], key) ?? key
    return interpolateTranslation(text, { currencyUnit: resolveCurrencyUnit(locale, currencyUnit), ...params })
  }
  return { locale, t }
}
