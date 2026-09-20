import { checkAdmin } from "@/actions/admin"
import { AdminUserDetailContent } from "@/components/admin/user-detail-content"
import { getAdminUserDetail } from "@/lib/points/ledger-db"
import { normalizeAdminUserProfileId } from "@/lib/user-profile-link"
import { unstable_noStore } from "next/cache"
import { notFound } from "next/navigation"

export async function AdminUserDetailPageContent({ userId }: { userId?: string | null }) {
    unstable_noStore()
    await checkAdmin()

    const normalizedUserId = normalizeAdminUserProfileId(userId)
    if (!normalizedUserId) return notFound()

    const detail = await getAdminUserDetail(normalizedUserId)
    if (!detail) return notFound()

    return (
        <AdminUserDetailContent
            user={detail.user}
            ledger={detail.ledger}
            orders={detail.orders}
            hasLegacyBalanceInit={detail.hasLegacyBalanceInit}
        />
    )
}
