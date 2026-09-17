'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders, refundRequests } from "@/lib/db/schema"
import { and, desc, eq, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { checkAdmin } from "@/actions/admin"
import { sanitizeClientErrorMessage } from "@/lib/errors/safe-error"
import { products } from "@/lib/db/schema"
import { notifyAdminRefundRequest } from "@/lib/notifications"
import { markOrderRefunded, proxyRefund } from "@/actions/refund"
import { createUserNotification } from "@/lib/db/queries"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"

async function ensureRefundRequestsTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      admin_username TEXT,
      admin_note TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS refund_requests_order_id_idx ON refund_requests(order_id);
  `)
}

class RefundRequestRejectedError extends Error {
  constructor(
    readonly errorKey: string,
    message: string,
  ) {
    super(message)
    this.name = 'RefundRequestRejectedError'
  }
}

export async function requestRefund(orderId: string, reason: string) {
  const session = await auth()
  const user = session?.user
  const normalizedReason = (reason || '').trim()

  try {
    if (!user?.id) {
      throw new RefundRequestRejectedError('refund_unauthorized', 'Unauthorized')
    }

    await ensureRefundRequestsTable()

    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
    if (!order) {
      throw new RefundRequestRejectedError('refund_order_not_found', 'Order not found')
    }
    if (order.userId !== user.id) {
      throw new RefundRequestRejectedError('refund_unauthorized', 'Unauthorized')
    }

    const status = order.status || 'pending'
    if (status !== 'paid' && status !== 'delivered') {
      throw new RefundRequestRejectedError('refund_not_allowed', 'Order is not refundable')
    }

    // Check 30-day limit after transaction completion (paid/delivered)
    const completionTime = order.deliveredAt || order.paidAt || order.createdAt
    if (completionTime) {
      const elapsed = Date.now() - new Date(completionTime).getTime()
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
      if (elapsed > thirtyDaysMs) {
        throw new RefundRequestRejectedError(
          'refund_expired',
          '订单交易成功已超过 30 天，无法再发起退款申请',
        )
      }
    }

    const existing = await db.query.refundRequests.findFirst({
      where: and(eq(refundRequests.orderId, orderId), eq(refundRequests.userId, user.id)),
      orderBy: [desc(refundRequests.createdAt)],
    })
    if (existing && existing.status !== 'rejected' && existing.status !== 'processed') {
      await recordAuditEvent({
        eventName: 'refund.requested',
        actorType: 'user',
        actorUserId: user.id,
        actorUsername: user.username ?? null,
        targetId: orderId,
        source: 'refund.request',
        metadata: { orderId, status: existing.status || 'pending' },
      })
      return { ok: true }
    }

    await db.insert(refundRequests).values({
      orderId,
      userId: user.id,
      username: user.username || null,
      reason: normalizedReason || null,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await recordAuditEvent({
      eventName: 'refund.requested',
      actorType: 'user',
      actorUserId: user.id,
      actorUsername: user.username ?? null,
      targetId: orderId,
      source: 'refund.request',
      metadata: {
        orderId,
        reason: normalizedReason.slice(0, 200),
        status: 'pending',
      },
    })

    const product = await db.query.products.findFirst({
      where: eq(products.id, order.productId),
      columns: { name: true }
    })

    await notifyAdminRefundRequest({
      orderId,
      productName: product?.name || 'Unknown',
      amount: order.amount,
      username: user.username,
      reason: normalizedReason || null
    })

    revalidatePath(`/order/${orderId}`)
    revalidatePath('/admin/refunds')
    return { ok: true }
  } catch (error) {
    if (error instanceof RefundRequestRejectedError) {
      await recordAuditEvent({
        eventName: 'refund.requested',
        result: 'failure',
        actorType: 'user',
        actorUserId: user?.id ?? null,
        actorUsername: user?.username ?? null,
        targetId: orderId || null,
        errorKey: error.errorKey,
        source: 'refund.request',
        metadata: { orderId, status: 'rejected' },
      })
      throw error
    }

    await recordServerError('refund.request', error, {
      actorType: 'user',
      actorUserId: user?.id ?? null,
      actorUsername: user?.username ?? null,
      auditEvent: {
        eventName: 'refund.requested',
        actorType: 'user',
        actorUserId: user?.id ?? null,
        actorUsername: user?.username ?? null,
        targetId: orderId || null,
        source: 'refund.request',
      },
    })
    throw error
  }
}

export async function adminApproveRefund(requestId: number, adminNote?: string) {
  await checkAdmin()
  await ensureRefundRequestsTable()

  const session = await auth()
  const username = session?.user?.username || null

  const req = await db.query.refundRequests.findFirst({
    where: eq(refundRequests.id, requestId),
    columns: { orderId: true, status: true }
  })
  if (!req) {
    throw new Error("Refund request not found")
  }

  const order = await db.query.orders.findFirst({
    where: eq(orders.orderId, req.orderId),
    columns: { orderId: true, tradeNo: true, amount: true, userId: true, productName: true }
  })
  if (!order) {
    throw new Error("Order not found")
  }

  await db.update(refundRequests).set({
    status: 'approved',
    adminUsername: username,
    adminNote: adminNote || null,
    updatedAt: new Date(),
  }).where(eq(refundRequests.id, requestId))

  await recordAuditEvent({
    eventName: 'refund.approved',
    actorType: 'admin',
    actorUserId: session?.user?.id ?? null,
    actorUsername: username,
    targetId: String(requestId),
    source: 'admin.refunds',
    metadata: {
      refundId: requestId,
      orderId: order.orderId,
      status: 'approved',
    },
  })

  if (order.userId) {
    await createUserNotification({
      userId: order.userId,
      type: 'refund_approved',
      titleKey: 'profile.notifications.refundApprovedTitle',
      contentKey: 'profile.notifications.refundApprovedBody',
      data: {
        params: {
          orderId: order.orderId,
          productName: order.productName || 'Product'
        },
        href: `/order/${order.orderId}`
      }
    })
  }

  revalidatePath('/admin/refunds')

  // Auto refund for approved requests
  if (!order.tradeNo || Number(order.amount) <= 0) {
    await markOrderRefunded(order.orderId)
    return { ok: true, processed: true }
  }

  try {
    const result = await proxyRefund(order.orderId)
    if (result?.processed) {
      return { ok: true, processed: true }
    }
    return { ok: true, processed: false, error: sanitizeClientErrorMessage(result?.message, 'refund_failed') }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : null
    await recordServerError('refund.proxy', error, {
      actorType: 'admin',
      actorUserId: session?.user?.id ?? null,
      actorUsername: username,
      auditEvent: {
        eventName: 'refund.completed',
        actorType: 'admin',
        actorUserId: session?.user?.id ?? null,
        actorUsername: username,
        targetId: String(requestId),
        source: 'admin.refunds',
        metadata: { refundId: requestId, orderId: order.orderId },
      },
    })
    return {
      ok: true,
      processed: false,
      error: sanitizeClientErrorMessage(errorMessage, 'refund_failed'),
    }
  }
}

export async function adminRejectRefund(requestId: number, adminNote?: string) {
  await checkAdmin()
  await ensureRefundRequestsTable()

  const session = await auth()
  const username = session?.user?.username || null

  const req = await db.query.refundRequests.findFirst({
    where: eq(refundRequests.id, requestId),
    columns: { orderId: true }
  })
  if (!req) {
    throw new Error("Refund request not found")
  }

  const order = await db.query.orders.findFirst({
    where: eq(orders.orderId, req.orderId),
    columns: { orderId: true, userId: true, productName: true }
  })

  await db.update(refundRequests).set({
    status: 'rejected',
    adminUsername: username,
    adminNote: adminNote || null,
    updatedAt: new Date(),
  }).where(eq(refundRequests.id, requestId))

  await recordAuditEvent({
    eventName: 'refund.rejected',
    actorType: 'admin',
    actorUserId: session?.user?.id ?? null,
    actorUsername: username,
    targetId: String(requestId),
    source: 'admin.refunds',
    metadata: {
      refundId: requestId,
      orderId: req.orderId,
      status: 'rejected',
    },
  })

  if (order?.userId) {
    const note = (adminNote || "").trim()
    await createUserNotification({
      userId: order.userId,
      type: 'refund_rejected',
      titleKey: 'profile.notifications.refundRejectedTitle',
      contentKey: note ? 'profile.notifications.refundRejectedBodyWithNote' : 'profile.notifications.refundRejectedBody',
      data: {
        params: {
          orderId: order.orderId,
          productName: order.productName || 'Product',
          adminNote: note ? note.slice(0, 200) : undefined
        },
        href: `/order/${order.orderId}`
      }
    })
  }

  revalidatePath('/admin/refunds')
}

export async function getPendingRefundRequestCount() {
  try {
    await checkAdmin()
    await ensureRefundRequestsTable()
    const rows = await db.select({
      count: sql<number>`count(*)`
    }).from(refundRequests).where(eq(refundRequests.status, 'pending'))
    return { success: true, count: Number(rows[0]?.count || 0) }
  } catch {
    return { success: false, count: 0 }
  }
}
