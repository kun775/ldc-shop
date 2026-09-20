import { AdminUserDetailPageContent } from "@/components/admin/admin-user-detail-page"

export default async function AdminUserDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = await params
    return <AdminUserDetailPageContent userId={id} />
}
