import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { AdminSidebar } from "@/components/admin/sidebar"
import { UpdateNotification } from "@/components/admin/update-notification"
import { getSetting } from "@/lib/db/queries"
import { RegistryPrompt } from "@/components/admin/registry-prompt"
import { isRegistryEnabled } from "@/lib/registry"
import { APP_VERSION } from "@/lib/version"
import { Suspense } from "react"

async function AdminLayoutContent({ children }: { children: React.ReactNode }) {
    const session = await auth()
    const user = session?.user

    // Admin Check - redirect to home if not admin
    const adminUsers = process.env.ADMIN_USERS?.toLowerCase().split(',') || []
    if (!user || !user.username || !adminUsers.includes(user.username.toLowerCase())) {
        redirect("/")
    }

    const registryEnabled = isRegistryEnabled()
    let registryPrompted = null
    let registryOptIn = null
    if (registryEnabled) {
        try {
            const [prompted, optIn] = await Promise.all([
                getSetting("registry_prompted"),
                getSetting("registry_opt_in"),
            ])
            registryPrompted = prompted
            registryOptIn = optIn
        } catch {
            registryPrompted = null
            registryOptIn = null
        }
    }

    const shouldPrompt = registryEnabled && registryPrompted !== "true" && registryOptIn !== "true"

    return (
        <div className="min-h-screen bg-background md:h-screen">
            <UpdateNotification currentVersion={APP_VERSION} />
            <RegistryPrompt shouldPrompt={shouldPrompt} registryEnabled={registryEnabled} />
            <AdminSidebar username={user.username} />
            <main className="px-4 py-6 md:ml-64 md:h-screen md:overflow-y-auto md:px-8 md:py-10">
                {children}
            </main>
        </div>
    )
}

function AdminLayoutFallback() {
    return (
        <div className="min-h-screen bg-background md:h-screen">
            <div className="h-16 border-b border-border/40 bg-background/70 md:hidden" />
            <div className="hidden md:fixed md:inset-y-0 md:left-0 md:block md:w-64 md:border-r md:border-border/40 md:bg-muted/10" />
            <main className="p-6 md:ml-64 md:h-screen md:overflow-y-auto md:px-8 md:py-10">
                <div className="space-y-4">
                    <div className="h-8 w-40 rounded-md bg-muted/60 animate-pulse" />
                    <div className="h-24 w-full rounded-xl bg-muted/40 animate-pulse" />
                    <div className="h-24 w-full rounded-xl bg-muted/40 animate-pulse" />
                </div>
            </main>
        </div>
    )
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return (
        <Suspense fallback={<AdminLayoutFallback />}>
            <AdminLayoutContent>{children}</AdminLayoutContent>
        </Suspense>
    )
}
