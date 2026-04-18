import { checkAdmin } from "@/actions/admin"
import { AdminUserDetailContent } from "@/components/admin/user-detail-content"
import { getAdminUserDetail } from "@/lib/points/ledger-db"
import { unstable_noStore } from "next/cache"
import { notFound } from "next/navigation"

export default async function AdminUserDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    unstable_noStore()
    await checkAdmin()

    const { id } = await params
    const detail = await getAdminUserDetail(id)
    if (!detail) {
        return notFound()
    }

    return (
        <AdminUserDetailContent
            user={detail.user}
            ledger={detail.ledger}
            orders={detail.orders}
            hasLegacyBalanceInit={detail.hasLegacyBalanceInit}
        />
    )
}
