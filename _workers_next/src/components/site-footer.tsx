import { getSetting, getVisitorCount } from "@/lib/db/queries"
import { FooterContent } from "./footer-content"
import { APP_VERSION } from "@/lib/version"

export async function SiteFooter() {
    let shopFooter: string | null = null
    let visitorCount = 0
    try {
        const [footer, count] = await Promise.all([
            getSetting('shop_footer'),
            getVisitorCount().catch(() => 0),
        ])
        shopFooter = footer
        visitorCount = count
    } catch {
        shopFooter = null
        visitorCount = 0
    }

    return <FooterContent customFooter={shopFooter} version={APP_VERSION} visitorCount={visitorCount} />
}
