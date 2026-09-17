import { db } from '@/lib/db'
import { coupons, couponProducts, couponUsages, couponUserCounters, orders, products } from '@/lib/db/schema'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { ensureDatabaseInitialized } from '@/lib/db/queries'
import { normalizeCouponCode, orderCouponEntriesByCode } from './code.ts'
import type {
    CouponRecord,
    CouponRuntimeState,
    CouponScope,
    CouponStatus,
    CouponUsageStatus,
    CouponDiscountType,
    CouponRefundPolicy,
} from './types.ts'

const COUPON_LIST_MAX_PAGE_SIZE = 100
const COUPON_PAGE_SIZE_DEFAULT = 20

/** 页面与业务请求保持纯读写，不在请求内执行数据库 DDL。 */
function runCouponOperation<T>(run: () => Promise<T>): Promise<T> {
    return run()
}

export interface CouponAdminFilters {
    page?: number
    pageSize?: number
    q?: string
    status?: string
    discountType?: string
    scope?: string
}

export interface CouponUsageRow {
    id: string
    couponId: string
    couponCode: string
    orderId: string
    userId: string | null
    username: string | null
    status: CouponUsageStatus
    sequence: number
    discountAmountCents: number
    eligibleAmountCents: number
    reservedAt: number | null
    consumedAt: number | null
    releasedAt: number | null
    reversedAt: number | null
    reason: string | null
    orderStatus: string | null
    orderAmount: string | null
    orderProductName: string | null
    orderPointsUsed: number
    orderCreatedAt: number | null
}

export interface CouponListRow extends CouponRecord {
    usageCount: number
    userCount: number
}

function toMs(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.getTime()
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function clampPage(value: unknown, fallback: number): number {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

function mapCouponRow(row: any, productIds: string[]): CouponRecord {
    return {
        id: String(row.id),
        code: String(row.code || ''),
        name: String(row.name || ''),
        description: row.description ?? null,
        discountType: (row.discountType || 'fixed') as CouponDiscountType,
        rateBps: row.rateBps === null || row.rateBps === undefined ? null : Number(row.rateBps),
        discountAmountCents:
            row.discountAmountCents === null || row.discountAmountCents === undefined
                ? null
                : Number(row.discountAmountCents),
        minSpendCents: Number(row.minSpendCents || 0),
        maxDiscountCents:
            row.maxDiscountCents === null || row.maxDiscountCents === undefined
                ? null
                : Number(row.maxDiscountCents),
        scope: (row.scope || 'all') as CouponScope,
        productIds,
        totalUseLimit:
            row.totalUseLimit === null || row.totalUseLimit === undefined ? null : Number(row.totalUseLimit),
        perUserLimit:
            row.perUserLimit === null || row.perUserLimit === undefined ? null : Number(row.perUserLimit),
        reservedCount: Number(row.reservedCount || 0),
        consumedCount: Number(row.consumedCount || 0),
        stackableWithCoupons: Boolean(row.stackableWithCoupons),
        stackableWithPoints: Boolean(row.stackableWithPoints),
        refundPolicy: (row.refundPolicy || 'unfulfilled_full_refund') as CouponRefundPolicy,
        status: (row.status || 'draft') as CouponStatus,
        startsAt: toMs(row.startsAt),
        endsAt: toMs(row.endsAt),
        createdBy: row.createdBy ?? null,
        createdAt: toMs(row.createdAt),
        updatedAt: toMs(row.updatedAt),
    }
}

async function loadProductIdsByCoupon(couponIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    if (!couponIds.length) return map
    const rows = await db
        .select({ couponId: couponProducts.couponId, productId: couponProducts.productId })
        .from(couponProducts)
        .where(inArray(couponProducts.couponId, couponIds))
    for (const row of rows) {
        const list = map.get(row.couponId) || []
        list.push(row.productId)
        map.set(row.couponId, list)
    }
    return map
}

function buildCouponStatusCondition(status: string, now: number) {
    switch (status) {
        case 'draft':
            return sql`${coupons.status} = 'draft'`
        case 'disabled':
            return sql`${coupons.status} = 'disabled'`
        case 'scheduled':
            return sql`${coupons.status} = 'active' AND ${coupons.startsAt} IS NOT NULL AND ${coupons.startsAt} > ${now}`
        case 'expired':
            return sql`${coupons.endsAt} IS NOT NULL AND ${coupons.endsAt} < ${now}`
        case 'exhausted':
            return sql`${coupons.totalUseLimit} IS NOT NULL AND (${coupons.reservedCount} + ${coupons.consumedCount}) >= ${coupons.totalUseLimit}`
        case 'active':
            return sql`${coupons.status} = 'active'
                AND (${coupons.startsAt} IS NULL OR ${coupons.startsAt} <= ${now})
                AND (${coupons.endsAt} IS NULL OR ${coupons.endsAt} >= ${now})
                AND (${coupons.totalUseLimit} IS NULL OR (${coupons.reservedCount} + ${coupons.consumedCount}) < ${coupons.totalUseLimit})`
        default:
            return null
    }
}

// listAdminCoupons 查询后台优惠券列表
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增支持关键词、状态、类型、范围筛选的服务端分页查询。
export async function listAdminCoupons(filters: CouponAdminFilters = {}) {
    await ensureDatabaseInitialized()

    const page = clampPage(filters.page, 1)
    const pageSize = Math.min(clampPage(filters.pageSize, COUPON_PAGE_SIZE_DEFAULT), COUPON_LIST_MAX_PAGE_SIZE)
    const offset = (page - 1) * pageSize
    const now = Date.now()

    const whereParts: any[] = []
    const keyword = String(filters.q || '').trim()
    if (keyword) {
        const like = `%${keyword.toUpperCase()}%`
        whereParts.push(or(
            sql`upper(${coupons.code}) LIKE ${like}`,
            sql`upper(${coupons.name}) LIKE ${like}`
        ))
    }
    const statusCondition = buildCouponStatusCondition(String(filters.status || 'all'), now)
    if (statusCondition) whereParts.push(statusCondition)

    const discountType = String(filters.discountType || '').trim()
    if (discountType) {
        whereParts.push(eq(coupons.discountType, discountType))
    }

    const scope = String(filters.scope || '').trim()
    if (scope) {
        whereParts.push(eq(coupons.scope, scope))
    }

    const whereExpr = whereParts.length ? and(...whereParts) : undefined

    // 查询异常一律上抛，由调用方统一脱敏并记录错误 ID。
    return runCouponOperation(async () => {
        const countQuery = db.select({ count: sql<number>`count(*)` }).from(coupons)
        const rowsQuery = db.select().from(coupons)
            .orderBy(desc(coupons.createdAt))
            .limit(pageSize)
            .offset(offset)

        const [countRows, couponRows] = await Promise.all([
            whereExpr ? countQuery.where(whereExpr as any) : countQuery,
            whereExpr ? rowsQuery.where(whereExpr as any) : rowsQuery,
        ])

        const total = Number(countRows[0]?.count || 0)
        const couponIds = couponRows.map((row: any) => String(row.id))
        const productMap = await loadProductIdsByCoupon(couponIds)

        const usageStats = new Map<string, { usageCount: number; userCount: number }>()
        if (couponIds.length > 0) {
            const statRows = await db
                .select({
                    couponId: couponUsages.couponId,
                    usageCount: sql<number>`count(*)`,
                    userCount: sql<number>`count(distinct coalesce(${couponUsages.userId}, ${couponUsages.orderId}))`,
                })
                .from(couponUsages)
                .where(and(
                    inArray(couponUsages.couponId, couponIds),
                    inArray(couponUsages.status, ['reserved', 'consumed'])
                ))
                .groupBy(couponUsages.couponId)
            for (const stat of statRows) {
                usageStats.set(String(stat.couponId), {
                    usageCount: Number(stat.usageCount || 0),
                    userCount: Number(stat.userCount || 0),
                })
            }
        }

        const items: CouponListRow[] = couponRows.map((row: any) => {
            const record = mapCouponRow(row, productMap.get(String(row.id)) || [])
            const stat = usageStats.get(record.id) || { usageCount: 0, userCount: 0 }
            return { ...record, usageCount: stat.usageCount, userCount: stat.userCount }
        })

        return { items, total, page, pageSize }
    })
}

export async function getCouponById(id: string): Promise<CouponRecord | null> {
    if (!id) return null
    await ensureDatabaseInitialized()

    // null 严格表示「记录不存在」；结构或查询异常一律抛出，由上层转为可追踪失败
    return runCouponOperation(async () => {
        const rows = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1)
        if (!rows.length) return null
        const productMap = await loadProductIdsByCoupon([id])
        return mapCouponRow(rows[0], productMap.get(id) || [])
    })
}

// getCouponRuntimeState 读取单张优惠券的总次数与用户次数占用
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增结算与预占阶段使用的实时占用读取。
export async function getCouponRuntimeState(couponId: string, userId: string | null): Promise<CouponRuntimeState> {
    const base: CouponRuntimeState = {
        totalReserved: 0,
        totalConsumed: 0,
        userReserved: 0,
        userConsumed: 0,
    }
    if (!couponId) return base

    return runCouponOperation(async () => {
        const rows = await db
            .select({ reservedCount: coupons.reservedCount, consumedCount: coupons.consumedCount })
            .from(coupons)
            .where(eq(coupons.id, couponId))
            .limit(1)
        base.totalReserved = Number(rows[0]?.reservedCount || 0)
        base.totalConsumed = Number(rows[0]?.consumedCount || 0)

        if (userId) {
            const counterRows = await db
                .select({
                    reservedCount: couponUserCounters.reservedCount,
                    consumedCount: couponUserCounters.consumedCount,
                })
                .from(couponUserCounters)
                .where(and(eq(couponUserCounters.couponId, couponId), eq(couponUserCounters.userId, userId)))
                .limit(1)
            base.userReserved = Number(counterRows[0]?.reservedCount || 0)
            base.userConsumed = Number(counterRows[0]?.consumedCount || 0)
        }

        return base
    })
}

// loadCouponRuntimeEntries 按优惠码批量加载优惠券及其占用状态
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增结算前一次性加载多张券的运行时数据，避免逐张查询。
export async function loadCouponRuntimeEntries(codes: string[], userId: string | null) {
    const normalized = Array.from(new Set(codes.map((code) => normalizeCouponCode(code)).filter(Boolean)))
    const found = new Map<string, CouponRecord>()
    if (!normalized.length) return { entries: [], missing: normalized }

    await ensureDatabaseInitialized()

    // 查询异常上抛，由上层转为可追踪失败，不把系统错误伪装成「优惠码不存在」。
    const { rows, productMap, counterMap } = await runCouponOperation(async () => {
        const rows = await db
            .select()
            .from(coupons)
            .where(normalized.length === 1
                ? sql`upper(${coupons.code}) = ${normalized[0]}`
                : or(...normalized.map((code) => sql`upper(${coupons.code}) = ${code}`)))

        const productMap = await loadProductIdsByCoupon(rows.map((row: any) => String(row.id)))

        const counterMap = new Map<string, { reservedCount: number; consumedCount: number }>()
        if (userId && rows.length > 0) {
            const counterRows = await db
                .select({
                    couponId: couponUserCounters.couponId,
                    reservedCount: couponUserCounters.reservedCount,
                    consumedCount: couponUserCounters.consumedCount,
                })
                .from(couponUserCounters)
                .where(and(
                    eq(couponUserCounters.userId, userId),
                    inArray(couponUserCounters.couponId, rows.map((row: any) => String(row.id)))
                ))
            for (const counter of counterRows) {
                counterMap.set(String(counter.couponId), {
                    reservedCount: Number(counter.reservedCount || 0),
                    consumedCount: Number(counter.consumedCount || 0),
                })
            }
        }

        return { rows, productMap, counterMap }
    })

    const unorderedEntries = rows.map((row: any) => {
        const coupon = mapCouponRow(row, productMap.get(String(row.id)) || [])
        const counter = counterMap.get(coupon.id)
        return {
            coupon,
            runtime: {
                totalReserved: coupon.reservedCount,
                totalConsumed: coupon.consumedCount,
                userReserved: counter?.reservedCount || 0,
                userConsumed: counter?.consumedCount || 0,
            } satisfies CouponRuntimeState,
        }
    })

    const entries = orderCouponEntriesByCode(
        normalized,
        unorderedEntries,
        (entry) => entry.coupon.code
    )

    for (const entry of entries) {
        found.set(entry.coupon.code.toUpperCase(), entry.coupon)
    }

    const missing = normalized.filter((code) => !found.has(code))
    return { entries, missing }
}

// listCouponUsages 查询优惠券使用记录（服务端分页，含关联订单信息）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增使用人、状态与关联订单的联合查询。
export async function listCouponUsages(input: {
    couponId: string
    page?: number
    pageSize?: number
    status?: string
}) {
    const page = clampPage(input.page, 1)
    const pageSize = Math.min(clampPage(input.pageSize, COUPON_PAGE_SIZE_DEFAULT), COUPON_LIST_MAX_PAGE_SIZE)
    const offset = (page - 1) * pageSize

    if (!input.couponId) {
        return { items: [] as CouponUsageRow[], total: 0, page, pageSize }
    }

    await ensureDatabaseInitialized()

    const status = String(input.status || 'all')
    const whereParts: any[] = [eq(couponUsages.couponId, input.couponId)]
    if (status !== 'all') {
        whereParts.push(eq(couponUsages.status, status))
    }
    const whereExpr = and(...whereParts)

    // 查询异常上抛，避免「优惠券详情页显示 0 条使用记录」而实际是结构漂移。
    const { total, usageRows, orderMap } = await runCouponOperation(async () => {
        const [countRows, usageRows] = await Promise.all([
            db.select({ count: sql<number>`count(*)` }).from(couponUsages).where(whereExpr),
            db.select().from(couponUsages)
                .where(whereExpr)
                .orderBy(desc(couponUsages.createdAt), desc(couponUsages.sequence))
                .limit(pageSize)
                .offset(offset),
        ])

        const total = Number(countRows[0]?.count || 0)
        const orderIds = Array.from(new Set(usageRows.map((row: any) => String(row.orderId))))
        const orderMap = new Map<string, any>()
        if (orderIds.length > 0) {
            const orderRows = await db
                .select({
                    orderId: orders.orderId,
                    status: orders.status,
                    amount: orders.amount,
                    productName: orders.productName,
                    pointsUsed: orders.pointsUsed,
                    createdAt: orders.createdAt,
                })
                .from(orders)
                .where(inArray(orders.orderId, orderIds))
            for (const order of orderRows) {
                orderMap.set(String(order.orderId), order)
            }
        }

        return { total, usageRows, orderMap }
    })

    const items: CouponUsageRow[] = usageRows.map((row: any) => {
        const order = orderMap.get(String(row.orderId))
        return {
            id: String(row.id),
            couponId: String(row.couponId),
            couponCode: String(row.couponCodeSnapshot || ''),
            orderId: String(row.orderId),
            userId: row.userId ?? null,
            username: row.username ?? null,
            status: (row.status || 'reserved') as CouponUsageStatus,
            sequence: Number(row.sequence || 0),
            discountAmountCents: Number(row.discountAmountCents || 0),
            eligibleAmountCents: Number(row.eligibleAmountCents || 0),
            reservedAt: toMs(row.reservedAt),
            consumedAt: toMs(row.consumedAt),
            releasedAt: toMs(row.releasedAt),
            reversedAt: toMs(row.reversedAt),
            reason: row.reason ?? null,
            orderStatus: order?.status ?? null,
            orderAmount: order?.amount ?? null,
            orderProductName: order?.productName ?? null,
            orderPointsUsed: Number(order?.pointsUsed || 0),
            orderCreatedAt: toMs(order?.createdAt),
        }
    })

    return { items, total, page, pageSize }
}

// getCouponUsageSummary 统计优惠券的核销、预占与优惠总额
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增后台详情页使用概览统计。
export async function getCouponUsageSummary(couponId: string) {
    const empty = {
        consumedCount: 0,
        reservedCount: 0,
        releasedCount: 0,
        reversedCount: 0,
        userCount: 0,
        discountTotalCents: 0,
        orderAmountTotalCents: 0,
    }
    if (!couponId) return empty
    await ensureDatabaseInitialized()

    // 统计查询异常直接上抛。
    // 详情页会把这个失败显示为「统计不可用」而不是静默显示 0，
    // 避免结构漂移被误读成「这张券没人用过」。
    return runCouponOperation(async () => {
        const rows = await db
            .select({
                status: couponUsages.status,
                usageCount: sql<number>`count(*)`,
                discountTotal: sql<number>`coalesce(sum(${couponUsages.discountAmountCents}), 0)`,
            })
            .from(couponUsages)
            .where(eq(couponUsages.couponId, couponId))
            .groupBy(couponUsages.status)

        const result = { ...empty }
        for (const row of rows) {
            const count = Number(row.usageCount || 0)
            const discount = Number(row.discountTotal || 0)
            if (row.status === 'consumed') {
                result.consumedCount = count
                result.discountTotalCents += discount
            } else if (row.status === 'reserved') {
                result.reservedCount = count
            } else if (row.status === 'released') {
                result.releasedCount = count
            } else if (row.status === 'reversed') {
                result.reversedCount = count
                result.discountTotalCents += discount
            }
        }

        const userRows = await db
            .select({ userCount: sql<number>`count(distinct coalesce(${couponUsages.userId}, ${couponUsages.orderId}))` })
            .from(couponUsages)
            .where(and(
                eq(couponUsages.couponId, couponId),
                inArray(couponUsages.status, ['consumed', 'reversed'])
            ))
        result.userCount = Number(userRows[0]?.userCount || 0)

        return result
    })
}

export interface CouponWriteInput {
    id: string
    code: string
    name: string
    description: string | null
    discountType: CouponDiscountType
    rateBps: number | null
    discountAmountCents: number | null
    minSpendCents: number
    maxDiscountCents: number | null
    scope: CouponScope
    productIds: string[]
    totalUseLimit: number | null
    perUserLimit: number | null
    stackableWithCoupons: boolean
    stackableWithPoints: boolean
    refundPolicy: CouponRefundPolicy
    status: CouponStatus
    startsAt: number | null
    endsAt: number | null
    createdBy: string | null
}

export async function insertCoupon(input: CouponWriteInput): Promise<void> {
    await db.insert(coupons).values({
        id: input.id,
        code: input.code,
        name: input.name,
        description: input.description,
        discountType: input.discountType,
        rateBps: input.rateBps,
        discountAmountCents: input.discountAmountCents,
        minSpendCents: input.minSpendCents,
        maxDiscountCents: input.maxDiscountCents,
        scope: input.scope,
        totalUseLimit: input.totalUseLimit,
        perUserLimit: input.perUserLimit,
        reservedCount: 0,
        consumedCount: 0,
        stackableWithCoupons: input.stackableWithCoupons,
        stackableWithPoints: input.stackableWithPoints,
        refundPolicy: input.refundPolicy,
        status: input.status,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        createdBy: input.createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
    })

    await replaceCouponProducts(input.id, input.productIds)
}

export async function updateCouponRecord(input: CouponWriteInput): Promise<void> {
    await db.update(coupons).set({
        code: input.code,
        name: input.name,
        description: input.description,
        discountType: input.discountType,
        rateBps: input.rateBps,
        discountAmountCents: input.discountAmountCents,
        minSpendCents: input.minSpendCents,
        maxDiscountCents: input.maxDiscountCents,
        scope: input.scope,
        totalUseLimit: input.totalUseLimit,
        perUserLimit: input.perUserLimit,
        stackableWithCoupons: input.stackableWithCoupons,
        stackableWithPoints: input.stackableWithPoints,
        refundPolicy: input.refundPolicy,
        status: input.status,
        startsAt: input.startsAt === null ? null : new Date(input.startsAt),
        endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        updatedAt: new Date(),
    }).where(eq(coupons.id, input.id))

    await replaceCouponProducts(input.id, input.productIds)
}

export async function setCouponStatusRecord(id: string, status: CouponStatus): Promise<void> {
    await db.update(coupons).set({ status, updatedAt: new Date() }).where(eq(coupons.id, id))
}

// replaceCouponProducts 覆盖优惠券的适用商品集合
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增适用商品全量替换逻辑，避免残留失效关联。
//
// 2026-09-17 调整：从「先全删再全插」改为**集合差分**（只插缺的、只删多的）。
//   原因：`coupon_products` 没有唯一约束，旧写法一旦在 delete 之后 insert 失败
//   （例如结构漂移、请求超时），该券的适用商品会被清空且无法回滚，
//   直接表现为「编辑保存后满减券变成了全场券」。集合差分天然幂等，
//   重试与并发重入都不会丢数据。
export async function replaceCouponProducts(couponId: string, productIds: string[]): Promise<void> {
    const unique = Array.from(new Set(productIds.map((id) => String(id || '').trim()).filter(Boolean)))

    await runCouponOperation(async () => {
        const existingRows = await db
            .select({ productId: couponProducts.productId })
            .from(couponProducts)
            .where(eq(couponProducts.couponId, couponId))
        const existing = new Set(existingRows.map((row) => String(row.productId)))
        const desired = new Set(unique)

        const toInsert = unique.filter((productId) => !existing.has(productId))
        const toDelete = Array.from(existing).filter((productId) => !desired.has(productId))

        if (toInsert.length) {
            await db.insert(couponProducts).values(
                toInsert.map((productId) => ({ couponId, productId, createdAt: new Date() }))
            )
        }
        if (toDelete.length) {
            await db.delete(couponProducts).where(and(
                eq(couponProducts.couponId, couponId),
                inArray(couponProducts.productId, toDelete)
            ))
        }
    })
}

export async function deleteCouponProducts(couponId: string): Promise<void> {
    await runCouponOperation(async () => {
        await db.delete(couponProducts).where(eq(couponProducts.couponId, couponId))
    })
}

export async function deleteCouponRecord(couponId: string): Promise<void> {
    await runCouponOperation(async () => {
        await db.delete(coupons).where(eq(coupons.id, couponId))
    })
}

export async function getProductNamesByIds(productIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const unique = Array.from(new Set(productIds.filter(Boolean)))
    if (!unique.length) return map
    const rows = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, unique))
    for (const row of rows) {
        map.set(row.id, row.name)
    }
    return map
}

export async function listActiveProductOptions(): Promise<Array<{ id: string; name: string }>> {
    await ensureDatabaseInitialized()
    const rows = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .orderBy(asc(products.sortOrder), desc(products.createdAt))
    return rows.map((row) => ({ id: String(row.id), name: String(row.name || row.id) }))
}

export async function findCouponIdByCode(code: string): Promise<string | null> {
    const normalized = normalizeCouponCode(code)
    if (!normalized) return null
    // null 只表示「优惠码未被占用」；结构/查询异常上抛，避免把系统错误
    // 当成「可用优惠码」，进而在保存时撞上真实唯一约束。
    return runCouponOperation(async () => {
        const rows = await db
            .select({ id: coupons.id })
            .from(coupons)
            .where(eq(sql`upper(${coupons.code})`, normalized))
            .limit(1)
        return rows.length ? String(rows[0].id) : null
    })
}
