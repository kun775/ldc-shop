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
  coupons,
  couponProducts,
  couponUsages,
  couponUserCounters,
  orderDeliveryFiles,
  userPointLedger,
  databaseMigrations,
} from "@/lib/db/schema"
import { and, desc, eq, getTableColumns, getTableName, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm"
import { integer, primaryKey, sqliteTable, text, type AnySQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"
import { ensureDatabaseInitialized } from "@/lib/db/queries"
import { isAdminIdentity } from "@/lib/admin-auth"
import { prepareManualStockProductsForSqlBackup } from "@/lib/manual-stock-backup"
import { logServerError, sanitizeClientErrorMessage } from "@/lib/errors/safe-error"

function requireAdminIdentity(user?: { id?: string | null; username?: string | null } | null) {
  if (!isAdminIdentity(user)) throw new Error("Unauthorized")
}

function csvEscape(value: any): string {
  if (value === null || value === undefined) return ""
  const str = String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function escapeString(val: string): string {
  // 导入器逐行解析 INSERT，SQL 字符串中的换行必须改成单行表达式。
  return "'" + val.replace(/'/g, "''").replace(/\r/g, "' || char(13) || '").replace(/\n/g, "' || char(10) || '") + "'"
}

function formatSqlValue(val: any): string {
  if (val === undefined) throw new Error("Missing column value in export")
  if (val === null) return "NULL"
  if (typeof val === "boolean") return val ? "1" : "0"
  if (val instanceof Date) {
    if (isNaN(val.getTime())) throw new Error("Invalid date in export")
    return String(val.getTime())
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) throw new Error("Invalid number in export")
    return String(val)
  }
  if (typeof val === "string") return escapeString(val)
  if (val instanceof ArrayBuffer || ArrayBuffer.isView(val)) {
    const bytes = val instanceof ArrayBuffer ? new Uint8Array(val) : new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
    return `X'${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`
  }
  return escapeString(JSON.stringify(val))
}

function rowToInsertOrIgnore(table: string, row: Record<string, any>): string {
  const keys = Object.keys(row)
  const columns = keys.join(", ")
  const values = keys.map((k) => formatSqlValue(row[k])).join(", ")
  return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${values});`
}

// ---------------------------------------------------------------------------
// 导出按页读取并通过 ReadableStream 边生成边下发，避免把整库加载到内存。
// 不设置行数上限：全量备份必须包含每一行，不能静默截断。
// ---------------------------------------------------------------------------
const EXPORT_PAGE_SIZE = 500

// 独立 SQL DDL 表的列名及类型在这里显式声明，不从 JS 键名推测 SQL 列名。
const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  event_name: text("event_name"),
  category: text("category"),
  severity: text("severity"),
  result: text("result"),
  actor_type: text("actor_type"),
  actor_user_id: text("actor_user_id"),
  actor_username: text("actor_username"),
  target_type: text("target_type"),
  target_id: text("target_id"),
  error_id: text("error_id"),
  error_key: text("error_key"),
  source: text("source"),
  ip_hash: text("ip_hash"),
  user_agent: text("user_agent"),
  metadata: text("metadata"),
  created_at: integer("created_at"),
})

const platformErrorLogs = sqliteTable("platform_error_logs", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint"),
  fingerprint_bucket: integer("fingerprint_bucket"),
  scope: text("scope"),
  severity: text("severity"),
  error_code: text("error_code"),
  message: text("message"),
  stack: text("stack"),
  error_chain: text("error_chain"),
  actor_type: text("actor_type"),
  actor_user_id: text("actor_user_id"),
  actor_username: text("actor_username"),
  request_method: text("request_method"),
  request_path: text("request_path"),
  ip_hash: text("ip_hash"),
  user_agent: text("user_agent"),
  occurrence_count: integer("occurrence_count"),
  first_seen_at: integer("first_seen_at"),
  last_seen_at: integer("last_seen_at"),
  status: text("status"),
  handled_at: integer("handled_at"),
  handled_by: text("handled_by"),
  handle_note: text("handle_note"),
  created_at: integer("created_at"),
  updated_at: integer("updated_at"),
  error_id: text("error_id"),
})

const rateLimitCounters = sqliteTable("rate_limit_counters", {
  bucket: text("bucket").notNull(),
  subject: text("subject").notNull(),
  window_start: integer("window_start").notNull(),
  count: integer("count"),
  expires_at: integer("expires_at"),
}, (table) => [primaryKey({ columns: [table.bucket, table.subject, table.window_start] })])

interface ExportTableSpec {
  table: SQLiteTable
  /** 必须是该表的唯一主键；复合主键按声明顺序排列。 */
  keys: readonly string[]
  /** 仅迁移前的限流运行态表可不存在；不存在时必须在导出中显式标记。 */
  optional?: boolean
}

const FULL_EXPORT_TABLES: ExportTableSpec[] = [
  { table: categories, keys: ["id"] },
  { table: products, keys: ["id"] },
  { table: cards, keys: ["id"] },
  { table: orders, keys: ["orderId"] },
  { table: reviews, keys: ["id"] },
  { table: reviewReplies, keys: ["id"] },
  { table: settings, keys: ["key"] },
  { table: loginUsers, keys: ["userId"] },
  { table: userNotifications, keys: ["id"] },
  { table: userMessages, keys: ["id"] },
  { table: adminMessages, keys: ["id"] },
  { table: broadcastMessages, keys: ["id"] },
  { table: broadcastReads, keys: ["id"] },
  { table: wishlistItems, keys: ["id"] },
  { table: wishlistVotes, keys: ["id"] },
  { table: refundRequests, keys: ["id"] },
  { table: dailyCheckins, keys: ["id"] },
  { table: coupons, keys: ["id"] },
  { table: couponProducts, keys: ["couponId", "productId"] },
  { table: couponUsages, keys: ["id"] },
  { table: couponUserCounters, keys: ["couponId", "userId"] },
  { table: orderDeliveryFiles, keys: ["id"] },
  { table: userPointLedger, keys: ["id"] },
  { table: databaseMigrations, keys: ["id"] },
  { table: auditEvents, keys: ["id"] },
  { table: platformErrorLogs, keys: ["id"] },
  { table: rateLimitCounters, keys: ["bucket", "subject", "window_start"], optional: true },
]

type ExportBound = { spec: ExportTableSpec; highWater: unknown[] | null; missing: boolean }

function keyColumns(spec: ExportTableSpec): AnySQLiteColumn[] {
  const columns = getTableColumns(spec.table)
  return spec.keys.map((key) => columns[key])
}

/** 按复合主键做字典序比较，避免并发插删造成 OFFSET 跳页或重复。 */
function afterKey(columns: AnySQLiteColumn[], values: unknown[]) {
  return or(...columns.map((column, index) => and(
    ...columns.slice(0, index).map((previous, i) => eq(previous, values[i] as string)),
    gt(column, values[index] as string),
  )))
}

async function captureExportBounds(): Promise<ExportBound[]> {
  const bounds: ExportBound[] = []
  const existing = await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`) as Array<{ name: string }>
  const names = new Set(existing.map((row) => row.name))
  const unknown = existing.filter((row) => !FULL_EXPORT_TABLES.some((spec) => getTableName(spec.table) === row.name))
  if (unknown.length) throw new Error(`Unrecognized tables in full export: ${unknown.map((row) => row.name).join(", ")}`)
  for (const spec of FULL_EXPORT_TABLES) {
    const name = getTableName(spec.table)
    if (spec.optional && !names.has(name)) {
      bounds.push({ spec, highWater: null, missing: true })
      continue
    }
    const actualColumns = await db.all(sql.raw(`PRAGMA table_info("${name}")`)) as Array<{ name: string }>
    const mappedColumns = Object.values(getTableColumns(spec.table)).map((column) => column.name)
    if (actualColumns.length && (actualColumns.length !== mappedColumns.length || actualColumns.some((column) => !mappedColumns.includes(column.name)))) {
      throw new Error(`Column mismatch in full export: ${name}`)
    }
    const columns = keyColumns(spec)
    // 空表也校验全部列，防止旧库缺列时返回看似成功的备份。
    await db.select().from(spec.table).limit(0)
    const selectedKeys = Object.fromEntries(spec.keys.map((key, index) => [key, columns[index]]))
    const [last] = await db.select(selectedKeys).from(spec.table).orderBy(...columns.map(desc)).limit(1)
    bounds.push({ spec, highWater: last ? spec.keys.map((key) => last[key]) : null, missing: false })
  }
  return bounds
}

async function* readExportPages(bound: ExportBound): AsyncIterable<Array<Record<string, any>>> {
  const { spec, highWater } = bound
  if (!highWater) return
  const columns = keyColumns(spec)
  let cursor: unknown[] | null = null
  while (true) {
    const page: Array<Record<string, any>> = await db.select().from(spec.table)
      .where(and(
        cursor ? afterKey(columns, cursor) : undefined,
        // 唯一上界：允许等于高水位，但不读取其后新增的行。
        or(...columns.map((column, index) => and(
          ...columns.slice(0, index).map((previous, i) => eq(previous, highWater[i] as string)),
          lt(column, highWater[index] as string),
        )), and(...columns.map((column, i) => eq(column, highWater[i] as string)))),
      ))
      .orderBy(...columns)
      .limit(EXPORT_PAGE_SIZE)
    if (page.length) yield page
    if (page.length < EXPORT_PAGE_SIZE) break
    const last = page[page.length - 1]
    cursor = spec.keys.map((key) => last[key])
  }
}

/** Drizzle 的字段元数据是 SQL 列名的唯一来源，不推测 camelCase 转换规则。 */
function toSqlColumnRow(spec: ExportTableSpec, row: Record<string, any>): Record<string, any> {
  const mapped: Record<string, any> = {}
  for (const [key, column] of Object.entries(getTableColumns(spec.table))) {
    mapped[column.name] = row[key]
  }
  return mapped
}

/** 把「字符串块」的异步迭代器包成 HTTP 响应体 */
function textStreamResponse(
  chunks: AsyncIterable<string>,
  contentType: string,
  filename: string,
  bounds?: ExportBound[],
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
        logServerError("admin:data-export-stream", error)
        controller.error(error)
      }
    },
    async cancel() {
      try {
        await iterator.return?.()
      } catch (error) {
        logServerError("admin:data-export-stream", error)
      }
    },
  })

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  }
  const missing = bounds?.filter((bound) => bound.missing).map((bound) => getTableName(bound.spec.table)) ?? []
  if (missing.length) headers["X-Export-Missing-Optional-Tables"] = missing.join(",")

  return new NextResponse(stream, { headers })
}

/** 流式 JSON：{"table":[...],...}，逐行拼接，不构造整份对象 */
async function* streamFullJson(bounds: ExportBound[]): AsyncIterable<string> {
  yield "{"
  let firstTable = true

  for (const bound of bounds) {
    if (!firstTable) yield ","
    firstTable = false
    const name = getTableName(bound.spec.table)
    if (bound.missing) {
      // null 与存在但为空的 [] 不同，保存为文件后仍能辨认缺失的可选表。
      yield `${JSON.stringify(name)}:null`
      continue
    }
    yield `${JSON.stringify(name)}:[`

    let wroteAny = false
    for await (const page of readExportPages(bound)) {
      for (const row of page) {
        yield wroteAny ? `,${JSON.stringify(row)}` : JSON.stringify(row)
        wroteAny = true
      }
    }
    yield "]"
  }

  yield "}"
}

/** 按页读取并流式生成 SQL dump；products 页内按 product_id 聚合预占量后回算库存。 */
async function* streamFullSql(bounds: ExportBound[]): AsyncIterable<string> {
  yield `-- Database Migration Dump (Cloudflare D1)\n`
  yield `-- Generated at ${new Date().toISOString()}\n`
  yield `-- Keyset high-water per table; concurrent updates/deletes and cross-table changes are NOT snapshot-consistent.\n`
  yield `-- Import only if the completion marker appears at EOF and the download finished successfully.\n`
  const missing = bounds.filter((bound) => bound.missing).map((bound) => getTableName(bound.spec.table))
  if (missing.length) yield `-- Missing optional tables: ${missing.join(", ")} (not present in source database).\n`
  yield `\n`

  for (const bound of bounds) {
    const { spec } = bound
    const name = getTableName(spec.table)
    for await (const page of readExportPages(bound)) {
      if (name === "products") {
        const productIds = page.map((product) => product.id).filter((id): id is string => typeof id === "string" && id.length > 0)
        const reservationRows = productIds.length
          ? await db
              .select({
                productId: orders.productId,
                manualStockQuantity: sql<number>`coalesce(sum(${orders.manualStockQuantity}), 0)`,
              })
              .from(orders)
              .where(and(
                inArray(orders.productId, productIds),
                sql`${orders.manualStockQuantity} > 0`,
                or(sql`${orders.status} IS NULL`, notInArray(orders.status, ["cancelled", "failed", "refunded"])),
              ))
              .groupBy(orders.productId)
          : []
        for (const row of prepareManualStockProductsForSqlBackup(page, reservationRows)) {
          yield `${rowToInsertOrIgnore(name, toSqlColumnRow(spec, row))}\n`
        }
      } else {
        for (const row of page) {
          yield `${rowToInsertOrIgnore(name, toSqlColumnRow(spec, row))}\n`
        }
      }
    }
    yield `\n`
  }

  yield `-- End of Dump\n`
}

async function* streamJsonRows<T>(
  fetchPage: (limit: number, cursor: unknown[] | null) => Promise<T[]>,
  keyOf: (row: T) => unknown[],
  mapRow: (row: T) => Record<string, any>,
): AsyncIterable<string> {
  yield "["
  let first = true
  let cursor: unknown[] | null = null
  while (true) {
    const page = await fetchPage(EXPORT_PAGE_SIZE, cursor)
    for (const row of page) {
      yield `${first ? "" : ","}${JSON.stringify(mapRow(row))}`
      first = false
    }
    if (page.length < EXPORT_PAGE_SIZE) break
    cursor = keyOf(page[page.length - 1])
  }
  yield "]"
}

async function* streamCsvRows<T>(
  headers: string[],
  fetchPage: (limit: number, cursor: unknown[] | null) => Promise<T[]>,
  keyOf: (row: T) => unknown[],
  mapRow: (row: T) => Record<string, any>,
): AsyncIterable<string> {
  yield `\uFEFF${headers.map(csvEscape).join(",")}\n`
  let cursor: unknown[] | null = null
  while (true) {
    const page = await fetchPage(EXPORT_PAGE_SIZE, cursor)
    for (const row of page) {
      const mapped = mapRow(row)
      yield `${headers.map((header) => csvEscape(mapped[header])).join(",")}\n`
    }
    if (page.length < EXPORT_PAGE_SIZE) break
    cursor = keyOf(page[page.length - 1])
  }
}

function mapOrderExportRow(order: any, includeSecrets: boolean) {
  return {
    orderId: order.orderId,
    username: order.username,
    email: includeSecrets ? order.email : null,
    productId: order.productId,
    productName: order.productName,
    amount: order.amount,
    status: order.status,
    tradeNo: includeSecrets ? order.tradeNo : null,
    cardKey: includeSecrets ? order.cardKey : null,
    cardIds: includeSecrets ? order.cardIds : null,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    deliveredAt: order.deliveredAt,
    userId: order.userId,
  }
}

function mapReviewExportRow(review: any) {
  return {
    id: review.id,
    productId: review.productId,
    orderId: review.orderId,
    userId: review.userId,
    username: review.username,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
  }
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
      const [{ orderId: highWater } = { orderId: null }] = await db.select({ orderId: orders.orderId })
        .from(orders).where(whereExpr).orderBy(desc(orders.orderId)).limit(1)
      const fetchPage = (limit: number, cursor: unknown[] | null) => highWater === null
        ? Promise.resolve([] as Array<typeof orders.$inferSelect>)
        : db.select().from(orders)
          .where(and(whereExpr, cursor ? gt(orders.orderId, cursor[0] as string) : undefined, sql`${orders.orderId} <= ${highWater}`))
          .orderBy(orders.orderId).limit(limit)
      const keyOf = (order: typeof orders.$inferSelect) => [order.orderId]
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
      const mapRow = (order: any) => mapOrderExportRow(order, includeSecrets)

      if (format === "json") {
        return textStreamResponse(
          streamJsonRows(fetchPage, keyOf, mapRow),
          "application/json; charset=utf-8",
          "orders.json",
        )
      }

      if (format === "csv") {
        return textStreamResponse(
          streamCsvRows(headers, fetchPage, keyOf, mapRow),
          "text/csv; charset=utf-8",
          `orders${includeSecrets ? "-with-secrets" : ""}.csv`,
        )
      }
    }

    if (type === "products") {
      const [{ id: highWater } = { id: null }] = await db.select({ id: products.id })
        .from(products).orderBy(desc(products.id)).limit(1)
      const fetchPage = async (limit: number, cursor: unknown[] | null) => {
        if (highWater === null) return []
        const rows = await db.select().from(products)
          .where(and(cursor ? gt(products.id, cursor[0] as string) : undefined, sql`${products.id} <= ${highWater}`))
          .orderBy(products.id).limit(limit)
        return rows.map((product: any) => ({
          id: product.id,
          name: product.name,
          description: product.description,
          price: product.price,
          category: product.category,
          image: product.image,
          isActive: product.isActive ?? true,
          sortOrder: product.sortOrder ?? 0,
          purchaseLimit: product.purchaseLimit,
          visibilityLevel: product.visibilityLevel ?? -1,
          stock: product.stockCount,
          sold: product.soldCount,
        }))
      }
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

      if (format === "json") {
        return textStreamResponse(
          streamJsonRows(fetchPage, (row) => [row.id], (row) => row),
          "application/json; charset=utf-8",
          "products.json",
        )
      }

      if (format === "csv") {
        return textStreamResponse(
          streamCsvRows(headers, fetchPage, (row) => [row.id], (row) => row),
          "text/csv; charset=utf-8",
          "products.csv",
        )
      }
    }

    if (type === "reviews") {
      const [{ id: highWater } = { id: null }] = await db.select({ id: reviews.id })
        .from(reviews).orderBy(desc(reviews.id)).limit(1)
      const fetchPage = (limit: number, cursor: unknown[] | null) => highWater === null
        ? Promise.resolve([] as Array<typeof reviews.$inferSelect>)
        : db.select().from(reviews)
          .where(and(cursor ? gt(reviews.id, cursor[0] as number) : undefined, sql`${reviews.id} <= ${highWater}`))
          .orderBy(reviews.id).limit(limit)
      const keyOf = (review: typeof reviews.$inferSelect) => [review.id]
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

      if (format === "json") {
        return textStreamResponse(
          streamJsonRows(fetchPage, keyOf, mapReviewExportRow),
          "application/json; charset=utf-8",
          "reviews.json",
        )
      }

      if (format === "csv") {
        return textStreamResponse(
          streamCsvRows(headers, fetchPage, keyOf, mapReviewExportRow),
          "text/csv; charset=utf-8",
          "reviews.csv",
        )
      }
    }

    if (type === "settings") {
      const [{ key: highWater } = { key: null }] = await db.select({ key: settings.key })
        .from(settings).orderBy(desc(settings.key)).limit(1)
      const fetchPage = async (limit: number, cursor: unknown[] | null) => {
        if (highWater === null) return []
        const rows = await db.select().from(settings)
          .where(and(cursor ? gt(settings.key, cursor[0] as string) : undefined, sql`${settings.key} <= ${highWater}`))
          .orderBy(settings.key).limit(limit)
        return rows.map((setting: any) => ({
          key: setting.key,
          value: setting.value,
          updatedAt: setting.updatedAt,
        }))
      }
      return textStreamResponse(
        streamJsonRows(fetchPage, (row) => [row.key], (row) => row),
        "application/json; charset=utf-8",
        "settings.json",
      )
    }

    if (type === "full") {
      if (format === "json") {
        const bounds = await captureExportBounds()
        return textStreamResponse(
          streamFullJson(bounds),
          "application/json; charset=utf-8",
          "full-dump.json",
          bounds,
        )
      }

      if (format === "sql") {
        const bounds = await captureExportBounds()
        return textStreamResponse(
          streamFullSql(bounds),
          "text/plain; charset=utf-8",
          "migration_data.sql",
          bounds,
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
