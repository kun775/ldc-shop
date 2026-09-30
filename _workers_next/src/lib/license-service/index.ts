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
    resolveLicenseServiceConfig,
    type LicenseServiceConfig,
} from './config.ts'
import { createD1CardServiceDatabase } from './database.ts'
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
    orderHasRemoteMappings,
    partitionDeletableLocalCardIds,
} from './guards.ts'

/** 是否具备调用中心的最小配置（Base URL + 销售 Key）。 */
export function isLicenseServiceConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return resolveLicenseServiceConfig(env).ok
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
 * 作废用的是**独立**的 `cards:revoke` Key（`LICENSE_SERVICE_REVOKE_API_KEY`）。
 * 该 Key 缺失时不会在这里抛错 —— 与销售 Key 同理，纯本地订单的退款不该被一个
 * 配置问题挡住；缺失会在真正调用 `revoke()` 时就地失败为 `revoke_key_missing`，
 * 由 `executeOrderRevokes` 归入 `failed` 并留在运维面板的复核清单里。
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
    return restockProductCards(buildCardServiceDeps(env), { productId, ...options })
}

/** 低水位补货扫描。未配置中心凭据时返回 `null`，由调用方决定是否记录。 */
export async function replenishCardStock(
    options: ReplenishOptions = {},
    env: Record<string, string | undefined> = process.env,
): Promise<ReplenishSummary | null> {
    if (!isLicenseServiceConfigured(env)) return null
    return replenishLowStockProducts(buildCardServiceDeps(env), options)
}

/** 待办重放与超窗清理。未配置中心凭据时返回 `null`。 */
export async function reconcileCardService(
    options: { limit?: number } = {},
    env: Record<string, string | undefined> = process.env,
): Promise<ReconcileSummary | null> {
    if (!isLicenseServiceConfigured(env)) return null
    return reconcileCardServiceState(buildCardServiceDeps(env), options)
}

/**
 * 作废待办重放（退款后中心不可达、或单卡失败留痕的那部分）。
 *
 * 与对账一致：中心凭据整体缺失时返回 `null`（功能未启用）。但**销售 Key 配好而
 * 作废 Key 没配**的情况不返回 `null` —— 那是一个需要被看见的配置缺陷，逐卡会
 * 归入 `failed` 并进入运维面板复核清单，而不是静默跳过。
 */
export async function replayPendingCardServiceRevokes(
    options: { limit?: number; reason?: string } = {},
    env: Record<string, string | undefined> = process.env,
): Promise<(RevokeOutcome & { attempted: number; review: number }) | null> {
    if (!isLicenseServiceConfigured(env)) return null
    return revokePendingCardServiceOperations(buildRevokeDeps(env), options)
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
    if (!resolved.ok) {
        return failRevokesWithoutClient(database, {
            orderId: input.orderId,
            cards: input.cards,
            errorCode: 'config_error',
        })
    }
    return executeOrderRevokes(
        { client: createLicenseServiceClient(resolved.config), database },
        input,
    )
}

/** 待办重放时的计划重建（按远端 card_id），供运维面板「重试作废」使用。 */
export async function reloadRevokePlan(
    input: { orderId: string; remoteCardIds: readonly string[] },
    env: Record<string, string | undefined> = process.env,
): Promise<OrderRevokePlan> {
    return loadRevokePlanForRemoteCards(buildRevokeDeps(env).database, input)
}

/** 供运维面板/健康检查展示的稳定错误码集合，避免各处硬编码字符串。 */
export const LICENSE_SERVICE_CONFIG_ERROR_CODES = ['config_error', 'revoke_key_missing'] as const satisfies readonly LicenseServiceErrorCode[]
