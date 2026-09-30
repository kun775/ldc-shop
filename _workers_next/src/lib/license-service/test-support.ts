/**
 * license-service 模块的测试支撑（**仅测试使用**）。
 *
 * 文件名不含 `.test`，因此不会被 `node --test src/lib/**\/*.test.ts` 当作测试入口，
 * 但仍在 `tsconfig.json` 的 `include` 范围内，会被 `tsc --noEmit` 检查。
 *
 * 提供两样东西：
 *   1. 一个建立在真实 SQLite（`node:sqlite`，内存库）上的 `CardServiceDatabase`，
 *      每次 `write` 用 `BEGIN/COMMIT` 包住，**任一条失败即 ROLLBACK** ——
 *      这样测试验证的是真实 SQL 与真实原子性，而不是替身对象的行为；
 *   2. 一个记录调用的假客户端，用来断言请求体、幂等键与调用次数。
 *
 * `node:sqlite` 在 `@types/node@20` 里还没有类型定义，所以这里用
 * `createRequire` 拿到运行时对象，再按自己声明的最小接口使用，避免为了
 * 一个测试帮手引入 `@ts-ignore`。
 */

import { createRequire } from 'node:module'
import { CARD_SERVICE_DDL_STATEMENTS } from '../db/license-service-schema.ts'
import type {
    CardServiceDatabase,
    CardServiceStatement,
    CardServiceWriteResult,
} from './db-port.ts'
import type { AllocationDetail, AllocationStatusUpdate, CardStatusDetail, RevokeResult } from './contract.ts'
import type { LicenseServiceClient } from './client.ts'

interface SqliteStatement {
    all(...params: unknown[]): Array<Record<string, unknown>>
    run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint }
}

interface SqliteDatabase {
    exec(sql: string): void
    prepare(sql: string): SqliteStatement
}

interface SqliteModule {
    DatabaseSync: new (path: string) => SqliteDatabase
}

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as SqliteModule

/**
 * 与 `src/lib/db/queries.ts` 中 `cards` / `orders` / `products` 的建表语句保持
 * 一致的关键列。
 *
 * `orders` 只在阶段 D（交付前 Sell 的原子批次会同时写订单行与 `cards`）里需要，
 * 但既然交付批次把三者放进同一个事务，测试就必须同时提供三者，否则验证不到
 * 「claim 丢失时整批落空」这条不变式。
 */
const CORE_TABLE_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        card_key TEXT NOT NULL,
        is_used INTEGER DEFAULT 0,
        reserved_order_id TEXT,
        reserved_at INTEGER,
        expires_at INTEGER,
        used_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        amount TEXT NOT NULL,
        email TEXT,
        status TEXT DEFAULT 'pending',
        trade_no TEXT,
        card_key TEXT,
        card_ids TEXT,
        paid_at INTEGER,
        delivered_at INTEGER,
        user_id TEXT,
        username TEXT,
        points_used INTEGER DEFAULT 0,
        quantity INTEGER DEFAULT 1 NOT NULL,
        manual_stock_quantity INTEGER DEFAULT 0 NOT NULL,
        current_payment_id TEXT,
        checkout_field_values TEXT,
        fulfillment_mode TEXT DEFAULT 'auto',
        delivery_note TEXT,
        fulfillment_claim_id TEXT,
        fulfillment_claimed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
    )`,
]

function normalizeParams(params: readonly unknown[] | undefined) {
    return (params ?? []).map((value) => (value === undefined ? null : value))
}

export interface SqliteTestContext {
    database: CardServiceDatabase
    sqlite: SqliteDatabase
    /** 直接查一行，用于断言表内容。 */
    get(sql: string, params?: readonly unknown[]): Record<string, unknown> | undefined
    all(sql: string, params?: readonly unknown[]): Array<Record<string, unknown>>
    exec(sql: string): void
    /** 让下一次 write 抛错，用于验证「整批回滚」。 */
    failNextWrite(error: Error): void
}

export function createSqliteCardServiceDatabase(): SqliteTestContext {
    const sqlite = new DatabaseSync(':memory:')
    for (const statement of CORE_TABLE_STATEMENTS) sqlite.exec(statement)
    for (const statement of CARD_SERVICE_DDL_STATEMENTS) sqlite.exec(statement)

    let pendingWriteError: Error | null = null

    const database: CardServiceDatabase = {
        async query<T>(sql: string, params?: readonly unknown[]) {
            return sqlite.prepare(sql).all(...normalizeParams(params)) as T[]
        },

        async write(statements: readonly CardServiceStatement[]): Promise<CardServiceWriteResult[]> {
            if (pendingWriteError) {
                const error = pendingWriteError
                pendingWriteError = null
                throw error
            }
            if (!statements.length) return []

            sqlite.exec('BEGIN')
            const results: CardServiceWriteResult[] = []
            try {
                for (const statement of statements) {
                    const run = sqlite.prepare(statement.sql).run(...normalizeParams(statement.params))
                    const lastRowId = Number(run.lastInsertRowid)
                    const changes = Number(run.changes)
                    results.push({
                        lastRowId: Number.isFinite(lastRowId) && lastRowId > 0 ? lastRowId : null,
                        changes: Number.isFinite(changes) ? changes : 0,
                    })
                }
                sqlite.exec('COMMIT')
            } catch (error) {
                // D1 的 batch 是「任一条失败则整批回滚」，替身必须同语义，
                // 否则「半成品」这类缺陷在测试里查不出来。
                sqlite.exec('ROLLBACK')
                throw error
            }
            return results
        },
    }

    return {
        database,
        sqlite,
        get(sql, params) {
            return sqlite.prepare(sql).all(...normalizeParams(params))[0]
        },
        all(sql, params) {
            return sqlite.prepare(sql).all(...normalizeParams(params))
        },
        exec(sql) {
            sqlite.exec(sql)
        },
        failNextWrite(error) {
            pendingWriteError = error
        },
    }
}

// ---------------------------------------------------------------------------
// 假客户端
// ---------------------------------------------------------------------------

export interface FakeClientCall {
    method: string
    args: unknown
}

export interface FakeLicenseServiceClient extends LicenseServiceClient {
    calls: FakeClientCall[]
    callCount(method: string): number
    callsOf(method: string): unknown[]
}

export interface FakeClientBehavior {
    allocate?: (input: unknown, attempt: number) => Promise<AllocationDetail>
    ack?: (input: unknown, attempt: number) => Promise<AllocationStatusUpdate>
    sell?: (input: unknown, attempt: number) => Promise<AllocationStatusUpdate>
    cancel?: (input: unknown, attempt: number) => Promise<AllocationStatusUpdate>
    getAllocation?: (allocationId: string, attempt: number) => Promise<AllocationDetail>
    listAllocations?: (query: unknown) => Promise<{ items: never[]; nextCursor: null; hasMore: false }>
    getCardStatus?: (cardId: string) => Promise<CardStatusDetail>
    revoke?: (cardId: string, input: unknown) => Promise<RevokeResult>
}

export function createFakeLicenseServiceClient(behavior: FakeClientBehavior = {}): FakeLicenseServiceClient {
    const calls: FakeClientCall[] = []
    const attempts = new Map<string, number>()

    function record(method: string, args: unknown) {
        calls.push({ method, args })
        const next = (attempts.get(method) ?? 0) + 1
        attempts.set(method, next)
        return next
    }

    function unimplemented(method: string): never {
        throw new Error(`fake client: ${method} is not stubbed`)
    }

    const client: FakeLicenseServiceClient = {
        baseUrl: 'https://lks.test',
        calls,
        callCount(method) {
            return calls.filter((call) => call.method === method).length
        },
        callsOf(method) {
            return calls.filter((call) => call.method === method).map((call) => call.args)
        },

        async allocate(input) {
            const attempt = record('allocate', input)
            if (!behavior.allocate) return unimplemented('allocate')
            return behavior.allocate(input, attempt)
        },
        async ack(input) {
            const attempt = record('ack', input)
            if (!behavior.ack) return unimplemented('ack')
            return behavior.ack(input, attempt)
        },
        async sell(input) {
            const attempt = record('sell', input)
            if (!behavior.sell) return unimplemented('sell')
            return behavior.sell(input, attempt)
        },
        async cancel(input) {
            const attempt = record('cancel', input)
            if (!behavior.cancel) return unimplemented('cancel')
            return behavior.cancel(input, attempt)
        },
        async getAllocation(allocationId) {
            const attempt = record('getAllocation', allocationId)
            if (!behavior.getAllocation) return unimplemented('getAllocation')
            return behavior.getAllocation(allocationId, attempt)
        },
        async listAllocations(query = {}) {
            record('listAllocations', query)
            if (!behavior.listAllocations) return unimplemented('listAllocations')
            return behavior.listAllocations(query)
        },
        async getCardStatus(cardId) {
            record('getCardStatus', cardId)
            if (!behavior.getCardStatus) return unimplemented('getCardStatus')
            return behavior.getCardStatus(cardId)
        },
        async revoke(cardId, input) {
            record('revoke', { cardId, input })
            if (!behavior.revoke) return unimplemented('revoke')
            return behavior.revoke(cardId, input)
        },
    }

    return client
}

/** 构造一份合法的分配详情，字段与中心响应一致。 */
export function makeAllocationDetail(overrides: Partial<AllocationDetail> = {}): AllocationDetail {
    const quantity = overrides.quantity ?? 1
    const createdAtMs = overrides.createdAtMs ?? Date.parse('2026-09-22T08:00:00.000Z')
    return {
        allocationId: overrides.allocationId ?? 'all_01K0000000000000000000001',
        programId: overrides.programId ?? 'prog_01K0000000000000000000001',
        programKey: overrides.programKey ?? 'bill-service',
        externalRef: overrides.externalRef ?? '',
        status: overrides.status ?? 'allocated',
        quantity,
        cards: overrides.cards ?? Array.from({ length: quantity }, (_, index) => ({
            id: `card_01K000000000000000000000${index + 1}`,
            key: `CS-7K2M-9XPT-4WQH-8CDE-3NR${index}`,
            maskedKey: `CS-7K2M-****-****-3NR${index}`,
        })),
        expiresAtMs: overrides.expiresAtMs ?? Date.parse('2026-09-22T08:30:00.000Z'),
        createdAtMs,
        acknowledgedAtMs: overrides.acknowledgedAtMs ?? null,
    }
}
