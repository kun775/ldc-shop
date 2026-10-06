/**
 * 低水位补货扫描（接入方案阶段 C 第 5 条）。
 *
 * 这是**可靠补货系统**，管理端「拉一张」/ 售后补一张之类只是辅助触发：
 * 那些入口依赖人工点击或某条业务路径恰好走到，做不到「库存被买空后自动补回」。
 *
 * 两条刻意的节奏约束：
 *   - **串行**：同一轮里一次只跑一个补货任务，避免并发 Allocate 把中心配额
 *     打满、也避免多个未确认分配同时逼近 30 分钟窗口；
 *   - **单商品有上限**：目标库存再高也不会在一轮里无限循环，剩余额度留给
 *     下一轮（cron 每分钟一次，收敛速度足够）。
 */

import { RESERVATION_TTL_MS } from '../constants.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'
import { listCardServiceProgramProducts } from './product-config.ts'
import { restockProductCardsBatch, type RestockDeps, type RestockResult } from './restock.ts'

/** 未显式配置 `target_stock` 时的目标库存：够卖一单。 */
export const CARD_SERVICE_DEFAULT_TARGET_STOCK = 1

/** 单商品单轮最多申请几张（一次批量领取，逐笔串行确认）。 */
export const CARD_SERVICE_REPLENISH_BATCH_LIMIT = 20

/** 单轮最多扫描多少个已接入商品。其余留到下一轮，从上次停住的商品之后继续。 */
export const CARD_SERVICE_REPLENISH_PRODUCT_LIMIT = 20

/** 单轮全场最多申请多少张，失败或部分成功也消耗预算。 */
export const CARD_SERVICE_REPLENISH_ROUND_CARD_LIMIT = 20

/** 补货轮转游标。存在现有 settings 表，不新增迁移。 */
export const CARD_SERVICE_REPLENISH_CURSOR_KEY = 'card_service_replenish_cursor'

/** 交付、对账、作废 cron 未传 limit 时的处理量；补货使用独立预算。 */
export const CARD_SERVICE_CRON_DEFAULT_LIMIT = 1

/** 交付、对账、作废 cron 允许的最大处理量，不影响补货预算。 */
export const CARD_SERVICE_CRON_MAX_LIMIT = 10

/** 读取补货轮转游标。settings 表缺失时视为没有游标。 */
export async function readReplenishCursor(database: CardServiceDatabase): Promise<string | null> {
    try {
        const rows = await database.query<{ value?: unknown }>(
            'SELECT value FROM settings WHERE key = ? LIMIT 1',
            [CARD_SERVICE_REPLENISH_CURSOR_KEY],
        )
        const value = rows[0]?.value
        return typeof value === 'string' && value.trim() ? value : null
    } catch (error) {
        if (isMissingTableError(error)) return null
        throw error
    }
}

export async function writeReplenishCursor(database: CardServiceDatabase, cursor: string, nowMs = Date.now()): Promise<void> {
    await database.write([{
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [CARD_SERVICE_REPLENISH_CURSOR_KEY, cursor, nowMs],
    }])
}

/**
 * 未传、空串、非数字一律用默认值。
 *
 * `Number(null)` 与 `Number("")` 都是 0，而 `Number("abc")` 是 NaN。
 * 非法文本不能比「没传」处理得更多。
 */
export function clampCardServiceCronLimit(raw: string | null): number {
    if (raw == null || raw.trim() === '') return CARD_SERVICE_CRON_DEFAULT_LIMIT
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return CARD_SERVICE_CRON_DEFAULT_LIMIT
    return Math.min(CARD_SERVICE_CRON_MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
}

export interface ReplenishSummary {
    products: number
    /** 本轮申请预算用量，与成功物化张数分开统计。 */
    requested: number
    restocked: number
    skipped: number
    deferred: number
    expired: number
    failed: number
    /**
     * 本轮**真正把新卡搬进本地卡池**的商品（去重）。
     *
     * 单独带出来是因为 `products.stock_count` 只在 `recalcProductAggregates*`
     * 里回写：装配层拿到这批 ID 才能重算前台库存，否则「补货成功但商品页
     * 还是缺货」。
     */
    changedProductIds: string[]
    /** 本轮扫描停住的商品。下一轮把它传回 `afterProductId`，从它后面继续。 */
    cursor: string | null
}

export function emptyReplenishSummary(): ReplenishSummary {
    return { products: 0, requested: 0, restocked: 0, skipped: 0, deferred: 0, expired: 0, failed: 0, changedProductIds: [], cursor: null }
}

function tally(summary: ReplenishSummary, result: RestockResult, productId: string) {
    switch (result.status) {
        case 'restocked':
            if (!summary.changedProductIds.includes(productId)) summary.changedProductIds.push(productId)
            break
        case 'skipped': summary.skipped += 1; break
        case 'deferred': summary.deferred += 1; break
        case 'expired': summary.expired += 1; break
        case 'failed': summary.failed += 1; break
    }
}

/**
 * 统计「新订单现在就能拿到的」本地卡数量。
 *
 * 判据与 `reserveCardsForFulfillment` 的候选池一致（未使用、未被预留、未过期），
 * 因此这是一个**补货阈值**口径，不是商品页展示的那个库存口径 —— 后者还会叠加
 * 手动库存与共享卡语义。用它来触发补货是合适的：一张卡被订单预留后就会立刻
 * 计入缺口，从而尽早触发下一张的领取。
 */
export async function countReplenishableLocalCards(
    deps: RestockDeps,
    productId: string,
    nowMs: number,
): Promise<number> {
    const rows = await deps.database.query<{ available?: unknown }>(
        `SELECT COUNT(*) AS available FROM cards
         WHERE product_id = ?
           AND (is_used = 0 OR is_used IS NULL)
           AND (reserved_at IS NULL OR reserved_at < ?)
           AND (expires_at IS NULL OR expires_at > ?)`,
        [productId, nowMs - RESERVATION_TTL_MS, nowMs],
    )
    const parsed = Number(rows[0]?.available)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export interface ReplenishOptions {
    /** 单商品单轮补货上限，默认 `CARD_SERVICE_REPLENISH_BATCH_LIMIT`。 */
    maxPerProduct?: number
    /** 单轮扫描的商品数上限，默认 `CARD_SERVICE_REPLENISH_PRODUCT_LIMIT`。 */
    maxProducts?: number
    /** 单轮全场申请张数上限，默认 `CARD_SERVICE_REPLENISH_ROUND_CARD_LIMIT`。 */
    maxCards?: number
    /**
     * 上一轮停住的商品 ID。本轮从它的下一个开始，扫到末尾再回头，
     * 避免每轮都只处理排序后的前几个商品。
     */
    afterProductId?: string | null
    /** 触发来源文案，写入 Allocate 的 `metadata.source`。 */
    reason?: string
}

function clampReplenishBudget(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
    return Math.min(100, Math.max(1, Math.trunc(value)))
}

/**
 * 仅扫描明确上架且走通用卡密服务的商品，把低于目标库存的部分补齐。
 * 未上架商品不查卡库存、不占扫描预算、不发起新补货；上架后自动恢复。
 *
 * 目标库存留空时默认保有 1 张；设为 0 时暂停自动补货，已有卡仍可正常销售。
 * 每轮有补货上限，较大的库存缺口由后续定时任务逐步补齐。
 */
export async function replenishLowStockProducts(
    deps: RestockDeps,
    options: ReplenishOptions = {},
): Promise<ReplenishSummary> {
    const summary = emptyReplenishSummary()
    const now = deps.now ?? (() => Date.now())
    const maxPerProduct = clampReplenishBudget(options.maxPerProduct, CARD_SERVICE_REPLENISH_BATCH_LIMIT)
    const maxProducts = clampReplenishBudget(options.maxProducts, CARD_SERVICE_REPLENISH_PRODUCT_LIMIT)
    const maxCards = clampReplenishBudget(options.maxCards, CARD_SERVICE_REPLENISH_ROUND_CARD_LIMIT)
    const reason = options.reason ?? 'low-water'

    const products = [...await listCardServiceProgramProducts(deps.database)]
        .sort((left, right) => left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0)
    summary.products = products.length
    const start = Math.max(0, products.findIndex((product) => product.productId > (options.afterProductId ?? '')))
    const ordered = start > 0 ? [...products.slice(start), ...products.slice(0, start)] : products

    let scanned = 0
    for (const product of ordered) {
        if (scanned >= maxProducts || summary.requested >= maxCards) break
        scanned += 1
        summary.cursor = product.productId
        const target = product.targetStock ?? CARD_SERVICE_DEFAULT_TARGET_STOCK
        if (target <= 0) {
            summary.skipped += 1
            continue
        }

        let available: number
        try {
            available = await countReplenishableLocalCards(deps, product.productId, now())
        } catch {
            // 库存查询失败同样只算本商品失败：抛出去会丢掉本轮已成功的补货摘要，
            // 装配层也就拿不到 changedProductIds（前台库存不重算）和游标（不推进）。
            summary.failed += 1
            continue
        }
        const quantity = Math.min(target - available, maxPerProduct, maxCards - summary.requested, 100)
        if (quantity <= 0) continue

        // 先扣申请预算：部分成功、全部失败或未预期异常都不能释放额度去超量领取。
        summary.requested += quantity
        try {
            const batch = await restockProductCardsBatch(deps, {
                productId: product.productId,
                quantity,
                reason,
            })
            summary.restocked += batch.restocked
            for (const result of batch.results) tally(summary, result, product.productId)
            // 准入跳过没有发起领取；尤其候选读取后下架的商品不能消耗申请预算。
            if (batch.results.length > 0 && batch.results.every((result) => result.status === 'skipped')) {
                summary.requested -= quantity
            }
        } catch {
            // 保留此前已成功的摘要和游标，让装配层仍能重算 changedProductIds。
            summary.failed += 1
        }
    }

    return summary
}
