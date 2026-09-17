import { unstable_noStore } from 'next/cache'
import { AdminCouponsContent } from '@/components/admin/coupons/coupon-list-content'
import { listAdminCoupons } from '@/lib/coupons/repository'
import { isCouponsEnabled } from '@/lib/coupons/flag'

function firstParam(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined
    return Array.isArray(value) ? value[0] : value
}

function parseIntParam(value: unknown, fallback: number) {
    const num = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
    return Number.isFinite(num) && num > 0 ? num : fallback
}

export default async function AdminCouponsPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    unstable_noStore()
    const searchParams = await props.searchParams

    const q = (firstParam(searchParams.q) || '').trim()
    const status = (firstParam(searchParams.status) || '').trim()
    const discountType = (firstParam(searchParams.discountType) || '').trim()
    const scope = (firstParam(searchParams.scope) || '').trim()
    const page = parseIntParam(firstParam(searchParams.page), 1)
    const pageSize = Math.min(parseIntParam(firstParam(searchParams.pageSize), 20), 100)

    const [result, enabled] = await Promise.all([
        listAdminCoupons({ q, status, discountType, scope, page, pageSize }).catch(() => ({
            items: [],
            total: 0,
            page,
            pageSize,
        })),
        isCouponsEnabled().catch(() => false),
    ])

    return (
        <AdminCouponsContent
            coupons={result.items}
            total={result.total}
            page={result.page}
            pageSize={result.pageSize}
            query={q}
            status={status}
            discountType={discountType}
            scope={scope}
            featureEnabled={enabled}
        />
    )
}
