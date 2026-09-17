import { notFound } from 'next/navigation'
import { unstable_noStore } from 'next/cache'
import { CouponForm, toCouponFormInitial } from '@/components/admin/coupons/coupon-form'
import { getCouponById, listActiveProductOptions } from '@/lib/coupons/repository'

export default async function AdminCouponEditPage({ params }: { params: Promise<{ id: string }> }) {
    unstable_noStore()
    const { id } = await params

    const [coupon, products] = await Promise.all([
        getCouponById(id).catch(() => null),
        listActiveProductOptions().catch(() => []),
    ])

    if (!coupon) return notFound()

    const usageLocked = coupon.reservedCount + coupon.consumedCount > 0

    return (
        <CouponForm
            mode="edit"
            initial={toCouponFormInitial(coupon)}
            products={products}
            usageLocked={usageLocked}
        />
    )
}
