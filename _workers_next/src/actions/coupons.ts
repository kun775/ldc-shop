'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { loginUsers, products } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { ensureDatabaseInitialized, setSetting } from '@/lib/db/queries'
import { checkAdmin } from '@/actions/admin'
import { parseCouponForm } from '@/lib/coupons/admin-validation'
import { generateCouponCode } from '@/lib/coupons/code'
import { isCouponsEnabled, COUPONS_ENABLED_SETTING_KEY } from '@/lib/coupons/flag'
import { centsToLdcNumber } from '@/lib/coupons/money'
import { resolveCouponQuote } from '@/lib/coupons/checkout-quote'
import { COUPON_ADMIN_ERROR_KEY_MAP } from '@/lib/coupons/errors'
import {
    deleteCouponProducts,
    deleteCouponRecord,
    findCouponIdByCode,
    getCouponById,
    insertCoupon,
    listCouponUsages,
    setCouponStatusRecord,
    updateCouponRecord,
} from '@/lib/coupons/repository'
import { COUPON_STATUSES } from '@/lib/coupons/types'
import type { CouponStatus } from '@/lib/coupons/types'
import { resolveClientErrorKey } from '@/lib/errors/safe-error'
import { recordAuditEvent, recordServerError } from '@/lib/audit/record'

export interface CouponPreviewLine {
    code: string
    discountCents: number
    sequence: number
}

export interface CouponPreviewPayload {
    success: true
    enabled: boolean
    subtotalCents: number
    couponDiscountCents: number
    pointsDiscountCents: number
    pointsToUse: number
    finalAmountCents: number
    couponDiscountLdc: number
    pointsDiscountLdc: number
    finalAmountLdc: number
    stackableWithPoints: boolean
    coupons: CouponPreviewLine[]
}

export type CouponPreviewResponse = CouponPreviewPayload | { success: false; error: string }

/**
 * 后台优惠券写操作的统一返回协议。
 *
 * 为什么不继续 throw：
 *   Server Action 的**返回值**不会被 Next.js 脱敏，只有 throw 才会。反过来说，
 *   throw 出去的错误在客户端只能拿到被 Next.js 替换过的通用消息（或 digest），
 *   业务错误与系统错误无法区分，用户看到的永远是「错误」两个字。
 *   因此这里统一改为「显式 return」：服务端脱敏 → 稳定 i18n key + errorId。
 */
export type CouponActionResult =
    | { ok: true; id?: string }
    | { ok: false; errorKey: string; errorId: string }

async function failure(
    scope: string,
    error: unknown,
    eventName?: 'coupon.created' | 'coupon.updated',
    targetId?: string | null,
): Promise<CouponActionResult> {
    const errorKey = resolveClientErrorKey(error, COUPON_ADMIN_ERROR_KEY_MAP, 'common.error')
    const session = await auth()
    const errorId = await recordServerError(scope, error, {
        actorType: 'admin',
        actorUserId: session?.user?.id ?? null,
        actorUsername: session?.user?.username ?? null,
        auditEvent: eventName ? {
            eventName,
            actorType: 'admin',
            actorUserId: session?.user?.id ?? null,
            actorUsername: session?.user?.username ?? null,
            targetId: targetId || null,
            errorKey,
            source: 'admin.coupons',
        } : undefined,
    })
    return { ok: false, errorKey, errorId }
}

// previewCoupons 结算页优惠码实时校验与报价（不占用次数）
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增用户端优惠码试算接口，仅返回报价，不改变任何占用状态。
export async function previewCoupons(input: {
    productId: string
    quantity?: number
    codes?: string[]
    usePoints?: boolean
}): Promise<CouponPreviewResponse> {
    const productId = String(input?.productId || '').trim()
    if (!productId) return { success: false, error: 'buy.productNotFound' }

    await ensureDatabaseInitialized()

    const session = await auth()
    const user = session?.user

    let availablePoints = 0
    if (user?.id) {
        try {
            const rows = await db
                .select({ points: loginUsers.points })
                .from(loginUsers)
                .where(eq(loginUsers.userId, user.id))
                .limit(1)
            availablePoints = Number(rows[0]?.points || 0)
        } catch {
            availablePoints = 0
        }
    }

    const product = await db.query.products.findFirst({
        where: eq(products.id, productId),
        columns: {
            id: true,
            price: true,
            pointDiscountEnabled: true,
            pointDiscountPercent: true,
            couponUsageRestriction: true,
        },
    })
    if (!product) return { success: false, error: 'buy.productNotFound' }

    const enabled = await isCouponsEnabled()

    const quote = await resolveCouponQuote({
        product,
        quantity: Number(input?.quantity || 1),
        codes: Array.isArray(input?.codes) ? input.codes : [],
        usePoints: Boolean(input?.usePoints),
        userId: user?.id ?? null,
        availablePoints,
    })

    if (!quote.ok) return { success: false, error: quote.error }

    const { result } = quote

    return {
        success: true,
        enabled,
        subtotalCents: quote.subtotalCents,
        couponDiscountCents: result.couponDiscountCents,
        pointsDiscountCents: result.pointsDiscountCents,
        pointsToUse: result.pointsToUse,
        finalAmountCents: result.finalAmountCents,
        couponDiscountLdc: centsToLdcNumber(result.couponDiscountCents),
        pointsDiscountLdc: centsToLdcNumber(result.pointsDiscountCents),
        finalAmountLdc: centsToLdcNumber(result.finalAmountCents),
        stackableWithPoints: result.lines.every((line) => line.stackableWithPoints),
        coupons: result.lines.map((line) => ({
            code: line.code,
            discountCents: line.discountAmountCents,
            sequence: line.sequence,
        })),
    }
}

export async function getCouponFeatureFlag(): Promise<boolean> {
    return isCouponsEnabled()
}

// setCouponFeatureFlag 切换优惠券功能开关
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增运营侧开关，作为上线验证与回滚的控制点。
export async function setCouponFeatureFlag(enabled: boolean): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await setSetting(COUPONS_ENABLED_SETTING_KEY, enabled ? 'true' : 'false')
        revalidatePath('/admin/coupons')
        revalidatePath('/')
        return { ok: true }
    } catch (error) {
        return failure('admin.coupon.setFeatureFlag', error)
    }
}

async function readAdminActor() {
    try {
        const session = await auth()
        return {
            id: session?.user?.id ?? null,
            username: session?.user?.username ?? null,
        }
    } catch {
        return { id: null, username: null }
    }
}

// createCouponAction 后台创建优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增管理员创建优惠券入口，服务端强校验并锁定计数字段。
export async function createCouponAction(formData: FormData): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await ensureDatabaseInitialized()
        const actor = await readAdminActor()

        const parsed = parseCouponForm(formData, { createdBy: actor.id })
        if (!parsed.ok) return { ok: false, errorKey: parsed.error, errorId: '' }

        const existingId = await findCouponIdByCode(parsed.value.code)
        if (existingId) return { ok: false, errorKey: 'coupon.admin.errors.codeTaken', errorId: '' }

        await insertCoupon(parsed.value)

        await recordAuditEvent({
            eventName: 'coupon.created',
            actorType: 'admin',
            actorUserId: actor.id,
            actorUsername: actor.username,
            targetId: parsed.value.id,
            source: 'admin.coupons',
            metadata: {
                couponId: parsed.value.id,
                couponCode: parsed.value.code,
                status: parsed.value.status,
            },
        })

        revalidatePath('/admin/coupons')
        return { ok: true, id: parsed.value.id }
    } catch (error) {
        // 唯一约束（并发创建同码）由 COUPON_ADMIN_ERROR_KEY_MAP 映射为 codeTaken
        return failure('admin.coupon.create', error, 'coupon.created')
    }
}

// updateCouponAction 后台编辑优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增编辑入口；已产生使用记录时锁定经济规则。
export async function updateCouponAction(formData: FormData): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await ensureDatabaseInitialized()
        const actor = await readAdminActor()

        const id = String(formData.get('id') || '').trim()
        if (!id) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        const existing = await getCouponById(id)
        if (!existing) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        const parsed = parseCouponForm(formData, { existingId: id, createdBy: existing.createdBy })
        if (!parsed.ok) return { ok: false, errorKey: parsed.error, errorId: '' }

        const otherId = await findCouponIdByCode(parsed.value.code)
        if (otherId && otherId !== id) {
            return { ok: false, errorKey: 'coupon.admin.errors.codeTaken', errorId: '' }
        }

        const hasUsage = existing.reservedCount + existing.consumedCount > 0
        if (hasUsage) {
            const lockedChanged =
                parsed.value.code !== existing.code ||
                parsed.value.discountType !== existing.discountType ||
                parsed.value.rateBps !== existing.rateBps ||
                parsed.value.discountAmountCents !== existing.discountAmountCents ||
                parsed.value.minSpendCents !== existing.minSpendCents ||
                parsed.value.maxDiscountCents !== existing.maxDiscountCents ||
                parsed.value.scope !== existing.scope ||
                parsed.value.totalUseLimit !== existing.totalUseLimit ||
                parsed.value.perUserLimit !== existing.perUserLimit ||
                parsed.value.stackableWithCoupons !== existing.stackableWithCoupons ||
                parsed.value.stackableWithPoints !== existing.stackableWithPoints ||
                parsed.value.productIds.slice().sort().join(',') !== existing.productIds.slice().sort().join(',')

            if (lockedChanged) {
                return { ok: false, errorKey: 'coupon.admin.errors.lockedAfterUsage', errorId: '' }
            }
        }

        await updateCouponRecord(parsed.value)

        await recordAuditEvent({
            eventName: 'coupon.updated',
            actorType: 'admin',
            actorUserId: actor.id,
            actorUsername: actor.username,
            targetId: id,
            source: 'admin.coupons',
            metadata: {
                couponId: id,
                couponCode: parsed.value.code,
                status: parsed.value.status,
            },
        })

        revalidatePath('/admin/coupons')
        revalidatePath(`/admin/coupons/${id}`)
        return { ok: true, id }
    } catch (error) {
        const targetId = String(formData.get('id') || '').trim() || null
        return failure('admin.coupon.update', error, 'coupon.updated', targetId)
    }
}

// setCouponStatusAction 启用、停用或转草稿
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增状态切换，停用不影响历史订单与使用记录。
export async function setCouponStatusAction(id: string, status: string): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await ensureDatabaseInitialized()

        const couponId = String(id || '').trim()
        const nextStatus = String(status || '').trim() as CouponStatus
        if (!couponId || !COUPON_STATUSES.includes(nextStatus)) {
            return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }
        }

        const existing = await getCouponById(couponId)
        if (!existing) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        await setCouponStatusRecord(couponId, nextStatus)

        revalidatePath('/admin/coupons')
        revalidatePath(`/admin/coupons/${couponId}`)
        return { ok: true }
    } catch (error) {
        return failure('admin.coupon.setStatus', error)
    }
}

// duplicateCouponAction 复制优惠券为新草稿
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增复制入口，避免直接修改已使用的优惠券规则。
export async function duplicateCouponAction(id: string): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await ensureDatabaseInitialized()
        const actor = await readAdminActor()

        const couponId = String(id || '').trim()
        if (!couponId) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        const existing = await getCouponById(couponId)
        if (!existing) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        // 生成不冲突的优惠码：最多重试 5 次。
        // 注意循环结束后必须复查一次 —— 旧实现重试耗尽时不再校验，
        // 会把一个「可能已存在」的码直接拿去插入，撞唯一约束报错。
        let code = generateCouponCode(8, 'CP')
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const taken = await findCouponIdByCode(code)
            if (!taken) break
            code = generateCouponCode(8, 'CP')
        }
        if (await findCouponIdByCode(code)) {
            return { ok: false, errorKey: 'coupon.admin.errors.codeTaken', errorId: '' }
        }

        const newId = `cpn_${crypto.randomUUID()}`
        await insertCoupon({
            id: newId,
            code,
            name: `${existing.name} 副本`,
            description: existing.description,
            discountType: existing.discountType,
            rateBps: existing.rateBps,
            discountAmountCents: existing.discountAmountCents,
            minSpendCents: existing.minSpendCents,
            maxDiscountCents: existing.maxDiscountCents,
            scope: existing.scope,
            productIds: existing.productIds,
            totalUseLimit: existing.totalUseLimit,
            perUserLimit: existing.perUserLimit,
            stackableWithCoupons: existing.stackableWithCoupons,
            stackableWithPoints: existing.stackableWithPoints,
            refundPolicy: existing.refundPolicy,
            // 副本一律以草稿落地，避免复制后立即对外生效
            status: 'draft',
            startsAt: existing.startsAt,
            endsAt: existing.endsAt,
            createdBy: actor.id,
        })

        await recordAuditEvent({
            eventName: 'coupon.created',
            actorType: 'admin',
            actorUserId: actor.id,
            actorUsername: actor.username,
            targetId: newId,
            source: 'admin.coupons',
            metadata: {
                couponId: newId,
                couponCode: code,
                status: 'draft',
            },
        })

        revalidatePath('/admin/coupons')
        return { ok: true, id: newId }
    } catch (error) {
        return failure('admin.coupon.duplicate', error, 'coupon.created')
    }
}

// deleteCouponAction 删除未产生任何使用记录的优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增删除入口，存在使用记录时禁止删除以保留审计链。
export async function deleteCouponAction(id: string): Promise<CouponActionResult> {
    try {
        await checkAdmin()
        await ensureDatabaseInitialized()

        const couponId = String(id || '').trim()
        if (!couponId) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        const existing = await getCouponById(couponId)
        if (!existing) return { ok: false, errorKey: 'coupon.admin.errors.notFound', errorId: '' }

        const usages = await listCouponUsages({ couponId, page: 1, pageSize: 1 })
        if (usages.total > 0) {
            return { ok: false, errorKey: 'coupon.admin.errors.hasUsage', errorId: '' }
        }

        // 先删主记录（权威对象），再清理关联商品。
        // 顺序不能反：若先删关联商品而主记录删除失败，会留下一张
        // 「指定商品但商品列表为空」的券（语义已变）；反过来只会留下
        // 指向不存在券的孤儿关联行，无副作用且可随时清理。
        await deleteCouponRecord(couponId)
        try {
            await deleteCouponProducts(couponId)
        } catch (cleanupError) {
            console.error('[Coupon] orphan product links cleanup failed', cleanupError)
        }

        revalidatePath('/admin/coupons')
        return { ok: true }
    } catch (error) {
        return failure('admin.coupon.delete', error)
    }
}
