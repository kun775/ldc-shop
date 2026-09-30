import { unstable_noStore } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminIdentity } from '@/lib/admin-auth'
import { CardServiceContent } from '@/components/admin/card-service-content'
import { loadCardServiceSnapshot, type CardServiceSnapshot } from '@/lib/license-service'
import { logServerError } from '@/lib/errors/safe-error'

export default async function AdminCardServicePage() {
    unstable_noStore()

    // 布局已经拦过一次；这里再查一遍是因为 App Router 会并行渲染 layout 与 page，
    // 不能把「只有管理员能看到这份账本」寄托在另一个组件先跑完上。
    const session = await auth()
    if (!isAdminIdentity(session?.user)) redirect('/')

    let initialSnapshot: CardServiceSnapshot | null = null
    let initialErrorId: string | null = null

    try {
        initialSnapshot = await loadCardServiceSnapshot()
    } catch (error: unknown) {
        initialErrorId = logServerError('admin.cardService.snapshot', error)
    }

    return <CardServiceContent initialSnapshot={initialSnapshot} initialErrorId={initialErrorId} />
}
