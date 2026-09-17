'use client'

import { useState } from 'react'
import { useI18n } from '@/lib/i18n/context'
import { StarRating } from '@/components/star-rating'
import { Card, CardContent } from '@/components/ui/card'
import { ClientDate } from '@/components/client-date'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { submitReviewReply } from '@/actions/reviews'
import { toast } from 'sonner'
import { CornerUpLeft } from 'lucide-react'

interface Review {
    id: number
    nickname: string
    rating: number
    comment: string | null
    createdAt: Date | string | null
    replies?: Array<{
        id: number
        nickname: string
        comment: string
        createdAt: Date | string | null
    }>
}

interface ReviewListProps {
    reviews: Review[]
    averageRating: number
    totalCount: number
    productId: string
    isLoggedIn?: boolean
    onReplySubmitted?: () => void
}

export function ReviewList({ reviews, averageRating, totalCount, productId, isLoggedIn = false, onReplySubmitted }: ReviewListProps) {
    const { t } = useI18n()
    const [openReplyId, setOpenReplyId] = useState<number | null>(null)
    const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({})
    const [submittingReplyId, setSubmittingReplyId] = useState<number | null>(null)

    const handleReply = async (reviewId: number) => {
        const comment = (replyDrafts[reviewId] || '').trim()
        if (!comment) {
            toast.error(t('review.replyEmpty'))
            return
        }

        setSubmittingReplyId(reviewId)
        try {
            const result = await submitReviewReply(reviewId, productId, comment)
            if (!result.success) {
                toast.error(result.error ? t(result.error) : t('review.replySubmitError'))
                return
            }
            setReplyDrafts((prev) => ({ ...prev, [reviewId]: '' }))
            setOpenReplyId(null)
            toast.success(t('review.replySubmitted'))
            onReplySubmitted?.()
        } finally {
            setSubmittingReplyId(null)
        }
    }

    if (totalCount === 0) {
        return (
            <div className="text-center py-8 text-muted-foreground">
                <p>{t('review.noReviews')}</p>
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {/* Summary */}
            <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-lg">
                <div className="text-3xl font-bold gradient-text">
                    {averageRating.toFixed(1)}
                </div>
                <div className="space-y-1">
                    <StarRating rating={Math.round(averageRating)} size="md" />
                    <p className="text-sm text-muted-foreground">
                        {totalCount} {t('review.title').toLowerCase()}
                    </p>
                </div>
            </div>

            {/* Review List */}
            <div className="space-y-3">
                {reviews.map((review) => (
                    <Card key={review.id} className="bg-card/50">
                        <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium text-sm">
                                            {review.nickname || t('profile.anonymous')}
                                        </span>
                                        <StarRating rating={review.rating} size="sm" />
                                    </div>
                                    {review.comment && (
                                        <p className="text-sm text-muted-foreground">{review.comment}</p>
                                    )}
                                    {review.replies && review.replies.length > 0 && (
                                        <div className="space-y-2 pt-2">
                                            {review.replies.map((reply) => (
                                                <div key={reply.id} className="rounded-xl border border-border/25 bg-muted/20 px-3 py-3">
                                                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                                                        <span className="font-medium text-foreground">
                                                            {reply.nickname || t('profile.anonymous')}
                                                        </span>
                                                        <ClientDate value={reply.createdAt} />
                                                    </div>
                                                    <p className="text-sm text-muted-foreground">{reply.comment}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {isLoggedIn && openReplyId === review.id && (
                                        <div className="mt-3 space-y-2 rounded-xl border border-border/25 bg-background/60 p-3">
                                            <Textarea
                                                value={replyDrafts[review.id] || ''}
                                                onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [review.id]: e.target.value }))}
                                                placeholder={t('review.replyPlaceholder')}
                                                rows={3}
                                                className="resize-none"
                                            />
                                            <div className="flex justify-end">
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    disabled={submittingReplyId === review.id}
                                                    onClick={() => handleReply(review.id)}
                                                >
                                                    {submittingReplyId === review.id ? t('common.processing') : t('review.replySubmit')}
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-2">
                                    <ClientDate
                                        value={review.createdAt}
                                        className="text-xs text-muted-foreground"
                                    />
                                    {isLoggedIn ? (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 rounded-full border border-border/35 bg-background/75 px-3 text-xs font-medium text-muted-foreground shadow-sm hover:bg-background hover:text-foreground"
                                            onClick={() => setOpenReplyId((prev) => prev === review.id ? null : review.id)}
                                        >
                                            <CornerUpLeft className="h-3.5 w-3.5" />
                                            {openReplyId === review.id ? t('common.cancel') : t('review.reply')}
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    )
}
