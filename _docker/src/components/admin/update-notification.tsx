'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n/context'
import { checkForUpdatesClient, type ClientUpdateCheckResult } from '@/lib/update-check-client'
import { SOURCE_REPO_URL } from '@/lib/version'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'

export function UpdateNotification({ currentVersion }: { currentVersion: string }) {
    const { t } = useI18n()
    const [updateInfo, setUpdateInfo] = useState<ClientUpdateCheckResult | null>(null)
    const [dismissed, setDismissed] = useState(false)

    useEffect(() => {
        // Check if user has dismissed this version's notification
        const dismissedVersion = localStorage.getItem('dismissed_update_version')

        checkForUpdatesClient(currentVersion).then((result) => {
            if (result.hasUpdate && result.latestVersion !== dismissedVersion) {
                setUpdateInfo(result)
            }
        }).catch(console.error)
    }, [currentVersion])

    if (!updateInfo || !updateInfo.hasUpdate || dismissed) {
        return null
    }

    const handleDismiss = () => {
        if (updateInfo.latestVersion) {
            localStorage.setItem('dismissed_update_version', updateInfo.latestVersion)
        }
        setDismissed(true)
    }

    return (
        <div className="bg-red-500 text-white px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                <div className="text-sm">
                    <span className="font-medium">{t('update.available')}</span>
                    <span className="ml-2 opacity-90">
                        {t('update.versionInfo', {
                            current: updateInfo.currentVersion,
                            latest: updateInfo.latestVersion || 'unknown'
                        })}
                    </span>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <a
                    href={updateInfo.releaseUrl || SOURCE_REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm underline underline-offset-2 hover:no-underline flex items-center gap-1"
                >
                    {t('update.syncNow')}
                    <ExternalLink className="h-3 w-3" />
                </a>
                <button
                    onClick={handleDismiss}
                    className="p-1 hover:bg-white/20 rounded"
                    aria-label="Dismiss"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    )
}
