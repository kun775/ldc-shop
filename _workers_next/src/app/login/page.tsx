import { Suspense } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { LoginForm } from "./login-form"

// provider 可用性来自 Cloudflare Worker Secret，必须在运行时读取；
// 一旦被静态预渲染固化，构建期不可见的 secret 会让入口永久消失。
export const dynamic = "force-dynamic"

function isGithubEnabled() {
    const clientId = process.env.GITHUB_ID || process.env.AUTH_GITHUB_ID
    const clientSecret = process.env.GITHUB_SECRET || process.env.AUTH_GITHUB_SECRET
    return Boolean(clientId && clientSecret)
}

function isDexEnabled() {
    if (process.env.DEX_ENABLED === "false") return false
    return Boolean(process.env.DEX_CLIENT_ID && process.env.DEX_CLIENT_SECRET)
}

function LoginFallback() {
    return (
        <main className="container py-16 max-w-md">
            <Card className="tech-card overflow-hidden">
                <CardHeader className="space-y-2">
                    <div className="h-8 w-24 rounded-md bg-muted/60 animate-pulse" />
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="h-10 w-full rounded-md bg-muted/40 animate-pulse" />
                    <div className="h-10 w-full rounded-md bg-muted/40 animate-pulse" />
                </CardContent>
            </Card>
        </main>
    )
}

export default function LoginPage() {
    return (
        <Suspense fallback={<LoginFallback />}>
            <LoginForm githubEnabled={isGithubEnabled()} dexEnabled={isDexEnabled()} />
        </Suspense>
    )
}
