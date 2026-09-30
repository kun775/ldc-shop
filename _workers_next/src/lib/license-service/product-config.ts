/**
 * 商品 → 供应模式 / Program 的映射读取（阶段 B 建表，本模块负责读写）。
 *
 * 表 `card_service_product_configs` 刻意独立于 `products`：`products` 是管理端
 * 表单与全量导出的直接载体，把「供应来源」放进去会让它跟着商品一起被编辑或
 * 泄露到备份里。没有配置行的商品走 `local` 兜底，因此**既有商品不需要任何
 * 数据回填**，行为与接入前完全一致。
 */

import {
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

function toOptionalInteger(value: unknown): number | null {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function toOptionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

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
): Promise<void> {
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
