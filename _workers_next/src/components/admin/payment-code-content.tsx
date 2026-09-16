'use client'

import { useMemo } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CopyButton } from "@/components/copy-button"
import { AdminPageShell } from "@/components/admin/admin-page-shell"

export function AdminPaymentCodeContent({ payLink, payee }: { payLink: string; payee?: string | null }) {
    const { t } = useI18n()

    const qrUrl = useMemo(() => {
        const encoded = encodeURIComponent(payLink)
        return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encoded}`
    }, [payLink])

    const displayLink = useMemo(() => {
        try {
            const url = new URL(payLink)
            return `${url.protocol}//${url.host}${url.pathname}`
        } catch {
            return payLink.split('?')[0]
        }
    }, [payLink])

    return (
        <AdminPageShell className="max-w-2xl space-y-6 p-0.5">
            <Card className="tech-card">
                <CardHeader className="space-y-2">
                    <CardTitle className="text-2xl">{t('payment.adminTitle')}</CardTitle>
                    <CardDescription>{t('payment.adminDescription')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex flex-col items-center gap-4">
                        {payee && (
                            <div className="w-full rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
                                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                    {t('payment.payeeLabel')}
                                </div>
                                <div className="mt-1 text-sm font-semibold">{payee}</div>
                            </div>
                        )}
                        <div className="rounded-2xl border border-border/50 bg-muted/30 p-4">
                            <img
                                src={qrUrl}
                                alt={t('payment.qrAlt')}
                                className="h-56 w-56"
                            />
                        </div>
                        <div className="w-full space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                {t('payment.linkLabel')}
                            </div>
                            <div className="flex items-start gap-2">
                                <a
                                    href={payLink}
                                    className="text-sm text-primary break-all underline-offset-4 hover:underline"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {displayLink}
                                </a>
                                <CopyButton text={displayLink} iconOnly />
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </AdminPageShell>
    )
}
