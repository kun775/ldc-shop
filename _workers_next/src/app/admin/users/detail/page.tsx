import { AdminUserDetailPageContent } from "@/components/admin/admin-user-detail-page"

export default async function AdminUserDetailQueryPage({
    searchParams,
}: {
    searchParams: Promise<{ userId?: string | string[] }>
}) {
    const params = await searchParams
    const userId = Array.isArray(params.userId) ? params.userId[0] : params.userId

    return <AdminUserDetailPageContent userId={userId} />
}
