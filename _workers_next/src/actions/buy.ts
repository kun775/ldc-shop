'use server'

import { auth } from "@/lib/auth"
import { canUserReview, getProductRating, getProductReviews } from "@/lib/db/queries"
import { getEmailSettings } from "@/lib/email"

interface BuyMetaReview {
    id: number
    nickname: string
    rating: number
    comment: string | null
    createdAt: string | null
    replies: Array<{
        id: number
        nickname: string
        comment: string
        createdAt: string | null
    }>
}

interface BuyPageMeta {
    reviews: BuyMetaReview[]
    averageRating: number
    reviewCount: number
    canReview: boolean
    reviewOrderId?: string
    emailConfigured: boolean
}

const EMPTY_BUY_META: BuyPageMeta = {
    reviews: [],
    averageRating: 0,
    reviewCount: 0,
    canReview: false,
    reviewOrderId: undefined,
    emailConfigured: false,
}

function toIsoString(value: Date | string | null): string | null {
    if (!value) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function mapReviews(rawReviews: Awaited<ReturnType<typeof getProductReviews>>): BuyMetaReview[] {
    return rawReviews.map((review) => ({
        id: Number(review.id),
        nickname: review.nickname || "",
        rating: Number(review.rating || 0),
        comment: review.comment || null,
        createdAt: toIsoString(review.createdAt),
        replies: review.replies.map((reply) => ({
            id: Number(reply.id),
            nickname: reply.nickname || "",
            comment: reply.comment || "",
            createdAt: toIsoString(reply.createdAt),
        })),
    }))
}

export async function getMoreProductReviews(
    productId: string,
    cursor: { createdAt: string | null; id: number },
): Promise<BuyMetaReview[]> {
    const id = productId.trim()
    const cursorDate = cursor.createdAt ? new Date(cursor.createdAt) : null
    const cursorId = Math.trunc(cursor.id)
    if (!id || !Number.isFinite(cursorId) || (cursorDate && Number.isNaN(cursorDate.getTime()))) return []

    const rawReviews = await getProductReviews(id, 20, {
        createdAtMs: cursorDate?.getTime() ?? 0,
        id: cursorId,
    })
    return mapReviews(rawReviews)
}

export async function getBuyPageMeta(productId: string): Promise<BuyPageMeta> {
    const id = productId.trim()
    if (!id) return { ...EMPTY_BUY_META }

    const session = await auth()

    const [rawReviews, ratingSummary, emailSettings] = await Promise.all([
        getProductReviews(id, 20).catch(() => [] as Awaited<ReturnType<typeof getProductReviews>>),
        getProductRating(id).catch(() => ({ average: 0, count: 0 })),
        getEmailSettings().catch(() => ({ apiKey: null, fromEmail: null, enabled: false, fromName: null })),
    ])

    const reviews = mapReviews(rawReviews)

    let canReview = false
    let reviewOrderId: string | undefined = undefined

    if (session?.user?.id) {
        try {
            const eligibility = await canUserReview(session.user.id, id, session.user.username || undefined)
            canReview = eligibility.canReview
            reviewOrderId = eligibility.orderId
        } catch {
            canReview = false
            reviewOrderId = undefined
        }
    }

    const reviewCount = Number(ratingSummary.count || 0)
    const averageRating = Number(ratingSummary.average || 0)

    return {
        reviews,
        averageRating,
        reviewCount,
        canReview,
        reviewOrderId,
        emailConfigured: !!(emailSettings?.enabled && emailSettings?.apiKey && emailSettings?.fromEmail),
    }
}
