import { randomUUID } from "crypto"
import { db, execD1 } from "@/lib/db"
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
import { LOGIN_USERS_COLUMN_DEFINITIONS, LOGIN_USERS_CREATE_TABLE_STATEMENT } from "@/lib/db/login-users-schema"
import { isEmptySchemaError, isDuplicateColumnError, isDuplicateSchemaObjectError } from "@/lib/db/error-utils"
import {
    evaluatePointLedgerStructure,
    LOGIN_USERS_POINT_INDEX_STATEMENTS,
    LOGIN_USERS_POINT_NORMALIZE_STATEMENTS,
    USER_POINT_LEDGER_BALANCE_TRIGGER_NAME,
    USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT,
    USER_POINT_LEDGER_COLUMN_DEFINITIONS,
    USER_POINT_LEDGER_CREATE_TABLE_STATEMENT,
    USER_POINT_LEDGER_INDEX_STATEMENTS,
    USER_POINT_LEDGER_TABLE,
    type PointLedgerStructureSnapshot,
} from "@/lib/db/point-ledger-schema"

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
const POINT_LEDGER_SCHEMA_VERSION = 3
const POINT_LEDGER_CLAIM_TTL_MS = 5 * 60 * 1000

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

function normalizeTimestampMs(column: any) {
    return sql<number>`CASE WHEN ${column} < ${TIMESTAMP_MS_THRESHOLD} THEN ${column} * 1000 ELSE ${column} END`
}

/** 兼容 D1/drizzle 两种返回形状（results / rows），统一取数组 */
function rowsFromResult<T>(result: unknown): T[] {
    const value = result as { results?: T[]; rows?: T[] }
    return value?.results || value?.rows || []
}

async function safeAddColumn(table: string, column: string, definition: string) {
    try {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`))
    } catch (error: unknown) {
        if (!isDuplicateColumnError(error)) throw error
    }
}

async function safeCreateIndex(statement: string) {
    try {
        await db.run(sql.raw(statement))
    } catch (error: unknown) {
        if (isDuplicateSchemaObjectError(error)) return
        throw error
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

    await ensureOnce(pointLedgerLoginUsersState, async () => {
        await db.run(sql.raw(LOGIN_USERS_CREATE_TABLE_STATEMENT))
        for (const [column, definition] of LOGIN_USERS_COLUMN_DEFINITIONS) {
            await safeAddColumn('login_users', column, definition)
        }
        for (const statement of LOGIN_USERS_POINT_INDEX_STATEMENTS) {
            await safeCreateIndex(statement)
        }

        pointLedgerLoginUsersSchemaReady = true
    })
}

/**
 * readPointLedgerStructure 只读探测积分账本结构。
 *
 * 全部为只读查询，任何一步失败都原样抛出 —— 由调用方决定是否升级为修复，
 * 这里绝不吞异常（否则「探测失败」会被误判成「结构完整」）。
 */
async function readPointLedgerStructure(): Promise<PointLedgerStructureSnapshot> {
    const [tableResult, columnResult, indexResult, triggerResult] = await Promise.all([
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = ${USER_POINT_LEDGER_TABLE}
            LIMIT 1
        `),
        db.run(sql.raw(`PRAGMA table_info(${USER_POINT_LEDGER_TABLE})`)),
        db.run(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = ${USER_POINT_LEDGER_TABLE}
        `),
        db.run(sql`
            SELECT sql FROM sqlite_master
            WHERE type = 'trigger' AND name = ${USER_POINT_LEDGER_BALANCE_TRIGGER_NAME}
            LIMIT 1
        `),
    ])

    const tables = rowsFromResult<{ name?: unknown }>(tableResult)
    const columns = rowsFromResult<{ name?: unknown }>(columnResult)
    const indexes = rowsFromResult<{ name?: unknown }>(indexResult)
    const triggers = rowsFromResult<{ sql?: unknown }>(triggerResult)

    return {
        tableExists: tables.length > 0,
        columns: columns.map((row) => String(row.name || '')),
        indexes: indexes.map((row) => String(row.name || '')),
        triggerSql: triggers.length > 0 ? String(triggers[0].sql || '') : null,
    }
}

/**
 * repairPointLedgerStructure 幂等修复积分账本结构（无条件执行 DDL）。
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-09-17
 *   - 更新内容: 修复「版本标记领先于真实结构」导致的缺列故障；
 *     改为按只读探测结果精确修复，并校验余额触发器的守卫是否完整。
 *
 * 铁律:
 *   - **不**用版本号短路 DDL。`point_ledger_schema_version` 会被手工置位，
 *     版本领先真实结构时缺列将永久无法自愈。所有语句都是幂等的。
 *   - 触发器只在「不存在」或「缺少余额守卫」时重建：`CREATE TRIGGER IF NOT
 *     EXISTS` 对已存在的触发器是空操作，因此旧版本触发器必须显式 DROP。
 *   - 版本号只在未达标时写入，避免每 isolate 一次无谓写操作。
 */
async function repairPointLedgerStructure(): Promise<number> {
    const persistedVersion = await getPointLedgerSchemaVersion()
    const versionSatisfied = persistedVersion !== null
        && isSchemaVersionSatisfied(persistedVersion, POINT_LEDGER_SCHEMA_VERSION)

    await ensurePointLedgerLoginUsersSchema()

    // 先探测，再按需修复：探测失败（例如瞬时网络错误）会向上抛出，
    // 不会退化成「无条件重跑一遍 DDL」。
    const snapshot = await readPointLedgerStructure()
    const verdict = evaluatePointLedgerStructure(snapshot)

    if (!snapshot.tableExists) {
        await db.run(sql.raw(USER_POINT_LEDGER_CREATE_TABLE_STATEMENT))
    }
    for (const [column, definition] of USER_POINT_LEDGER_COLUMN_DEFINITIONS) {
        if (!snapshot.tableExists || verdict.missingColumns.includes(column)) {
            await safeAddColumn(USER_POINT_LEDGER_TABLE, column, definition)
        }
    }
    for (const statement of USER_POINT_LEDGER_INDEX_STATEMENTS) {
        await safeCreateIndex(statement)
    }

    if (verdict.triggerNeedsRebuild) {
        // 旧触发器可能缺少余额守卫 → 无条件重建，保证定义体是当前版本
        try {
            await db.run(sql.raw(`DROP TRIGGER IF EXISTS ${USER_POINT_LEDGER_BALANCE_TRIGGER_NAME}`))
        } catch (dropError) {
            console.error('Failed to drop legacy point ledger balance trigger:', dropError)
            throw dropError
        }
    }
    try {
        await execD1(USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT)
    } catch (triggerError) {
        // 并发场景下另一个 isolate 可能刚创建了同名触发器 → 幂等冲突可忽略
        if (!isDuplicateSchemaObjectError(triggerError)) {
            console.error("Failed to create user_point_ledger_apply_balance trigger:", triggerError)
            throw triggerError
        }
    }

    // 后置校验：`execD1` 曾因触发器体内的嵌套 `CASE ... END` 被 D1 的语句
    // 切分器误判而**静默地**建不出触发器（返回 incomplete input，或解析成
    // 一条不完整的语句而不报错）。触发器缺失会让 `verifyPointLedgerStructure()`
    // 恒为 false，进而让漂移探测恒为 true、三个升级项在每个请求上重跑并失败，
    // 把首页与后台拖到 30s 以上。
    //
    // 因此这里必须确认触发器**真的存在**，缺失时改走 `db.run`（与 manual_stock /
    // coupon 触发器同一条已被线上验证可用的路径）再试一次。两条路径都失败才抛错，
    // 保证「结构修复」不会以静默失败收场、演变成每请求重试的死循环。
    if (!(await hasPointLedgerBalanceTrigger())) {
        console.warn('[PointLedger] balance trigger missing after execD1, retrying via db.run')
        try {
            await db.run(sql.raw(USER_POINT_LEDGER_BALANCE_TRIGGER_STATEMENT))
        } catch (retryError) {
            if (!isDuplicateSchemaObjectError(retryError)) throw retryError
        }
        if (!(await hasPointLedgerBalanceTrigger())) {
            throw new Error('POINT_LEDGER_BALANCE_TRIGGER_CREATE_FAILED')
        }
    }

    // 历史 NULL 余额归零。必须在触发器就绪之后执行：否则触发器的
    // COALESCE 会把一次「本该失败」的扣减当作对 0 余额的扣减，
    // 而规范化本身也需要在同一轮修复里完成，才能让后续调整正常工作。
    for (const statement of LOGIN_USERS_POINT_NORMALIZE_STATEMENTS) {
        await db.run(sql.raw(statement))
    }

    if (!versionSatisfied) {
        await setSettingValue("point_ledger_schema_version", String(POINT_LEDGER_SCHEMA_VERSION))
    }
    markPointLedgerSchemaReady()

    return verdict.complete ? 0 : 1
}

/**
 * hasPointLedgerBalanceTrigger 只读确认余额触发器是否真的存在于数据库中。
 *
 * 用于 `repairPointLedgerStructure` 的后置校验：语句「执行未报错」并不等于
 * 结构已就绪（D1 的语句切分器可能把 CREATE TRIGGER 解析成一条不完整语句），
 * 必须回到 sqlite_master 核实。
 */
async function hasPointLedgerBalanceTrigger(): Promise<boolean> {
    const result = await db.run(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = ${USER_POINT_LEDGER_BALANCE_TRIGGER_NAME}
        LIMIT 1
    `)
    return rowsFromResult<{ name?: unknown }>(result).length > 0
}

/**
 * isPointLedgerReady 供外部（结构漂移探测）查询当前 isolate 是否已确认账本结构。
 */
export function isPointLedgerSchemaReady(): boolean {
    return pointLedgerSchemaReady
}

/**
 * verifyPointLedgerStructure 只读校验账本结构是否完整（不执行任何 DDL）。
 *
 * 供 `detectSchemaDrift` 这类「先探测、后决定是否迁移」的路径使用。
 */
export async function verifyPointLedgerStructure(): Promise<boolean> {
    try {
        const snapshot = await readPointLedgerStructure()
        return evaluatePointLedgerStructure(snapshot).complete
    } catch (error) {
        // 探测失败（网络/限流/超时）不构成「结构缺失」的证据，按完整处理，
        // 避免把一次偶发故障升级为一次全量迁移。
        if (isEmptySchemaError(error)) return true
        console.warn('[PointLedger] structure verification failed:', error)
        return true
    }
}

/**
 * repairPointLedgerStructureIfNeeded 按探测结果修复，完整时零 DDL。
 *
 * 与 `ensureUserPointLedgerSchema` 的区别：本函数**不依赖 isolate 级 ready
 * 标记**，用于结构漂移路径下的强制复查。
 */
export async function repairPointLedgerStructureIfNeeded(): Promise<boolean> {
    const repaired = await repairPointLedgerStructure()
    return repaired > 0
}

/**
 * ensureUserPointLedgerSchema 确保积分账本表、索引与余额触发器存在。
 *
 * 参数:
 *   - force: 跳过 isolate 级 ready 标记，强制重新探测并修复（漂移路径使用）
 */
export async function ensureUserPointLedgerSchema(options?: { force?: boolean }) {
    if (options?.force) {
        await repairPointLedgerStructure()
        return
    }
    if (pointLedgerSchemaReady) return
    await ensureOnce(pointLedgerSchemaState, async () => {
        await repairPointLedgerStructure()
    })
}

/**
 * resetPointLedgerSchemaReady 复位 isolate 级结构标记。
 *
 * 用于结构漂移路径：全局快速路径可能已把账本标记为 ready，
 * 必须先复位，否则 ensureUserPointLedgerSchema 会被短路而无法修复。
 */
export function resetPointLedgerSchemaReady() {
    pointLedgerSchemaReady = false
    pointLedgerLoginUsersSchemaReady = false
    pointLedgerSchemaState.ready = false
    pointLedgerSchemaState.pending = null
    pointLedgerLoginUsersState.ready = false
    pointLedgerLoginUsersState.pending = null
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
        claimId: row.claimId ?? null,
        claimedAt: row.claimedAt
            ? (row.claimedAt instanceof Date ? row.claimedAt : new Date(row.claimedAt))
            : null,
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

            const claimId = randomUUID()
            const now = new Date()
            const staleBefore = new Date(now.getTime() - POINT_LEDGER_CLAIM_TTL_MS)
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
                claimId,
                claimedAt: now,
                createdAt: now,
            }).onConflictDoNothing().returning({ id: userPointLedger.id })

            let claimed = inserted.length > 0
            if (!claimed) {
                const reclaimed = await db.update(userPointLedger)
                    .set({ claimId, claimedAt: now })
                    .where(and(
                        eq(userPointLedger.businessKey, input.businessKey),
                        eq(userPointLedger.status, "pending"),
                        sql`(${userPointLedger.claimedAt} IS NULL OR ${userPointLedger.claimedAt} < ${staleBefore.getTime()})`,
                    ))
                    .returning({ id: userPointLedger.id })
                claimed = reclaimed.length > 0
            }

            const record = await this.findByBusinessKey(input.businessKey)
            return { claimed, claimId: claimed ? claimId : null, record }
        },
        async finalizeAutomaticEvent(id, claimId) {
            await ensureReady()

            const rows = await db.update(userPointLedger)
                .set({
                    // balanceAfter 必须 COALESCE：历史 NULL 余额下
                    // `NULL + delta` 会写入 NULL 明细，前台显示为「变动后余额 -」，
                    // 与触发器实际把余额归零再加减的结果不一致。
                    balanceAfter: sql`(
                        SELECT COALESCE(points, 0) + ${userPointLedger.delta}
                        FROM login_users
                        WHERE user_id = ${userPointLedger.userId}
                    )`,
                    status: "completed",
                    claimId: null,
                    claimedAt: null,
                })
                .where(and(
                    eq(userPointLedger.id, id),
                    eq(userPointLedger.status, "pending"),
                    eq(userPointLedger.claimId, claimId),
                ))
                .returning()

            if (!rows.length) {
                throw new Error("POINT_LEDGER_CLAIM_LOST")
            }

            return mapLedgerRow(rows[0])
        },
        async rollbackAutomaticEvent(id, claimId) {
            await ensureReady()
            await db.delete(userPointLedger)
                .where(and(
                    eq(userPointLedger.id, id),
                    eq(userPointLedger.status, "pending"),
                    eq(userPointLedger.claimId, claimId),
                ))
        },
        async claimManualAdjustment(input) {
            await ensureReady()

            const claimId = randomUUID()
            const now = new Date()
            const staleBefore = new Date(now.getTime() - POINT_LEDGER_CLAIM_TTL_MS)
            const inserted = await db.insert(userPointLedger).values({
                userId: input.userId,
                eventType: "admin_adjust",
                delta: input.delta,
                balanceAfter: null,
                businessKey: input.businessKey,
                sourceType: "admin",
                sourceId: input.sourceId ?? null,
                reason: input.reason,
                operatorUserId: input.operatorUserId,
                operatorUsername: input.operatorUsername,
                metadata: input.metadata ?? null,
                status: "pending",
                claimId,
                claimedAt: now,
                createdAt: now,
            }).onConflictDoNothing().returning({ id: userPointLedger.id })

            let claimed = inserted.length > 0
            if (!claimed) {
                const reclaimed = await db.update(userPointLedger)
                    .set({ claimId, claimedAt: now })
                    .where(and(
                        eq(userPointLedger.businessKey, input.businessKey),
                        eq(userPointLedger.status, "pending"),
                        sql`(${userPointLedger.claimedAt} IS NULL OR ${userPointLedger.claimedAt} < ${staleBefore.getTime()})`,
                    ))
                    .returning({ id: userPointLedger.id })
                claimed = reclaimed.length > 0
            }

            const record = await this.findByBusinessKey(input.businessKey)
            return { claimed, claimId: claimed ? claimId : null, record }
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
        nickname: loginUsers.nickname,
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
                nickname: loginUsers.nickname,
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
