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
import { listCardServiceProgramProducts } from './product-config.ts'
import { restockProductCards, type RestockDeps, type RestockResult } from './restock.ts'

/** 未显式配置 `target_stock` 时的目标库存：够卖一单。 */
export const CARD_SERVICE_DEFAULT_TARGET_STOCK = 1

/** 单商品单轮最多补几张（仍需逐张串行执行）。 */
export const CARD_SERVICE_REPLENISH_BATCH_LIMIT = 5

export interface ReplenishSummary {
    products: number
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
}

export function emptyReplenishSummary(): ReplenishSummary {
    return { products: 0, restocked: 0, skipped: 0, deferred: 0, expired: 0, failed: 0, changedProductIds: [] }
}

function tally(summary: ReplenishSummary, result: RestockResult, productId: string) {
    switch (result.status) {
        case 'restocked':
            summary.restocked += 1
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
    /** 触发来源文案，写入 Allocate 的 `metadata.source`。 */
    reason?: string
}

/**
 * 扫描所有走通用卡密服务的商品，把低于目标库存的部分补齐。
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
    const maxPerProduct = Math.max(1, Math.trunc(options.maxPerProduct ?? CARD_SERVICE_REPLENISH_BATCH_LIMIT))
    const reason = options.reason ?? 'low-water'

    const products = await listCardServiceProgramProducts(deps.database)
    summary.products = products.length

    for (const product of products) {
        const target = product.targetStock ?? CARD_SERVICE_DEFAULT_TARGET_STOCK
        if (target <= 0) {
            summary.skipped += 1
            continue
        }

        const available = await countReplenishableLocalCards(deps, product.productId, now())
        let missing = Math.min(target - available, maxPerProduct)

        while (missing > 0) {
            const result = await restockProductCards(deps, {
                productId: product.productId,
                quantity: 1,
                reason,
            })
            tally(summary, result, product.productId)

            // 一旦不是「补到一张」，本轮就该停：继续循环只会在同一个故障上
            // 连续失败（例如库存不足、Key 失效），既无意义也会淹掉日志。
            if (result.status !== 'restocked') break
            missing -= 1
        }
    }

    return summary
}
