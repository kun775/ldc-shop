'use client'

import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n/context'

interface StarRatingProps {
    rating: number
    maxRating?: number
    size?: 'xs' | 'sm' | 'md' | 'lg'
    interactive?: boolean
    onChange?: (rating: number) => void
}

export function StarRating({
    rating,
    maxRating = 5,
    size = 'md',
    interactive = false,
    onChange
}: StarRatingProps) {
    const { t } = useI18n()

    const sizeClasses = {
        xs: 'w-3 h-3',
        sm: 'w-3.5 h-3.5',
        md: 'w-4 h-4',
        lg: 'w-5 h-5'
    }

    const handleClick = (index: number) => {
        if (interactive && onChange) {
            onChange(index + 1)
        }
    }

    // 只放图标的星按钮此前完全没有 accessible name：
    // 读屏用户只会听到 5 个「按钮」，无法知道点第几个会打几分。
    // 非交互（纯展示）时整组用 role="img" + 数值标签，避免逐星朗读噪音。
    if (!interactive) {
        return (
            <div
                className="flex items-center gap-0.5"
                role="img"
                aria-label={`${rating}/${maxRating}`}
            >
                {Array.from({ length: maxRating }, (_, i) => (
                    <Star
                        key={i}
                        aria-hidden="true"
                        className={cn(
                            sizeClasses[size],
                            i < rating
                                ? "fill-yellow-400 text-yellow-400"
                                : "fill-muted text-muted-foreground/30"
                        )}
                    />
                ))}
            </div>
        )
    }

    return (
        <div className="flex items-center gap-0.5" role="group" aria-label={t('common.ratingLabel')}>
            {Array.from({ length: maxRating }, (_, i) => (
                <button
                    key={i}
                    type="button"
                    onClick={() => handleClick(i)}
                    aria-label={t('common.starLabel', { count: i + 1 })}
                    aria-pressed={i + 1 === rating}
                    className={cn(
                        "transition-colors cursor-pointer hover:scale-110"
                    )}
                >
                    <Star
                        aria-hidden="true"
                        className={cn(
                            sizeClasses[size],
                            i < rating
                                ? "fill-yellow-400 text-yellow-400"
                                : "fill-muted text-muted-foreground/30"
                        )}
                    />
                </button>
            ))}
        </div>
    )
}
