/**
 * 通用卡密服务接入的对外入口（阶段 C）。
 *
 * 这一层只做「装配」：把 `process.env` 里的凭据、D1 绑定与业务参数拼成
 * 各子模块需要的依赖。业务逻辑一律在纯模块里（`client.ts` / `contract.ts` /
 * `restock.ts` / `reconcile.ts`），因此本文件不做源码级单测，改由这些模块的
 * 单测覆盖。
 *
 * 调用约定：**任何入口都不应因为它抛出配置错误而中断业务**。未接入的商品
 * （绝大多数）走 `local` 供应模式，`restockProductCard` 会返回 `skipped`；
 * 定时任务在缺配置时直接跳过。
 */

import { createLicenseServiceClient, type LicenseServiceClient } from './client.ts'
import {
    LICENSE_SERVICE_CONFIG_FAILURE_MESSAGES,
    describeLicenseServiceConfig,
    resolveLicenseServiceConfig,
    type LicenseServiceConfig,
    type LicenseServiceConfigStatus,
} from './config.ts'
import { createD1CardServiceDatabase } from './database.ts'
import type { CardServiceDatabase } from './db-port.ts'
import { resolveAffectedProductIds } from './affected-products.ts'
// 前台库存聚合（`products.stock_count`）的**唯一**回写入口。本层是全模块唯一
// 允许依赖它、也是唯一能依赖它的地方：子模块必须保持「纯端口」，才能被
// `node --test` 直接加载。
import { getProducts, recalcProductAggregatesForMany } from '@/lib/db/queries'
import { LicenseServiceError, type LicenseServiceErrorCode } from './errors.ts'
import {
    replenishLowStockProducts,
    type ReplenishOptions,
    type ReplenishSummary,
} from './replenish.ts'
import { reconcileCardServiceState, type ReconcileSummary } from './reconcile.ts'
import {
    listCardServiceProductStatus,
    listCardServiceReviewQueue,
    loadCardServiceOverview,
    type CardServiceOverview,
    type CardServiceOverviewOptions,
    type CardServiceProductStatus,
    type CardServiceReviewQueue,
} from './ops.ts'
import {
    buildRefundRevokeStatements,
    executeOrderRevokes,
    failRevokesWithoutClient,
    loadOrderRevokePlan,
    loadRevokePlanForRemoteCards,
    revokePendingCardServiceOperations,
    type OrderRevokeCard,
    type OrderRevokePlan,
    type RevokeDeps,
    type RevokeOutcome,
} from './revoke.ts'
import {
    restockProductCards,
    type RestockDeps,
    type RestockOptions,
    type RestockResult,
} from './restock.ts'
import type { OrderSaleDeps } from './delivery.ts'

export type { ReplenishOptions, ReplenishSummary } from './replenish.ts'
export type { ReconcileSummary, ReconcileOutcome } from './reconcile.ts'
export type { RestockDeps, RestockOptions, RestockResult, RestockSkipReason } from './restock.ts'
export type { LicenseServiceClient } from './client.ts'
export type { LicenseServiceConfig } from './config.ts'
export type { LicenseServiceErrorCategory, LicenseServiceErrorCode } from './errors.ts'
export type { CardServiceSupplyMode } from '../db/license-service-schema.ts'
export type {
    OrderRemoteSalePlan,
    OrderRemoteSaleGroup,
    OrderSaleBlockReason,
    OrderSaleDeps,
    OrderSaleExecution,
} from './delivery.ts'
export type {
    OrderRevokeBlockReason,
    OrderRevokeCard,
    OrderRevokePlan,
    RevokeDeps,
    RevokeOutcome,
} from './revoke.ts'
export type {
    CardServiceAllocationCounts,
    CardServiceCardCounts,
    CardServiceDrift,
    CardServiceOperationSummary,
    CardServiceOperationTally,
    CardServiceOverview,
    CardServiceOverviewOptions,
    CardServiceProductStatus,
    CardServiceReviewQueue,
    ExpiringAllocationRow,
    OrphanMappingRow,
    PendingOperationDetail,
} from './ops.ts'
export type { LicenseServiceConfigStatus, LicenseServiceMissingSetting } from './config.ts'

export { LICENSE_SERVICE_CONFIG_FAILURE_MESSAGES } from './config.ts'
export { describeLicenseServiceConfig } from './config.ts'
export {
    CARD_SERVICE_EXPIRING_SOON_DEFAULT_MS,
    CARD_SERVICE_REVIEW_DEFAULT_LIMIT,
    emptyCardServiceAllocationCounts,
    emptyCardServiceCardCounts,
    emptyCardServiceDrift,
    emptyCardServiceOperationSummary,
    emptyCardServiceOverview,
    listCardServiceProductStatus,
    listCardServiceReviewQueue,
    loadCardServiceOverview,
} from './ops.ts'
export { LicenseServiceError, isLicenseServiceError } from './errors.ts'
export { createLicenseServiceClient } from './client.ts'
export { loadCardServiceProductConfig, saveCardServiceProductConfig, listCardServiceProgramProducts } from './product-config.ts'
export { CARD_SERVICE_DEFAULT_TARGET_STOCK, CARD_SERVICE_REPLENISH_BATCH_LIMIT } from './replenish.ts'
export {
    OrderSaleError,
    buildDeliverOrderStatements,
    buildSellDeferStatements,
    buildSellFailStatements,
    buildSellIntentStatements,
    executeOrderRemoteSales,
    listOrderRemoteCardRows,
    listPendingSellOperations,
    loadOrderRemoteSalePlan,
    mapOrderSaleFailure,
    mapOrderSalePlanFailure,
} from './delivery.ts'
export {
    buildRevokeDeferStatements,
    buildRevokeFailStatements,
    buildRevokeIntentStatements,
    buildRevokeRetainStatements,
    buildRevokeSuccessStatements,
    emptyRevokeOutcome,
    executeOrderRevokes,
    failRevokesWithoutClient,
    listMappingsByLocalCardIds,
    listMappingsByOrderId,
    listMappingsByRemoteCardIds,
    listPendingRevokeOperations,
    loadOrderRevokePlan,
    loadRevokePlanForRemoteCards,
    revokePendingCardServiceOperations,
} from './revoke.ts'
export {
    listProtectedLocalCardIds,
    orderHasPendingCardServiceOperations,
    orderHasRemoteMappings,
    orderHasUnsettledCardServiceLedger,
    partitionDeletableLocalCardIds,
} from './guards.ts'

/** 是否具备调用中心的最小配置（Base URL + API Key）。 */
export function isLicenseServiceConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return resolveLicenseServiceConfig(env).ok
}

/**
 * 重算前台库存聚合（`products.stock_count` / `locked_count` / `sold_count`）。
 *
 * 这一步**必须**在每个会改动本地卡池的入口之后执行：`stock_count` 是由
 * `recalcProductAggregates*` 算出来的一列派生值，没有任何触发器会跟着
 * `cards` 的变化自动更新。少了它就会出现「补货成功但商品页一直缺货」以及
 * 「退款作废把卡收回来、前台仍按旧库存继续卖」这两类不一致。
 *
 * 失败只记日志：聚合是派生值，重算失败不会让卡池或账本变错，下一轮会再算一次；
 * 反过来让补货/退款因为一次统计查询失败而回滚，代价大得多。
 */
async function recalcStorefrontStock(productIds: readonly string[]): Promise<void> {
    const ids = Array.from(
        new Set(productIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)),
    )
    if (!ids.length) return
    try {
        await recalcProductAggregatesForMany(ids)
    } catch (error) {
        console.error('[CardService] storefront stock recalc failed', ids, error)
    }
}

/** 退款作废之后重算：卡池变化只体现在这些卡所属的商品上。 */
async function recalcStockForRevokedCards(
    database: CardServiceDatabase,
    orderId: string,
    cards: readonly OrderRevokeCard[],
): Promise<void> {
    const productIds = await resolveAffectedProductIds(database, {
        orderId,
        localCardIds: cards.map((card) => card.localCardId),
        remoteCardIds: cards.map((card) => card.remoteCardId),
    })
    await recalcStorefrontStock(productIds)
}

function requireLicenseServiceConfig(env: Record<string, string | undefined>): LicenseServiceConfig {
    const resolved = resolveLicenseServiceConfig(env)
    if (!resolved.ok) {
        throw new LicenseServiceError({
            code: 'config_error',
            cause: LICENSE_SERVICE_CONFIG_FAILURE_MESSAGES[resolved.reason],
        })
    }
    return resolved.config
}

export function getLicenseServiceClient(env: Record<string, string | undefined> = process.env): LicenseServiceClient {
    return createLicenseServiceClient(requireLicenseServiceConfig(env))
}

/** 组装补货/对账所需的依赖。 */
export function buildCardServiceDeps(env: Record<string, string | undefined> = process.env): RestockDeps {
    return {
        client: getLicenseServiceClient(env),
        database: createD1CardServiceDatabase(),
    }
}

/**
 * 组装「交付前 Sell」所需的依赖。
 *
 * 与补货共用同一套凭据与 D1 端口。凭据缺失时 `getLicenseServiceClient` 抛
 * `config_error`；履约路径必须在确认订单确实含远端卡**之后**才调用它，
 * 否则纯本地订单会被一个无关的配置问题挡住。
 */
export function buildOrderSaleDeps(env: Record<string, string | undefined> = process.env): OrderSaleDeps {
    return {
        client: getLicenseServiceClient(env),
        database: createD1CardServiceDatabase(),
    }
}

/**
 * 组装退款作废所需的依赖。
 *
 * 与销售、补货共用 `LICENSE_SERVICE_API_KEY`，该 Key 需包含 `cards:revoke` 权限。
 * 凭据缺失不会在这里抛错，纯本地订单的退款不应被中心配置问题挡住。
 * 远端作废失败由 `executeOrderRevokes` 留在运维面板的复核清单里。
 */
export function buildRevokeDeps(env: Record<string, string | undefined> = process.env): RevokeDeps {
    return {
        client: getLicenseServiceClient(env),
        database: createD1CardServiceDatabase(),
    }
}

/**
 * 运维总览 / 复核清单 / 商品维度状态。
 *
 * 这三个入口**只读本地账本、不联网**，所以不需要凭据、也不检查
 * `isLicenseServiceConfigured` —— 面板恰恰要在「凭据没配好」时把账本与
 * 配置状态一起展示出来。未执行 0038 时返回 `enabled: false` 的空快照。
 */
export async function getCardServiceOverview(
    options: CardServiceOverviewOptions = {},
): Promise<CardServiceOverview> {
    return loadCardServiceOverview(createD1CardServiceDatabase(), options)
}

export async function getCardServiceReviewQueue(
    options: { now?: number; limit?: number } = {},
): Promise<CardServiceReviewQueue> {
    return listCardServiceReviewQueue(createD1CardServiceDatabase(), options)
}

export async function getCardServiceProductStatus(
    options: { limit?: number } = {},
): Promise<CardServiceProductStatus[]> {
    return listCardServiceProductStatus(createD1CardServiceDatabase(), options)
}

/** 运维面板整页数据，以及接入商品下拉框的候选项。 */
export interface CardServiceSnapshot {
    overview: CardServiceOverview
    review: CardServiceReviewQueue
    products: CardServiceProductStatus[]
    configStatus: LicenseServiceConfigStatus
    productOptions: Array<{ id: string; name: string }>
}

/**
 * 组装运维面板的整页快照。
 *
 * 刻意放在这里、而不是 `actions/card-service.ts`：带 `'use server'` 的文件里
 * **每个导出都会变成浏览器可直接调用的 RPC 端点**，把不带鉴权的读取函数放进去
 * 等于凭空开一个后门。服务端页面与动作各自加上自己的鉴权后调用它。
 */
export async function loadCardServiceSnapshot(): Promise<CardServiceSnapshot> {
    const [overview, review, products, allProducts] = await Promise.all([
        getCardServiceOverview(),
        getCardServiceReviewQueue(),
        getCardServiceProductStatus(),
        getProducts(),
    ])
    const connectedProductIds = new Set(products.map((product) => product.productId))

    return {
        overview,
        review,
        products,
        configStatus: describeLicenseServiceConfig(),
        productOptions: allProducts
            .filter((product) => !product.isShared && !connectedProductIds.has(product.id))
            .map((product) => ({ id: product.id, name: product.name })),
    }
}

/**
 * 给单个商品补一张卡。
 *
 * 未接入或已暂停的商品返回 `skipped`，不抛错：调用方（售后、管理端、
 * 定时任务）不应为了一个无关商品去处理异常。
 */
export async function restockProductCard(
    productId: string,
    options: Omit<RestockOptions, 'productId'> = {},
    env: Record<string, string | undefined> = process.env,
): Promise<RestockResult> {
    const result = await restockProductCards(buildCardServiceDeps(env), { productId, ...options })
    // `restocked` 的语义就是「卡已经搬进 `cards`」，因此必须重算前台库存。
    // 其余状态（skipped / deferred / expired / failed）都不改变本地卡池。
    if (result.status === 'restocked') await recalcStorefrontStock([productId])
    return result
}

/** 低水位补货扫描。未配置中心凭据时返回 `null`，由调用方决定是否记录。 */
export async function replenishCardStock(
    options: ReplenishOptions = {},
    env: Record<string, string | undefined> = process.env,
): Promise<ReplenishSummary | null> {
    if (!isLicenseServiceConfigured(env)) return null
    const summary = await replenishLowStockProducts(buildCardServiceDeps(env), options)
    await recalcStorefrontStock(summary.changedProductIds)
    return summary
}

/** 待办重放与超窗清理。未配置中心凭据时返回 `null`。 */
export async function reconcileCardService(
    options: { limit?: number } = {},
    env: Record<string, string | undefined> = process.env,
): Promise<ReconcileSummary | null> {
    if (!isLicenseServiceConfigured(env)) return null
    const summary = await reconcileCardServiceState(buildCardServiceDeps(env), options)
    // 重放 Ack 会把卡搬进 `cards`；不重算就会出现「对账补齐了、商品页还是 0」。
    await recalcStorefrontStock(summary.changedProductIds)
    return summary
}

/**
 * 作废待办重放（退款后中心不可达、或单卡失败留痕的那部分）。
 *
 * 与对账一致：中心凭据缺失时返回 `null`（功能未启用）。
 * API Key 缺少作废权限时，远端失败逐卡进入运维面板复核清单。
 */
export async function replayPendingCardServiceRevokes(
    options: { limit?: number; reason?: string } = {},
    env: Record<string, string | undefined> = process.env,
): Promise<(RevokeOutcome & { attempted: number; review: number; orderIds: string[] }) | null> {
    if (!isLicenseServiceConfigured(env)) return null
    const deps = buildRevokeDeps(env)
    const outcome = await revokePendingCardServiceOperations(deps, options)

    // 重放同样会改本地卡：作废会隔离（`is_used = 1`），保留会放回可售池。
    const productIds = new Set<string>()
    for (const orderId of outcome.orderIds) {
        for (const id of await resolveAffectedProductIds(deps.database, { orderId })) productIds.add(id)
    }
    await recalcStorefrontStock(Array.from(productIds))

    return outcome
}

/**
 * 退款作废的**规划**阶段：必须在清空订单上的 `card_key`/`card_ids` **之前**调用。
 *
 * 规划只读 `card_service_cards`（按订单号与本地卡 ID 双向取并集），返回的
 * `plan.cards` 是内存快照，因此退款批次把订单卡密清掉之后，仍可用它推进作废。
 * 规划结果为 `blocked` 时不做任何远端动作，把原因交给调用方呈现给管理员。
 *
 * 刻意不接收 `env`：这一步只碰本地账本，**不该**因为中心凭据没配好而挡住退款。
 */
export async function planOrderCardRevoke(
    input: { orderId: string; localCardIds: readonly number[] },
): Promise<OrderRevokePlan> {
    return loadOrderRevokePlan(createD1CardServiceDatabase(), input)
}

/**
 * 退款作废的**执行**阶段：本地退款结算完成后调用。
 *
 * 先落作废意图（幂等键 `revoke:<cardId>:<orderId>`）再逐卡调中心；中心超时/5xx
 * 只记为待重试，**不得**向管理员说成已完成。返回分类计数，`retained` 表示中心
 * 明确显示该卡仍可用、已保留为本店库存。
 *
 * 中心凭据缺失时**照样落账**：意图写进台账、逐卡记 `failed`，等运维配好 Key
 * 由重放补上。退款已经结算过，这条路径不允许抛错把退款动作整个带崩。
 */
export async function executeOrderRevokePlan(
    input: { orderId: string; cards: readonly OrderRevokeCard[]; reason: string },
    env: Record<string, string | undefined> = process.env,
): Promise<RevokeOutcome> {
    const database = createD1CardServiceDatabase()
    const resolved = resolveLicenseServiceConfig(env)
    const outcome = resolved.ok
        ? await executeOrderRevokes(
            { client: createLicenseServiceClient(resolved.config), database },
            input,
        )
        // 缺凭据也要落账（意图 + 隔离），因此同样改了本地卡池 → 同样要重算。
        : await failRevokesWithoutClient(database, {
            orderId: input.orderId,
            cards: input.cards,
            errorCode: 'config_error',
        })

    await recalcStockForRevokedCards(database, input.orderId, input.cards)
    return outcome
}

/** 待办重放时的计划重建（按远端 card_id），供运维面板「重试作废」使用。 */
export async function reloadRevokePlan(
    input: { orderId: string; remoteCardIds: readonly string[] },
    env: Record<string, string | undefined> = process.env,
): Promise<OrderRevokePlan> {
    return loadRevokePlanForRemoteCards(buildRevokeDeps(env).database, input)
}

/**
 * 退款原子批次里要一并提交的作废语句（意图 + 本地卡隔离）。
 *
 * 暴露成纯函数而不是让退款动作直接依赖 `revoke.ts`：退款侧只需要「一批语句」，
 * 不该知道操作台账长什么样，也不该自己写 `CardServiceStatement → AtomicD1Statement`
 * 的转换（两处各自转换，迟早有一处漏掉 `params`）。
 *
 * 提交顺序仍是唯一的硬约束：**先本地结算、后远端作废**。这里只产生「本地那一半」。
 */
export function planOrderRevokeBatchStatements(input: {
    orderId: string
    cards: readonly OrderRevokeCard[]
    nowMs: number
}): Array<{ query: string; bindings?: readonly unknown[] }> {
    return buildRefundRevokeStatements(input).map((statement) => ({
        query: statement.sql,
        ...(statement.params ? { bindings: statement.params } : {}),
    }))
}

/** 配置错误码集合；保留旧版 revoke_key_missing，以识别账本中的历史失败。 */
export const LICENSE_SERVICE_CONFIG_ERROR_CODES = ['config_error', 'revoke_key_missing'] as const satisfies readonly LicenseServiceErrorCode[]
