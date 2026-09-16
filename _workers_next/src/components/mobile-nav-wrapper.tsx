import { auth } from "@/lib/auth"
import { getSetting } from "@/lib/db/queries"
import { isRegistryEnabled } from "@/lib/registry"
import { MobileNav } from "./mobile-nav"
import { isAdminIdentity } from "@/lib/admin-auth"

export async function MobileNavWrapper() {
    const session = await auth()
    const user = session?.user

    const isAdmin = isAdminIdentity(user)

    const registryEnabled = isRegistryEnabled()
    let registryOptIn = false
    let registryHideNav = false
    if (registryEnabled) {
        try {
            const [optIn, hideNav] = await Promise.all([
                getSetting('registry_opt_in'),
                getSetting('registry_hide_nav')
            ])
            registryOptIn = optIn === 'true'
            registryHideNav = hideNav === 'true'
        } catch {
            registryOptIn = false
            registryHideNav = false
        }
    }
    const showNav = registryEnabled && (registryOptIn || !registryHideNav)

    return <MobileNav isLoggedIn={!!user} isAdmin={isAdmin} showNav={showNav} />
}
