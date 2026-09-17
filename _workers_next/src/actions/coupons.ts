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
export async function setCouponFeatureFlag(enabled: boolean) {
    await checkAdmin()
    await setSetting(COUPONS_ENABLED_SETTING_KEY, enabled ? 'true' : 'false')
    revalidatePath('/admin/coupons')
    revalidatePath('/')
    return { success: true, enabled }
}

async function readAdminIdentity() {
    const session = await auth()
    return session?.user?.id ?? null
}

// createCouponAction 后台创建优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增管理员创建优惠券入口，服务端强校验并锁定计数字段。
export async function createCouponAction(formData: FormData) {
    await checkAdmin()
    await ensureDatabaseInitialized()

    const parsed = parseCouponForm(formData, { createdBy: await readAdminIdentity() })
    if (!parsed.ok) return { success: false, error: parsed.error }

    const existingId = await findCouponIdByCode(parsed.value.code)
    if (existingId) return { success: false, error: 'coupon.admin.errors.codeTaken' }

    try {
        await insertCoupon(parsed.value)
    } catch (error: any) {
        const text = String(error?.message || error).toLowerCase()
        if (text.includes('unique') || text.includes('constraint')) {
            return { success: false, error: 'coupon.admin.errors.codeTaken' }
        }
        throw error
    }

    revalidatePath('/admin/coupons')
    return { success: true, id: parsed.value.id }
}

// updateCouponAction 后台编辑优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增编辑入口；已产生使用记录时锁定经济规则。
export async function updateCouponAction(formData: FormData) {
    await checkAdmin()
    await ensureDatabaseInitialized()

    const id = String(formData.get('id') || '').trim()
    if (!id) return { success: false, error: 'coupon.admin.errors.notFound' }

    const existing = await getCouponById(id)
    if (!existing) return { success: false, error: 'coupon.admin.errors.notFound' }

    const parsed = parseCouponForm(formData, { existingId: id, createdBy: existing.createdBy })
    if (!parsed.ok) return { success: false, error: parsed.error }

    const otherId = await findCouponIdByCode(parsed.value.code)
    if (otherId && otherId !== id) return { success: false, error: 'coupon.admin.errors.codeTaken' }

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
            return { success: false, error: 'coupon.admin.errors.lockedAfterUsage' }
        }
    }

    await updateCouponRecord(parsed.value)

    revalidatePath('/admin/coupons')
    revalidatePath(`/admin/coupons/${id}`)
    return { success: true, id }
}

// setCouponStatusAction 启用、停用或转草稿
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增状态切换，停用不影响历史订单与使用记录。
export async function setCouponStatusAction(id: string, status: string) {
    await checkAdmin()
    await ensureDatabaseInitialized()

    const couponId = String(id || '').trim()
    const nextStatus = String(status || '').trim() as CouponStatus
    if (!couponId || !COUPON_STATUSES.includes(nextStatus)) {
        return { success: false, error: 'coupon.admin.errors.notFound' }
    }

    const existing = await getCouponById(couponId)
    if (!existing) return { success: false, error: 'coupon.admin.errors.notFound' }

    await setCouponStatusRecord(couponId, nextStatus)

    revalidatePath('/admin/coupons')
    revalidatePath(`/admin/coupons/${couponId}`)
    return { success: true }
}

// duplicateCouponAction 复制优惠券为新草稿
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增复制入口，避免直接修改已使用的优惠券规则。
export async function duplicateCouponAction(id: string) {
    await checkAdmin()
    await ensureDatabaseInitialized()

    const couponId = String(id || '').trim()
    const existing = await getCouponById(couponId)
    if (!existing) return { success: false, error: 'coupon.admin.errors.notFound' }

    let code = generateCouponCode(8, 'CP')
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const taken = await findCouponIdByCode(code)
        if (!taken) break
        code = generateCouponCode(8, 'CP')
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
        status: 'draft',
        startsAt: existing.startsAt,
        endsAt: existing.endsAt,
        createdBy: await readAdminIdentity(),
    })

    revalidatePath('/admin/coupons')
    return { success: true, id: newId }
}

// deleteCouponAction 删除未产生任何使用记录的优惠券
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增删除入口，存在使用记录时禁止删除以保留审计链。
export async function deleteCouponAction(id: string) {
    await checkAdmin()
    await ensureDatabaseInitialized()

    const couponId = String(id || '').trim()
    const existing = await getCouponById(couponId)
    if (!existing) return { success: false, error: 'coupon.admin.errors.notFound' }

    const usages = await listCouponUsages({ couponId, page: 1, pageSize: 1 })
    if (usages.total > 0) {
        return { success: false, error: 'coupon.admin.errors.hasUsage' }
    }

    await deleteCouponProducts(couponId)
    await deleteCouponRecord(couponId)

    revalidatePath('/admin/coupons')
    return { success: true }
}
