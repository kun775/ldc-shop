import { CouponForm } from '@/components/admin/coupons/coupon-form'
import { listActiveProductOptions } from '@/lib/coupons/repository'

export default async function AdminCouponNewPage() {
    const products = await listActiveProductOptions().catch(() => [])
    return <CouponForm mode="create" products={products} />
}
