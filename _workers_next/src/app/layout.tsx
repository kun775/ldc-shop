import type { Metadata } from "next";
import { resolveEffectiveShopLogo } from "@/lib/shop-logo";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { MobileNavWrapper } from "@/components/mobile-nav-wrapper";
import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";
import { getAllSettings } from "@/lib/db/queries";
import { Suspense } from "react";
import { detectServerLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/shared";
import { DEFAULT_MONO_FONT_STACK, getThemeFontStack, getThemeFontStylesheetHref } from "@/lib/theme-fonts";

const DEFAULT_TITLE = "LDC Virtual Goods Shop";
const DEFAULT_DESCRIPTION = "High-quality virtual goods, instant delivery";
const THEME_HUES: Record<string, number> = {
  purple: 270,
  indigo: 255,
  blue: 240,
  cyan: 200,
  teal: 170,
  green: 150,
  lime: 120,
  amber: 85,
  orange: 45,
  red: 25,
  rose: 345,
  pink: 330,
  black: 0,
};
const THEME_CHROMA: Record<string, number> = {
  black: 0,
};
const THEME_PRIMARY_L: Record<string, number> = {
  black: 0.2,
};
const THEME_PRIMARY_DARK_L: Record<string, number> = {
  black: 0.8,
};

export async function generateMetadata(): Promise<Metadata> {
  let shopName: string | null = null;
  let shopDescription: string | null = null;
  let noIndex = false;
  let shopLogo: string | null = null;
  let logoUpdatedAt: string | null = null;
  try {
    // 单次读取全部 settings。
    // 此前这里是 6 次 getSetting（每次一条 SELECT ... WHERE key = ?），
    // 加上 RootLayoutContent 的 3 次，每个页面渲染根布局都要发 9 条 D1 查询。
    // getAllSettings 由 React cache() 包裹，同一请求内多处调用只会真正读一次。
    const allSettings = await getAllSettings();
    shopName = allSettings.shop_name ?? null;
    shopDescription = allSettings.shop_description ?? null;
    noIndex = allSettings.noindex_enabled === 'true';
    shopLogo = resolveEffectiveShopLogo(
      allSettings.shop_logo ?? null,
      allSettings.shop_logo_source ?? null,
    ).effectiveLogo || null;
    logoUpdatedAt = allSettings.shop_logo_updated_at ?? null;
  } catch {
    shopName = null;
    shopDescription = null;
  }

  const metadata: Metadata = {
    title: shopName?.trim() || DEFAULT_TITLE,
    description: shopDescription?.trim() || DEFAULT_DESCRIPTION,
    robots: noIndex ? { index: false, follow: false } : undefined,
    manifest: "/manifest.json",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: shopName?.trim() || DEFAULT_TITLE,
    },
    formatDetection: {
      telephone: false,
    },
    other: {
      "mobile-web-app-capable": "yes",
    },
    icons: {
      icon: shopLogo || (logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon"),
      shortcut: shopLogo || (logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon"),
      apple: shopLogo || (logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon"),
    },
  };

  return metadata;
}

async function RootLayoutContent({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let themeColor: string | null = null;
  let themeFont: string | null = null;
  let currencyUnit: string | null = null;
  let initialLocale: Locale = "en";
  try {
    // 与 generateMetadata 共用同一次 getAllSettings()（React cache 去重）。
    const [allSettings, resolvedLocale] = await Promise.all([
      getAllSettings(),
      detectServerLocale(),
    ]);
    themeColor = allSettings.theme_color ?? null;
    themeFont = allSettings.theme_font ?? null;
    currencyUnit = allSettings.currency_unit ?? null;
    initialLocale = resolvedLocale;
  } catch {
    themeColor = null;
    themeFont = null;
    currencyUnit = null;
    initialLocale = "en";
  }
  const themeHue = THEME_HUES[themeColor || "purple"] || 270;
  const themeChroma = THEME_CHROMA[themeColor || "purple"] ?? 1;
  const themePrimaryL = THEME_PRIMARY_L[themeColor || "purple"] ?? 0.45;
  const themePrimaryDarkL = THEME_PRIMARY_DARK_L[themeColor || "purple"] ?? 0.7;
  const themeFontStack = getThemeFontStack(themeFont);
  const themeFontStylesheetHref = getThemeFontStylesheetHref(themeFont);

  return (
    <html
      lang={initialLocale === "zh" ? "zh-CN" : "en"}
      suppressHydrationWarning
      style={{
        ["--theme-hue" as any]: themeHue,
        ["--theme-chroma" as any]: themeChroma,
        ["--theme-primary-l" as any]: themePrimaryL,
        ["--theme-primary-dark-l" as any]: themePrimaryDarkL,
        ["--app-font-sans" as any]: themeFontStack,
        ["--app-font-mono" as any]: DEFAULT_MONO_FONT_STACK,
      }}
    >
      <head>
        {themeFontStylesheetHref && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
            <link rel="stylesheet" href={themeFontStylesheetHref} />
          </>
        )}
        {/* Polyfill for esbuild's __name helper - fixes "__name is not defined" error on Cloudflare Workers */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var __name = function(fn, name) { return Object.defineProperty(fn, "name", { value: name, configurable: true }); };`,
          }}
        />
      </head>
      <body className={cn("min-h-screen bg-background font-sans antialiased has-[[data-admin-root]]:h-dvh has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:overflow-hidden")}>
        <Providers themeColor={themeColor} initialLocale={initialLocale} currencyUnit={currencyUnit}>
          <div className="relative flex min-h-screen flex-col has-[[data-admin-root]]:h-dvh has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:overflow-hidden">
            <SiteHeader />
            <div className="flex-1 safe-area-pb-nav has-[[data-admin-root]]:flex has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:flex-col has-[[data-admin-root]]:overflow-hidden has-[[data-admin-root]]:pb-0">{children}</div>
            <SiteFooter />
            <MobileNavWrapper />
          </div>
        </Providers>
      </body>
    </html>
  );
}

function RootLayoutFallback() {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased has-[[data-admin-root]]:h-dvh has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:overflow-hidden")}>
        <div className="relative flex min-h-screen flex-col has-[[data-admin-root]]:h-dvh has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:overflow-hidden">
          <div className="h-16 border-b border-border/40 bg-background/70" />
          <div className="flex flex-1 items-center justify-center">
            {/* 冷启动兜底指示：根布局尚未解析完成时，客户端遮罩还没有机会挂载，
                这里用纯 CSS 旋转器保证「不出现纯空白页」。不参与水合，无闪烁风险。 */}
            <div
              role="status"
              aria-label="Loading"
              className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary motion-reduce:animate-none"
            />
          </div>
          <div className="h-16 border-t border-border/40 bg-background/70" />
        </div>
      </body>
    </html>
  )
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Suspense fallback={<RootLayoutFallback />}>
      <RootLayoutContent>{children}</RootLayoutContent>
    </Suspense>
  )
}
