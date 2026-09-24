import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  orders,
  reviews,
  reviewReplies,
  settings,
  products,
  cards,
  loginUsers,
  categories,
  refundRequests,
  dailyCheckins,
  userNotifications,
  userMessages,
  adminMessages,
  broadcastMessages,
  broadcastReads,
  wishlistItems,
  wishlistVotes,
} from "@/lib/db/schema"
import { and, desc, eq, or, sql } from "drizzle-orm"
import { ensureDatabaseInitialized, getProducts, normalizeTimestampMs } from "@/lib/db/queries"
import { isAdminIdentity } from "@/lib/admin-auth"
import { prepareManualStockProductsForSqlBackup } from "@/lib/manual-stock-backup"
import { logServerError, sanitizeClientErrorMessage } from "@/lib/errors/safe-error"

function requireAdminIdentity(user?: { id?: string | null; username?: string | null } | null) {
  if (!isAdminIdentity(user)) throw new Error("Unauthorized")
}

function isMissingTable(error: any) {
  const errorString = JSON.stringify(error)
  return (
    error?.message?.includes("does not exist") ||
    error?.cause?.message?.includes("does not exist") ||
    errorString.includes("42P01") ||
    (errorString.includes("relation") && errorString.includes("does not exist"))
  )
}

function csvEscape(value: any): string {
  if (value === null || value === undefined) return ""
  const str = String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function toCsv(headers: string[], rows: Array<Record<string, any>>): string {
  const lines: string[] = []
  lines.push(headers.map(csvEscape).join(","))
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","))
  }
  return lines.join("\n") + "\n"
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}

function escapeString(val: string): string {
  return "'" + val.replace(/'/g, "''") + "'"
}

function formatSqlValue(val: any): string {
  if (val === null || val === undefined) return "NULL"
  if (typeof val === "boolean") return val ? "1" : "0"
  if (val instanceof Date) {
    // Check if valid date
    if (isNaN(val.getTime())) return "NULL"
    return "'" + val.toISOString().replace("T", " ").replace("Z", "") + "'"
  }
  if (typeof val === "number") return String(val)
  if (typeof val === "string") return escapeString(val)
  return escapeString(JSON.stringify(val))
}

function rowToInsertOrIgnore(table: string, row: Record<string, any>): string {
  const keys = Object.keys(row)
  const columns = keys.join(", ")
  const values = keys.map((k) => formatSqlValue(row[k])).join(", ")
  return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${values});`
}

// ---------------------------------------------------------------------------
// 全量导出（type=full）的内存边界
//
// 此前 type=full 会把**每一张表**一次性 `.all()` 读进内存，再把整份 dump
// 拼成一个大字符串。Worker 内存上限 128MB：当 cards / orders 达到数万行时，
// 「全表行对象 + 完整字符串」两份副本很容易直接 OOM，而 OOM 的 Worker 是
// 被直接杀掉的，管理员只会看到一个无响应的下载。
//
// 现在改为:
//   1. 每张表按页读取（EXPORT_PAGE_SIZE），峰值内存只有一页；
//   2. 通过 ReadableStream 边生成边下发，不再持有整份 dump；
//   3. 每张表仍设硬上限（EXPORT_MAX_ROWS），命中时用响应头
//      `X-Export-Truncated: 1` 明确告知，而不是静默丢数据。
// ---------------------------------------------------------------------------
const EXPORT_PAGE_SIZE = 500
const EXPORT_MAX_ROWS = 20_000

interface ExportTableSpec {
  name: string
  /** 读取一页；表不存在时由调用方兜底为空页 */
  fetchPage: (limit: number, offset: number) => Promise<Array<Record<string, any>>>
}

const FULL_EXPORT_TABLES: ExportTableSpec[] = [
  { name: "categories", fetchPage: (limit, offset) => db.select().from(categories).limit(limit).offset(offset) },
  { name: "products", fetchPage: (limit, offset) => db.select().from(products).limit(limit).offset(offset) },
  { name: "cards", fetchPage: (limit, offset) => db.select().from(cards).limit(limit).offset(offset) },
  { name: "orders", fetchPage: (limit, offset) => db.select().from(orders).limit(limit).offset(offset) },
  { name: "reviews", fetchPage: (limit, offset) => db.select().from(reviews).limit(limit).offset(offset) },
  { name: "review_replies", fetchPage: (limit, offset) => db.select().from(reviewReplies).limit(limit).offset(offset) },
  { name: "settings", fetchPage: (limit, offset) => db.select().from(settings).limit(limit).offset(offset) },
  { name: "login_users", fetchPage: (limit, offset) => db.select().from(loginUsers).limit(limit).offset(offset) },
  { name: "user_notifications", fetchPage: (limit, offset) => db.select().from(userNotifications).limit(limit).offset(offset) },
  { name: "user_messages", fetchPage: (limit, offset) => db.select().from(userMessages).limit(limit).offset(offset) },
  { name: "admin_messages", fetchPage: (limit, offset) => db.select().from(adminMessages).limit(limit).offset(offset) },
  { name: "broadcast_messages", fetchPage: (limit, offset) => db.select().from(broadcastMessages).limit(limit).offset(offset) },
  { name: "broadcast_reads", fetchPage: (limit, offset) => db.select().from(broadcastReads).limit(limit).offset(offset) },
  { name: "wishlist_items", fetchPage: (limit, offset) => db.select().from(wishlistItems).limit(limit).offset(offset) },
  { name: "wishlist_votes", fetchPage: (limit, offset) => db.select().from(wishlistVotes).limit(limit).offset(offset) },
  { name: "refund_requests", fetchPage: (limit, offset) => db.select().from(refundRequests).limit(limit).offset(offset) },
  { name: "daily_checkins_v2", fetchPage: (limit, offset) => db.select().from(dailyCheckins).limit(limit).offset(offset) },
]

/** 缺表按空处理（历史库可能还没建某张表），其余错误照常抛出 */
async function readExportPage(spec: ExportTableSpec, limit: number, offset: number) {
  try {
    return (await spec.fetchPage(limit, offset)) as Array<Record<string, any>>
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
}

/** 把 camelCase 键映射为 SQL 导出用的 snake_case */
const SQL_COLUMN_MAPPING: Record<string, string> = {
  userId: 'user_id',
  productId: 'product_id',
  orderId: 'order_id',
  reviewId: 'review_id',
  itemId: 'item_id',
  messageId: 'message_id',
  // Products
  compareAtPrice: 'compare_at_price',
  isHot: 'is_hot',
  isActive: 'is_active',
  isShared: 'is_shared',
  sortOrder: 'sort_order',
  purchaseLimit: 'purchase_limit',
  purchaseWarning: 'purchase_warning',
  visibilityLevel: 'visibility_level',
  manualStockCount: 'manual_stock_count',
  stockCount: 'stock_count',
  lockedCount: 'locked_count',
  soldCount: 'sold_count',
  reviewCount: 'review_count',
  variantGroupId: 'variant_group_id',
  variantLabel: 'variant_label',
  purchaseQuestions: 'purchase_questions',
  checkoutFields: 'checkout_fields',
  fulfillmentMode: 'fulfillment_mode',
  productImages: 'product_images',
  createdAt: 'created_at',
  // Cards
  cardKey: 'card_key',
  isUsed: 'is_used',
  reservedOrderId: 'reserved_order_id',
  reservedAt: 'reserved_at',
  expiresAt: 'expires_at',
  usedAt: 'used_at',
  // Orders
  productName: 'product_name',
  tradeNo: 'trade_no',
  paidAt: 'paid_at',
  deliveredAt: 'delivered_at',
  pointsUsed: 'points_used',
  manualStockQuantity: 'manual_stock_quantity',
  checkoutFieldValues: 'checkout_field_values',
  deliveryNote: 'delivery_note',
  currentPaymentId: 'current_payment_id',
  cardIds: 'card_ids',
  // Reviews
  // orderId, productId, userId already covered
  // Settings
  updatedAt: 'updated_at',
  // Login Users
  lastLoginAt: 'last_login_at',
  lastCheckinAt: 'last_checkin_at',
  consecutiveDays: 'consecutive_days',
  isBlocked: 'is_blocked',
  desktopNotificationsEnabled: 'desktop_notifications_enabled',
  // Refund Requests
  adminUsername: 'admin_username',
  adminNote: 'admin_note',
  processedAt: 'processed_at',
  // Notification / message tables
  titleKey: 'title_key',
  contentKey: 'content_key',
  isRead: 'is_read',
  // Broadcast / admin messages
  targetType: 'target_type',
  targetValue: 'target_value',
}

function toSnakeCaseRow(row: Record<string, any>): Record<string, any> {
  const mapped: Record<string, any> = {}
  for (const [key, value] of Object.entries(row)) {
    mapped[SQL_COLUMN_MAPPING[key] || key] = value
  }
  return mapped
}

/** 把「字符串块」的异步迭代器包成 HTTP 响应体 */
function textStreamResponse(
  chunks: AsyncIterable<string>,
  contentType: string,
  filename: string,
  truncated: { value: boolean },
): NextResponse {
  const encoder = new TextEncoder()
  const iterator = chunks[Symbol.asyncIterator]()

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  }
  if (truncated.value) headers["X-Export-Truncated"] = "1"

  return new NextResponse(stream, { headers })
}

/** 流式 JSON：{"table":[...],...}，逐行拼接，不构造整份对象 */
async function* streamFullJson(truncated: { value: boolean }): AsyncIterable<string> {
  yield "{"
  let firstTable = true

  for (const spec of FULL_EXPORT_TABLES) {
    let offset = 0
    let page = await readExportPage(spec, EXPORT_PAGE_SIZE, offset)
    if (!firstTable) yield ","
    firstTable = false
    yield `${JSON.stringify(spec.name)}:[`

    let wroteAny = false
    while (true) {
      for (const row of page) {
        yield wroteAny ? `,${JSON.stringify(row)}` : JSON.stringify(row)
        wroteAny = true
      }
      if (page.length < EXPORT_PAGE_SIZE) break
      offset += page.length
      if (offset >= EXPORT_MAX_ROWS) {
        truncated.value = true
        break
      }
      page = await readExportPage(spec, EXPORT_PAGE_SIZE, offset)
      if (!page.length) break
    }

    yield "]"
  }

  yield "}"
}

/** 流式 SQL dump：逐条 INSERT OR IGNORE */
async function* streamFullSql(
  adjustedProducts: Array<Record<string, any>>,
  truncated: { value: boolean },
): AsyncIterable<string> {
  yield `-- Database Migration Dump (Vercel Postgres -> Cloudflare D1)\n`
  yield `-- Generated at ${new Date().toISOString()}\n`
  yield `\n`
  yield `-- Note: Transaction statements removed for D1 compatibility\n`
  yield `\n`

  for (const spec of FULL_EXPORT_TABLES) {
    // products 需要先按手工库存规则回算，直接使用预先调整好的结果集，
    // 不再为了这一个用途把整张 orders 表读进内存。
    if (spec.name === "products") {
      for (const row of adjustedProducts) {
        yield `${rowToInsertOrIgnore(spec.name, toSnakeCaseRow(row))}\n`
      }
      yield `\n`
      continue
    }

    let offset = 0
    let page = await readExportPage(spec, EXPORT_PAGE_SIZE, offset)
    while (true) {
      for (const row of page) {
        yield `${rowToInsertOrIgnore(spec.name, toSnakeCaseRow(row))}\n`
      }
      if (page.length < EXPORT_PAGE_SIZE) break
      offset += page.length
      if (offset >= EXPORT_MAX_ROWS) {
        truncated.value = true
        break
      }
      page = await readExportPage(spec, EXPORT_PAGE_SIZE, offset)
      if (!page.length) break
    }
    yield `\n`
  }

  yield `-- End of Dump\n`
  yield `\n`
}

export async function GET(req: Request) {
  const session = await auth()
  requireAdminIdentity(session?.user)
  await ensureDatabaseInitialized()

  const { searchParams } = new URL(req.url)
  const type = (searchParams.get("type") || "").toLowerCase()
  const format = (searchParams.get("format") || "").toLowerCase()
  const includeSecrets = searchParams.get("includeSecrets") === "1"
  const q = (searchParams.get("q") || "").trim()
  const status = (searchParams.get("status") || "all").trim()
  const fulfillment = (searchParams.get("fulfillment") || "all").trim()

  try {
    if (type === "orders") {
      const whereParts: any[] = []
      if (status !== 'all') whereParts.push(eq(orders.status, status))
      if (fulfillment === 'needsDelivery') whereParts.push(and(eq(orders.status, 'paid'), sql`${orders.cardKey} IS NULL`))
      if (q) {
        const like = `%${q}%`
        whereParts.push(or(
          sql`${orders.orderId} LIKE ${like}`,
          sql`${orders.productName} LIKE ${like}`,
          sql`COALESCE(${orders.username}, '') LIKE ${like}`,
          sql`COALESCE(${orders.email}, '') LIKE ${like}`,
          sql`COALESCE(${orders.tradeNo}, '') LIKE ${like}`
        ))
      }
      const whereExpr = whereParts.length ? and(...whereParts) : undefined

      const orderRows = await db.query.orders.findMany({
        where: whereExpr,
        orderBy: [desc(normalizeTimestampMs(orders.createdAt))],
        limit: EXPORT_MAX_ROWS,
      })
      const mapped = orderRows.map((o: any) => ({
        orderId: o.orderId,
        username: o.username,
        email: includeSecrets ? o.email : null,
        productId: o.productId,
        productName: o.productName,
        amount: o.amount,
        status: o.status,
        tradeNo: includeSecrets ? o.tradeNo : null,
        cardKey: includeSecrets ? o.cardKey : null,
        cardIds: includeSecrets ? o.cardIds : null,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        deliveredAt: o.deliveredAt,
        userId: o.userId,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="orders.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "orderId",
          "username",
          "email",
          "productId",
          "productName",
          "amount",
          "status",
          "tradeNo",
          "cardKey",
          "cardIds",
          "createdAt",
          "paidAt",
          "deliveredAt",
          "userId",
        ]
        const csv = toCsv(headers, mapped as any)
        return csvResponse(csv, `orders${includeSecrets ? "-with-secrets" : ""}.csv`)
      }
    }

    if (type === "products") {
      const rows = await getProducts()
      const mapped = rows.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        image: p.image,
        isActive: p.isActive ?? true,
        sortOrder: p.sortOrder ?? 0,
        purchaseLimit: p.purchaseLimit,
        visibilityLevel: p.visibilityLevel ?? -1,
        stock: p.stock,
        sold: p.sold,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="products.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "id",
          "name",
          "description",
          "price",
          "category",
          "image",
          "isActive",
          "sortOrder",
          "purchaseLimit",
          "visibilityLevel",
          "stock",
          "sold",
        ]
        const csv = toCsv(headers, mapped as any)
        return csvResponse(csv, "products.csv")
      }
    }

    if (type === "reviews") {
      const rows = await db.query.reviews.findMany({
        orderBy: [desc(reviews.createdAt)],
        limit: EXPORT_MAX_ROWS,
      })
      const mapped = rows.map((r: any) => ({
        id: r.id,
        productId: r.productId,
        orderId: r.orderId,
        userId: r.userId,
        username: r.username,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
      }))

      if (format === "json") {
        return NextResponse.json(mapped, {
          headers: {
            "Content-Disposition": `attachment; filename="reviews.json"`,
          },
        })
      }

      if (format === "csv") {
        const headers = [
          "id",
          "productId",
          "orderId",
          "userId",
          "username",
          "rating",
          "comment",
          "createdAt",
        ]
        const csv = toCsv(headers, mapped as any)
        return csvResponse(csv, "reviews.csv")
      }
    }

    if (type === "settings") {
      const rows = await db.query.settings.findMany({
        orderBy: [desc(settings.updatedAt)],
      })
      const mapped = rows.map((s: any) => ({
        key: s.key,
        value: s.value,
        updatedAt: s.updatedAt,
      }))
      return NextResponse.json(mapped, {
        headers: {
          "Content-Disposition": `attachment; filename="settings.json"`,
        },
      })
    }

    if (type === "full") {
      if (format === "json") {
        const truncated = { value: false }
        // 先取第一页：让「认证 / 参数 / 首查失败」仍然返回结构化 JSON 错误，
        // 而不是已经开始下发 200 之后才中断连接。
        await readExportPage(FULL_EXPORT_TABLES[0], 1, 0)
        return textStreamResponse(
          streamFullJson(truncated),
          "application/json; charset=utf-8",
          "full-dump.json",
          truncated,
        )
      }

      if (format === "sql") {
        const truncated = { value: false }
        // 手工库存回算只需要 products 全表（小）与 orders 的三个窄列，
        // 不再为了它读取整张 orders。
        const productRows = (await db.select().from(products).limit(EXPORT_MAX_ROWS)) as Array<Record<string, any>>
        const manualStockReservations = (await db
          .select({
            productId: orders.productId,
            status: orders.status,
            manualStockQuantity: orders.manualStockQuantity,
          })
          .from(orders)
          .where(sql`${orders.manualStockQuantity} > 0`)
          .limit(EXPORT_MAX_ROWS)) as Array<Record<string, any>>

        const adjustedProducts = prepareManualStockProductsForSqlBackup(
          productRows,
          manualStockReservations,
        ) as Array<Record<string, any>>

        return textStreamResponse(
          streamFullSql(adjustedProducts, truncated),
          "text/plain; charset=utf-8",
          "migration_data.sql",
          truncated,
        )
      }
    }

    return NextResponse.json({ error: "Bad Request" }, { status: 400 })
  } catch (e: any) {
    const isUnauthorized = e?.message === "Unauthorized"
    if (isUnauthorized) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // 导出失败此前会把 e.message 原样返回给前端，可能包含 SQL 原文与绑定参数。
    // 现在一律走脱敏 + errorId 记录，只回稳定文案。
    const errorId = logServerError('admin:data-export', e)
    return NextResponse.json(
      { error: sanitizeClientErrorMessage(e?.message, "Export failed"), errorId },
      { status: 500 },
    )
  }
}
