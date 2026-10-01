'use server'

import { db } from "@/lib/db"
import { cards, orders, refundRequests } from "@/lib/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { revalidatePath, updateTag } from "next/cache"
import { checkAdmin } from "@/actions/admin"
import { createUserNotification, ensureDatabaseInitialized, getLoginUserEmail, recalcProductAggregates, recalcProductAggregatesForMany } from "@/lib/db/queries"
import { pullOneCardFromApi } from "@/lib/card-api"
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord } from "@/lib/points/ledger-db"
import { DELIVERY_FILE_LIMITS, deleteDeliveryFileIds, deleteDeliveryFiles, listDeliveryFiles, saveDeliveryFiles } from "@/lib/delivery-files"
import { isManualFulfillment } from "@/lib/fulfillment"
import { isValidEmail, sendManualDeliveryEmail } from "@/lib/email"
import { consumeCouponReservations, releaseCouponUsages } from "@/lib/coupons/reservation"
import {
    logServerError,
    resolveClientActionErrorKey,
    resolveClientErrorKey,
    sanitizeClientErrorMessage,
} from "@/lib/errors/safe-error"
import { ORDER_ERROR_KEY_MAP } from "@/lib/orders/order-errors"
import { auth } from "@/lib/auth"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"
import { createD1CardServiceDatabase } from "@/lib/license-service/database"
import { orderHasUnsettledCardServiceLedger } from "@/lib/license-service/guards"

/**
 * 订单写操作的统一返回协议。
 *
 * 为什么不继续 throw：
 *   Server Action 的返回值不会被 Next.js 脱敏，只有 throw 才会。反过来说，
 *   throw 出去的错误在客户端只能拿到被 Next.js 替换过的通用消息（或 digest），
 *   业务错误与系统错误无法区分。因此这里统一改为「显式 return」，
 *   由服务端完成脱敏并附带可对账的 errorId。
 */
export type OrderActionResult =
    | { ok: true; skippedRemoteMapped?: number; deletedCount?: number; skippedOrderIds?: string[] }
    | { ok: false; errorKey: string; errorId: string }

function failure(scope: string, error: unknown): OrderActionResult {
    const errorId = logServerError(scope, error)
    const errorKey = resolveClientErrorKey(error, ORDER_ERROR_KEY_MAP, 'common.error')
    return { ok: false, errorKey, errorId }
}

/** 兼容「按 name 匹配 i18n key」的服务端错误：name 优先于 message */
function resolveOrderErrorKey(error: unknown): string {
    const name = String((error as { name?: unknown })?.name ?? '').trim()
    if (name && /^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(name)) {
        return name
    }
    return resolveClientActionErrorKey(error)
}

export async function markOrderPaid(orderId: string): Promise<OrderActionResult> {
    try {
        await checkAdmin()
        if (!orderId) throw new Error("Missing order id")

        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
        await db.update(orders).set({
            status: 'paid',
            paidAt: new Date(),
        }).where(eq(orders.orderId, orderId))

        // 管理员手工标记已支付同样要核销优惠券预占，避免次数泄漏
        try {
            await consumeCouponReservations(orderId)
        } catch (error) {
            console.error('[Coupon] Consume on admin mark paid failed:', error)
        }

        revalidatePath('/admin/orders')
        revalidatePath(`/admin/orders/${orderId}`)
        revalidatePath(`/order/${orderId}`)
        if (order?.productId) {
            try {
                await recalcProductAggregates(order.productId)
            } catch {
                // best effort
            }
        }
        try {
            updateTag('home:products')
        } catch {
            // best effort
        }
        return { ok: true }
    } catch (error) {
        return failure('admin.markOrderPaid', error)
    }
}

export async function markOrderDelivered(orderId: string, formData?: FormData): Promise<OrderActionResult> {
    let savedFileIds: number[] = []
    let actorUserId: string | null = null
    let actorUsername: string | null = null
    let auditFulfillmentMode: string | null = null
    try {
        await checkAdmin()
        const session = await auth()
        actorUserId = session?.user?.id ?? null
        actorUsername = session?.user?.username ?? null
        await ensureDatabaseInitialized()
        if (!orderId) throw new Error("admin.orders.orderMissing")

        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
        if (!order) throw new Error("admin.orders.orderMissing")
        const manual = isManualFulfillment(order.fulfillmentMode)
        auditFulfillmentMode = order.fulfillmentMode ?? null

        // 幂等/状态保护：只有已支付且未发货的订单允许发货。
        // 并发或重复提交时，后到的请求命中这里并直接返回失败，
        // 不会产生第二次通知、第二封邮件或重复附件。
        if (order.status !== 'paid') {
            throw new Error("admin.orders.deliveryStatusInvalid")
        }

        const deliveryNote = String(formData?.get('deliveryNote') || '').trim()
        const files = formData ? formData.getAll('deliveryFiles').filter((item): item is File => item instanceof File && item.size > 0) : []
        if (manual) {
            if (deliveryNote.length > DELIVERY_FILE_LIMITS.maxNoteLength) {
                throw new Error("admin.orders.deliveryNoteTooLong")
            }
            if (!deliveryNote && files.length === 0) {
                throw new Error("admin.orders.deliveryContentRequired")
            }
        } else if (!order.cardKey) {
            throw new Error("admin.orders.deliveryCardKeyMissing")
        }

        if (files.length) {
            const saved = await saveDeliveryFiles(orderId, files)
            savedFileIds = saved.map((file) => file.id)
        }

        const updated = await db.update(orders).set({
            status: 'delivered',
            deliveredAt: new Date(),
            ...(manual ? { deliveryNote: deliveryNote || order.deliveryNote || null } : {}),
        })
            .where(and(eq(orders.orderId, orderId), eq(orders.status, 'paid')))
            .returning({ orderId: orders.orderId })

        if (!updated.length) {
            // 状态在本次请求过程中被其它请求改写（并发发货/取消）：回滚本次上传的附件
            await deleteDeliveryFileIds(orderId, savedFileIds)
            savedFileIds = []
            throw new Error("admin.orders.deliveryStatusInvalid")
        }

        if (order.userId) {
            await createUserNotification({
                userId: order.userId,
                type: 'order_delivered',
                titleKey: 'profile.notifications.orderDeliveredTitle',
                contentKey: 'profile.notifications.orderDeliveredBody',
                data: {
                    params: {
                        orderId: order.orderId,
                        productName: order.productName || 'Product'
                    },
                    href: `/order/${order.orderId}`
                }
            })
        }

        if (manual) {
            const finalNote = deliveryNote || order.deliveryNote || null
            try {
                let recipientEmail = (order.email || '').trim()
                let profileEmail = ''
                if (order.userId) {
                    try {
                        profileEmail = ((await getLoginUserEmail(order.userId)) || '').trim()
                    } catch {
                        // best effort
                    }
                }

                if (profileEmail && isValidEmail(profileEmail)) {
                    if (!recipientEmail || recipientEmail.toLowerCase().endsWith('@privaterelay.linux.do')) {
                        recipientEmail = profileEmail
                    }
                } else if (!recipientEmail && profileEmail) {
                    recipientEmail = profileEmail
                }
                if (recipientEmail && isValidEmail(recipientEmail)) {
                    const hasAttachments = savedFileIds.length > 0 || (await listDeliveryFiles(orderId)).length > 0
                    const emailResult = await sendManualDeliveryEmail({
                        to: recipientEmail,
                        orderId: order.orderId,
                        productName: order.productName || 'Product',
                        deliveryNote: finalNote,
                        hasAttachments,
                    })
                    console.log('[Email] sendManualDeliveryEmail result:', emailResult)
                } else {
                    console.log('[Email] Skipped sending manual delivery email: no valid email found for order', orderId)
                }
            } catch (err) {
                console.error('[Email] Manual delivery email failed:', err)
            }
        }

        if (order.productId && order.cardIds) {
            try {
                const result = await pullOneCardFromApi(order.productId)
                if (result.ok) {
                    console.log(`[Card API] Auto replenished for product ${order.productId}, reason=admin_mark_delivered:${orderId}`)
                } else if (result.skipped) {
                    console.info(`[Card API] Auto replenish skipped for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${result.error || "skipped"}`)
                } else {
                    console.warn(`[Card API] Auto replenish failed for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${result.error || "unknown_error"}`)
                }
            } catch (error: any) {
                console.warn(`[Card API] Auto replenish exception for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${error?.message || "unknown_error"}`)
            }
        }

        revalidatePath('/admin/orders')
        revalidatePath(`/admin/orders/${orderId}`)
        revalidatePath(`/order/${orderId}`)
        if (order?.productId) {
            try {
                await recalcProductAggregates(order.productId)
            } catch {
                // best effort
            }
        }
        try {
            updateTag('home:products')
        } catch {
            // best effort
        }
        await recordAuditEvent({
            eventName: 'admin.order.fulfillment',
            actorType: 'admin',
            actorUserId,
            actorUsername,
            targetId: orderId,
            source: 'admin.orders',
            metadata: {
                orderId,
                productId: order.productId,
                fulfillmentMode: order.fulfillmentMode,
                deliveryFileCount: savedFileIds.length,
                status: 'delivered',
            },
        })
        return { ok: true }
    } catch (error) {
        // 订单写入失败时回滚本次上传的附件，避免留下孤儿文件
        if (savedFileIds.length) {
            await deleteDeliveryFileIds(orderId, savedFileIds)
        }
        const errorKey = resolveOrderErrorKey(error)
        const errorId = await recordServerError('admin.markOrderDelivered', error, {
            actorType: 'admin',
            actorUserId,
            actorUsername,
            auditEvent: {
                eventName: 'admin.order.fulfillment',
                actorType: 'admin',
                actorUserId,
                actorUsername,
                targetId: orderId || null,
                errorKey,
                source: 'admin.orders',
                metadata: {
                    orderId,
                    fulfillmentMode: auditFulfillmentMode,
                    deliveryFileCount: savedFileIds.length,
                },
            },
        })
        return { ok: false, errorKey, errorId }
    }
}

export async function cancelOrder(orderId: string): Promise<OrderActionResult> {
  try {
    await checkAdmin()
    if (!orderId) throw new Error("admin.orders.orderMissing")

    // No transaction - D1 doesn't support SQL transactions
    // 1. Refund points if used
    const order = await db.query.orders.findFirst({
      where: eq(orders.orderId, orderId),
      columns: { userId: true, pointsUsed: true, productId: true, status: true }
    })
    if (!order) throw new Error("admin.orders.orderMissing")
    if (order.status === 'processing') throw new Error("admin.orders.cancelProcessing")

    const cancelled = await db.update(orders)
      .set({ status: 'cancelled', fulfillmentClaimId: null, fulfillmentClaimedAt: null })
      .where(and(
        eq(orders.orderId, orderId),
        sql`${orders.status} NOT IN ('paid', 'delivered', 'processing', 'refunded')`
      ))
      .returning({ orderId: orders.orderId })
    if (!cancelled.length) throw new Error("admin.orders.cancelNotAllowed")

    if (order.userId && order.pointsUsed && order.pointsUsed > 0) {
      await ensurePointLedgerUserRecord({
        userId: order.userId,
      })
      await applyUserAutomaticPointEvent({
        userId: order.userId,
        eventType: "refund_return",
        delta: order.pointsUsed,
        businessKey: `refund_return:${orderId}`,
        sourceType: "order",
        sourceId: orderId,
        reason: `订单 ${orderId} 取消返还积分`,
        metadata: JSON.stringify({
          action: "cancel",
        }),
      })
    }

    try {
      await db.run(sql.raw(`ALTER TABLE cards ADD COLUMN reserved_order_id TEXT`));
    } catch { /* duplicate column */ }
    try {
      await db.run(sql.raw(`ALTER TABLE cards ADD COLUMN reserved_at INTEGER`));
    } catch { /* duplicate column */ }
    await db.update(cards).set({ reservedOrderId: null, reservedAt: null })
      .where(sql`${cards.reservedOrderId} = ${orderId} AND ${cards.isUsed} = false`)

    // 释放优惠券预占次数（幂等）
    try {
      await releaseCouponUsages(orderId, 'admin_cancel')
    } catch (error) {
      console.error('[Coupon] Release on cancel failed:', error)
    }

    revalidatePath('/admin/orders')
    revalidatePath('/admin/users')
    if (order?.userId) {
      revalidatePath(`/admin/users/${order.userId}`)
    }
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath(`/order/${orderId}`)
    if (order?.productId) {
      try {
        await recalcProductAggregates(order.productId)
      } catch {
        // best effort
      }
    }
    try {
      updateTag('home:products')
    } catch {
      // best effort
    }
    return { ok: true }
  } catch (error) {
    return failure('admin.cancelOrder', error)
  }
}

export async function updateOrderEmail(orderId: string, email: string | null): Promise<OrderActionResult> {
  try {
    await checkAdmin()
    if (!orderId) throw new Error("admin.orders.orderMissing")
    const next = (email || '').trim()
    await db.update(orders).set({ email: next || null }).where(eq(orders.orderId, orderId))
    revalidatePath('/admin/orders')
    revalidatePath(`/admin/orders/${orderId}`)
    return { ok: true }
  } catch (error) {
    return failure('admin.updateOrderEmail', error)
  }
}

async function deleteOneOrder(orderId: string): Promise<{ deleted: boolean; blockedByRemoteMapping: boolean }> {
  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
  if (!order) return { deleted: false, blockedByRemoteMapping: false }

  // 守卫必须在**任何副作用之前**：订单行一旦删掉，就再也说不清这笔映射属于哪笔
  // 业务，退款与对账都只能靠人工比对；而中心在 Ack 之后没有归还可售的接口。
  // 所以这里直接拦下，让管理员先把远端卡处理掉（作废或继续履约）。
  //
  // 判定覆盖两路（见 `orderHasUnsettledCardServiceLedger`）：已确认的远端映射，
  // 以及尚未确认的 Sell / Revoke 待办 —— 只查前者会漏掉「中心可能已经卖掉了、
  // 本地还没确认」这段窗口。
  try {
    if (await orderHasUnsettledCardServiceLedger(createD1CardServiceDatabase(), orderId)) {
      console.warn(`[LicenseService] deleteOneOrder skipped ${orderId}: still holds unsettled card-service ledger entries`)
      return { deleted: false, blockedByRemoteMapping: true }
    }
  } catch (error) {
    // 判定失败时宁可少删：不能因为查不到就当成「没有映射」。
    console.error(`[LicenseService] deleteOneOrder guard failed for ${orderId}:`, error)
    return { deleted: false, blockedByRemoteMapping: true }
  }

  if (order.status === 'processing') return { deleted: false, blockedByRemoteMapping: true }

  // 已退款订单已通过退款积分账本结算，不以删除事件再次返还。
  if (order.status !== 'refunded' && order.userId && order.pointsUsed && order.pointsUsed > 0) {
    await ensurePointLedgerUserRecord({
      userId: order.userId,
      username: order.username ?? null,
      email: order.email ?? null,
    })
    await applyUserAutomaticPointEvent({
      userId: order.userId,
      username: order.username ?? null,
      email: order.email ?? null,
      eventType: "refund_return",
      delta: order.pointsUsed,
      businessKey: `refund_return:${orderId}`,
      sourceType: "order",
      sourceId: orderId,
      reason: `订单 ${orderId} 删除返还积分`,
      metadata: JSON.stringify({
        action: "delete",
      }),
    })
  }

  // Release reserved card if any
  try {
    await db.run(sql.raw(`ALTER TABLE cards ADD COLUMN reserved_order_id TEXT`));
  } catch { /* duplicate column */ }
  try {
    await db.run(sql.raw(`ALTER TABLE cards ADD COLUMN reserved_at INTEGER`));
  } catch { /* duplicate column */ }

  await db.update(cards).set({ reservedOrderId: null, reservedAt: null })
    .where(sql`${cards.reservedOrderId} = ${orderId} AND ${cards.isUsed} = false`)

  // 删除订单前释放仍处于预占的优惠券次数
  try {
    await releaseCouponUsages(orderId, 'order_deleted')
  } catch (error) {
    console.error('[Coupon] Release before delete failed:', error)
  }

  // Delete related refund requests (best effort)
  try {
    await db.delete(refundRequests).where(eq(refundRequests.orderId, orderId))
  } catch {
    // table may not exist yet
  }

  await deleteDeliveryFiles(orderId)
  const deleted = await db.delete(orders).where(eq(orders.orderId, orderId)).returning({ orderId: orders.orderId })
  return { deleted: deleted.length > 0, blockedByRemoteMapping: false }
}

export async function deleteOrder(orderId: string): Promise<OrderActionResult> {
  try {
    await checkAdmin()
    if (!orderId) throw new Error("admin.orders.orderMissing")

    const order = await db.query.orders.findFirst({
      where: eq(orders.orderId, orderId),
      columns: { productId: true, userId: true }
    })
    const result = await deleteOneOrder(orderId)
    if (result.blockedByRemoteMapping) return { ok: false, errorKey: 'admin.orders.deleteBlocked', errorId: '' }
    if (!result.deleted) return { ok: false, errorKey: 'admin.orders.orderMissing', errorId: '' }

    revalidatePath('/admin/orders')
    revalidatePath('/admin/users')
    if (order?.userId) {
      revalidatePath(`/admin/users/${order.userId}`)
    }
    revalidatePath(`/admin/orders/${orderId}`)
    if (order?.productId) {
      try {
        await recalcProductAggregates(order.productId)
      } catch {
        // best effort
      }
    }
    try {
      updateTag('home:products')
    } catch {
      // best effort
    }
    return { ok: true }
  } catch (error) {
    return failure('admin.deleteOrder', error)
  }
}

export async function deleteOrders(orderIds: string[]): Promise<OrderActionResult> {
  try {
    await checkAdmin()
    const ids = [...new Set((orderIds || []).map((s) => String(s).trim()).filter(Boolean))]
    if (!ids.length) return { ok: true, deletedCount: 0, skippedOrderIds: [] }

    const touchedProducts: string[] = []
    let skippedRemoteMapped = 0
    let deletedCount = 0
    const skippedOrderIds: string[] = []

    for (const id of ids) {
      const order = await db.query.orders.findFirst({ where: eq(orders.orderId, id), columns: { productId: true } })
      if (order?.productId) touchedProducts.push(order.productId)
      // 仍持有远端映射的订单不删：跳过而不是抛错，否则一单被拦会带崩整批删除。
      const result = await deleteOneOrder(id)
      if (result.deleted) deletedCount += 1
      else skippedOrderIds.push(id)
      if (result.blockedByRemoteMapping) skippedRemoteMapped += 1
    }

    revalidatePath('/admin/orders')
    revalidatePath('/admin/users')
    try {
      await recalcProductAggregatesForMany(touchedProducts)
    } catch {
      // best effort
    }
    try {
      updateTag('home:products')
    } catch {
      // best effort
    }
    return { ok: true, deletedCount, skippedRemoteMapped, skippedOrderIds }
  } catch (error) {
    return failure('admin.deleteOrders', error)
  }
}

import { queryOrderStatus } from "@/lib/epay"

export async function verifyOrderRefundStatus(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  try {
    const result = await queryOrderStatus(orderId)

    if (result.success) {
      // status 0 = Refunded
      if (result.status === 0) {
        const { markOrderRefunded } = await import("@/actions/refund")
        await markOrderRefunded(orderId)
        return { success: true, status: result.status, msg: 'Refunded (Verified)' }
      } else if (result.status === 1) {
        return { success: true, status: result.status, msg: 'Paid (Not Refunded)' }
      } else {
        return { success: true, status: result.status, msg: `Status: ${result.status}` }
      }
    } else {
      // 该返回值直接进管理端界面：上游 `data.msg` 属于业务语义可以透传，
      // 但网络/驱动层异常原文必须脱敏。
      return { success: false, error: sanitizeClientErrorMessage(result.error, 'common.error') }
    }

  } catch (e: any) {
    console.error('Verify refund error', e)
    return { success: false, error: sanitizeClientErrorMessage(e?.message, 'common.error') }
  }
}
