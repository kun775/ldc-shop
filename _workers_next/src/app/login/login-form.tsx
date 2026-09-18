"use client"

import { signIn } from "next-auth/react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertCircle, Github, LogIn, ShieldCheck } from "lucide-react"
import { useI18n } from "@/lib/i18n/context"

/**
 * Auth.js 抛回的错误码 → i18n key。
 *
 * DEX 是标准 OIDC，失败模式比现有两个 provider 更多（discovery 不可达、
 * client secret 错误、redirect_uri 未登记），统一映射为可操作的提示。
 */
const AUTH_ERROR_KEYS: Record<string, string> = {
    Configuration: "login.error.configuration",
    AccessDenied: "login.error.accessDenied",
    OAuthSignIn: "login.error.providerUnavailable",
    OAuthCallback: "login.error.callbackFailed",
    OAuthAccountNotLinked: "login.error.accountNotLinked",
    Verification: "login.error.verification",
    SessionRequired: "login.error.sessionRequired",
}

export function LoginForm({ githubEnabled, dexEnabled }: { githubEnabled: boolean; dexEnabled: boolean }) {
    const { t } = useI18n()
    const searchParams = useSearchParams()
    const callbackUrl = searchParams.get("callbackUrl") || "/"
    const errorCode = searchParams.get("error")
    const errorKey = errorCode ? AUTH_ERROR_KEYS[errorCode] || "login.error.generic" : null

    return (
        <main className="container py-16 max-w-md">
            <Card className="tech-card overflow-hidden">
                <CardHeader className="space-y-2">
                    <CardTitle className="text-2xl">{t("login.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    {errorKey && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p className="leading-relaxed">{t(errorKey)}</p>
                        </div>
                    )}
                    {dexEnabled && (
                        <div className="space-y-1.5">
                            <Button size="lg" className="w-full" onClick={() => signIn("dex", { callbackUrl })}>
                                <ShieldCheck className="mr-2 h-4 w-4" />
                                {t("login.withDex")}
                            </Button>
                            <p className="text-center text-xs text-muted-foreground">{t("login.dexHint")}</p>
                        </div>
                    )}
                    {githubEnabled && (
                        <Button
                            size="lg"
                            variant="outline"
                            className="w-full"
                            onClick={() => signIn("github", { callbackUrl })}
                        >
                            <Github className="mr-2 h-4 w-4" />
                            {t("login.withGitHub")}
                        </Button>
                    )}
                    <Button
                        size="lg"
                        className="w-full bg-foreground text-background hover:bg-foreground/90"
                        onClick={() => signIn("linuxdo", { callbackUrl })}
                    >
                        <LogIn className="mr-2 h-4 w-4" />
                        {t("login.withLinuxDo")}
                    </Button>
                </CardContent>
            </Card>
        </main>
    )
}
