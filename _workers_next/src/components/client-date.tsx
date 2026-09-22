'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n/context'

type DateValue = Date | string | number | null | undefined
type DateFormat = 'date' | 'dateTime'

interface ClientDateProps {
    value?: DateValue
    format?: DateFormat
    placeholder?: string
    className?: string
}

export function ClientDate({ value, format = 'dateTime', placeholder = '', className }: ClientDateProps) {
    const { locale } = useI18n()
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        const timeoutId = window.setTimeout(() => setMounted(true), 0)
        return () => window.clearTimeout(timeoutId)
    }, [])

    const renderValue = () => {
        if (!mounted || !value) return placeholder
        const date = value instanceof Date ? value : new Date(value)
        if (Number.isNaN(date.getTime())) return placeholder

        const intlLocale = locale === 'zh' ? 'zh-CN' : 'en-US'
        const options: Intl.DateTimeFormatOptions = format === 'dateTime'
            ? { dateStyle: 'medium', timeStyle: 'medium' }
            : { dateStyle: 'medium' }

        return new Intl.DateTimeFormat(intlLocale, options).format(date)
    }

    return (
        <time className={className}>
            {renderValue()}
        </time>
    )
}
