'use client'

import { useState, useEffect } from 'react'
import { Button } from "@/components/ui/button"
import { checkIn, getUserPoints, getCheckinStatus } from "@/actions/points"
import { toast } from "sonner"
import { Gift, Coins, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/context"

export function CheckInButton({
    enabled = true,
    showPoints = true,
    showCheckedInLabel = false,
    className,
    onPointsChange,
    onCheckedInChange,
}: {
    enabled?: boolean
    showPoints?: boolean
    showCheckedInLabel?: boolean
    className?: string
    onPointsChange?: (points: number) => void
    onCheckedInChange?: (checkedIn: boolean) => void
}) {
    const { t } = useI18n()
    const [points, setPoints] = useState(0)
    const [checkedIn, setCheckedIn] = useState(false)
    const [loading, setLoading] = useState(true)
    const [checkingIn, setCheckingIn] = useState(false)

    useEffect(() => {
        const init = async () => {
            try {
                const [p, s] = await Promise.all([getUserPoints(), getCheckinStatus()])
                setPoints(p)
                setCheckedIn(s.checkedIn)
                onPointsChange?.(p)
                onCheckedInChange?.(s.checkedIn)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        init()
    }, [])

    const handleCheckIn = async () => {
        setCheckingIn(true)
        try {
            const res = await checkIn()
            if (res.success) {
                toast.success(t('checkin.success', { points: res.points || 0 }))
                setPoints(prev => {
                    const next = prev + (res.points || 0)
                    onPointsChange?.(next)
                    return next
                })
                setCheckedIn(true)
                onCheckedInChange?.(true)
            } else {
                const errorKey = res.error || 'checkin.failed'
                if (errorKey === 'checkin.alreadyCheckedIn' || errorKey === 'Already checked in today') {
                    setCheckedIn(true)
                    onCheckedInChange?.(true)
                    toast.info(t('checkin.alreadyCheckedIn'))
                } else if (errorKey === 'checkin.inProgress') {
                    toast.info(t('checkin.inProgress'))
                } else {
                    toast.error(t(errorKey.startsWith('checkin.') ? errorKey : 'checkin.failed'))
                }
            }
        } catch (e) {
            toast.error(t('checkin.networkError'))
        } finally {
            setCheckingIn(false)
        }
    }

    if (loading) return null

    return (
        <div className={cn("flex items-center gap-1.5", className)}>
            {showPoints && (
                <div className="flex items-center gap-1.5 px-2.5 h-8 bg-background/80 border border-border/40 rounded-full text-xs font-semibold tabular-nums text-foreground shadow-2xs">
                    <Coins className="w-3.5 h-3.5 text-yellow-500" />
                    <span>{points}</span>
                </div>
            )}

            {enabled && !checkedIn && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5 rounded-full gap-1.5 text-xs font-medium bg-gradient-to-r from-amber-500/10 to-orange-500/10 hover:from-amber-500/20 hover:to-orange-500/20 border-amber-500/20 text-amber-600 dark:text-amber-400 shadow-2xs"
                    onClick={handleCheckIn}
                    disabled={checkingIn}
                >
                    <Gift className={cn("w-3.5 h-3.5", checkingIn && "animate-pulse")} />
                    <span>{t('checkin.button')}</span>
                </Button>
            )}

            {enabled && checkedIn && showCheckedInLabel && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2.5 text-xs text-muted-foreground/80 hover:text-muted-foreground cursor-default border border-border/30 bg-muted/30 rounded-full"
                    disabled
                >
                    <Check className="w-3.5 h-3.5 mr-1 text-emerald-500" />
                    <span>{t('checkin.checkedIn')}</span>
                </Button>
            )}
        </div>
    )
}
