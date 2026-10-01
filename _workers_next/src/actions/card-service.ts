'use server'

/**
 * 卡密服务运维面板的服务端动作（接入方案阶段 E 第 3 条）。
 *
 * 与订单动作保持同一套返回协议（显式 return + 脱敏错误 ID），不 throw：
 * Server Action 的返回值不会被 Next.js 替换，因此必须由服务端自己脱敏，
 * 否则 `e.message` 会带着 SQL / 内部路径流到浏览器。
 *
 * 所有动作都先过 `checkAdmin()`，并且**不回显任何密钥**。
 * 商品 Key 加密存库，面板只展示「配没配」。
 */

import { revalidatePath } from 'next/cache'
import { checkAdmin } from '@/actions/admin'
import { logServerError } from '@/lib/errors/safe-error'
import { recordAuditEvent } from '@/lib/audit/record'
import { createD1CardServiceDatabase } from '@/lib/license-service/database'
import {
    isCardServiceSupplyMode,
    type CardServiceSupplyMode,
} from '@/lib/db/license-service-schema'
import { saveCardServiceProductConnection } from '@/lib/license-service/product-connection'
import {
    discardCardServiceFailedAllocation,
    executeOrderRevokePlan,
    loadCardServiceSnapshot,
    reloadRevokePlan,
    restockProductCard,
    type CardServiceSnapshot,
} from '@/lib/license-service'
import { completePaidOrderDelivery } from '@/lib/order-processing'

export type CardServiceActionResult =
    | { ok: true }
    | { ok: false; errorKey: string; errorId: string }

export type { CardServiceSnapshot }

const PROGRAM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_TARGET_STOCK = 10_000

function failure(scope: string, error: unknown): CardServiceActionResult {
    const errorId = logServerError(scope, error)
    return { ok: false, errorKey: 'common.error', errorId }
}

/** 面板整页数据与商品候选项。只读本地数据库，不联网。 */
export async function loadCardServiceSnapshotAction(): Promise<CardServiceSnapshot> {
    await checkAdmin()
    return loadCardServiceSnapshot()
}

/**
 * 保存商品的 Program 映射 / 目标库存 / 供应模式。
 *
 * 校验放在服务端：`program_key` 会直接拼进对中心的请求，而 `target_stock`
 * 决定补货批量，两者都不能信任浏览器传来的值。
 */
export async function saveCardServiceProgramAction(input: {
    productId: string
    supplyMode: string
    programKey: string
    apiKey?: string
    targetStock: string
}): Promise<CardServiceActionResult> {
    try {
        await checkAdmin()

        const productId = (input.productId || '').trim()
        if (!productId) return { ok: false, errorKey: 'admin.cardService.errorProductId', errorId: logServerError('admin.cardService.saveProgram', new Error('missing product id')) }
        if (!isCardServiceSupplyMode(input.supplyMode)) {
            return { ok: false, errorKey: 'admin.cardService.errorSupplyMode', errorId: logServerError('admin.cardService.saveProgram', new Error('invalid supply mode')) }
        }

        const supplyMode: CardServiceSupplyMode = input.supplyMode
        const programKey = (input.programKey || '').trim()
        // 只有真正走中心供应的商品才要求 Program：切回 `local` 时允许留空。
        if (supplyMode === 'license_service' && programKey && !PROGRAM_KEY_PATTERN.test(programKey)) {
            return { ok: false, errorKey: 'admin.cardService.errorProgramKey', errorId: logServerError('admin.cardService.saveProgram', new Error('invalid program key')) }
        }
        if (supplyMode === 'license_service' && !programKey) {
            return { ok: false, errorKey: 'admin.cardService.errorProgramKeyRequired', errorId: logServerError('admin.cardService.saveProgram', new Error('program key required')) }
        }

        const rawTarget = (input.targetStock || '').trim()
        let targetStock: number | null = null
        if (rawTarget) {
            const parsed = Number(rawTarget)
            if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TARGET_STOCK) {
                return { ok: false, errorKey: 'admin.cardService.errorTargetStock', errorId: logServerError('admin.cardService.saveProgram', new Error('invalid target stock')) }
            }
            targetStock = parsed
        }

        // 准入闸门放在服务端**唯一**的写入口（`saveCardServiceProductConfig`）里：
        // 商品必须存在、不能是共享商品、切离中心供应时不能还有未结清的远端卡。
        // 前端禁用按钮只是提示，不是校验。
        const saved = await saveCardServiceProductConnection(createD1CardServiceDatabase(), {
            productId,
            supplyMode,
            programKey: programKey || null,
            targetStock,
            apiKey: input.apiKey,
        })
        if (!saved.ok) {
            const errorKeys = {
                product_not_found: 'admin.cardService.errorProductNotFound',
                shared_product: 'admin.cardService.errorSharedProduct',
                unsettled_remote_cards: 'admin.cardService.errorUnsettledRemoteCards',
                api_key_required: 'admin.cardService.errorApiKeyRequired',
                invalid_api_key: 'admin.cardService.errorApiKey',
                credential_storage_not_ready: 'admin.cardService.errorCredentialStorage',
                encryption_secret_missing: 'admin.cardService.errorEncryptionSecret',
            }
            const errorKey = errorKeys[saved.reason]
            return { ok: false, errorKey, errorId: logServerError('admin.cardService.saveProgram', new Error(saved.reason)) }
        }

        await recordAuditEvent({
            eventName: 'cardService.program.saved',
            actorType: 'admin',
            targetId: productId,
            source: 'admin.cardService',
            metadata: { productId, supplyMode, programKey: programKey || null, targetStock, apiKeyUpdated: Boolean(input.apiKey?.trim()) },
        })

        revalidatePath('/admin/card-service')
        return { ok: true }
    } catch (error) {
        return failure('admin.cardService.saveProgram', error)
    }
}

/** 手动补一张卡（辅助触发，不是可靠补货系统）。 */
export async function restockCardServiceProductAction(productId: string): Promise<CardServiceActionResult> {
    try {
        await checkAdmin()
        const result = await restockProductCard((productId || '').trim())
        revalidatePath('/admin/card-service')

        if (result.status !== 'restocked') {
            await recordAuditEvent({
                eventName: 'cardService.restock.skipped',
                actorType: 'admin',
                targetId: productId,
                source: 'admin.cardService',
                metadata: { productId, status: result.status },
            })
            // `skipped` 只是一个筐，真正要看的是原因（未配置 / 非中心供应 / 缺 Program）。
            const errorKey = result.status === 'skipped'
                ? `admin.cardService.restock.skipped_${result.reason}`
                : `admin.cardService.restock.${result.status}`
            return { ok: false, errorKey, errorId: '' }
        }
        return { ok: true }
    } catch (error) {
        return failure('admin.cardService.restock', error)
    }
}

/**
 * 重试履约：把「已支付但没交付」的订单重放到交付核心。
 *
 * 之所以要有这个显式入口：远端商品手工把订单改成 `delivered` 会**绕过 Sell**，
 * 用户拿到一张中心不认的卡。重试履约复用与付款回调完全相同的核心函数，
 * 幂等键与原订单绑定，重复点不会多卖。
 */
export async function retryCardServiceDeliveryAction(orderId: string): Promise<CardServiceActionResult> {
    try {
        await checkAdmin()
        const id = (orderId || '').trim()
        if (!id) return { ok: false, errorKey: 'admin.cardService.errorOrderId', errorId: logServerError('admin.cardService.retryDelivery', new Error('missing order id')) }

        const outcome = await completePaidOrderDelivery(id)
        revalidatePath('/admin/card-service')
        revalidatePath(`/admin/orders/${id}`)

        return outcome.delivered
            ? { ok: true }
            : { ok: false, errorKey: 'admin.cardService.retryDeliveryPending', errorId: '' }
    } catch (error) {
        return failure('admin.cardService.retryDelivery', error)
    }
}

/** 经管理员确认，删除 not_found 失败批次的本地卡密及待办，保留订单。 */
export async function discardCardServiceFailedAllocationAction(operationKey: string): Promise<CardServiceActionResult> {
    try {
        await checkAdmin()
        const key = typeof operationKey === 'string' ? operationKey.trim() : ''
        if (!key || key.length > 512) return { ok: false, errorKey: 'admin.cardService.review.discardBlocked', errorId: '' }
        const result = await discardCardServiceFailedAllocation(key)
        if (!result.ok) return { ok: false, errorKey: 'admin.cardService.review.discardBlocked', errorId: '' }

        await recordAuditEvent({
            eventName: 'cardService.allocation.discarded',
            actorType: 'admin',
            targetId: result.allocationId,
            source: 'admin.cardService',
            metadata: { operationKey: key, allocationId: result.allocationId, productId: result.productId,
                deletedCards: result.deletedCards, deletedStagedCards: result.deletedStagedCards },
        })
        revalidatePath('/admin/card-service')
        revalidatePath('/admin/cards')
        revalidatePath('/admin/products')
        revalidatePath('/admin/orders')
        revalidatePath('/')
        return { ok: true }
    } catch (error) {
        return failure('admin.cardService.discard', error)
    }
}

/** 重试作废：按台账里的远端身份重建范围再走一遍（中心超时/凭据缺失留下的待办）。 */
export async function retryCardServiceRevokeAction(input: {
    orderId: string
    remoteCardIds: string[]
}): Promise<CardServiceActionResult> {
    try {
        await checkAdmin()
        const orderId = (input.orderId || '').trim()
        const remoteCardIds = (input.remoteCardIds || []).map((id) => String(id).trim()).filter(Boolean)
        if (!orderId || !remoteCardIds.length) {
            return { ok: false, errorKey: 'admin.cardService.errorRevokeTarget', errorId: logServerError('admin.cardService.retryRevoke', new Error('missing revoke target')) }
        }

        const plan = await reloadRevokePlan({ orderId, remoteCardIds })
        if (plan.kind !== 'revoke') {
            return { ok: false, errorKey: 'admin.cardService.retryRevokeBlocked', errorId: '' }
        }

        const outcome = await executeOrderRevokePlan({
            orderId,
            cards: plan.cards,
            reason: `ldc-shop:admin-retry:${orderId}`,
        })
        revalidatePath('/admin/card-service')

        return outcome.deferred > 0 || outcome.failed > 0
            ? { ok: false, errorKey: 'admin.cardService.retryRevokePending', errorId: '' }
            : { ok: true }
    } catch (error) {
        return failure('admin.cardService.retryRevoke', error)
    }
}
