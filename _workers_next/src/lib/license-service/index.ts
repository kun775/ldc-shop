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

export { LICENSE_SERVICE_CONFIG_FAILURE_MESSAGES } from './config.ts'
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

/** 供运维面板/健康检查展示的稳定错误码集合，避免各处硬编码字符串。 */
export const LICENSE_SERVICE_CONFIG_ERROR_CODES = ['config_error', 'revoke_key_missing'] as const satisfies readonly LicenseServiceErrorCode[]
