import { db } from "@/lib/db"
import { loginUsers, orders, products, settings, userPointLedger } from "@/lib/db/schema"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import {
    applyAdminPointAdjustment,
    applyAutomaticPointEvent,
    type PointLedgerRecord,
    type PointLedgerRepository,
} from "./ledger-service"
import { buildLegacyPointLedgerEntries } from "./legacy-reconciliation"
import { createAsyncOnceState, ensureOnce, isSchemaVersionSatisfied, parseSchemaVersion } from "@/lib/runtime/async-once"

type UserIdentity = {
    userId: string
    username?: string | null
    email?: string | null
}

type AutomaticPointEventInput = {
    userId: string
    username?: string | null
    email?: string | null
    eventType: "checkin_reward" | "order_deduction" | "refund_return"
    delta: number
    businessKey: string
    sourceType: string
    sourceId?: string | null
    reason: string
    metadata?: string | null
}

type ManualPointAdjustmentInput = {
    userId: string
    username?: string | null
    email?: string | null
    direction: "increase" | "decrease"
    amount: number
    reason: string
    operatorUserId: string | null
    operatorUsername: string | null
    businessKey: string
}

let pointLedgerSchemaReady = false
let pointLedgerLoginUsersSchemaReady = false
const pointLedgerSchemaState = createAsyncOnceState()
const pointLedgerLoginUsersState = createAsyncOnceState()
const persistedPointLedgerSchemaVersionState = createAsyncOnceState()
const POINT_LEDGER_SCHEMA_VERSION = 1

const TIMESTAMP_MS_THRESHOLD = 1_000_000_000_000
let persistedPointLedgerSchemaVersion: number | null = null

function primePointLedgerSchemaVersion(version: number | null) {
    persistedPointLedgerSchemaVersion = version
    persistedPointLedgerSchemaVersionState.ready = true
    persistedPointLedgerSchemaVersionState.pending = null
}

function markPointLedgerSchemaReady(version: number = POINT_LEDGER_SCHEMA_VERSION) {
    primePointLedgerSchemaVersion(version)
    pointLedgerSchemaReady = true
    pointLedgerLoginUsersSchemaReady = true
}

async function getPointLedgerSchemaVersion() {
    if (persistedPointLedgerSchemaVersionState.ready) {
        return persistedPointLedgerSchemaVersion
    }

    await ensureOnce(persistedPointLedgerSchemaVersionState, async () => {
        persistedPointLedgerSchemaVersion = parseSchemaVersion(await getSettingValue("point_ledger_schema_version"))
    })

    return persistedPointLedgerSchemaVersion
}

async function hasCurrentPointLedgerSchema() {
    const version = await getPointLedgerSchemaVersion()
    if (version !== null && isSchemaVersionSatisfied(version, POINT_LEDGER_SCHEMA_VERSION)) {
        markPointLedgerSchemaReady(version)
        return true
    }
    return false
}

function normalizeTimestampMs(column: any) {
    return sql<number>`CASE WHEN ${column} < ${TIMESTAMP_MS_THRESHOLD} THEN ${column} * 1000 ELSE ${column} END`
}

async function safeAddColumn(table: string, column: string, definition: string) {
    try {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`))
    } catch (error: any) {
        const errorString = (JSON.stringify(error) + String(error) + (error?.message || '')).toLowerCase()
        if (!errorString.includes('duplicate column')) {
            throw error
        }
    }
}

async function ensureSettingsTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
}

async function getSettingValue(key: string) {
    await ensureSettingsTable()
    const rows = await db.select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
    return rows[0]?.value ?? null
}

async function setSettingValue(key: string, value: string) {
    await ensureSettingsTable()
    await db.insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
        })
    if (key === "point_ledger_schema_version") {
        primePointLedgerSchemaVersion(parseSchemaVersion(value))
    }
}

async function getProductVariantLabels(productIds: string[]) {
    const ids = Array.from(new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean)))
    if (!ids.length) return {} as Record<string, string | null>

    const rows = await db.select({
        id: products.id,
        variantLabel: products.variantLabel,
    })
        .from(products)
        .where(inArray(products.id, ids))

    const output: Record<string, string | null> = {}
    for (const row of rows) {
        output[row.id] = row.variantLabel?.trim() || null
    }
    return output
}

async function ensurePointLedgerLoginUsersSchema() {
    if (pointLedgerLoginUsersSchemaReady) return
    if (await hasCurrentPointLedgerSchema()) return

    await ensureOnce(pointLedgerLoginUsersState, async () => {
        await db.run(sql`
            CREATE TABLE IF NOT EXISTS login_users (
                user_id TEXT PRIMARY KEY,
                username TEXT,
                email TEXT,
                points INTEGER DEFAULT 0 NOT NULL,
                is_blocked INTEGER DEFAULT 0,
                desktop_notifications_enabled INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (unixepoch() * 1000),
                last_login_at INTEGER DEFAULT (unixepoch() * 1000),
                last_checkin_at INTEGER,
                consecutive_days INTEGER DEFAULT 0
            )
        `)

        await safeAddColumn('login_users', 'email', 'TEXT')
        await safeAddColumn('login_users', 'points', 'INTEGER DEFAULT 0 NOT NULL')
        await safeAddColumn('login_users', 'is_blocked', 'INTEGER DEFAULT 0')
        await safeAddColumn('login_users', 'desktop_notifications_enabled', 'INTEGER DEFAULT 0')
        await safeAddColumn('login_users', 'created_at', 'INTEGER DEFAULT (unixepoch() * 1000)')
        await safeAddColumn('login_users', 'last_login_at', 'INTEGER DEFAULT (unixepoch() * 1000)')
        await safeAddColumn('login_users', 'last_checkin_at', 'INTEGER')
        await safeAddColumn('login_users', 'consecutive_days', 'INTEGER DEFAULT 0')

        pointLedgerLoginUsersSchemaReady = true
    })
}

/**
 * ensureUserPointLedgerSchema 确保积分账本表与索引存在。
 *
 * 参数:
 *   - 无
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化积分账本 D1 表结构。
 */
export async function ensureUserPointLedgerSchema() {
    if (pointLedgerSchemaReady) return
    await ensureOnce(pointLedgerSchemaState, async () => {
        if (await hasCurrentPointLedgerSchema()) {
            return
        }

        await ensurePointLedgerLoginUsersSchema()

        await db.run(sql`
            CREATE TABLE IF NOT EXISTS user_point_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                delta INTEGER NOT NULL,
                balance_after INTEGER,
                business_key TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id TEXT,
                reason TEXT NOT NULL,
                operator_user_id TEXT,
                operator_username TEXT,
                metadata TEXT,
                status TEXT NOT NULL DEFAULT 'completed',
                created_at INTEGER DEFAULT (unixepoch() * 1000)
            )
        `)
        await db.run(sql`
            CREATE UNIQUE INDEX IF NOT EXISTS user_point_ledger_business_key_uq
            ON user_point_ledger (business_key)
        `)
        await db.run(sql`
            CREATE INDEX IF NOT EXISTS user_point_ledger_user_created_idx
            ON user_point_ledger (user_id, created_at DESC, id DESC)
        `)

        await setSettingValue("point_ledger_schema_version", String(POINT_LEDGER_SCHEMA_VERSION))
        markPointLedgerSchemaReady()
    })
}

/**
 * ensurePointLedgerUserRecord 确保积分账本相关用户记录存在。
 *
 * 参数:
 *   - identity UserIdentity: 顾客身份信息
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化积分账本用户兜底写入逻辑。
 */
export async function ensurePointLedgerUserRecord(identity: UserIdentity) {
    if (!identity.userId) return

    await ensurePointLedgerLoginUsersSchema()
    await db.insert(loginUsers).values({
        userId: identity.userId,
        username: identity.username ?? null,
        email: identity.email ?? null,
        points: 0,
        createdAt: new Date(),
        lastLoginAt: new Date(),
    }).onConflictDoNothing()
}

/**
 * mapLedgerRow 将数据库行映射为账本记录对象。
 *
 * 参数:
 *   - row any: 数据库返回行
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化账本记录映射逻辑。
 */
function mapLedgerRow(row: any): PointLedgerRecord {
    return {
        id: Number(row.id),
        userId: row.userId,
        eventType: row.eventType as PointLedgerRecord["eventType"],
        delta: Number(row.delta || 0),
        businessKey: row.businessKey,
        sourceType: row.sourceType,
        sourceId: row.sourceId ?? null,
        reason: row.reason,
        operatorUserId: row.operatorUserId ?? null,
        operatorUsername: row.operatorUsername ?? null,
        metadata: row.metadata ?? null,
        balanceAfter: row.balanceAfter === null || row.balanceAfter === undefined ? null : Number(row.balanceAfter),
        status: row.status === "pending" ? "pending" : "completed",
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    }
}

/**
 * createPointLedgerRepository 创建积分账本数据库仓储。
 *
 * 参数:
 *   - identity UserIdentity: 顾客身份信息
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化积分账本数据库仓储实现。
 */
function createPointLedgerRepository(identity: UserIdentity): PointLedgerRepository {
    const readyState = createAsyncOnceState()
    const ensureReady = async () => {
        await ensureOnce(readyState, async () => {
            await ensureUserPointLedgerSchema()
            await ensurePointLedgerUserRecord(identity)
        })
    }

    return {
        async getCurrentBalance(userId) {
            await ensureReady()
            const row = await db.query.loginUsers.findFirst({
                where: eq(loginUsers.userId, userId),
                columns: { points: true },
            })
            return Number(row?.points || 0)
        },
        async findByBusinessKey(businessKey) {
            await ensureReady()
            const row = await db.query.userPointLedger.findFirst({
                where: eq(userPointLedger.businessKey, businessKey),
            })
            return row ? mapLedgerRow(row) : null
        },
        async claimAutomaticEvent(input) {
            await ensureReady()

            const inserted = await db.insert(userPointLedger).values({
                userId: input.userId,
                eventType: input.eventType,
                delta: input.delta,
                balanceAfter: null,
                businessKey: input.businessKey,
                sourceType: input.sourceType,
                sourceId: input.sourceId ?? null,
                reason: input.reason,
                operatorUserId: null,
                operatorUsername: null,
                metadata: input.metadata ?? null,
                status: "pending",
                createdAt: new Date(),
            }).onConflictDoNothing().returning({ id: userPointLedger.id })

            const record = await this.findByBusinessKey(input.businessKey)
            return { claimed: inserted.length > 0, record }
        },
        async applyBalanceDelta(userId, delta) {
            await ensureReady()

            const updated = await db.update(loginUsers)
                .set({ points: sql`${loginUsers.points} + ${delta}` })
                .where(and(
                    eq(loginUsers.userId, userId),
                    sql`${loginUsers.points} + ${delta} >= 0`,
                ))
                .returning({ balanceAfter: loginUsers.points })

            if (!updated.length) {
                return { ok: false }
            }

            return {
                ok: true,
                balanceAfter: Number(updated[0].balanceAfter || 0),
            }
        },
        async finalizeAutomaticEvent(id, patch) {
            await ensureReady()

            const rows = await db.update(userPointLedger)
                .set({
                    balanceAfter: patch.balanceAfter,
                    status: "completed",
                })
                .where(eq(userPointLedger.id, id))
                .returning()

            if (!rows.length) {
                throw new Error("POINT_LEDGER_NOT_FOUND")
            }

            return mapLedgerRow(rows[0])
        },
        async rollbackAutomaticEvent(id) {
            await ensureReady()
            await db.delete(userPointLedger)
                .where(and(
                    eq(userPointLedger.id, id),
                    eq(userPointLedger.status, "pending"),
                ))
        },
        async insertManualAdjustment(input) {
            await ensureReady()

            const existing = await this.findByBusinessKey(input.businessKey)
            if (existing) {
                return existing
            }

            const balanceResult = await this.applyBalanceDelta(input.userId, input.delta)
            if (!balanceResult.ok) {
                throw new Error("POINT_BALANCE_NEGATIVE")
            }

            try {
                const rows = await db.insert(userPointLedger).values({
                    userId: input.userId,
                    eventType: "admin_adjust",
                    delta: input.delta,
                    balanceAfter: balanceResult.balanceAfter,
                    businessKey: input.businessKey,
                    sourceType: "admin",
                    sourceId: input.sourceId ?? null,
                    reason: input.reason,
                    operatorUserId: input.operatorUserId,
                    operatorUsername: input.operatorUsername,
                    metadata: input.metadata ?? null,
                    status: "completed",
                    createdAt: new Date(),
                }).returning()

                if (!rows.length) {
                    throw new Error("POINT_LEDGER_INSERT_FAILED")
                }

                return mapLedgerRow(rows[0])
            } catch (error) {
                await this.applyBalanceDelta(input.userId, -input.delta)
                throw error
            }
        },
    }
}

/**
 * applyUserAutomaticPointEvent 落地自动积分事件到账本。
 *
 * 参数:
 *   - input AutomaticPointEventInput: 自动积分事件输入
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化自动积分账本落库入口。
 */
export async function applyUserAutomaticPointEvent(input: AutomaticPointEventInput) {
    const repo = createPointLedgerRepository({
        userId: input.userId,
        username: input.username ?? null,
        email: input.email ?? null,
    })

    return applyAutomaticPointEvent(repo, input)
}

/**
 * applyUserManualPointAdjustment 落地后台积分调整到账本。
 *
 * 参数:
 *   - input ManualPointAdjustmentInput: 后台积分调整输入
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化后台积分调整落库入口。
 */
export async function applyUserManualPointAdjustment(input: ManualPointAdjustmentInput) {
    const repo = createPointLedgerRepository({
        userId: input.userId,
        username: input.username ?? null,
        email: input.email ?? null,
    })

    return applyAdminPointAdjustment(repo, input)
}

/**
 * ensureUserPointLedgerHistory 确保用户历史积分流水已回填。
 *
 * 参数:
 *   - userId string: 顾客 ID
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化历史积分回填逻辑。
 */
export async function ensureUserPointLedgerHistory(userId: string) {
    if (!userId) return

    await ensureUserPointLedgerSchema()
    const settingKey = `user_point_ledger_backfill:${userId}`
    const backfilled = await getSettingValue(settingKey)
    if (backfilled === "1") {
        return
    }

    const [user, existingStatsRows, orderRows] = await Promise.all([
        db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, userId),
            columns: { points: true },
        }),
        db.select({
            deltaSum: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
            earliestCreatedAt: sql<number>`MIN(${normalizeTimestampMs(userPointLedger.createdAt)})`,
        })
            .from(userPointLedger)
            .where(eq(userPointLedger.userId, userId)),
        db.select({
            orderId: orders.orderId,
            pointsUsed: orders.pointsUsed,
            refunded: sql<boolean>`${orders.status} = 'refunded'`,
            createdAt: normalizeTimestampMs(orders.createdAt),
        })
            .from(orders)
            .where(and(
                eq(orders.userId, userId),
                sql`COALESCE(${orders.pointsUsed}, 0) > 0`,
            ))
            .orderBy(normalizeTimestampMs(orders.createdAt)),
    ])

    const currentPoints = Number(user?.points || 0)
    const existingDeltaSum = Number(existingStatsRows[0]?.deltaSum || 0)
    const earliestCreatedAt = existingStatsRows[0]?.earliestCreatedAt
        ? Number(existingStatsRows[0].earliestCreatedAt)
        : null
    const lastHistoricalCreatedAt = orderRows.length
        ? Number(orderRows[orderRows.length - 1]?.createdAt || 0)
        : 0

    const initializationCreatedAt = earliestCreatedAt
        ? Math.max(0, Math.min(earliestCreatedAt - 1, Math.max(lastHistoricalCreatedAt + 1, 0)))
        : undefined

    const legacyEntries = buildLegacyPointLedgerEntries({
        userId,
        currentPoints: currentPoints - existingDeltaSum,
        orderRows: orderRows.map((row) => ({
            orderId: row.orderId,
            pointsUsed: Number(row.pointsUsed || 0),
            refunded: !!row.refunded,
            createdAt: Number(row.createdAt || 0),
        })),
        initializationCreatedAt,
    })

    for (const entry of legacyEntries) {
        await db.insert(userPointLedger).values({
            userId: entry.userId,
            eventType: entry.eventType,
            delta: entry.delta,
            balanceAfter: entry.balanceAfter,
            businessKey: entry.businessKey,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            reason: entry.reason,
            operatorUserId: null,
            operatorUsername: null,
            metadata: null,
            status: "completed",
            createdAt: new Date(entry.createdAt),
        }).onConflictDoNothing()
    }

    await setSettingValue(settingKey, "1")
}

/**
 * getAdminUserDetail 查询后台顾客详情页所需数据。
 *
 * 参数:
 *   - userId string: 顾客 ID
 *   - options object: 分页参数
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化后台顾客详情聚合查询逻辑。
 */
export async function getAdminUserDetail(
    userId: string,
    options?: {
        ledgerPage?: number
        ledgerPageSize?: number
        orderPage?: number
        orderPageSize?: number
    },
) {
    const ledgerPage = Math.max(1, Number(options?.ledgerPage || 1))
    const ledgerPageSize = Math.max(1, Number(options?.ledgerPageSize || 20))
    const orderPage = Math.max(1, Number(options?.orderPage || 1))
    const orderPageSize = Math.max(1, Number(options?.orderPageSize || 20))

    await ensureUserPointLedgerSchema()

    let userRow = await db.select({
        userId: loginUsers.userId,
        username: loginUsers.username,
        email: loginUsers.email,
        points: loginUsers.points,
        isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
        createdAt: loginUsers.createdAt,
        lastLoginAt: loginUsers.lastLoginAt,
        orderCount: sql<number>`COUNT(${orders.orderId})`,
    })
        .from(loginUsers)
        .leftJoin(orders, eq(loginUsers.userId, orders.userId))
        .where(eq(loginUsers.userId, userId))
        .groupBy(loginUsers.userId)

    if (!userRow.length) {
        const orderFallback = await db.query.orders.findFirst({
            where: eq(orders.userId, userId),
            columns: {
                userId: true,
                username: true,
                email: true,
            },
        })
        if (orderFallback?.userId) {
            await ensurePointLedgerUserRecord({
                userId: orderFallback.userId,
                username: orderFallback.username,
                email: orderFallback.email,
            })
            userRow = await db.select({
                userId: loginUsers.userId,
                username: loginUsers.username,
                email: loginUsers.email,
                points: loginUsers.points,
                isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
                createdAt: loginUsers.createdAt,
                lastLoginAt: loginUsers.lastLoginAt,
                orderCount: sql<number>`COUNT(${orders.orderId})`,
            })
                .from(loginUsers)
                .leftJoin(orders, eq(loginUsers.userId, orders.userId))
                .where(eq(loginUsers.userId, userId))
                .groupBy(loginUsers.userId)
        }
    }

    if (!userRow.length) {
        return null
    }

    await ensureUserPointLedgerHistory(userId)

    const ledgerOffset = (ledgerPage - 1) * ledgerPageSize
    const orderOffset = (orderPage - 1) * orderPageSize

    const [ledgerItems, ledgerCountRes, legacyInitRes, orderItems, orderCountRes] = await Promise.all([
        db.select()
            .from(userPointLedger)
            .where(eq(userPointLedger.userId, userId))
            .orderBy(desc(normalizeTimestampMs(userPointLedger.createdAt)), desc(userPointLedger.id))
            .limit(ledgerPageSize)
            .offset(ledgerOffset),
        db.select({ count: sql<number>`COUNT(*)` })
            .from(userPointLedger)
            .where(eq(userPointLedger.userId, userId)),
        db.select({ count: sql<number>`COUNT(*)` })
            .from(userPointLedger)
            .where(and(
                eq(userPointLedger.userId, userId),
                eq(userPointLedger.sourceId, "legacy_balance_init"),
            )),
        db.select({
            orderId: orders.orderId,
            productId: orders.productId,
            productName: orders.productName,
            amount: orders.amount,
            status: orders.status,
            email: orders.email,
            tradeNo: orders.tradeNo,
            cardKey: orders.cardKey,
            pointsUsed: orders.pointsUsed,
            quantity: orders.quantity,
            createdAt: orders.createdAt,
            paidAt: orders.paidAt,
            deliveredAt: orders.deliveredAt,
        })
            .from(orders)
            .where(eq(orders.userId, userId))
            .orderBy(desc(normalizeTimestampMs(orders.createdAt)))
            .limit(orderPageSize)
            .offset(orderOffset),
        db.select({ count: sql<number>`COUNT(*)` })
            .from(orders)
            .where(eq(orders.userId, userId)),
    ])

    const variantLabels = await getProductVariantLabels(orderItems.map((item) => item.productId).filter(Boolean))

    return {
        user: {
            ...userRow[0],
            points: Number(userRow[0].points || 0),
            orderCount: Number(userRow[0].orderCount || 0),
        },
        ledger: {
            items: ledgerItems.map((item) => mapLedgerRow(item)),
            total: Number(ledgerCountRes[0]?.count || 0),
            page: ledgerPage,
            pageSize: ledgerPageSize,
        },
        orders: {
            items: orderItems.map((item) => ({
                ...item,
                pointsUsed: Number(item.pointsUsed || 0),
                quantity: Number(item.quantity || 1),
                productVariantLabel: item.productId ? variantLabels[item.productId] ?? null : null,
            })),
            total: Number(orderCountRes[0]?.count || 0),
            page: orderPage,
            pageSize: orderPageSize,
        },
        hasLegacyBalanceInit: Number(legacyInitRes[0]?.count || 0) > 0,
    }
}
