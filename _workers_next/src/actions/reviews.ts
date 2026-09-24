'use server'

import { auth } from '@/lib/auth'
import { createReview, createReviewReply, ensureReviewsTable, reviewExistsForOrder } from '@/lib/db/queries'
import { db } from '@/lib/db'
import { orders, reviews } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath, updateTag } from 'next/cache'
import { enforceRateLimit } from '@/lib/rate-limit'
import { isUniqueConstraintError } from '@/lib/db/error-utils'
import { logServerError } from '@/lib/errors/safe-error'

export async function submitReview(
    productId: string,
    orderId: string,
    rating: number,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user) {
            return { success: false, error: 'review.authRequired' }
        }

        // Validate rating
        if (rating < 1 || rating > 5) {
            return { success: false, error: 'review.invalidRating' }
        }

        // 限流放在最前面（读订单之前）：
        // 被刷时先用 O(1) 的计数器把请求挡掉，不要让它消耗订单查询与后续写入。
        const rateLimit = await enforceRateLimit('review:submit', session.user.id)
        if (!rateLimit.allowed) {
            return { success: false, error: 'common.tooManyRequests' }
        }

        const order = await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: {
                userId: true,
                username: true,
                status: true,
                productId: true
            }
        })

        if (!order) {
            return { success: false, error: 'review.orderNotFound' }
        }

        if (order.productId !== productId) {
            return { success: false, error: 'review.invalidOrder' }
        }

        const sessionUsername = session.user.username || session.user.name || ''
        const isOwner =
            (order.userId && order.userId === session.user.id) ||
            (order.username && sessionUsername && order.username === sessionUsername)

        if (!isOwner) {
            return { success: false, error: 'review.notOwner' }
        }

        if (order.status !== 'delivered') {
            return { success: false, error: 'review.orderNotDelivered' }
        }

        // 收敛原本每次提交都裸跑的 CREATE TABLE：改为 isolate 级一次性的 ensure，
        // 同时尽力建立 reviews(order_id) 唯一索引（有历史重复行时留给升级项 0035）。
        await ensureReviewsTable()

        // 廉价预检：命中即返回业务错误，避免依赖异常分支。
        if (await reviewExistsForOrder(orderId)) {
            return { success: false, error: 'review.alreadyReviewed' }
        }

        try {
            await createReview({
                productId,
                orderId,
                userId: session.user.id || '',
                username: session.user.username || session.user.name || 'Anonymous',
                rating,
                comment: comment || undefined
            })
        } catch (error: unknown) {
            // 预检与插入之间有竞态：并发重复提交会撞上 reviews_order_id_uq。
            // 这是预期内的结果（等价于 alreadyReviewed），不是异常。
            if (isUniqueConstraintError(error)) {
                return { success: false, error: 'review.alreadyReviewed' }
            }
            throw error
        }

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/order/${orderId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        const errorId = logServerError('review:submit', error)
        console.error('Failed to submit review:', errorId)
        return { success: false, error: 'review.submitError' }
    }
}

export async function submitReviewReply(
    reviewId: number,
    productId: string,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user) {
            return { success: false, error: 'review.authRequired' }
        }

        const normalizedComment = comment.trim()
        if (!normalizedComment) {
            return { success: false, error: 'review.replyEmpty' }
        }
        if (normalizedComment.length > 1000) {
            return { success: false, error: 'review.replyTooLong' }
        }

        // 回复同样是写入口，复用评价限流桶（同一主体、同一窗口）。
        const rateLimit = await enforceRateLimit('review:submit', session.user.id)
        if (!rateLimit.allowed) {
            return { success: false, error: 'common.tooManyRequests' }
        }

        // review_replies 的建表由 createReviewReply → ensureReviewRepliesTable() 统一负责，
        // 这里不再裸跑 CREATE TABLE。
        const review = await db.query.reviews.findFirst({
            where: eq(reviews.id, reviewId),
            columns: {
                id: true,
                productId: true,
            }
        })

        if (!review || review.productId !== productId) {
            return { success: false, error: 'review.replyInvalidReview' }
        }

        await createReviewReply({
            reviewId,
            userId: session.user.id || '',
            username: session.user.username || session.user.name || 'Anonymous',
            comment: normalizedComment,
        })

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        const errorId = logServerError('review:reply', error)
        console.error('Failed to submit review reply:', errorId)
        return { success: false, error: 'review.replySubmitError' }
    }
}
