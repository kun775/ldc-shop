import { db, runAtomicD1Batch } from "./index";
import { products, cards, orders, settings, reviews, reviewReplies, loginUsers, categories, userNotifications, wishlistItems, wishlistVotes, userPointLedger, refundRequests, userMessages } from "./schema";
import { INFINITE_STOCK, LOGIN_HEARTBEAT_TTL_MS, RESERVATION_TTL_MS } from "@/lib/constants";
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord, ensureUserPointLedgerSchema, repairPointLedgerStructureIfNeeded, resetPointLedgerSchemaReady, verifyPointLedgerStructure } from "@/lib/points/ledger-db";
import { USER_POINT_LEDGER_REBUILD_STATEMENTS } from "@/lib/db/point-ledger-schema";
import {
    repairAuditErrorIdStructureIfNeeded,
    repairAuditStructureIfNeeded,
    resetAuditSchemaReady,
    verifyAuditBaseStructure,
    verifyAuditStructure,
} from "@/lib/audit/service";
import { createAsyncOnceState, createAsyncTtlCache, ensureOnce, parseSchemaVersion } from "@/lib/runtime/async-once";
import {
    BASELINE_SCHEMA_DRIFT_PROBES,
    DELIVERY_FILE_DOWNLOAD_SCHEMA_DRIFT_PROBES,
    POINT_LEDGER_HISTORY_SCHEMA_DRIFT_PROBES,
    PRODUCT_COUPON_RESTRICTION_SCHEMA_DRIFT_PROBES,
    RATE_LIMIT_SCHEMA_DRIFT_PROBES,
    isSchemaDriftError,
} from "./schema-drift";
import {
    COUPON_COUNTER_RECONCILIATION_STATEMENTS,
    COUPON_USAGE_TRIGGER_NAMES,
    COUPON_USAGE_TRIGGER_STATEMENTS,
} from "@/lib/coupons/counter-triggers";
import { MANUAL_STOCK_TRIGGER_NAMES, MANUAL_STOCK_TRIGGER_STATEMENTS } from "@/lib/manual-stock-triggers";
import { LOGIN_USERS_COLUMN_DEFINITIONS, LOGIN_USERS_CREATE_TABLE_STATEMENT } from "./login-users-schema";
import { collectErrorText, isDuplicateColumnError, isDuplicateSchemaObjectError } from "./error-utils";
import { isManualFulfillment, resolveProductStockCount } from "@/lib/product-stock";
import { RATE_LIMIT_EXPIRES_INDEX_NAME, resetRateLimitSchemaReady } from "@/lib/rate-limit";
import { RATE_LIMIT_DDL_STATEMENTS } from "./rate-limit-schema";
import { executeDatabaseUpgrades, ensureDatabaseMigrationsTable, readDatabaseUpgradeStatus } from "./database-upgrades";
import { supportsRegisteredDatabaseUpgrades, type DatabaseUpgradeHealth } from "./database-upgrade-registry";
import { isMissingRelationError } from "./schema-errors";
import { canonicalGitHubUserId, isSameGitHubAccount } from "@/lib/github-identity";
import { buildLoginUserMergeStatements } from "./user-merge";
import { getCustomerActivityThresholds } from "@/lib/customer-activity";
import { eq, sql, desc, and, asc, gte, or, inArray, lte, isNull } from "drizzle-orm";
import { updateTag, revalidatePath } from "next/cache";
import { cache } from "react";

// Database initialization state
let dbInitialized = false;
let loginUsersSchemaReady = false;
let wishlistTablesReady = false;
const CURRENT_SCHEMA_VERSION = 36;
const dbInitializationState = createAsyncOnceState();
const databaseUpgradePreparationState = createAsyncOnceState();
const persistedSchemaVersionState = createAsyncOnceState();
type ColumnEnsureKey = 'products' | 'orders' | 'cards' | 'loginUsers';
const columnEnsureState: Record<ColumnEnsureKey, { ready: boolean; pending: Promise<void> | null }> = {
    products: { ready: false, pending: null },
    orders: { ready: false, pending: null },
    cards: { ready: false, pending: null },
    loginUsers: { ready: false, pending: null },
};
const reviewRepliesEnsureState = { ready: false, pending: null as Promise<void> | null };
// reviews 表此前由 src/actions/reviews.ts 在每次提交/回复时裸跑 CREATE TABLE。
// 这里收敛为 isolate 级一次性的 ensure*，让写入路径不再重复发 DDL。
const reviewsEnsureState = { ready: false, pending: null as Promise<void> | null };
let persistedSchemaVersion: number | null = null;

/** reviews(order_id) 唯一索引名：0035 升级项、写入路径 ensure 与结构校验共用 */
export const REVIEW_ORDER_ID_UNIQUE_INDEX = 'reviews_order_id_uq';

function primePersistedSchemaVersion(version: number | null) {
    persistedSchemaVersion = version;
    persistedSchemaVersionState.ready = true;
    persistedSchemaVersionState.pending = null;
}

function markCurrentSchemaReady(version: number = CURRENT_SCHEMA_VERSION) {
    primePersistedSchemaVersion(version);
    dbInitialized = true;
    dbInitializationState.ready = true;
    loginUsersSchemaReady = true;
    wishlistTablesReady = true;
    reviewRepliesEnsureState.ready = true;
    reviewRepliesEnsureState.pending = null;
    reviewsEnsureState.ready = true;
    reviewsEnsureState.pending = null;

    for (const key of Object.keys(columnEnsureState) as ColumnEnsureKey[]) {
        columnEnsureState[key].ready = true;
        columnEnsureState[key].pending = null;
    }
}

// resetSchemaReadyFlags 复位所有「已就绪」标记
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-09-17
//   - 更新内容: 新增漂移修复路径所需的标记复位，使各 ensure* 真正执行 DDL。
//
// 说明: 全局快速路径会把各 ensure* 标记为 ready。探测到结构漂移后必须先复位，
// 才能让本次增量迁移重新执行所有幂等 DDL。
function resetSchemaReadyFlags() {
    dbInitialized = false;
    dbInitializationState.ready = false;
    loginUsersSchemaReady = false;
    wishlistTablesReady = false;
    reviewRepliesEnsureState.ready = false;
    reviewRepliesEnsureState.pending = null;
    reviewsEnsureState.ready = false;
    reviewsEnsureState.pending = null;
    // 积分账本和审计模块各自维护 isolate 级 ready 标记；管理员在同一
    // isolate 内继续执行独立升级项时必须重新探测，不能沿用旧就绪状态。
    resetPointLedgerSchemaReady();
    resetAuditSchemaReady();
    resetRateLimitSchemaReady();

    for (const key of Object.keys(columnEnsureState) as ColumnEnsureKey[]) {
        columnEnsureState[key].ready = false;
        columnEnsureState[key].pending = null;
    }
}

async function verifyBaselineDatabaseStructure(): Promise<boolean> {
    for (const probe of BASELINE_SCHEMA_DRIFT_PROBES) {
        try {
            await db.run(sql.raw(probe));
        } catch (error: unknown) {
            if (isSchemaDriftError(error)) return false;
        }
    }

    try {
        const result = await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'trigger'`);
        const queryResult = result as unknown as {
            results?: Array<{ name?: unknown }>;
            rows?: Array<{ name?: unknown }>;
        };
        const rows = queryResult.results || queryResult.rows || [];
        const triggerNames = new Set(rows.map((row) => String(row.name || '')));
        return !(
            COUPON_USAGE_TRIGGER_NAMES.some((name) => !triggerNames.has(name))
            || MANUAL_STOCK_TRIGGER_NAMES.some((name) => !triggerNames.has(name))
        );
    } catch (error: unknown) {
        return !isSchemaDriftError(error);
    }
}

async function verifyDeliveryFileDownloadStructure(): Promise<boolean> {
    for (const probe of DELIVERY_FILE_DOWNLOAD_SCHEMA_DRIFT_PROBES) {
        try {
            await db.run(sql.raw(probe));
        } catch (error: unknown) {
            if (isSchemaDriftError(error)) return false;
        }
    }
    return true;
}

async function preservePointLedgerHistory() {
    const tables = await db.all(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('user_point_ledger', 'user_point_ledger_nocascade')
    `) as Array<{ name?: string }>
    const tableNames = new Set(tables.map((row) => row.name).filter(Boolean))

    // Recover an interrupted pre-atomic migration that dropped the original
    // table after copying its rows but failed before the rename.
    if (!tableNames.has('user_point_ledger') && tableNames.has('user_point_ledger_nocascade')) {
        await db.run(sql.raw(`ALTER TABLE user_point_ledger_nocascade RENAME TO user_point_ledger`))
        resetPointLedgerSchemaReady()
        await repairPointLedgerStructureIfNeeded()
        return
    }
    if (!tableNames.has('user_point_ledger')) {
        resetPointLedgerSchemaReady()
        await repairPointLedgerStructureIfNeeded()
        return
    }

    const foreignKeys = await db.all(sql`PRAGMA foreign_key_list(user_point_ledger)`) as Array<{ table?: string }>
    const cascadesFromUsers = foreignKeys.some((row) => row.table === 'login_users')
    if (!cascadesFromUsers) {
        if (tableNames.has('user_point_ledger_nocascade')) {
            await db.run(sql.raw(`DROP TABLE user_point_ledger_nocascade`))
        }
        return
    }

    await runAtomicD1Batch(USER_POINT_LEDGER_REBUILD_STATEMENTS.map((query) => ({ query })))
    resetPointLedgerSchemaReady()
    await repairPointLedgerStructureIfNeeded()
}

async function verifyPointLedgerHistoryStructure(): Promise<boolean> {
    try {
        const foreignKeys = await db.all(sql`PRAGMA foreign_key_list(user_point_ledger)`) as Array<{ table?: string }>
        if (foreignKeys.some((row) => row.table === 'login_users')) return false
    } catch (error: unknown) {
        if (isSchemaDriftError(error)) return false
    }

    for (const probe of POINT_LEDGER_HISTORY_SCHEMA_DRIFT_PROBES) {
        try {
            await db.run(sql.raw(probe))
        } catch (error: unknown) {
            if (isSchemaDriftError(error)) return false
        }
    }
    return true
}

async function verifyProductCouponRestrictionStructure(): Promise<boolean> {
    for (const probe of PRODUCT_COUPON_RESTRICTION_SCHEMA_DRIFT_PROBES) {
        try {
            await db.run(sql.raw(probe));
        } catch (error: unknown) {
            if (isSchemaDriftError(error)) return false;
        }
    }
    return true;
}

/** indexExists 按名查询 sqlite_master 中的索引（索引无法用 SELECT LIMIT 0 探测）。 */
async function indexExists(indexName: string): Promise<boolean> {
    const rows = await db.all(sql`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${indexName}
    `) as Array<{ name?: string }>
    return rows.some((row) => row.name === indexName)
}

async function verifyReviewOrderIdStructure(): Promise<boolean> {
    try {
        return await indexExists(REVIEW_ORDER_ID_UNIQUE_INDEX)
    } catch (error: unknown) {
        return !isSchemaDriftError(error)
    }
}

async function verifyRateLimitStructure(): Promise<boolean> {
    for (const probe of RATE_LIMIT_SCHEMA_DRIFT_PROBES) {
        try {
            await db.run(sql.raw(probe))
        } catch (error: unknown) {
            if (isSchemaDriftError(error)) return false
        }
    }

    try {
        return await indexExists(RATE_LIMIT_EXPIRES_INDEX_NAME)
    } catch (error: unknown) {
        return !isSchemaDriftError(error)
    }
}

async function verifyDatabaseUpgradeStructures(): Promise<DatabaseUpgradeHealth> {
    const [
        baseline,
        pointLedger,
        auditBase,
        auditCurrent,
        deliveryFileDownload,
        productCouponRestriction,
        pointLedgerHistory,
        reviewOrderId,
        rateLimit,
    ] = await Promise.all([
        verifyBaselineDatabaseStructure(),
        verifyPointLedgerStructure(),
        verifyAuditBaseStructure(),
        verifyAuditStructure(),
        verifyDeliveryFileDownloadStructure(),
        verifyProductCouponRestrictionStructure(),
        verifyPointLedgerHistoryStructure(),
        verifyReviewOrderIdStructure(),
        verifyRateLimitStructure(),
    ]);
    return {
        '0028_database_upgrade_registry': baseline,
        '0029_point_ledger_balance_trigger': pointLedger,
        '0030_audit_infrastructure': auditBase,
        '0031_audit_error_id_lookup': auditCurrent,
        '0032_delivery_file_download_tracking': deliveryFileDownload,
        '0033_product_coupon_restriction': productCouponRestriction,
        '0034_point_ledger_preserve_history': pointLedgerHistory,
        '0035_review_order_id_unique': reviewOrderId,
        '0036_rate_limit_counters': rateLimit,
    };
}

async function getPersistedSchemaVersion(): Promise<number | null> {
    if (persistedSchemaVersionState.ready) {
        return persistedSchemaVersion;
    }

    await ensureOnce(persistedSchemaVersionState, async () => {
        try {
            persistedSchemaVersion = parseSchemaVersion(await getSetting('schema_version'));
        } catch {
            persistedSchemaVersion = null;
        }
    });

    return persistedSchemaVersion;
}


async function ensureColumnsOnce(key: ColumnEnsureKey, task: () => Promise<void>) {
    const state = columnEnsureState[key];
    if (state.ready) return;
    if (state.pending) {
        await state.pending;
        return;
    }
    const pending = (async () => {
        await task();
        state.ready = true;
    })();
    state.pending = pending;
    try {
        await pending;
    } finally {
        state.pending = null;
    }
}

async function ensureCardKeyDuplicatesAllowed() {
    try {
        await db.run(sql`DROP INDEX IF EXISTS cards_product_id_card_key_uq;`);
    } catch {
        // best effort
    }
}

async function safeAddColumn(table: string, column: string, definition: string) {
    try {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
    } catch (error: unknown) {
        // Ignore "duplicate column" errors in SQLite / Cloudflare D1
        if (isDuplicateColumnError(error)) return;
        throw error;
    }
}

async function ensureIndexes() {
    // ... existing index logic unchanged ...
    const indexStatements = [
        `CREATE INDEX IF NOT EXISTS products_active_sort_idx ON products(is_active, sort_order, created_at)`,
        `CREATE INDEX IF NOT EXISTS products_stock_count_idx ON products(stock_count)`,
        `CREATE INDEX IF NOT EXISTS products_sold_count_idx ON products(sold_count)`,
        `CREATE INDEX IF NOT EXISTS cards_product_used_reserved_idx ON cards(product_id, is_used, reserved_at)`,
        `CREATE INDEX IF NOT EXISTS cards_reserved_order_idx ON cards(reserved_order_id)`,
        `CREATE INDEX IF NOT EXISTS cards_expires_at_idx ON cards(expires_at)`,
        `CREATE INDEX IF NOT EXISTS orders_status_paid_at_idx ON orders(status, paid_at)`,
        `CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders(status, created_at)`,
        `CREATE INDEX IF NOT EXISTS orders_user_status_created_at_idx ON orders(user_id, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS orders_product_status_idx ON orders(product_id, status)`,
        `CREATE INDEX IF NOT EXISTS reviews_product_created_at_idx ON reviews(product_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS review_replies_review_created_idx ON review_replies(review_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS refund_requests_order_id_idx ON refund_requests(order_id)`,
        `CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx ON user_notifications(user_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS user_notifications_user_read_idx ON user_notifications(user_id, is_read, created_at)`,
        `CREATE INDEX IF NOT EXISTS admin_messages_created_idx ON admin_messages(created_at)`,
        `CREATE INDEX IF NOT EXISTS user_messages_read_created_idx ON user_messages(is_read, created_at)`,
        `CREATE INDEX IF NOT EXISTS user_messages_user_created_idx ON user_messages(user_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS broadcast_messages_created_idx ON broadcast_messages(created_at)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS broadcast_reads_message_user_uq ON broadcast_reads(message_id, user_id)`,
        `CREATE INDEX IF NOT EXISTS broadcast_reads_user_idx ON broadcast_reads(user_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS wishlist_items_created_idx ON wishlist_items(created_at)`,
        `CREATE INDEX IF NOT EXISTS wishlist_votes_item_idx ON wishlist_votes(item_id, created_at)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS wishlist_votes_item_user_uq ON wishlist_votes(item_id, user_id)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS login_users_github_username_uq ON login_users(lower(username)) WHERE username IS NOT NULL AND lower(username) LIKE 'gh_%'`,
    ];

    // ... rest of ensureIndexes ...
    try {
        await db.run(sql`
            DELETE FROM broadcast_reads 
            WHERE id NOT IN (
                SELECT MIN(id) 
                FROM broadcast_reads 
                GROUP BY message_id, user_id
            )
        `);
    } catch {
    }

    for (const statement of indexStatements) {
        try {
            await db.run(sql.raw(statement));
        } catch (e: any) {
            const errorString = (JSON.stringify(e) + String(e) + (e?.message || '')).toLowerCase();
            if (errorString.includes('no such table') || errorString.includes('does not exist')) {
                continue;
            }
            if (errorString.includes('already exists') || errorString.includes('constraint failed')) {
                continue;
            }
            throw e;
        }
    }
}

async function ensureReviewRepliesTable() {
    if (reviewRepliesEnsureState.ready) return;
    if (reviewRepliesEnsureState.pending) {
        await reviewRepliesEnsureState.pending;
        return;
    }

    const pending = (async () => {
        try {
            await db.run(sql`
                CREATE TABLE IF NOT EXISTS review_replies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL,
                    username TEXT NOT NULL,
                    comment TEXT NOT NULL,
                    created_at INTEGER DEFAULT (unixepoch() * 1000)
                )
            `)
            reviewRepliesEnsureState.ready = true;
        } catch {
            // best effort
        }
    })();

    reviewRepliesEnsureState.pending = pending;
    try {
        await pending;
    } finally {
        reviewRepliesEnsureState.pending = null;
    }
}

// reviews 建表语句。与基线 DDL、升级项共用同一段结构，避免三处漂移。
const REVIEWS_CREATE_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
)`

// ensureReviewsTable 创建 reviews 表并尽力建立 order_id 唯一索引。
//
// 元数据:
//   - 作者: 达不溜
//   - 创建时间: 2026-09-24
//   - 更新内容: 取代 src/actions/reviews.ts 里每次提交都裸跑的 CREATE TABLE。
//
// 说明: 唯一索引在**存在历史重复行**时会创建失败（SQLite 不允许在重复值上建唯一索引），
// 此时不抛错、留给升级项 0035 先去重再建，保证写入路径不会因为脏数据而不可用。
export async function ensureReviewsTable() {
    if (reviewsEnsureState.ready) return;
    if (reviewsEnsureState.pending) {
        await reviewsEnsureState.pending;
        return;
    }

    const pending = (async () => {
        try {
            await db.run(sql.raw(REVIEWS_CREATE_TABLE_STATEMENT))
        } catch (error: unknown) {
            // 建表失败必须暴露：没有表，评价功能彻底不可用。
            if (!isDuplicateSchemaObjectError(error)) throw error;
        }
        await ensureReviewsOrderIdIndex();
        reviewsEnsureState.ready = true;
    })();

    reviewsEnsureState.pending = pending;
    try {
        await pending;
    } finally {
        reviewsEnsureState.pending = null;
    }
}

/**
 * ensureReviewsOrderIdIndex 幂等创建 reviews(order_id) 唯一索引。
 *
 * 返回是否已建立索引。失败（历史重复行）时返回 false，由升级项 0035 负责去重建。
 */
async function ensureReviewsOrderIdIndex(): Promise<boolean> {
    try {
        await db.run(sql.raw(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${REVIEW_ORDER_ID_UNIQUE_INDEX} ON reviews(order_id)`
        ));
        return true;
    } catch (error: unknown) {
        console.warn(
            '[Schema] reviews(order_id) unique index not applied; upgrade 0035 will dedupe then retry',
            error,
        );
        return false;
    }
}

/**
 * dedupeAndIndexReviewsOrderId 归并同一订单的历史重复评价并建立唯一索引。
 *
 * 升级项 0035 的执行体：先删除 order_id 重复行（保留 id 最小的一条，即最早提交的那条），
 * 再建立唯一索引。两步都幂等，可安全重复执行。
 */
async function dedupeAndIndexReviewsOrderId() {
    try {
        await db.run(sql`
            DELETE FROM reviews
            WHERE id NOT IN (
                SELECT MIN(id) FROM reviews GROUP BY order_id
            )
        `)
    } catch (error: unknown) {
        if (!isSchemaDriftError(error)) throw error
    }
    await db.run(sql.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${REVIEW_ORDER_ID_UNIQUE_INDEX} ON reviews(order_id)`
    ));
}

// ensureRateLimitStructureObjects 创建限流计数表与过期索引（升级项 0036 的执行体）。
// DDL 与 src/lib/rate-limit.ts 的请求路径 ensure 共用同一份常量。
async function ensureRateLimitStructureObjects() {
    resetRateLimitSchemaReady();
    for (const statement of RATE_LIMIT_DDL_STATEMENTS) {
        await db.run(sql.raw(statement));
    }
}

// ensureStructuralSchema 确保所有表、列与索引等结构对象存在（全部幂等）。
// 只能从管理员手动升级路径调用，普通页面访问不得触发此函数。
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-09-17
//   - 更新内容: 从普通请求初始化中隔离，仅供管理员手动升级与漂移修复使用。
async function ensureStructuralSchema() {
    await ensureDatabaseMigrationsTable();
    await ensureProductsColumns();
    await ensureOrdersColumns();
    await ensureManualStockTriggers();
    await ensureOrderDeliveryFilesTable();
    await ensureCouponTables();
    await ensureCardsColumns();
    await ensureCardKeyDuplicatesAllowed();
    await ensureReviewsTable();
    await ensureReviewRepliesTable();
    await ensureLoginUsersTable();
    await ensureLoginUsersColumns();
    loginUsersSchemaReady = true;
    await ensureUserNotificationsTable();
    await ensureAdminMessagesTable();
    await ensureUserMessagesTable();
    await ensureBroadcastTables();
    await ensureWishlistTables();
}

async function runRegisteredDatabaseUpgrades() {
    return executeDatabaseUpgrades({
        executors: {
            async '0028_database_upgrade_registry'({ structureHealthy }) {
                if (!structureHealthy) {
                    resetSchemaReadyFlags();
                    await ensureStructuralSchema();
                    await ensureIndexes();
                }
            },
            async '0029_point_ledger_balance_trigger'() {
                // 独立升级项：只重建积分账本结构与余额触发器。
                // 不复用 ensureStructuralSchema —— 那会连带重跑全部表/列/索引，
                // 在 D1 上代价过高，而本次修复范围明确限定在积分账本。
                // repairPointLedgerStructureIfNeeded 内部会先做只读探测，
                // 结构完整时零 DDL，因此可安全重复执行。
                resetPointLedgerSchemaReady();
                await repairPointLedgerStructureIfNeeded();
            },
            async '0030_audit_infrastructure'() {
                // 独立升级项：只创建审计两张表与索引。
                // 与 0029 同一理由 —— 不复用 ensureStructuralSchema，避免
                // 为一个新增表在 D1 上重跑全部结构 DDL。
                // repairAuditStructureIfNeeded 先只读探测，完整时零 DDL。
                resetAuditSchemaReady();
                await repairAuditStructureIfNeeded();
            },
            async '0031_audit_error_id_lookup'() {
                await repairAuditErrorIdStructureIfNeeded();
            },
            async '0032_delivery_file_download_tracking'() {
                await safeAddColumn('order_delivery_files', 'downloaded_at', 'INTEGER');
            },
            async '0033_product_coupon_restriction'() {
                await safeAddColumn('products', 'coupon_usage_restriction', "TEXT NOT NULL DEFAULT 'all'");
            },
            async '0034_point_ledger_preserve_history'() {
                await preservePointLedgerHistory();
            },
            async '0035_review_order_id_unique'() {
                // 独立升级项：只处理 reviews(order_id) 的唯一性。
                // 不复用 ensureStructuralSchema —— 那会连带重跑全部表/列/索引 DDL。
                await dedupeAndIndexReviewsOrderId();
            },
            async '0036_rate_limit_counters'() {
                // 独立升级项：只创建限流计数表与过期索引。
                await ensureRateLimitStructureObjects();
            },
        },
        verifyStructures: verifyDatabaseUpgradeStructures,
    });
}

export async function getDatabaseUpgradeStatus() {
    return readDatabaseUpgradeStatus(await verifyDatabaseUpgradeStructures());
}

export async function runPendingDatabaseUpgrades() {
    await prepareDatabaseForManualUpgrade();
    const result = await runRegisteredDatabaseUpgrades();
    const status = await getDatabaseUpgradeStatus();
    if (!result.failed && status.structureHealthy) {
        await setSetting('schema_version', String(CURRENT_SCHEMA_VERSION));
        markCurrentSchemaReady();
    }
    return { result, status };
}

// 仅由管理员点击“执行待升级项”时调用。这里保留历史数据库的基线补齐和
// 全新数据库初始化能力，但绝不能从首页或普通业务请求调用。
async function prepareDatabaseForManualUpgrade() {
    await ensureOnce(databaseUpgradePreparationState, async () => {
        const persistedVersion = await getPersistedSchemaVersion();
        const registeredUpgradeSupported = supportsRegisteredDatabaseUpgrades(persistedVersion);

        let tableExists = false;
        try {
            // Quick check if products table exists
            await db.run(sql`SELECT 1 FROM products LIMIT 1`);
            tableExists = true;
        } catch (error: unknown) {
            if (!isMissingRelationError(error)) throw error;
            tableExists = false;
        }

        if (tableExists) {
            if (registeredUpgradeSupported) {
                // schema 27+ 的数据库已经具备注册升级基线，具体升级由
                // runPendingDatabaseUpgrades() 在管理员操作后统一执行。
                return;
            }

            // IMPORTANT: Existing installations must never fall through to the
            // first-run bootstrap when an incremental migration fails.
            try {
                await ensureStructuralSchema();
                await migrateTimestampColumnsToMs();
                await migrateMalformedGitHubUserIds();
                await migrateGitHubUsersDedupAndCanonicalize();
                await ensureIndexes();
                await backfillProductAggregates();
            } catch (migrationError) {
                console.error("Manual database baseline migration failed:", migrationError);
                resetSchemaReadyFlags();
                throw migrationError;
            }
            return;
        }
        console.log("First run detected, initializing database...");

        await db.run(sql`
        -- Products table
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            price TEXT NOT NULL,
            compare_at_price TEXT,
            category TEXT,
            image TEXT,
            product_images TEXT,
            is_hot INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            is_shared INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            purchase_limit INTEGER,
            purchase_warning TEXT,
            visibility_level INTEGER DEFAULT -1,
            point_discount_enabled INTEGER DEFAULT 0,
            point_discount_percent INTEGER DEFAULT 0,
            manual_stock_count INTEGER NOT NULL DEFAULT 0,
            stock_count INTEGER DEFAULT 0,
            locked_count INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000),
            variant_group_id TEXT,
            variant_label TEXT,
            purchase_questions TEXT,
            checkout_fields TEXT,
            fulfillment_mode TEXT DEFAULT 'auto',
            coupon_usage_restriction TEXT NOT NULL DEFAULT 'all'
        );
        
        -- Cards (stock) table
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            card_key TEXT NOT NULL,
            is_used INTEGER DEFAULT 0,
            reserved_order_id TEXT,
            reserved_at INTEGER,
            expires_at INTEGER,
            used_at INTEGER,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        
        -- Orders table
        CREATE TABLE IF NOT EXISTS orders (
            order_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            product_name TEXT NOT NULL,
            amount TEXT NOT NULL,
            email TEXT,
            payee TEXT,
            status TEXT DEFAULT 'pending',
            trade_no TEXT,
            card_key TEXT,
            card_ids TEXT,
            paid_at INTEGER,
            delivered_at INTEGER,
            user_id TEXT,
            username TEXT,
            points_used INTEGER DEFAULT 0,
            quantity INTEGER DEFAULT 1,
            manual_stock_quantity INTEGER NOT NULL DEFAULT 0,
            current_payment_id TEXT,
            checkout_field_values TEXT,
            fulfillment_mode TEXT DEFAULT 'auto',
            delivery_note TEXT,
            fulfillment_claim_id TEXT,
            fulfillment_claimed_at INTEGER,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        CREATE TABLE IF NOT EXISTS order_delivery_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            storage TEXT NOT NULL,
            object_key TEXT,
            content BLOB,
            downloaded_at INTEGER,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX IF NOT EXISTS order_delivery_files_order_id_idx ON order_delivery_files(order_id);
        
        -- Login users table
        CREATE TABLE IF NOT EXISTS login_users (
            user_id TEXT PRIMARY KEY,
            username TEXT,
            nickname TEXT,
            email TEXT,
            points INTEGER DEFAULT 0,
            is_blocked INTEGER DEFAULT 0,
            desktop_notifications_enabled INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000),
            last_login_at INTEGER DEFAULT (unixepoch() * 1000),
            last_checkin_at INTEGER,
            consecutive_days INTEGER DEFAULT 0
        );
        
        -- Daily checkins table
        CREATE TABLE IF NOT EXISTS daily_checkins_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        
        -- Settings table
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        
        -- Categories table
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000),
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name);
        
        -- Reviews table
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            order_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            rating INTEGER NOT NULL,
            comment TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        CREATE TABLE IF NOT EXISTS review_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            comment TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        
        -- Refund requests table
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

        -- User notifications table
        CREATE TABLE IF NOT EXISTS user_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title_key TEXT NOT NULL,
            content_key TEXT NOT NULL,
            data TEXT,
            is_read INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- Admin messages table
        CREATE TABLE IF NOT EXISTS admin_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_value TEXT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sender TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- User messages table
        CREATE TABLE IF NOT EXISTS user_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            username TEXT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- Broadcast messages
        CREATE TABLE IF NOT EXISTS broadcast_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sender TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- Broadcast read receipts
        CREATE TABLE IF NOT EXISTS broadcast_reads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- Wishlist items
        CREATE TABLE IF NOT EXISTS wishlist_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            user_id TEXT,
            username TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        -- Wishlist votes
        CREATE TABLE IF NOT EXISTS wishlist_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS wishlist_votes_item_user_uq ON wishlist_votes(item_id, user_id);

        -- 订单评价唯一索引（升级项 0035）：全新库不存在重复行，可直接建。
        CREATE UNIQUE INDEX IF NOT EXISTS reviews_order_id_uq ON reviews(order_id);

        -- 写入口限流计数表（升级项 0036）
        CREATE TABLE IF NOT EXISTS rate_limit_counters (
            bucket TEXT NOT NULL,
            subject TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (bucket, subject, window_start)
        );
        CREATE INDEX IF NOT EXISTS rate_limit_counters_expires_idx ON rate_limit_counters(expires_at);
    `);

        await migrateTimestampColumnsToMs();
        await migrateMalformedGitHubUserIds();
        await migrateGitHubUsersDedupAndCanonicalize();
        await ensureIndexes();
        await ensureOrderDeliveryFilesTable();
        await ensureCouponTables();
        await ensureManualStockTriggers();
        await ensureUserPointLedgerSchema({ force: true });
        await ensureDatabaseMigrationsTable();
        await backfillProductAggregates();
        console.log("Database baseline initialized; registered upgrades are pending administrator execution");
    });
}

// 普通请求只确认基础业务表可读，不执行任何注册升级、DDL 或 schema 版本写入。
// 数据库尚未初始化时，管理员必须先在 /admin/database 手动执行升级。
export async function ensureDatabaseInitialized() {
    if (dbInitialized) return;

    await ensureOnce(dbInitializationState, async () => {
        try {
            await db.run(sql`SELECT 1 FROM products LIMIT 1`);
        } catch (error: unknown) {
            if (!isMissingRelationError(error)) throw error;
            throw new Error('DATABASE_NOT_INITIALIZED: run upgrades from /admin/database', { cause: error });
        }
        dbInitialized = true;
    });
}

async function ensureProductsColumns() {
    await ensureColumnsOnce('products', async () => {
        await safeAddColumn('products', 'compare_at_price', 'TEXT');
        await safeAddColumn('products', 'is_hot', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'purchase_warning', 'TEXT');
        await safeAddColumn('products', 'is_shared', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'visibility_level', 'INTEGER DEFAULT -1');
        await safeAddColumn('products', 'point_discount_enabled', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'point_discount_percent', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'manual_stock_count', 'INTEGER NOT NULL DEFAULT 0');
        await safeAddColumn('products', 'stock_count', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'locked_count', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'sold_count', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'rating', 'REAL DEFAULT 0');
        await safeAddColumn('products', 'review_count', 'INTEGER DEFAULT 0');
        await safeAddColumn('products', 'variant_group_id', 'TEXT');
        await safeAddColumn('products', 'variant_label', 'TEXT');
        await safeAddColumn('products', 'purchase_questions', 'TEXT');
        await safeAddColumn('products', 'product_images', 'TEXT');
        await safeAddColumn('products', 'checkout_fields', 'TEXT');
        await safeAddColumn('products', 'fulfillment_mode', "TEXT DEFAULT 'auto'");
        await safeAddColumn('products', 'coupon_usage_restriction', "TEXT NOT NULL DEFAULT 'all'");
    });
}

async function ensureOrdersColumns() {
    await ensureColumnsOnce('orders', async () => {
        await safeAddColumn('orders', 'points_used', 'INTEGER DEFAULT 0 NOT NULL');
        await safeAddColumn('orders', 'current_payment_id', 'TEXT');
        await safeAddColumn('orders', 'payee', 'TEXT');
        await safeAddColumn('orders', 'card_ids', 'TEXT');
        await safeAddColumn('orders', 'checkout_field_values', 'TEXT');
        await safeAddColumn('orders', 'fulfillment_mode', "TEXT DEFAULT 'auto'");
        await safeAddColumn('orders', 'delivery_note', 'TEXT');
        await safeAddColumn('orders', 'fulfillment_claim_id', 'TEXT');
        await safeAddColumn('orders', 'fulfillment_claimed_at', 'INTEGER');
        await safeAddColumn('orders', 'subtotal_amount_cents', 'INTEGER');
        await safeAddColumn('orders', 'coupon_discount_amount_cents', 'INTEGER DEFAULT 0');
        await safeAddColumn('orders', 'points_discount_amount_cents', 'INTEGER DEFAULT 0');
        await safeAddColumn('orders', 'pricing_snapshot', 'TEXT');
        await safeAddColumn('orders', 'manual_stock_quantity', 'INTEGER NOT NULL DEFAULT 0');
    });
}

export async function ensureProductWriteSchema() {
    await ensureProductsColumns();
}

async function ensureManualStockTriggers() {
    for (const statement of MANUAL_STOCK_TRIGGER_STATEMENTS) {
        await db.run(sql.raw(statement));
    }
    await db.run(sql`
        UPDATE products
        SET stock_count = MAX(0, COALESCE(manual_stock_count, 0)),
            locked_count = 0
        WHERE COALESCE(fulfillment_mode, 'auto') = 'manual'
    `);
}

// ensureCouponTables 幂等创建优惠券相关表与索引
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 补齐优惠券列，新增原子计数触发器并校准历史计数，schema v26。
export async function ensureCouponTables() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS coupons (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            discount_type TEXT NOT NULL DEFAULT 'fixed',
            rate_bps INTEGER,
            discount_amount_cents INTEGER,
            min_spend_cents INTEGER NOT NULL DEFAULT 0,
            max_discount_cents INTEGER,
            scope TEXT NOT NULL DEFAULT 'all',
            total_use_limit INTEGER,
            per_user_limit INTEGER,
            reserved_count INTEGER NOT NULL DEFAULT 0,
            consumed_count INTEGER NOT NULL DEFAULT 0,
            stackable_with_coupons INTEGER DEFAULT 0,
            stackable_with_points INTEGER DEFAULT 1,
            refund_policy TEXT NOT NULL DEFAULT 'unfulfilled_full_refund',
            status TEXT NOT NULL DEFAULT 'draft',
            starts_at INTEGER,
            ends_at INTEGER,
            created_by TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000),
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS coupon_products (
            coupon_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS coupon_usages (
            id TEXT PRIMARY KEY,
            coupon_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            user_id TEXT,
            username TEXT,
            status TEXT NOT NULL DEFAULT 'reserved',
            sequence INTEGER NOT NULL DEFAULT 0,
            reservation_id TEXT NOT NULL,
            reservation_expires_at INTEGER,
            coupon_code_snapshot TEXT NOT NULL,
            rule_snapshot TEXT NOT NULL,
            eligible_amount_cents INTEGER NOT NULL DEFAULT 0,
            discount_amount_cents INTEGER NOT NULL DEFAULT 0,
            reserved_at INTEGER,
            consumed_at INTEGER,
            released_at INTEGER,
            reversed_at INTEGER,
            reason TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `)
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS coupon_user_counters (
            coupon_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            reserved_count INTEGER NOT NULL DEFAULT 0,
            consumed_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER DEFAULT (unixepoch() * 1000),
            PRIMARY KEY (coupon_id, user_id)
        )
    `)

    const couponColumnStatements: Array<[string, string, string]> = [
        ['coupons', 'code', "TEXT NOT NULL DEFAULT ''"],
        ['coupons', 'name', "TEXT NOT NULL DEFAULT ''"],
        ['coupons', 'description', 'TEXT'],
        ['coupons', 'discount_type', "TEXT NOT NULL DEFAULT 'fixed'"],
        ['coupons', 'rate_bps', 'INTEGER'],
        ['coupons', 'discount_amount_cents', 'INTEGER'],
        ['coupons', 'min_spend_cents', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupons', 'max_discount_cents', 'INTEGER'],
        ['coupons', 'scope', "TEXT NOT NULL DEFAULT 'all'"],
        ['coupons', 'total_use_limit', 'INTEGER'],
        ['coupons', 'per_user_limit', 'INTEGER'],
        ['coupons', 'reserved_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupons', 'consumed_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupons', 'stackable_with_coupons', 'INTEGER DEFAULT 0'],
        ['coupons', 'stackable_with_points', 'INTEGER DEFAULT 1'],
        ['coupons', 'refund_policy', "TEXT NOT NULL DEFAULT 'unfulfilled_full_refund'"],
        ['coupons', 'status', "TEXT NOT NULL DEFAULT 'draft'"],
        ['coupons', 'starts_at', 'INTEGER'],
        ['coupons', 'ends_at', 'INTEGER'],
        ['coupons', 'created_by', 'TEXT'],
        ['coupons', 'created_at', 'INTEGER'],
        ['coupons', 'updated_at', 'INTEGER'],
        ['coupon_products', 'coupon_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_products', 'product_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_products', 'created_at', 'INTEGER'],
        ['coupon_usages', 'coupon_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_usages', 'order_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_usages', 'user_id', 'TEXT'],
        ['coupon_usages', 'username', 'TEXT'],
        ['coupon_usages', 'status', "TEXT NOT NULL DEFAULT 'reserved'"],
        ['coupon_usages', 'sequence', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupon_usages', 'reservation_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_usages', 'reservation_expires_at', 'INTEGER'],
        ['coupon_usages', 'coupon_code_snapshot', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_usages', 'rule_snapshot', "TEXT NOT NULL DEFAULT '{}'"],
        ['coupon_usages', 'eligible_amount_cents', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupon_usages', 'discount_amount_cents', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupon_usages', 'reserved_at', 'INTEGER'],
        ['coupon_usages', 'consumed_at', 'INTEGER'],
        ['coupon_usages', 'released_at', 'INTEGER'],
        ['coupon_usages', 'reversed_at', 'INTEGER'],
        ['coupon_usages', 'reason', 'TEXT'],
        ['coupon_usages', 'created_at', 'INTEGER'],
        ['coupon_user_counters', 'coupon_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_user_counters', 'user_id', "TEXT NOT NULL DEFAULT ''"],
        ['coupon_user_counters', 'reserved_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupon_user_counters', 'consumed_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['coupon_user_counters', 'updated_at', 'INTEGER'],
    ]
    for (const [table, column, definition] of couponColumnStatements) {
        await safeAddColumn(table, column, definition)
    }

    const couponIndexStatements = [
        `CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_uq ON coupons(upper(code))`,
        `CREATE INDEX IF NOT EXISTS coupons_status_window_idx ON coupons(status, starts_at, ends_at)`,
        `CREATE INDEX IF NOT EXISTS coupons_created_at_idx ON coupons(created_at)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS coupon_products_coupon_product_uq ON coupon_products(coupon_id, product_id)`,
        `CREATE INDEX IF NOT EXISTS coupon_products_product_idx ON coupon_products(product_id, coupon_id)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS coupon_usages_order_coupon_uq ON coupon_usages(order_id, coupon_id)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS coupon_usages_reservation_uq ON coupon_usages(reservation_id)`,
        `CREATE INDEX IF NOT EXISTS coupon_usages_coupon_status_idx ON coupon_usages(coupon_id, status, reserved_at)`,
        `CREATE INDEX IF NOT EXISTS coupon_usages_user_idx ON coupon_usages(coupon_id, user_id, status)`,
        `CREATE INDEX IF NOT EXISTS coupon_usages_order_idx ON coupon_usages(order_id, sequence)`,
        `CREATE INDEX IF NOT EXISTS coupon_usages_status_created_idx ON coupon_usages(status, created_at)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS coupon_user_counters_coupon_user_uq ON coupon_user_counters(coupon_id, user_id)`,
    ]

    for (const statement of couponIndexStatements) {
        try {
            await db.run(sql.raw(statement));
        } catch (e: any) {
            const errorString = (JSON.stringify(e) + String(e) + (e?.message || '')).toLowerCase();
            if (errorString.includes('no such table') || errorString.includes('does not exist')) {
                continue;
            }
            if (errorString.includes('already exists') || errorString.includes('constraint failed')) {
                continue;
            }
            throw e;
        }
    }

    for (const statement of COUPON_USAGE_TRIGGER_STATEMENTS) {
        await db.run(sql.raw(statement))
    }
    for (const statement of COUPON_COUNTER_RECONCILIATION_STATEMENTS) {
        await db.run(sql.raw(statement))
    }
}

async function ensureOrderDeliveryFilesTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS order_delivery_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            storage TEXT NOT NULL,
            object_key TEXT,
            content BLOB,
            downloaded_at INTEGER,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `);
    await db.run(sql`CREATE INDEX IF NOT EXISTS order_delivery_files_order_id_idx ON order_delivery_files(order_id)`);
}

async function ensureCardsColumns() {
    await ensureColumnsOnce('cards', async () => {
        await safeAddColumn('cards', 'reserved_order_id', 'TEXT');
        await safeAddColumn('cards', 'reserved_at', 'INTEGER');
        await safeAddColumn('cards', 'expires_at', 'INTEGER');
    });
}

async function ensureLoginUsersColumns() {
    await ensureColumnsOnce('loginUsers', async () => {
        for (const [column, definition] of LOGIN_USERS_COLUMN_DEFINITIONS) {
            await safeAddColumn('login_users', column, definition);
        }
    });
}

export async function ensureLoginUsersSchema() {
    if (loginUsersSchemaReady) return;
    await ensureLoginUsersTable();
    await ensureLoginUsersColumns();
    loginUsersSchemaReady = true;
}

async function isProductAggregatesBackfilled(): Promise<boolean> {
    try {
        const result = await db.select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, 'product_aggregates_backfilled_v2'));
        return result[0]?.value === '1';
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureSettingsTable();
            return false;
        }
        throw error;
    }
}

async function markProductAggregatesBackfilled() {
    await db.insert(settings).values({
        key: 'product_aggregates_backfilled_v2',
        value: '1',
        updatedAt: new Date()
    }).onConflictDoUpdate({
        target: settings.key,
        set: { value: '1', updatedAt: new Date() }
    });
}

export async function recalcProductAggregates(productId: string) {
    const pid = (productId || '').trim();
    if (!pid) return;

    try {
        await ensureProductsColumns();
        await ensureCardsColumns();
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return;
        throw error;
    }

    const product = await db.query.products.findFirst({
        where: eq(products.id, pid),
        columns: { isShared: true, fulfillmentMode: true, manualStockCount: true }
    });
    if (!product) return;

    const nowMs = Date.now();
    const fiveMinutesAgo = nowMs - RESERVATION_TTL_MS;
    let unusedCount = 0;
    let availableCount = 0;
    let lockedCount = 0;

    try {
        const cardRows = await db.select({
            unused: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) THEN 1 ELSE 0 END), 0)`,
            available: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < ${fiveMinutesAgo}) THEN 1 ELSE 0 END), 0)`,
            locked: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND ${cards.reservedAt} IS NOT NULL AND ${cards.reservedAt} >= ${fiveMinutesAgo} THEN 1 ELSE 0 END), 0)`
        })
            .from(cards)
            .where(eq(cards.productId, pid));

        const row = cardRows[0];
        unusedCount = Number(row?.unused || 0);
        availableCount = Number(row?.available || 0);
        lockedCount = Number(row?.locked || 0);
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    let soldCount = 0;
    try {
        const soldRows = await db.select({
            total: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} IN ('paid', 'delivered') THEN ${orders.quantity} ELSE 0 END), 0)`
        })
            .from(orders)
            .where(eq(orders.productId, pid));
        soldCount = Number(soldRows[0]?.total || 0);
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    let rating = 0;
    let reviewCount = 0;
    try {
        const reviewRows = await db.select({
            avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
            count: sql<number>`COUNT(*)`
        })
            .from(reviews)
            .where(eq(reviews.productId, pid));
        rating = Number(reviewRows[0]?.avg || 0);
        reviewCount = Number(reviewRows[0]?.count || 0);
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    const stockCount = product.fulfillmentMode === 'manual'
        ? Math.max(0, Number(product.manualStockCount || 0))
        : (product.isShared ? (unusedCount > 0 ? INFINITE_STOCK : 0) : availableCount);

    await db.update(products)
        .set({
            stockCount,
            lockedCount: product.fulfillmentMode === 'manual' ? 0 : lockedCount,
            soldCount,
            rating,
            reviewCount
        })
        .where(eq(products.id, pid));
}

export async function recalcProductAggregatesForMany(productIds: string[]) {
    const ids = Array.from(new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean)));
    if (!ids.length) return;

    try {
        await ensureProductsColumns();
        await ensureCardsColumns();
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return;
        throw error;
    }

    const QUERY_BATCH_SIZE = 50;
    const UPDATE_BATCH_SIZE = 8;
    const nowMs = Date.now();
    const fiveMinutesAgo = nowMs - RESERVATION_TTL_MS;

    const aggregates = new Map<string, {
        isShared: boolean;
        fulfillmentMode: string | null;
        manualStockCount: number;
        unused: number;
        available: number;
        locked: number;
        sold: number;
        rating: number;
        reviewCount: number;
    }>();

    for (let i = 0; i < ids.length; i += QUERY_BATCH_SIZE) {
        const batch = ids.slice(i, i + QUERY_BATCH_SIZE);
        const rows = await db.select({
            id: products.id,
            isShared: products.isShared,
            fulfillmentMode: products.fulfillmentMode,
            manualStockCount: sql<number>`COALESCE(${products.manualStockCount}, 0)`,
        })
            .from(products)
            .where(inArray(products.id, batch));
        for (const row of rows) {
            aggregates.set(row.id, {
                isShared: !!row.isShared,
                fulfillmentMode: row.fulfillmentMode || 'auto',
                manualStockCount: Number(row.manualStockCount || 0),
                unused: 0,
                available: 0,
                locked: 0,
                sold: 0,
                rating: 0,
                reviewCount: 0
            });
        }
    }

    const existingIds = Array.from(aggregates.keys());
    if (!existingIds.length) return;

    try {
        for (let i = 0; i < existingIds.length; i += QUERY_BATCH_SIZE) {
            const batch = existingIds.slice(i, i + QUERY_BATCH_SIZE);
            const cardRows = await db.select({
                productId: cards.productId,
                unused: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) THEN 1 ELSE 0 END), 0)`,
                available: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < ${fiveMinutesAgo}) THEN 1 ELSE 0 END), 0)`,
                locked: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND ${cards.reservedAt} IS NOT NULL AND ${cards.reservedAt} >= ${fiveMinutesAgo} THEN 1 ELSE 0 END), 0)`
            })
                .from(cards)
                .where(inArray(cards.productId, batch))
                .groupBy(cards.productId);

            for (const row of cardRows) {
                const agg = aggregates.get(row.productId);
                if (!agg) continue;
                agg.unused = Number(row.unused || 0);
                agg.available = Number(row.available || 0);
                agg.locked = Number(row.locked || 0);
            }
        }
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    try {
        for (let i = 0; i < existingIds.length; i += QUERY_BATCH_SIZE) {
            const batch = existingIds.slice(i, i + QUERY_BATCH_SIZE);
            const soldRows = await db.select({
                productId: orders.productId,
                total: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} IN ('paid', 'delivered') THEN ${orders.quantity} ELSE 0 END), 0)`
            })
                .from(orders)
                .where(inArray(orders.productId, batch))
                .groupBy(orders.productId);

            for (const row of soldRows) {
                const agg = aggregates.get(row.productId);
                if (!agg) continue;
                agg.sold = Number(row.total || 0);
            }
        }
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    try {
        for (let i = 0; i < existingIds.length; i += QUERY_BATCH_SIZE) {
            const batch = existingIds.slice(i, i + QUERY_BATCH_SIZE);
            const reviewRows = await db.select({
                productId: reviews.productId,
                avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
                count: sql<number>`COUNT(*)`
            })
                .from(reviews)
                .where(inArray(reviews.productId, batch))
                .groupBy(reviews.productId);

            for (const row of reviewRows) {
                const agg = aggregates.get(row.productId);
                if (!agg) continue;
                agg.rating = Number(row.avg || 0);
                agg.reviewCount = Number(row.count || 0);
            }
        }
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    const updates = existingIds.map((id) => {
        const agg = aggregates.get(id)!;
        const stockCount = agg.fulfillmentMode === 'manual'
            ? Math.max(0, agg.manualStockCount)
            : (agg.isShared ? (agg.unused > 0 ? INFINITE_STOCK : 0) : agg.available);
        return {
            id,
            stockCount,
            lockedCount: agg.fulfillmentMode === 'manual' ? 0 : agg.locked,
            soldCount: agg.sold,
            rating: agg.rating,
            reviewCount: agg.reviewCount
        };
    });

    for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
        const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
        const idsBatch = batch.map((row) => row.id);
        const stockCases = sql.join(
            batch.map((row) => sql`WHEN ${products.id} = ${row.id} THEN ${row.stockCount}`),
            sql` `
        );
        const lockedCases = sql.join(
            batch.map((row) => sql`WHEN ${products.id} = ${row.id} THEN ${row.lockedCount}`),
            sql` `
        );
        const soldCases = sql.join(
            batch.map((row) => sql`WHEN ${products.id} = ${row.id} THEN ${row.soldCount}`),
            sql` `
        );
        const ratingCases = sql.join(
            batch.map((row) => sql`WHEN ${products.id} = ${row.id} THEN ${row.rating}`),
            sql` `
        );
        const reviewCases = sql.join(
            batch.map((row) => sql`WHEN ${products.id} = ${row.id} THEN ${row.reviewCount}`),
            sql` `
        );

        await db.run(sql`
            UPDATE products
            SET
                stock_count = CASE ${products.id} ${stockCases} ELSE ${products.stockCount} END,
                locked_count = CASE ${products.id} ${lockedCases} ELSE ${products.lockedCount} END,
                sold_count = CASE ${products.id} ${soldCases} ELSE ${products.soldCount} END,
                rating = CASE ${products.id} ${ratingCases} ELSE ${products.rating} END,
                review_count = CASE ${products.id} ${reviewCases} ELSE ${products.reviewCount} END
            WHERE ${inArray(products.id, idsBatch)}
        `);
    }
}

export async function getLiveCardStats(productIds: string[]): Promise<Map<string, { unused: number; available: number; locked: number }>> {
    const ids = Array.from(new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean)));
    const stats = new Map<string, { unused: number; available: number; locked: number }>();
    if (!ids.length) return stats;

    for (const id of ids) {
        stats.set(id, { unused: 0, available: 0, locked: 0 });
    }

    try {
        await ensureCardsColumns();
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return stats;
        throw error;
    }

    const nowMs = Date.now();
    const fiveMinutesAgo = nowMs - RESERVATION_TTL_MS;

    try {
        const rows = await db.select({
            productId: cards.productId,
            unused: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) THEN 1 ELSE 0 END), 0)`,
            available: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < ${fiveMinutesAgo}) THEN 1 ELSE 0 END), 0)`,
            locked: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${cards.isUsed}, 0) = 0 AND (${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs}) AND ${cards.reservedAt} IS NOT NULL AND ${cards.reservedAt} >= ${fiveMinutesAgo} THEN 1 ELSE 0 END), 0)`
        })
            .from(cards)
            .where(inArray(cards.productId, ids))
            .groupBy(cards.productId);

        for (const row of rows) {
            if (!row.productId) continue;
            stats.set(row.productId, {
                unused: Number(row.unused || 0),
                available: Number(row.available || 0),
                locked: Number(row.locked || 0),
            });
        }
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    return stats;
}

async function backfillProductAggregates() {
    const already = await isProductAggregatesBackfilled();
    if (already) return;

    try {
        await ensureProductsColumns();
        const rows = await db.select({ id: products.id }).from(products);
        await recalcProductAggregatesForMany(rows.map((row) => row.id));
        await markProductAggregatesBackfilled();
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }
}

async function withProductColumnFallback<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch (error: any) {
        // Use more robust string conversion for error checking
        const errorString = (JSON.stringify(error) + String(error) + (error?.message || '')).toLowerCase();

        // Check for missing column errors (PostgreSQL: 42703, SQLite/D1: no such column, D1_COLUMN_NOTFOUND)
        if (errorString.includes('42703') || errorString.includes('no such column') || errorString.includes('column not found') || errorString.includes('d1_column_notfound')) {
            console.log("Detected missing column error, attempting remediation...");
            await ensureProductsColumns();
            return await fn();
        }
        throw error;
    }
}

export async function withOrderColumnFallback<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDatabaseInitialized()
    try {
        return await fn()
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) {
            await ensureOrdersColumns()
            return await fn()
        }
        throw error
    }
}

export async function getProducts() {
    return await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            fulfillmentMode: products.fulfillmentMode,
            manualStockCount: sql<number>`COALESCE(${products.manualStockCount}, 0)`,
            visibilityLevel: products.visibilityLevel,
            sortOrder: products.sortOrder,
            purchaseLimit: products.purchaseLimit,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`
        })
            .from(products)
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    })
}

function resolveVisibilityThreshold(isLoggedIn?: boolean, trustLevel?: number | null) {
    if (!isLoggedIn) return -1;
    const level = Number.isFinite(Number(trustLevel)) ? Number(trustLevel) : 0;
    return Math.max(0, level);
}

function visibilityCondition(isLoggedIn?: boolean, trustLevel?: number | null) {
    const threshold = resolveVisibilityThreshold(isLoggedIn, trustLevel);
    return lte(sql<number>`COALESCE(${products.visibilityLevel}, -1)`, threshold);
}

// 首页已改用 searchActiveProducts（服务端筛选/排序/分页），原先「无 LIMIT 取全表
// 再交给浏览器筛选」的 getActiveProducts 已无调用方，故移除。
// 参考 outputs/ldc-shop-code-review-2026-09-24.md §2.1。

function groupProductsAsVariants<T extends {
    id: string;
    price: string;
    variantGroupId: string | null;
    sortOrder: number | null;
    createdAt: Date | null;
    sold?: number;
    stock?: number;
    locked?: number;
    rating?: number;
    reviewCount?: number;
    isHot?: boolean | null;
    isShared?: boolean | null;
    fulfillmentMode?: string | null;
}>(rows: T[]): (T & { variantCount?: number; priceMin?: number; priceMax?: number; totalSold?: number; totalStock?: number; totalLocked?: number; totalReviewCount?: number; avgRating?: number; groupHot?: boolean; groupShared?: boolean; groupManual?: boolean; allVariantIds?: string[] })[] {
    const byGroup = new Map<string, T[]>();
    for (const row of rows) {
        const rawKey = (row.variantGroupId && row.variantGroupId.trim()) || null;
        const key = rawKey ?? row.id;
        const list = byGroup.get(key) ?? [];
        list.push(row);
        byGroup.set(key, list);
    }
    const result: (T & { variantCount?: number; priceMin?: number; priceMax?: number; totalSold?: number; totalStock?: number; totalLocked?: number; totalReviewCount?: number; avgRating?: number; groupHot?: boolean; groupShared?: boolean; groupManual?: boolean; allVariantIds?: string[] })[] = [];
    for (const list of byGroup.values()) {
        const rep = list.slice().sort((a, b) => {
            const soA = a.sortOrder ?? 0;
            const soB = b.sortOrder ?? 0;
            if (soA !== soB) return soA - soB;
            const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return ca - cb;
        })[0];
        const prices = list.map((p) => parseFloat(p.price)).filter((n) => Number.isFinite(n));
        const variantCount = list.length;
        const priceMin = prices.length ? Math.min(...prices) : undefined;
        const priceMax = prices.length ? Math.max(...prices) : undefined;

        if (variantCount > 1) {
            const totalSold = list.reduce((s, p) => s + (p.sold || 0), 0);
            const totalStock = list.reduce((s, p) => s + (p.stock || 0), 0);
            const totalLocked = list.reduce((s, p) => s + (p.locked || 0), 0);
            const totalReviewCount = list.reduce((s, p) => s + (p.reviewCount || 0), 0);
            const ratingSum = list.reduce((s, p) => s + (p.rating || 0) * (p.reviewCount || 0), 0);
            const avgRating = totalReviewCount > 0 ? ratingSum / totalReviewCount : 0;
            const groupHot = list.some((p) => !!p.isHot);
            const groupShared = list.some((p) => !!p.isShared);
            const groupManual = list.some((p) => p.fulfillmentMode === 'manual');
            const allVariantIds = list.map((p) => p.id);
            result.push({ ...rep, variantCount, priceMin, priceMax, totalSold, totalStock, totalLocked, totalReviewCount, avgRating, groupHot, groupShared, groupManual, allVariantIds });
        } else {
            result.push({ ...rep });
        }
    }
    result.sort((a, b) => {
        const soA = a.sortOrder ?? 0;
        const soB = b.sortOrder ?? 0;
        if (soA !== soB) return soA - soB;
        const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ca - cb;
    });
    return result;
}

export async function getWishlistItems(userId: string | null, limit = 10) {
    await ensureDatabaseInitialized();

    try {
        const result: any = await db.run(sql`
            SELECT
                wi.id AS id,
                wi.title AS title,
                wi.description AS description,
                lu.nickname AS nickname,
                wi.created_at AS created_at,
                COUNT(wv.id) AS votes,
                SUM(CASE WHEN wv.user_id = ${userId} THEN 1 ELSE 0 END) AS voted
            FROM wishlist_items wi
            LEFT JOIN wishlist_votes wv ON wv.item_id = wi.id
            LEFT JOIN login_users lu ON lu.user_id = wi.user_id
            GROUP BY wi.id, lu.nickname
            ORDER BY votes DESC, wi.created_at DESC
            LIMIT ${limit}
        `);

        const rows = result?.results || result?.rows || [];
        return rows.map((row: any) => ({
            id: Number(row.id),
            title: row.title,
            description: row.description,
            nickname: row.nickname,
            createdAt: Number(row.created_at ?? row.createdAt ?? 0),
            votes: Number(row.votes || 0),
            voted: Number(row.voted || 0) > 0,
        }));
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) {
            await ensureWishlistTables();
            // Retry once
            try {
                const result: any = await db.run(sql`
                    SELECT
                        wi.id AS id,
                        wi.title AS title,
                        wi.description AS description,
                        lu.nickname AS nickname,
                        wi.created_at AS created_at,
                        COUNT(wv.id) AS votes,
                        SUM(CASE WHEN wv.user_id = ${userId} THEN 1 ELSE 0 END) AS voted
                    FROM wishlist_items wi
                    LEFT JOIN wishlist_votes wv ON wv.item_id = wi.id
                    LEFT JOIN login_users lu ON lu.user_id = wi.user_id
                    GROUP BY wi.id, lu.nickname
                    ORDER BY votes DESC, wi.created_at DESC
                    LIMIT ${limit}
                `);
                const rows = result?.results || result?.rows || [];
                return rows.map((row: any) => ({
                    id: Number(row.id),
                    title: row.title,
                    description: row.description,
                    nickname: row.nickname,
                    createdAt: Number(row.created_at ?? row.createdAt ?? 0),
                    votes: Number(row.votes || 0),
                    voted: Number(row.voted || 0) > 0,
                }));
            } catch (retryError) {
                console.error('getWishlistItems retry failed:', retryError);
                return [];
            }
        }
        console.error('getWishlistItems failed:', error);
        return [];
    }
}

export async function getProduct(id: string, options?: { isLoggedIn?: boolean; trustLevel?: number | null }) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            purchaseLimit: products.purchaseLimit,
            purchaseWarning: products.purchaseWarning,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            visibilityLevel: products.visibilityLevel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            rating: sql<number>`COALESCE(${products.rating}, 0)`,
            reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            purchaseQuestions: products.purchaseQuestions,
            checkoutFields: products.checkoutFields,
            fulfillmentMode: products.fulfillmentMode,
            couponUsageRestriction: products.couponUsageRestriction,
        })
            .from(products)
            .where(and(eq(products.id, id), visibilityCondition(options?.isLoggedIn, options?.trustLevel)))
            ;

        // Return null if product doesn't exist or is inactive
        const product = result[0];
        if (!product || product.isActive === false) {
            return null;
        }
        return product;
    })
}

export async function getProductVisibility(id: string) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            isActive: products.isActive,
            visibilityLevel: products.visibilityLevel,
        })
            .from(products)
            .where(eq(products.id, id));

        return result[0] || null;
    });
}

export type ProductVariantRow = {
    id: string;
    name: string;
    description: string | null;
    price: string;
    compareAtPrice: string | null;
    image: string | null;
    productImages: string | null;
    variantLabel: string | null;
    stock: number;
    locked: number;
    isShared: boolean | null;
    sold: number;
    purchaseLimit: number | null;
    isHot: boolean | null;
    purchaseWarning: string | null;
    purchaseQuestions: string | null;
    checkoutFields: string | null;
    fulfillmentMode: string | null;
    pointDiscountEnabled: boolean | null;
    pointDiscountPercent: number;
    couponUsageRestriction: string;
};

export async function getProductVariants(
    groupId: string,
    options?: { isLoggedIn?: boolean; trustLevel?: number | null }
): Promise<ProductVariantRow[]> {
    return await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            image: products.image,
            productImages: products.productImages,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            isHot: products.isHot,
            purchaseWarning: products.purchaseWarning,
            purchaseQuestions: products.purchaseQuestions,
            checkoutFields: products.checkoutFields,
            fulfillmentMode: products.fulfillmentMode,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            couponUsageRestriction: products.couponUsageRestriction,
        })
            .from(products)
            .where(and(
                eq(products.variantGroupId, groupId),
                eq(products.isActive, true),
                visibilityCondition(options?.isLoggedIn, options?.trustLevel)
            ))
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    });
}

export async function getProductVariantLabels(productIds: string[]): Promise<Record<string, string | null>> {
    const ids = Array.from(new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean)));
    if (!ids.length) return {};
    const rows = await db.select({ id: products.id, variantLabel: products.variantLabel })
        .from(products)
        .where(inArray(products.id, ids));
    const out: Record<string, string | null> = {};
    for (const row of rows) {
        const label = row.variantLabel?.trim() || null;
        if (label) out[row.id] = label;
    }
    return out;
}

export async function getProductForAdmin(id: string) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            purchaseWarning: products.purchaseWarning,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            visibilityLevel: products.visibilityLevel,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            purchaseQuestions: products.purchaseQuestions,
            checkoutFields: products.checkoutFields,
            fulfillmentMode: products.fulfillmentMode,
            couponUsageRestriction: products.couponUsageRestriction,
            manualStockCount: sql<number>`COALESCE(${products.manualStockCount}, 0)`,
        })
            .from(products)
            .where(eq(products.id, id));

        return result[0] || null;
    });
}

// Dashboard Stats
export async function getDashboardStats(nowMs: number) {
    return await withOrderColumnFallback(async () => {
        const now = new Date(nowMs);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const todayStartMs = todayStart.getTime();
        const weekStartMs = weekStart.getTime();
        const monthStartMs = monthStart.getTime();
        const orderStats = await db.select({
            totalCount: sql<number>`count(*)`,
            totalRevenue: sql<number>`COALESCE(sum(CAST(${orders.amount} AS REAL)), 0)`,
            todayCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN 1 ELSE 0 END), 0)`,
            todayRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            weekCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN 1 ELSE 0 END), 0)`,
            weekRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            monthCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN 1 ELSE 0 END), 0)`,
            monthRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
        })
            .from(orders)
            .where(eq(orders.status, 'delivered'));

        const orderRow = orderStats[0] || {
            totalCount: 0,
            totalRevenue: 0,
            todayCount: 0,
            todayRevenue: 0,
            weekCount: 0,
            weekRevenue: 0,
            monthCount: 0,
            monthRevenue: 0,
        };

        const emptyPointRow = {
            totalProduced: 0,
            totalConsumed: 0,
            todayProduced: 0,
            todayConsumed: 0,
            weekProduced: 0,
            weekConsumed: 0,
            monthProduced: 0,
            monthConsumed: 0,
        };
        let pointRow = emptyPointRow;

        try {
            await ensureUserPointLedgerSchema();
            const pointStats = await db.select({
                totalProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'checkin_reward' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                totalConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'order_deduction' THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                todayProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'checkin_reward' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                todayConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'order_deduction' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                weekProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'checkin_reward' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${weekStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                weekConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'order_deduction' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${weekStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                monthProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'checkin_reward' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${monthStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                monthConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'order_deduction' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${monthStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
            })
                .from(userPointLedger);

            pointRow = pointStats[0] || emptyPointRow;
        } catch (error: any) {
            console.warn("Failed to query point stats in dashboard stats:", error);
            pointRow = emptyPointRow;
        }

        return {
            today: {
                count: orderRow.todayCount || 0,
                revenue: orderRow.todayRevenue || 0,
                pointsProduced: pointRow.todayProduced || 0,
                pointsConsumed: pointRow.todayConsumed || 0,
            },
            week: {
                count: orderRow.weekCount || 0,
                revenue: orderRow.weekRevenue || 0,
                pointsProduced: pointRow.weekProduced || 0,
                pointsConsumed: pointRow.weekConsumed || 0,
            },
            month: {
                count: orderRow.monthCount || 0,
                revenue: orderRow.monthRevenue || 0,
                pointsProduced: pointRow.monthProduced || 0,
                pointsConsumed: pointRow.monthConsumed || 0,
            },
            total: {
                count: orderRow.totalCount || 0,
                revenue: orderRow.totalRevenue || 0,
                pointsProduced: pointRow.totalProduced || 0,
                pointsConsumed: pointRow.totalConsumed || 0,
            }
        };
    })
}

export async function getRecentOrders(limit: number = 10) {
    return await withOrderColumnFallback(async () => {
        return await db.query.orders.findMany({
            orderBy: [desc(normalizeTimestampMs(orders.createdAt))],
            limit
        })
    })
}

function toSafeNumber(value: unknown) {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
}

function startOfLocalDay(nowMs: number, daysAgo = 0) {
    const now = new Date(nowMs)
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    start.setDate(start.getDate() - daysAgo)
    return start.getTime()
}

function formatLocalDate(ms: number) {
    const date = new Date(ms)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export async function getAdminOverview(lowStockThreshold = 5) {
    const nowMs = Date.now()
    const todayStartMs = startOfLocalDay(nowMs)
    const yesterdayStartMs = startOfLocalDay(nowMs, 1)
    const trendStartMs = startOfLocalDay(nowMs, 6)
    const threshold = Number.isFinite(lowStockThreshold) && lowStockThreshold > 0 ? lowStockThreshold : 5

    const emptyTrend = Array.from({ length: 7 }, (_, index) => {
        const dayStart = startOfLocalDay(nowMs, 6 - index)
        return {
            date: formatLocalDate(dayStart),
            orders: 0,
            revenue: 0,
            refunds: 0,
        }
    })

    const emptyOverview = {
        kpis: {
            todayRevenue: 0,
            yesterdayRevenue: 0,
            todayOrders: 0,
            yesterdayOrders: 0,
            monthRevenue: 0,
            totalRevenue: 0,
            todayRefunds: 0,
            monthRefunds: 0,
            todayPointsConsumed: 0,
            todayPointsProduced: 0,
            visitorCount: 0,
        },
        ops: {
            pendingOrders: 0,
            awaitingDelivery: 0,
            pendingRefunds: 0,
            unreadMessages: 0,
            lowStockProducts: 0,
            activeProducts: 0,
        },
        trend: emptyTrend,
        topProducts: [] as Array<{ productId: string; productName: string; orders: number; revenue: number }>,
        recentOrders: [] as Array<{
            orderId: string
            productName: string
            username: string | null
            amount: string
            pointsUsed: number
            status: string | null
            createdAt: Date | null
            paidAt: Date | null
        }>,
        lowStockItems: [] as Array<{ id: string; name: string; stock: number }>,
    }

    try {
        return await withOrderColumnFallback(async () => {
            const monthStartMs = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), 1).getTime()

            // 时间戳兼容阈值：值 < 1e12 说明该行仍是「秒」精度（历史数据），比较前需 ×1000。
            // 写成 `paid_at >= ? OR (paid_at < 1e12 AND paid_at * 1000 >= ?)`，而不是把整列包进
            // 兼容函数 —— 这样第一支能命中 orders_status_paid_at_idx，只有极少数历史行走第二支。
            const LEGACY_SECONDS_CEILING = 1_000_000_000_000

            const [
                monthlyRows,
                totalRevenueRows,
                opsRows,
                refundWindowRows,
                refundRows,
                messageRows,
                visitorRows,
                trendRows,
                topProductRows,
                recentOrderRows,
                productRows,
                pointRows,
            ] = await Promise.all([
                // 财务窗口（今日 / 昨日 / 本月）：只扫「本月已付款」的订单。
                // 此前这是**无 WHERE 的全表聚合**，且 10 个聚合条件都包着兼容函数，
                // 于是每次打开后台都要把 orders 全表扫一遍、索引完全用不上。
                db.select({
                    todayRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(orders.paidAt)} >= ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                    yesterdayRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(orders.paidAt)} >= ${yesterdayStartMs} AND ${normalizeTimestampMs(orders.paidAt)} < ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                    todayOrders: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(orders.paidAt)} >= ${todayStartMs} THEN 1 ELSE 0 END), 0)`,
                    yesterdayOrders: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(orders.paidAt)} >= ${yesterdayStartMs} AND ${normalizeTimestampMs(orders.paidAt)} < ${todayStartMs} THEN 1 ELSE 0 END), 0)`,
                    monthRevenue: sql<number>`COALESCE(SUM(CAST(${orders.amount} AS REAL)), 0)`,
                }).from(orders).where(and(
                    sql`${orders.status} IN ('paid', 'delivered')`,
                    sql`(${orders.paidAt} >= ${monthStartMs} OR (${orders.paidAt} < ${LEGACY_SECONDS_CEILING} AND ${orders.paidAt} * 1000 >= ${monthStartMs}))`,
                )),
                // 历史累计营收：无法避免一次全表聚合，但只取一个 SUM，
                // 不再在同一趟扫描里顺带求 9 个窗口条件。
                db.select({
                    totalRevenue: sql<number>`COALESCE(SUM(CAST(${orders.amount} AS REAL)), 0)`,
                }).from(orders).where(sql`${orders.status} IN ('paid', 'delivered')`),
                // 待处理运单：只扫 pending / paid 两类状态。
                db.select({
                    pendingOrders: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
                    awaitingDelivery: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'paid' AND COALESCE(${orders.fulfillmentMode}, 'auto') = 'manual' THEN 1 ELSE 0 END), 0)`,
                }).from(orders).where(sql`${orders.status} IN ('pending', 'paid')`),
                // 退款窗口：只扫已退款行（占比极小），因此这里保留三段式 COALESCE 时间戳。
                db.select({
                    todayRefunds: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${normalizeTimestampMs(orders.deliveredAt)}, ${normalizeTimestampMs(orders.paidAt)}, ${normalizeTimestampMs(orders.createdAt)}) >= ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                    monthRefunds: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${normalizeTimestampMs(orders.deliveredAt)}, ${normalizeTimestampMs(orders.paidAt)}, ${normalizeTimestampMs(orders.createdAt)}) >= ${monthStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                }).from(orders).where(sql`${orders.status} = 'refunded'`),
                db.select({
                    pendingRefunds: sql<number>`COALESCE(SUM(CASE WHEN ${refundRequests.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
                }).from(refundRequests).catch(() => [{ pendingRefunds: 0 }]),
                db.select({
                    unreadMessages: sql<number>`COALESCE(SUM(CASE WHEN ${userMessages.isRead} = 0 THEN 1 ELSE 0 END), 0)`,
                }).from(userMessages).catch(() => [{ unreadMessages: 0 }]),
                db.select({ count: sql<number>`count(*)` }).from(loginUsers).catch(() => [{ count: 0 }]),
                db.select({
                    dayKey: sql<string>`strftime('%Y-%m-%d', COALESCE(${normalizeTimestampMs(orders.paidAt)}, ${normalizeTimestampMs(orders.createdAt)}) / 1000, 'unixepoch', 'localtime')`,
                    ordersCount: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} IN ('paid', 'delivered') THEN 1 ELSE 0 END), 0)`,
                    revenue: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} IN ('paid', 'delivered') THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                    refunds: sql<number>`COALESCE(SUM(CASE WHEN ${orders.status} = 'refunded' THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
                }).from(orders).where(and(
                    sql`${orders.status} IN ('paid', 'delivered', 'refunded')`,
                    sql`COALESCE(${normalizeTimestampMs(orders.paidAt)}, ${normalizeTimestampMs(orders.createdAt)}) >= ${trendStartMs}`
                )).groupBy(sql`strftime('%Y-%m-%d', COALESCE(${normalizeTimestampMs(orders.paidAt)}, ${normalizeTimestampMs(orders.createdAt)}) / 1000, 'unixepoch', 'localtime')`).catch(() => []),
                db.select({
                    productId: orders.productId,
                    productName: orders.productName,
                    ordersCount: sql<number>`count(*)`,
                    revenue: sql<number>`COALESCE(sum(CAST(${orders.amount} AS REAL)), 0)`,
                }).from(orders).where(and(
                    sql`${orders.status} IN ('paid', 'delivered')`,
                    sql`${normalizeTimestampMs(orders.paidAt)} >= ${monthStartMs}`
                )).groupBy(orders.productId, orders.productName).orderBy(desc(sql<number>`COALESCE(sum(CAST(${orders.amount} AS REAL)), 0)`)).limit(5),
                db.select({
                    orderId: orders.orderId,
                    productName: orders.productName,
                    username: orders.username,
                    amount: orders.amount,
                    pointsUsed: orders.pointsUsed,
                    status: orders.status,
                    createdAt: orders.createdAt,
                    paidAt: orders.paidAt,
                }).from(orders).orderBy(desc(normalizeTimestampMs(orders.createdAt))).limit(8),
                db.select({
                    id: products.id,
                    name: products.name,
                    stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
                    isActive: products.isActive,
                    fulfillmentMode: products.fulfillmentMode,
                    isShared: products.isShared,
                }).from(products),
                (async () => {
                    try {
                        await ensureUserPointLedgerSchema()
                        const rows = await db.select({
                            todayProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'checkin_reward' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                            todayConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.status} = 'completed' AND ${userPointLedger.eventType} = 'order_deduction' AND ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                        }).from(userPointLedger)
                        return rows
                    } catch (error: any) {
                        console.warn("Failed to query point rows in admin overview:", error)
                        return [{ todayProduced: 0, todayConsumed: 0 }]
                    }
                })(),
            ])

            // 窗口聚合与累计值来自不同查询，这里合并回原来的 finance 形状，
            // 让下游 toSafeNumber(finance.xxx) 的取值方式保持不变。
            const finance = {
                ...(monthlyRows[0] || {}),
                totalRevenue: (totalRevenueRows[0] as { totalRevenue?: number } | undefined)?.totalRevenue,
                todayRefunds: (refundWindowRows[0] as { todayRefunds?: number } | undefined)?.todayRefunds,
                monthRefunds: (refundWindowRows[0] as { monthRefunds?: number } | undefined)?.monthRefunds,
                pendingOrders: (opsRows[0] as { pendingOrders?: number } | undefined)?.pendingOrders,
                awaitingDelivery: (opsRows[0] as { awaitingDelivery?: number } | undefined)?.awaitingDelivery,
            }
            const refundCount = toSafeNumber((refundRows as any)?.[0]?.pendingRefunds)
            const unreadMessages = toSafeNumber((messageRows as any)?.[0]?.unreadMessages)
            const visitorCount = toSafeNumber((visitorRows as any)?.[0]?.count)
            const points = pointRows[0] || { todayProduced: 0, todayConsumed: 0 }

            const trendMap = new Map<string, { orders: number; revenue: number; refunds: number }>()
            for (const row of trendRows as Array<{ dayKey?: string; ordersCount?: number; revenue?: number; refunds?: number }>) {
                const key = String(row.dayKey || '')
                if (!key) continue
                trendMap.set(key, {
                    orders: toSafeNumber(row.ordersCount),
                    revenue: toSafeNumber(row.revenue),
                    refunds: toSafeNumber(row.refunds),
                })
            }

            const trend = emptyTrend.map((item) => {
                const hit = trendMap.get(item.date)
                return hit ? { ...item, ...hit } : item
            })

            const activeProducts = productRows.filter((row) => row.isActive !== false).length
            const lowStockItems = productRows
                .filter((row) => {
                    if (row.isActive === false) return false
                    if (row.isShared) return false
                    const stock = toSafeNumber(row.stock)
                    return stock < INFINITE_STOCK && stock <= threshold
                })
                .sort((a, b) => toSafeNumber(a.stock) - toSafeNumber(b.stock))
                .slice(0, 6)
                .map((row) => ({ id: row.id, name: row.name, stock: toSafeNumber(row.stock) }))

            return {
                kpis: {
                    todayRevenue: toSafeNumber(finance.todayRevenue),
                    yesterdayRevenue: toSafeNumber(finance.yesterdayRevenue),
                    todayOrders: toSafeNumber(finance.todayOrders),
                    yesterdayOrders: toSafeNumber(finance.yesterdayOrders),
                    monthRevenue: toSafeNumber(finance.monthRevenue),
                    totalRevenue: toSafeNumber(finance.totalRevenue),
                    todayRefunds: toSafeNumber(finance.todayRefunds),
                    monthRefunds: toSafeNumber(finance.monthRefunds),
                    todayPointsConsumed: toSafeNumber(points.todayConsumed),
                    todayPointsProduced: toSafeNumber(points.todayProduced),
                    visitorCount,
                },
                ops: {
                    pendingOrders: toSafeNumber(finance.pendingOrders),
                    awaitingDelivery: toSafeNumber(finance.awaitingDelivery),
                    pendingRefunds: refundCount,
                    unreadMessages,
                    lowStockProducts: lowStockItems.length,
                    activeProducts,
                },
                trend,
                topProducts: (topProductRows || []).map((row) => ({
                    productId: row.productId,
                    productName: row.productName,
                    orders: toSafeNumber(row.ordersCount),
                    revenue: toSafeNumber(row.revenue),
                })),
                recentOrders: (recentOrderRows || []).map((row) => ({
                    orderId: row.orderId,
                    productName: row.productName,
                    username: row.username,
                    amount: row.amount,
                    pointsUsed: toSafeNumber(row.pointsUsed),
                    status: row.status,
                    createdAt: row.createdAt,
                    paidAt: row.paidAt,
                })),
                lowStockItems,
            }
        })
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return emptyOverview
        throw error
    }
}

// Settings
export const getSetting = cache(async (key: string): Promise<string | null> => {
    try {
        const rows = await db.select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, key))
            .limit(1);
        return rows.length ? (rows[0].value || '') : null;
    } catch (error: unknown) {
        if (isMissingTable(error)) {
            await ensureSettingsTable();
            return null;
        }
        throw error;
    }
});

export const getAllSettings = cache(async (): Promise<Record<string, string>> => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value || '';
            return acc;
        }, {} as Record<string, string>);
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureSettingsTable();
            return {};
        }
        throw error;
    }
});

export async function setSetting(key: string, value: string): Promise<void> {
    await db.insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() }
        });
    if (key === 'schema_version') {
        primePersistedSchemaVersion(parseSchemaVersion(value));
    }
}

// Categories (best-effort; table created on demand)
async function ensureCategoriesTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS categories(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        icon TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name);
    `)
}

export async function getCategories(): Promise<Array<{ id: number; name: string; icon: string | null; sortOrder: number }>> {
    try {
        const rows = await db.select({
            id: categories.id,
            name: categories.name,
            icon: categories.icon,
            sortOrder: sql<number>`COALESCE(${categories.sortOrder}, 0)`,
        }).from(categories).orderBy(asc(categories.sortOrder), asc(categories.name))
        return rows
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureCategoriesTable()
            return []
        }
        throw error
    }
}

export async function createUserNotification(params: {
    userId: string | null | undefined
    type: string
    titleKey: string
    contentKey: string
    data?: Record<string, any> | null
}) {
    if (!params.userId) return
    await ensureDatabaseInitialized()
    try {
        await db.insert(userNotifications).values({
            userId: params.userId,
            type: params.type,
            titleKey: params.titleKey,
            contentKey: params.contentKey,
            data: params.data ? JSON.stringify(params.data) : null,
            isRead: false,
            createdAt: new Date()
        })
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            await db.insert(userNotifications).values({
                userId: params.userId,
                type: params.type,
                titleKey: params.titleKey,
                contentKey: params.contentKey,
                data: params.data ? JSON.stringify(params.data) : null,
                isRead: false,
                createdAt: new Date()
            })
            return
        }
        throw error
    }
}

export async function getUserNotifications(userId: string, limit: number = 20) {
    await ensureDatabaseInitialized()
    try {
        return await db.select({
            id: userNotifications.id,
            userId: userNotifications.userId,
            type: userNotifications.type,
            titleKey: userNotifications.titleKey,
            contentKey: userNotifications.contentKey,
            data: userNotifications.data,
            isRead: userNotifications.isRead,
            createdAt: userNotifications.createdAt
        })
            .from(userNotifications)
            .where(eq(userNotifications.userId, userId))
            .orderBy(desc(normalizeTimestampMs(userNotifications.createdAt)))
            .limit(limit)
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            return []
        }
        throw error
    }
}

export async function markAllUserNotificationsRead(userId: string) {
    await ensureDatabaseInitialized()
    try {
        await db.update(userNotifications)
            .set({ isRead: true })
            .where(eq(userNotifications.userId, userId))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            return
        }
        throw error
    }
}

export async function getUserUnreadNotificationCount(userId: string) {
    await ensureDatabaseInitialized()
    try {
        const rows = await db.select({
            count: sql<number>`count(*)`
        })
            .from(userNotifications)
            .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)))
        return Number(rows[0]?.count || 0)
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            return 0
        }
        throw error
    }
}

export async function markUserNotificationRead(userId: string, id: number) {
    await ensureDatabaseInitialized()
    try {
        await db.update(userNotifications)
            .set({ isRead: true })
            .where(and(eq(userNotifications.userId, userId), eq(userNotifications.id, id)))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            return
        }
        throw error
    }
}

export async function clearUserNotifications(userId: string) {
    await ensureDatabaseInitialized()
    try {
        await db.delete(userNotifications)
            .where(eq(userNotifications.userId, userId))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureUserNotificationsTable()
            return
        }
        throw error
    }
}

export async function searchActiveProducts(params: {
    q?: string
    category?: string
    sort?: string
    page?: number
    pageSize?: number
    fulfillment?: string
    isLoggedIn?: boolean
    trustLevel?: number | null
}) {
    const q = (params.q || '').trim()
    const category = (params.category || '').trim()
    const sort = (params.sort || 'default').trim()
    const fulfillment = (params.fulfillment || 'all').trim()
    const page = params.page && params.page > 0 ? params.page : 1
    const pageSize = Math.min(params.pageSize && params.pageSize > 0 ? params.pageSize : 24, 60)
    const offset = (page - 1) * pageSize

    const whereParts: any[] = [eq(products.isActive, true), visibilityCondition(params.isLoggedIn, params.trustLevel)]
    if (category && category !== 'all') whereParts.push(eq(products.category, category))
    if (q) {
        const like = `%${q}%`
        whereParts.push(or(
            sql`${products.name} LIKE ${like}`,
            sql`COALESCE(${products.description}, '') LIKE ${like}`
        ))
    }
    const whereExpr = and(...whereParts)

    const orderByParts: any[] = []
    switch (sort) {
        case 'priceAsc':
            orderByParts.push(asc(products.price))
            break
        case 'priceDesc':
            orderByParts.push(desc(products.price))
            break
        case 'stockDesc':
            orderByParts.push(desc(sql<number>`COALESCE(${products.stockCount}, 0) + COALESCE(${products.lockedCount}, 0)`))
            break
        case 'soldDesc':
            orderByParts.push(desc(sql<number>`COALESCE(${products.soldCount}, 0)`))
            break
        case 'hot':
            orderByParts.push(desc(sql<number>`case when ${products.isHot} = 1 then 1 else 0 end`))
            orderByParts.push(asc(products.sortOrder), desc(products.createdAt))
            break
        default:
            orderByParts.push(asc(products.sortOrder), desc(products.createdAt))
            break
    }

    const rows = await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            // 列表页最多展示两行摘要，整篇 Markdown 只在详情页需要。
            // 这里截断到 1000 字符，避免把长描述原样搬进 RSC payload。
            description: sql<string | null>`CASE
                WHEN ${products.description} IS NULL THEN NULL
                WHEN length(${products.description}) > 1000 THEN substr(${products.description}, 1, 1000)
                ELSE ${products.description}
            END`,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            image: products.image,
            category: products.category,
            isHot: products.isHot,
            isShared: products.isShared,
            fulfillmentMode: products.fulfillmentMode,
            purchaseLimit: products.purchaseLimit,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            sortOrder: products.sortOrder,
            createdAt: products.createdAt,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            rating: sql<number>`COALESCE(${products.rating}, 0)`,
            reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`
        })
            .from(products)
            .where(whereExpr)
            .orderBy(...orderByParts)
    })

    // 变体归组只能在 SQL 之外完成：同一变体组的行不保证相邻，且库存/价格/销量
    // 都要按组聚合，因此「总数」与「分页」只能发生在归组之后。这是当前 schema
    // 的固有限制（详见 outputs/ldc-shop-code-review-2026-09-24.md §2.1 路线 B）。
    const grouped = groupProductsAsVariants(rows)
    const withStock = grouped.map((item) => ({ ...item, stockCount: resolveProductStockCount(item) }))

    const filtered = fulfillment && fulfillment !== 'all'
        ? withStock.filter((item) => {
            if (fulfillment === 'auto') return !isManualFulfillment(item)
            if (fulfillment === 'manual') return isManualFulfillment(item)
            if (fulfillment === 'inStock') return item.stockCount > 0
            return true
        })
        : withStock

    const total = filtered.length
    const items = filtered.slice(offset, offset + pageSize)

    return {
        items,
        total,
        page,
        pageSize,
    }
}

export async function getActiveProductCategories(options?: { isLoggedIn?: boolean; trustLevel?: number | null }): Promise<string[]> {
    await ensureDatabaseInitialized();
    try {
        const rows = await db
            .select({ category: products.category })
            .from(products)
            .where(and(
                eq(products.isActive, true),
                visibilityCondition(options?.isLoggedIn, options?.trustLevel),
                sql`${products.category} IS NOT NULL`,
                sql`TRIM(${products.category}) <> ''`
            ))
            .groupBy(products.category)
            .orderBy(asc(products.category));
        return rows.map((r) => r.category as string).filter(Boolean);
    } catch (error: any) {
        if (isMissingTable(error)) return [];
        throw error;
    }
}

// Reviews
export async function getProductReviews(
    productId: string,
    limit = 20,
    cursor?: { createdAtMs: number; id: number } | null,
) {
    await ensureDatabaseInitialized()
    await ensureReviewRepliesTable()
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100)
    const cursorCondition = cursor
        ? sql`(
            COALESCE(${reviews.createdAt}, 0) < ${cursor.createdAtMs}
            OR (COALESCE(${reviews.createdAt}, 0) = ${cursor.createdAtMs} AND ${reviews.id} < ${cursor.id})
        )`
        : undefined
    const reviewRows = await db.select({
        id: reviews.id,
        productId: reviews.productId,
        orderId: reviews.orderId,
        userId: reviews.userId,
        rating: reviews.rating,
        comment: reviews.comment,
        createdAt: reviews.createdAt,
        nickname: loginUsers.nickname,
    })
        .from(reviews)
        .leftJoin(loginUsers, eq(reviews.userId, loginUsers.userId))
        .where(and(eq(reviews.productId, productId), cursorCondition))
        .orderBy(sql`COALESCE(${reviews.createdAt}, 0) DESC`, desc(reviews.id))
        .limit(safeLimit);

    if (!reviewRows.length) return reviewRows.map((review) => ({ ...review, replies: [] }));

    try {
        const replyRows = await db.select({
            id: reviewReplies.id,
            reviewId: reviewReplies.reviewId,
            userId: reviewReplies.userId,
            comment: reviewReplies.comment,
            createdAt: reviewReplies.createdAt,
            nickname: loginUsers.nickname,
        })
            .from(reviewReplies)
            .leftJoin(loginUsers, eq(reviewReplies.userId, loginUsers.userId))
            .where(inArray(reviewReplies.reviewId, reviewRows.map((review) => review.id)))
            .orderBy(asc(reviewReplies.createdAt));

        const replyMap = new Map<number, typeof replyRows>()
        for (const reply of replyRows) {
            const list = replyMap.get(reply.reviewId) ?? []
            list.push(reply)
            replyMap.set(reply.reviewId, list)
        }

        return reviewRows.map((review) => ({
            ...review,
            replies: replyMap.get(review.id) ?? [],
        }));
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
        return reviewRows.map((review) => ({ ...review, replies: [] }));
    }
}

export async function getProductRating(productId: string): Promise<{ average: number; count: number }> {
    const result = await db.select({
        avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
        count: sql<number>`COUNT(*)`
    })
        .from(reviews)
        .where(eq(reviews.productId, productId));

    return {
        average: result[0]?.avg ?? 0,
        count: result[0]?.count ?? 0
    };
}

export async function getProductRatings(productIds: string[]): Promise<Map<string, { average: number; count: number }>> {
    const map = new Map<string, { average: number; count: number }>();
    if (!productIds.length) return map;

    try {
        const rows = await db.select({
            productId: reviews.productId,
            avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
            count: sql<number>`COUNT(*)`
        })
            .from(reviews)
            .where(inArray(reviews.productId, productIds))
            .groupBy(reviews.productId);

        for (const row of rows) {
            map.set(row.productId, {
                average: row.avg ?? 0,
                count: row.count ?? 0
            });
        }
    } catch (error: any) {
        if (!isMissingTable(error)) throw error;
    }

    return map;
}

export async function createReview(data: {
    productId: string;
    orderId: string;
    userId: string;
    username: string;
    rating: number;
    comment?: string;
}) {
    const res = await db.insert(reviews).values({
        ...data,
        createdAt: new Date()
    }).returning();

    // Update product aggregates (rating/review_count)
    await recalcProductAggregates(data.productId);

    return res;
}

/**
 * reviewExistsForOrder 判断某订单是否已有评价。
 *
 * 这是「一单一评」的**廉价预检**：命中时直接返回业务错误，避免走进异常分支。
 * 真正的唯一性保证由 `reviews_order_id_uq` 唯一索引承担 ——
 * 预检与插入之间存在竞态，并发下仍可能两处都通过预检，
 * 此时后到的那次插入会被数据库拒绝（见 submitReview 的冲突处理）。
 */
export async function reviewExistsForOrder(orderId: string): Promise<boolean> {
    const normalized = String(orderId || '').trim()
    if (!normalized) return false
    try {
        const rows = await db.select({ id: reviews.id })
            .from(reviews)
            .where(eq(reviews.orderId, normalized))
            .limit(1)
        return rows.length > 0
    } catch (error: unknown) {
        if (isSchemaDriftError(error)) return false
        throw error
    }
}

export async function createReviewReply(data: {
    reviewId: number;
    userId: string;
    username: string;
    comment: string;
}) {
    await ensureReviewRepliesTable()
    return await db.insert(reviewReplies).values({
        ...data,
        createdAt: new Date(),
    }).returning();
}

export async function canUserReview(userId: string, productId: string, username?: string): Promise<{ canReview: boolean; orderId?: string }> {
    try {
        const findUnreviewedOrder = async (whereClause: any) => {
            const rows = await db.select({ orderId: orders.orderId })
                .from(orders)
                .leftJoin(reviews, eq(reviews.orderId, orders.orderId))
                .where(and(
                    whereClause,
                    eq(orders.productId, productId),
                    eq(orders.status, 'delivered'),
                    isNull(reviews.id)
                ))
                .orderBy(desc(normalizeTimestampMs(orders.createdAt)))
                .limit(1);
            return rows[0]?.orderId;
        };

        // Prefer userId; only fallback to username when userId has no delivered orders.
        const byUserIdOrderId = await findUnreviewedOrder(eq(orders.userId, userId));
        if (byUserIdOrderId) {
            return { canReview: true, orderId: byUserIdOrderId };
        }

        const hasDeliveredByUserId = await db.select({ orderId: orders.orderId })
            .from(orders)
            .where(and(
                eq(orders.userId, userId),
                eq(orders.productId, productId),
                eq(orders.status, 'delivered')
            ))
            .limit(1);
        if (hasDeliveredByUserId.length > 0) {
            return { canReview: false };
        }

        if (!username) {
            return { canReview: false };
        }

        const byUsernameOrderId = await findUnreviewedOrder(eq(orders.username, username));
        if (byUsernameOrderId) {
            return { canReview: true, orderId: byUsernameOrderId };
        }

        return { canReview: false };
    } catch (error) {
        console.error('canUserReview error:', error);
        return { canReview: false };
    }
}

export async function hasUserReviewedOrder(orderId: string): Promise<boolean> {
    const result = await db.select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.orderId, orderId));
    return result.length > 0;
}

function isMissingTable(error: any) {
    const errorString = collectErrorText(error).toLowerCase();
    return (
        error?.message?.includes('does not exist') ||
        error?.cause?.message?.includes('does not exist') ||
        errorString.includes('42p01') ||
        errorString.includes('no such table') ||
        (errorString.includes('relation') && errorString.includes('does not exist'))
    );
}

function isMissingTableOrColumn(error: any) {
    const errorString = collectErrorText(error).toLowerCase();
    return isMissingTable(error) || errorString.includes('42703') || errorString.includes('no such column') || errorString.includes('column not found') || errorString.includes('d1_column_notfound');
}

const TIMESTAMP_MS_THRESHOLD = 1_000_000_000_000;

export function normalizeTimestampMs(column: any) {
    return sql<number>`CASE WHEN ${column} < ${TIMESTAMP_MS_THRESHOLD} THEN ${column} * 1000 ELSE ${column} END`
}

async function migrateTimestampColumnsToMs() {
    const tableColumns = [
        { table: 'products', columns: ['created_at'] },
        { table: 'cards', columns: ['reserved_at', 'used_at', 'created_at'] },
        { table: 'orders', columns: ['paid_at', 'delivered_at', 'created_at'] },
        { table: 'login_users', columns: ['created_at', 'last_login_at'] },
        { table: 'daily_checkins_v2', columns: ['created_at'] },
        { table: 'settings', columns: ['updated_at'] },
        { table: 'reviews', columns: ['created_at'] },
        { table: 'review_replies', columns: ['created_at'] },
        { table: 'categories', columns: ['created_at', 'updated_at'] },
        { table: 'refund_requests', columns: ['created_at', 'updated_at', 'processed_at'] },
        { table: 'user_notifications', columns: ['created_at'] },
        { table: 'admin_messages', columns: ['created_at'] },
        { table: 'user_messages', columns: ['created_at'] },
        { table: 'broadcast_messages', columns: ['created_at'] },
        { table: 'broadcast_reads', columns: ['created_at'] },
        { table: 'wishlist_items', columns: ['created_at'] },
        { table: 'wishlist_votes', columns: ['created_at'] },
        { table: 'order_delivery_files', columns: ['created_at'] },
    ];

    for (const { table, columns } of tableColumns) {
        for (const column of columns) {
            try {
                await db.run(sql.raw(
                    `UPDATE ${table} SET ${column} = ${column} * 1000 WHERE ${column} IS NOT NULL AND ${column} < ${TIMESTAMP_MS_THRESHOLD}`
                ));
            } catch (error: any) {
                if (!isMissingTableOrColumn(error)) throw error;
            }
        }
    }
}

async function ensureLoginUsersTable() {
    await db.run(sql.raw(LOGIN_USERS_CREATE_TABLE_STATEMENT));
}

async function ensureSettingsTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS settings(
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        )
        `);
}

async function ensureUserNotificationsTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS user_notifications(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title_key TEXT NOT NULL,
            content_key TEXT NOT NULL,
            data TEXT,
            is_read INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `);
}

async function ensureAdminMessagesTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS admin_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_value TEXT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sender TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `);
}

async function ensureUserMessagesTable() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS user_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            username TEXT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        )
    `);
}

async function ensureBroadcastTables() {
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS broadcast_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sender TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS broadcast_reads(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
    `);

    await ensureCardKeyDuplicatesAllowed();
}

async function ensureWishlistTables() {
    if (wishlistTablesReady) return;
    await db.run(sql`
        CREATE TABLE IF NOT EXISTS wishlist_items(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            user_id TEXT,
            username TEXT,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS wishlist_votes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
            created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS wishlist_votes_item_user_uq ON wishlist_votes(item_id, user_id);
    `);

    await ensureWishlistColumns();
    wishlistTablesReady = true;
}

async function ensureWishlistColumns() {
    await safeAddColumn('wishlist_items', 'description', 'TEXT');
    await safeAddColumn('wishlist_items', 'user_id', 'TEXT');
    await safeAddColumn('wishlist_items', 'username', 'TEXT');
    await safeAddColumn('wishlist_items', 'created_at', 'INTEGER');
    await safeAddColumn('wishlist_votes', 'created_at', 'INTEGER');
}

type GitHubLoginUserRow = {
    userId: string
    username: string | null
    nickname: string | null
    email: string | null
    points: number
    isBlocked: boolean
    desktopNotificationsEnabled: boolean
    createdAt: Date | null
    lastLoginAt: Date | null
}

function toEpochMs(value: Date | number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function pickCanonicalGitHubUser(rows: GitHubLoginUserRow[]) {
    const byRecentLoginDesc = [...rows].sort((a, b) => {
        const bTime = toEpochMs(b.lastLoginAt) || 0
        const aTime = toEpochMs(a.lastLoginAt) || 0
        if (bTime !== aTime) return bTime - aTime
        const aCreated = toEpochMs(a.createdAt) || 0
        const bCreated = toEpochMs(b.createdAt) || 0
        return aCreated - bCreated
    })

    const stableProviderId = byRecentLoginDesc.find((row) => /^github:\d+$/i.test(row.userId))
    if (stableProviderId) return stableProviderId

    const githubScoped = byRecentLoginDesc.find((row) => row.userId.toLowerCase().startsWith('github:'))
    if (githubScoped) return githubScoped

    return byRecentLoginDesc[0]
}

function normalizeGitHubUserIdValue(userId?: string | null): string | null {
    return canonicalGitHubUserId(userId)
}

function normalizeGitHubUsernameValue(username?: string | null): string | null {
    if (!username) return null
    const normalized = username.trim().toLowerCase()
    if (!normalized) return null
    return normalized
}

function isInvalidGitHubPlaceholderUser(userId?: string | null, username?: string | null) {
    const normalizedUserId = (userId || '').trim().toLowerCase()
    const normalizedUsername = (username || '').trim().toLowerCase()

    return (
        normalizedUserId === 'github:undefined' ||
        normalizedUserId === 'github:null' ||
        normalizedUserId === 'github:nan' ||
        normalizedUsername === 'gh_undefined' ||
        normalizedUsername === 'gh_null' ||
        normalizedUsername === 'gh_nan'
    )
}

async function migrateMalformedGitHubUserIds() {
    await ensureLoginUsersSchema()

    const malformedRows = await db.select({
        userId: loginUsers.userId,
        username: loginUsers.username,
        nickname: loginUsers.nickname,
        email: loginUsers.email,
        points: loginUsers.points,
        isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
        desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
        createdAt: loginUsers.createdAt,
        lastLoginAt: loginUsers.lastLoginAt,
    })
        .from(loginUsers)
        .where(sql`LOWER(${loginUsers.userId}) LIKE 'github:github:%'`)

    if (!malformedRows.length) return

    for (const row of malformedRows) {
        const sourceUser: GitHubLoginUserRow = {
            userId: row.userId,
            username: row.username || null,
            nickname: row.nickname || null,
            email: row.email || null,
            points: Number(row.points || 0),
            isBlocked: !!row.isBlocked,
            desktopNotificationsEnabled: !!row.desktopNotificationsEnabled,
            createdAt: row.createdAt || null,
            lastLoginAt: row.lastLoginAt || null,
        }

        const targetUserId = normalizeGitHubUserIdValue(sourceUser.userId)
        if (!targetUserId || !isSameGitHubAccount(sourceUser.userId, targetUserId)) continue

        const normalizedUsername = normalizeGitHubUsernameValue(sourceUser.username)
        await runAtomicD1Batch(buildLoginUserMergeStatements({
            source: sourceUser,
            targetUserId,
            username: normalizedUsername,
        }))
        invalidateVisitorCountCache();
    }
}

async function migrateGitHubUsersDedupAndCanonicalize() {
    await ensureLoginUsersSchema()

    const githubUsers = await db.select({
        userId: loginUsers.userId,
        username: loginUsers.username,
        nickname: loginUsers.nickname,
        email: loginUsers.email,
        points: loginUsers.points,
        isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
        desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
        createdAt: loginUsers.createdAt,
        lastLoginAt: loginUsers.lastLoginAt,
    })
        .from(loginUsers)
        .where(sql`${loginUsers.username} IS NOT NULL AND LOWER(${loginUsers.username}) LIKE 'gh_%'`)

    if (!githubUsers.length) return

    const groups = new Map<string, GitHubLoginUserRow[]>()
    for (const row of githubUsers) {
        const normalizedUsername = (row.username || '').trim().toLowerCase()
        if (!normalizedUsername.startsWith('gh_')) continue
        const list = groups.get(normalizedUsername) || []
        list.push({
            userId: row.userId,
            username: row.username,
            nickname: row.nickname || null,
            email: row.email || null,
            points: Number(row.points || 0),
            isBlocked: !!row.isBlocked,
            desktopNotificationsEnabled: !!row.desktopNotificationsEnabled,
            createdAt: row.createdAt || null,
            lastLoginAt: row.lastLoginAt || null,
        })
        groups.set(normalizedUsername, list)
    }

    for (const [normalizedUsername, rows] of groups.entries()) {
        if (!rows.length) continue
        const canonical = pickCanonicalGitHubUser(rows)
        if (!canonical) continue
        const sameAccountRows = rows.filter((row) => isSameGitHubAccount(row.userId, canonical.userId))
        if (sameAccountRows.length < 2) continue

        for (const row of sameAccountRows) {
            if (row.userId === canonical.userId) continue
            await runAtomicD1Batch(buildLoginUserMergeStatements({
                source: row,
                targetUserId: canonical.userId,
                username: normalizedUsername,
            }))
            invalidateVisitorCountCache();
        }
    }
}

async function isLoginUsersBackfilled(): Promise<boolean> {
    try {
        const result = await db.select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, 'login_users_backfilled'));
        return result[0]?.value === '1';
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureSettingsTable();
            return false;
        }
        throw error;
    }
}

async function markLoginUsersBackfilled() {
    await db.insert(settings).values({
        key: 'login_users_backfilled',
        value: '1',
        updatedAt: new Date()
    }).onConflictDoUpdate({
        target: settings.key,
        set: { value: '1', updatedAt: new Date() }
    });
}

async function backfillLoginUsersFromOrdersAndReviews() {
    const alreadyBackfilled = await isLoginUsersBackfilled();
    if (alreadyBackfilled) return;

    await ensureLoginUsersTable();

    try {
        await db.run(sql`
            INSERT INTO login_users(user_id, username, created_at, last_login_at)
            SELECT user_id, MAX(username) AS username, (unixepoch() * 1000), (unixepoch() * 1000)
            FROM (
                SELECT user_id, username FROM orders WHERE user_id IS NOT NULL AND user_id <> ''
                UNION ALL
                SELECT user_id, username FROM reviews WHERE user_id IS NOT NULL AND user_id <> ''
            )
            GROUP BY user_id
            ON CONFLICT(user_id) DO NOTHING
        `);
    } catch (error: any) {
        if (isMissingTable(error)) return;
        throw error;
    }

    await markLoginUsersBackfilled();
    invalidateVisitorCountCache();
}

async function persistLoginUser(userId: string, username?: string | null, email?: string | null) {
    const nextUsername = username || null;
    const now = new Date();
    const existing = await db.select({
        username: loginUsers.username,
        email: loginUsers.email,
        lastLoginAt: loginUsers.lastLoginAt,
    })
        .from(loginUsers)
        .where(eq(loginUsers.userId, userId))
        .limit(1);

    const current = existing[0];
    if (!current) {
        const result = await db.insert(loginUsers).values({
            userId,
            username: nextUsername,
            email: email || null,
            lastLoginAt: now,
        });
        invalidateVisitorCountCache();
        if ((result as any)?.meta?.changes === 1) {
            try {
                updateTag('home:visitors');
            } catch {
                // best effort
            }
        }
        return;
    }

    const lastLoginAtMs = toEpochMs(current.lastLoginAt);
    const heartbeatFresh = lastLoginAtMs !== null && (Date.now() - lastLoginAtMs) < LOGIN_HEARTBEAT_TTL_MS;
    const usernameUnchanged = (current.username || null) === nextUsername;
    const emailAlreadySet = !email || !!current.email;

    if (heartbeatFresh && usernameUnchanged && emailAlreadySet) {
        return;
    }

    const patch: { username?: string | null; lastLoginAt?: Date } = {};
    if (!usernameUnchanged) patch.username = nextUsername;
    if (!heartbeatFresh) patch.lastLoginAt = now;
    if (Object.keys(patch).length > 0) {
        await db.update(loginUsers)
            .set(patch)
            .where(eq(loginUsers.userId, userId));
    }
    if (email && !current.email) {
        try {
            await db.run(sql`UPDATE login_users SET email = ${email} WHERE user_id = ${userId} AND (email IS NULL OR email = '')`);
        } catch {
            // best effort
        }
    }
}

export async function recordLoginUser(userId: string, username?: string | null, email?: string | null) {
    if (!userId) return;
    if (isInvalidGitHubPlaceholderUser(userId, username)) {
        console.warn("recordLoginUser skipped invalid GitHub placeholder user", { userId, username })
        return;
    }

    try {
        await persistLoginUser(userId, username, email);
    } catch (error: any) {
        if (isMissingTable(error) || error?.code === '42703' || error?.message?.includes('column')) {
            await ensureLoginUsersSchema();
            try {
                await persistLoginUser(userId, username, email);
            } catch (retryError) {
                console.error('recordLoginUser error:', retryError);
            }
            return;
        }
        console.error('recordLoginUser error:', error);
    }
}

export async function getLoginUserEmail(userId: string): Promise<string | null> {
    if (!userId) return null;
    try {
        const result = await db.select({ email: loginUsers.email })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);
        return result[0]?.email ?? null;
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return null;
        throw error;
    }
}

export async function getLoginUserNickname(userId: string): Promise<string | null> {
    if (!userId) return null;
    try {
        const result = await db.select({ nickname: loginUsers.nickname })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);
        return result[0]?.nickname?.trim() || null;
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return null;
        throw error;
    }
}

export async function updateLoginUserNickname(userId: string, nickname: string) {
    if (!userId) return;
    const doUpdate = async () => {
        await db.insert(loginUsers).values({
            userId,
            nickname,
            lastLoginAt: new Date(),
        }).onConflictDoUpdate({
            target: loginUsers.userId,
            set: { nickname, lastLoginAt: new Date() },
        });
        invalidateVisitorCountCache();
    };

    try {
        await doUpdate();
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) {
            await ensureLoginUsersSchema();
            await doUpdate();
            return;
        }
        throw error;
    }
}

export async function updateLoginUserEmail(userId: string, email: string | null) {
    if (!userId) return;
    const doUpdate = async () => {
        const existing = await db.select({ userId: loginUsers.userId })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);

        if (existing.length > 0) {
            await db.update(loginUsers)
                .set({ email: email || null, lastLoginAt: new Date() })
                .where(eq(loginUsers.userId, userId));
        } else {
            await db.insert(loginUsers).values({
                userId,
                email: email || null,
                lastLoginAt: new Date(),
            });
            invalidateVisitorCountCache();
        }
    };

    try {
        await doUpdate();
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) {
            await ensureLoginUsersSchema();
            await doUpdate();
            return;
        }
        throw error;
    }
}

export async function getLoginUserDesktopNotificationsEnabled(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
        const result = await db.select({ enabled: loginUsers.desktopNotificationsEnabled })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);
        return Boolean(result[0]?.enabled);
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return false;
        throw error;
    }
}

export async function updateLoginUserDesktopNotificationsEnabled(userId: string, enabled: boolean) {
    if (!userId) return;
    try {
        await ensureLoginUsersSchema();
        await db.update(loginUsers)
            .set({ desktopNotificationsEnabled: enabled, lastLoginAt: new Date() })
            .where(eq(loginUsers.userId, userId));
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return;
        throw error;
    }
}

export async function cleanupExpiredCardsIfNeeded(throttleMs: number = 10 * 60 * 1000, productId?: string) {
    const now = Date.now();
    try {
        await ensureCardsColumns();
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
        return false;
    }

    if (productId) {
        try {
            const hasExpired = await db.select({ id: cards.id })
                .from(cards)
                .where(and(
                    eq(cards.productId, productId),
                    sql`${cards.expiresAt} IS NOT NULL AND ${cards.expiresAt} < ${now}`
                ))
                .limit(1);
            if (hasExpired.length > 0) {
                throttleMs = 0;
            }
        } catch (error: any) {
            if (!isMissingTableOrColumn(error)) throw error;
        }
    }

    let lastRun = 0;
    try {
        const last = await getSetting('cards_expiry_cleanup_at');
        lastRun = Number(last || 0);
    } catch {
        // best effort
    }

    if (now - lastRun < throttleMs) return false;

    let affectedProductIds: string[] = [];
    try {
        const rows = await db.select({ productId: cards.productId })
            .from(cards)
            .where(sql`${cards.expiresAt} IS NOT NULL AND ${cards.expiresAt} < ${now}`);
        affectedProductIds = Array.from(new Set(rows.map((r) => r.productId).filter(Boolean)));
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    try {
        await db.run(sql`DELETE FROM cards WHERE expires_at IS NOT NULL AND expires_at < ${now}`);
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
    }

    if (affectedProductIds.length > 0) {
        try {
            await recalcProductAggregatesForMany(affectedProductIds);
        } catch {
            // best effort
        }
        try {
            updateTag('home:products');
            updateTag('home:product-categories');
        } catch {
            // best effort
        }
    }

    try {
        await setSetting('cards_expiry_cleanup_at', String(now));
    } catch {
        // best effort
    }

    return true;
}

// Public site-wide total: keep a bounded per-Worker snapshot to avoid scanning
// every login_users row for each page render (the deployed tag cache is dummy).
// Each isolate refreshes within 5 minutes; mutations in this isolate invalidate immediately.
const visitorCountCache = createAsyncTtlCache(5 * 60 * 1000, async () => {
    await backfillLoginUsersFromOrdersAndReviews();
    const result = await db.select({ count: sql<number>`count(*)` })
        .from(loginUsers);
    return Number(result[0]?.count || 0);
});

export function invalidateVisitorCountCache() {
    visitorCountCache.invalidate();
}

export const getVisitorCount = cache(async (): Promise<number> => {
    try {
        return await visitorCountCache.get();
    } catch (error: unknown) {
        if (isMissingTable(error)) return 0;
        throw error;
    }
});

export async function cancelExpiredOrders(filters: { productId?: string; userId?: string; orderId?: string } = {}) {
    const productId = filters.productId ?? null;
    const userId = filters.userId ?? null;
    const orderId = filters.orderId ?? null;

    try {
        await Promise.all([
            ensureOrdersColumns(),
            ensureCardsColumns(),
        ])
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error
    }

    try {
        // No transaction - D1 doesn't support SQL transactions
        const fiveMinutesAgoMs = Date.now() - RESERVATION_TTL_MS;
        // Preselect expired orders because D1 may not return rows for UPDATE ... RETURNING
        const candidates = await db
            .select({
                orderId: orders.orderId,
                productId: orders.productId,
                userId: orders.userId,
                username: orders.username,
                email: orders.email,
                pointsUsed: orders.pointsUsed,
            })
            .from(orders)
            .where(and(
                eq(orders.status, 'pending'),
                lte(orders.createdAt, new Date(fiveMinutesAgoMs)),
                productId ? eq(orders.productId, productId) : sql`1=1`,
                userId ? eq(orders.userId, userId) : sql`1=1`,
                orderId ? eq(orders.orderId, orderId) : sql`1=1`
            ));

        const orderIds = candidates.map((row) => row.orderId).filter(Boolean);
        if (!orderIds.length) return orderIds;

        const actuallyCancelled: typeof candidates = [];
        let releasedCouponUsageCount = 0;
        for (const expired of candidates) {
            const expiredOrderId = expired.orderId;
            if (!expiredOrderId) continue;
            const cancelled = await db.update(orders)
                .set({ status: 'cancelled' })
                .where(and(
                    eq(orders.orderId, expiredOrderId),
                    eq(orders.status, 'pending')
                ))
                .returning({ orderId: orders.orderId });
            if (!cancelled.length) continue;
            actuallyCancelled.push(expired);

            if (expired.userId && expired.pointsUsed && expired.pointsUsed > 0) {
                await ensurePointLedgerUserRecord({
                    userId: expired.userId,
                    username: expired.username ?? null,
                    email: expired.email ?? null,
                });
                await applyUserAutomaticPointEvent({
                    userId: expired.userId,
                    username: expired.username ?? null,
                    email: expired.email ?? null,
                    eventType: "refund_return",
                    delta: expired.pointsUsed,
                    businessKey: `refund_return:${expiredOrderId}`,
                    sourceType: "order",
                    sourceId: expiredOrderId,
                    reason: `订单 ${expiredOrderId} 超时取消返还积分`,
                    metadata: JSON.stringify({
                        action: "timeout_cancel",
                    }),
                });
            }
            try {
                // 超时取消同时释放优惠券预占，避免次数被永久占用
                const { releaseCouponUsages } = await import("@/lib/coupons/reservation");
                releasedCouponUsageCount += await releaseCouponUsages(expiredOrderId, 'timeout_cancel');
            } catch (error: any) {
                console.error('[Coupon] Release on timeout cancel failed:', error);
            }
        }

        if (releasedCouponUsageCount > 0) {
            console.info('[Coupon] Released reservations on timeout cancel:', releasedCouponUsageCount);
        }

        // 卡密释放改为**循环外一次性批量**：
        // 此前每取消一单就发一条 UPDATE，超时清理扫到 N 单就是 N 次 D1 写往返。
        // 现在按 reserved_order_id IN (...) 合并为一条，写入次数从 O(N) 降到 O(1)。
        const cancelledOrderIds = actuallyCancelled
            .map((row) => row.orderId)
            .filter((value): value is string => Boolean(value));
        if (cancelledOrderIds.length > 0) {
            try {
                // Mirror manual cancel behavior to guarantee release
                await db.update(cards)
                    .set({ reservedOrderId: null, reservedAt: null })
                    .where(inArray(cards.reservedOrderId, cancelledOrderIds));
            } catch (error: any) {
                if (!isMissingTableOrColumn(error)) throw error;
            }
        }

        // 商品聚合一次性重算：recalcProductAggregatesForMany 内部按批处理，
        // 不再「每个受影响商品各跑一遍全量聚合」。
        const productIds = Array.from(new Set(actuallyCancelled.map((row) => row.productId).filter(Boolean)));
        if (productIds.length > 0) {
            try {
                await recalcProductAggregatesForMany(productIds);
            } catch {
                // best effort
            }
        }
        try {
            updateTag('home:products');
            updateTag('home:product-categories');
        } catch {
            // best effort
        }
        try {
            revalidatePath('/orders');
            revalidatePath('/admin/orders');
            revalidatePath('/admin/users');
            for (const expired of actuallyCancelled) {
                if (expired.orderId) {
                    revalidatePath(`/order/${expired.orderId}`);
                }
                if (expired.userId) {
                    revalidatePath(`/admin/users/${expired.userId}`);
                }
            }
        } catch {
            // best effort
        }

        return actuallyCancelled.map((row) => row.orderId).filter(Boolean);
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return [];
        throw error;
    }
}

// Customer Management
export async function getUsers(page = 1, pageSize = 20, q = '') {
    const offset = (page - 1) * pageSize
    const search = q.trim()
    const activityThresholds = getCustomerActivityThresholds()

    try {
        await backfillLoginUsersFromOrdersAndReviews();
        await ensureLoginUsersSchema();

        let whereClause = undefined
        if (search) {
            const like = `%${search}%`
            whereClause = or(
                sql`${loginUsers.nickname} LIKE ${like}`,
                sql`${loginUsers.username} LIKE ${like}`,
                sql`${loginUsers.userId} LIKE ${like}`
            )
        }

        const itemsPromise = db.select({
            userId: loginUsers.userId,
            nickname: loginUsers.nickname,
            username: loginUsers.username,
            points: loginUsers.points,
            isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
            lastLoginAt: loginUsers.lastLoginAt,
            createdAt: loginUsers.createdAt,
            orderCount: sql<number>`count(CASE WHEN ${orders.status} IN ('paid', 'delivered', 'refunded') THEN 1 END)`
        })
            .from(loginUsers)
            .leftJoin(orders, eq(loginUsers.userId, orders.userId))
            .where(whereClause)
            .groupBy(loginUsers.userId)
            .orderBy(desc(loginUsers.lastLoginAt))
            .limit(pageSize)
            .offset(offset)

        const countQuery = db.select({ count: sql<number>`count(DISTINCT ${loginUsers.userId})` })
            .from(loginUsers)
            .where(whereClause)

        const activityQuery = db.select({
            today: sql<number>`COUNT(CASE WHEN ${loginUsers.lastLoginAt} >= ${activityThresholds.todayStartMs} THEN 1 END)`,
            last7Days: sql<number>`COUNT(CASE WHEN ${loginUsers.lastLoginAt} >= ${activityThresholds.last7DaysStartMs} THEN 1 END)`,
            last30Days: sql<number>`COUNT(CASE WHEN ${loginUsers.lastLoginAt} >= ${activityThresholds.last30DaysStartMs} THEN 1 END)`,
        }).from(loginUsers)

        const [items, totalRes, activityRes] = await Promise.all([itemsPromise, countQuery, activityQuery])
        const activity = activityRes[0]

        return {
            items,
            total: totalRes[0]?.count || 0,
            page,
            pageSize,
            activity: {
                today: Number(activity?.today || 0),
                last7Days: Number(activity?.last7Days || 0),
                last30Days: Number(activity?.last30Days || 0),
            },
        }
    } catch (error: any) {
        if (isMissingTable(error)) {
            return {
                items: [],
                total: 0,
                page,
                pageSize,
                activity: { today: 0, last7Days: 0, last30Days: 0 },
            }
        }
        throw error
    }
}

export async function toggleUserBlock(userId: string, isBlocked: boolean) {
    await ensureLoginUsersTable();
    // Ensure column exists
    try {
        await db.run(sql.raw(`ALTER TABLE login_users ADD COLUMN is_blocked INTEGER DEFAULT 0`));
    } catch { /* duplicate column */ }

    await db.update(loginUsers)
        .set({ isBlocked })
        .where(eq(loginUsers.userId, userId));
}

export async function getUserPendingOrders(userId: string) {
    return await db.select({
        orderId: orders.orderId,
        createdAt: orders.createdAt,
        productName: orders.productName,
        amount: orders.amount
    })
        .from(orders)
        .where(and(
            eq(orders.userId, userId),
            eq(orders.status, 'pending')
        ))
        .orderBy(desc(normalizeTimestampMs(orders.createdAt)));
}
