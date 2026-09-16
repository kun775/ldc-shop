import { cookies } from "next/headers"
import { unstable_noStore } from "next/cache"
import { getAdminOverview, getSetting } from "@/lib/db/queries"
import { AdminOverviewContent } from "@/components/admin/overview-content"

export default async function AdminOverviewPage() {
    const cookieStore = await cookies()
    void cookieStore.get('ldc_pending_order')
    unstable_noStore()

    const nowMs = Date.now()
    const thresholdRaw = await getSetting('low_stock_threshold').catch(() => '5')
    const lowStockThreshold = Number.parseInt(thresholdRaw || '5', 10) || 5
    const overview = await getAdminOverview(nowMs, lowStockThreshold)

    return <AdminOverviewContent data={overview} />
}
