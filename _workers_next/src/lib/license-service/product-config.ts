/**
 * 商品 → 供应模式 / Program 的映射读取（阶段 B 建表，本模块负责读写）。
 *
 * 表 `card_service_product_configs` 刻意独立于 `products`：`products` 是管理端
 * 表单与全量导出的直接载体，把「供应来源」放进去会让它跟着商品一起被编辑或
 * 泄露到备份里。没有配置行的商品走 `local` 兜底，因此**既有商品不需要任何
 * 数据回填**，行为与接入前完全一致。
 */

import {
    CARD_SERVICE_CARDS_TABLE,
    CARD_SERVICE_PRODUCT_CONFIG_TABLE,
    CARD_SERVICE_DEFAULT_SUPPLY_MODE,
    isCardServiceSupplyMode,
    type CardServiceSupplyMode,
} from '../db/license-service-schema.ts'
import { isMissingTableError, type CardServiceDatabase } from './db-port.ts'

export interface CardServiceProductConfig {
    productId: string
    supplyMode: CardServiceSupplyMode
    programKey: string | null
    targetStock: number | null
    /** 配置行是否存在。不存在表示该商品从未接入，`supplyMode` 为兜底值。 */
    configured: boolean
}

export function defaultCardServiceProductConfig(productId: string): CardServiceProductConfig {
    return {
        productId,
        supplyMode: CARD_SERVICE_DEFAULT_SUPPLY_MODE,
        programKey: null,
        targetStock: null,
        configured: false,
    }
}

/**
 * 把列值折算成可选整数。
 *
 * ⚠️ 空值必须回 `null` 而不是 `0`：`Number(null) === 0`、`Number('') === 0`，
 * 而 `target_stock = 0` 在补货调度里表示「暂停补货」——
 * 「表单留空」绝不能变成「静默停掉这个商品的自动补货」。
 */
function toOptionalInteger(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' && value.trim() === '') return null
    if (typeof value !== 'number' && typeof value !== 'string') return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function toOptionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

export interface CardServiceProductGuard {
    /** 商品是否存在。不存在时不该写配置行。 */
    exists: boolean
    /** 是否共享卡商品。共享商品**不能**接入中心供应（它绕过 Sell 直接发明文）。 */
    isShared: boolean
}

/** 读商品的接入准入事实。查不到列/表一律按「非共享」处理 —— 这是叠在其它校验之上的策略闸门，失败不改变既有行为。 */
export async function loadProductSupplyGuard(
    database: CardServiceDatabase,
    productId: string,
): Promise<CardServiceProductGuard> {
    try {
        const rows = await database.query<{ is_shared?: unknown }>(
            'SELECT is_shared FROM products WHERE id = ? LIMIT 1',
            [productId],
        )
        if (!rows.length) return { exists: false, isShared: false }
        return { exists: true, isShared: Number(rows[0].is_shared ?? 0) === 1 }
    } catch (error) {
        if (isMissingTableError(error)) return { exists: false, isShared: false }
        // 老库缺 `is_shared` 列等结构差异：按「存在且非共享」放行，不因此挡住配置。
        return { exists: true, isShared: false }
    }
}

/**
 * 该商品还有多少张卡「仍归中心管理或已由中心售出」（`acknowledged` / `sold`）。
 *
 * 用于供应模式切换的互斥判定：切离 `license_service` 之前必须为 0，否则那些卡
 * 会被本地当成普通库存继续卖，而中心那边永远不会被标记售出。
 * 台账表不存在时返回 0（该商品从未接入，切换本就无关）。
 */
export async function countUnsettledRemoteMappings(
    database: CardServiceDatabase,
    productId: string,
): Promise<number> {
    try {
        const rows = await database.query<{ total?: unknown }>(
            `SELECT COUNT(*) AS total FROM ${CARD_SERVICE_CARDS_TABLE}
              WHERE product_id = ? AND state IN ('acknowledged', 'sold')`,
            [productId],
        )
        const parsed = Number(rows[0]?.total)
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
    } catch (error) {
        if (isMissingTableError(error)) return 0
        throw error
    }
}

export type CardServiceConfigSaveResult =
    | { ok: true }
    | { ok: false; reason: 'product_not_found' | 'shared_product' | 'unsettled_remote_cards' }

/**
 * 读取单个商品的供应配置。
 *
 * 表不存在（阶段 B 的 0038 尚未执行）时返回兜底值而不是抛错：接入方在升级
 * 完成前不应因为读配置而 500。
 */
export async function loadCardServiceProductConfig(
    database: CardServiceDatabase,
    productId: string,
): Promise<CardServiceProductConfig> {
    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT supply_mode, program_key, target_stock FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE} WHERE product_id = ? LIMIT 1`,
            [productId],
        )
    } catch (error) {
        if (isMissingTableError(error)) return defaultCardServiceProductConfig(productId)
        throw error
    }

    if (!rows.length) return defaultCardServiceProductConfig(productId)

    const row = rows[0]
    const rawMode = toOptionalText(row.supply_mode)
    return {
        productId,
        supplyMode: isCardServiceSupplyMode(rawMode) ? rawMode : CARD_SERVICE_DEFAULT_SUPPLY_MODE,
        programKey: toOptionalText(row.program_key),
        targetStock: toOptionalInteger(row.target_stock),
        configured: true,
    }
}

/**
 * 写入（或更新）商品供应配置。
 *
 * 这是服务端管理动作，不暴露给商品表单；`updated_at` 由调用方传入以便测试
 * 与审计可复现。
 *
 * 两道准入闸门（都很关键，不能只靠前端禁用按钮）：
 *
 *   1. **商品必须存在**：凭空写一个 `product_id` 会留下永远对不上的配置行，
 *      之后补货调度只会对着空气 Allocate。
 *   2. **共享商品不得接入中心供应**：共享商品直接发「一张本地卡明文」当交付引用，
 *      **完全绕过 Sell**。让它走中心供应等于「卡从中心领出来、明文发出去、中心
 *      那边永远是未售出」—— 库存与账目对不上，退款也无从作废。
 */
export async function saveCardServiceProductConfig(
    database: CardServiceDatabase,
    config: {
        productId: string
        supplyMode: CardServiceSupplyMode
        programKey?: string | null
        targetStock?: number | null
    },
    nowMs: number = Date.now(),
): Promise<CardServiceConfigSaveResult> {
    const product = await loadProductSupplyGuard(database, config.productId)
    if (!product.exists) return { ok: false, reason: 'product_not_found' }
    if (product.isShared) return { ok: false, reason: 'shared_product' }

    // 供应模式互斥：从中心供应切走时，必须先把手上的远端卡结清。
    // 否则本地会继续把「仍归中心管理、只有中心知道是否卖过」的卡当普通库存卖出去。
    if (config.supplyMode !== 'license_service') {
        const unsettled = await countUnsettledRemoteMappings(database, config.productId)
        if (unsettled > 0) return { ok: false, reason: 'unsettled_remote_cards' }
    }

    await database.write([{
        sql: `INSERT INTO ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}
            (product_id, supply_mode, program_key, target_stock, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id) DO UPDATE SET
                supply_mode = excluded.supply_mode,
                program_key = excluded.program_key,
                target_stock = excluded.target_stock,
                updated_at = excluded.updated_at`,
        params: [
            config.productId,
            config.supplyMode,
            toOptionalText(config.programKey),
            toOptionalInteger(config.targetStock),
            nowMs,
            nowMs,
        ],
    }])

    return { ok: true }
}

/** 列出所有走通用卡密服务的商品，供补货调度使用。 */
export async function listCardServiceProgramProducts(
    database: CardServiceDatabase,
): Promise<CardServiceProductConfig[]> {
    let rows: Array<Record<string, unknown>>
    try {
        rows = await database.query(
            `SELECT product_id, supply_mode, program_key, target_stock FROM ${CARD_SERVICE_PRODUCT_CONFIG_TABLE}`,
        )
    } catch (error) {
        if (isMissingTableError(error)) return []
        throw error
    }

    return rows.map((row) => {
        const productId = toOptionalText(row.product_id) ?? ''
        const rawMode = toOptionalText(row.supply_mode)
        return {
            productId,
            supplyMode: isCardServiceSupplyMode(rawMode) ? rawMode : CARD_SERVICE_DEFAULT_SUPPLY_MODE,
            programKey: toOptionalText(row.program_key),
            targetStock: toOptionalInteger(row.target_stock),
            configured: true,
        }
    }).filter((config) => config.productId && config.supplyMode === 'license_service')
}
