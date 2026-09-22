import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import { sql } from "drizzle-orm"
import { db, runAtomicD1Batch } from "@/lib/db"
import { loginUsers } from "@/lib/db/schema"
import { recordAuditEvent, recordServerError } from "@/lib/audit/record"
import { isSameGitHubAccount } from "@/lib/github-identity"
import { buildLoginUserMergeStatements } from "@/lib/db/user-merge"

const githubClientId = process.env.GITHUB_ID || process.env.AUTH_GITHUB_ID
const githubClientSecret = process.env.GITHUB_SECRET || process.env.AUTH_GITHUB_SECRET

/**
 * DEX 单点登录配置。
 *
 * DEX 仅用于后台管理员登录（路线 0），普通用户继续使用 Linux DO / GitHub。
 * DEX 是标准 OIDC：仅授权码模式 + PKCE S256 + RS256 签名，且 token 端点
 * 只接受 client_secret_basic / client_secret_post，因此必须配置 client secret。
 *
 * 未配置时该 provider 不注册，登录页也不会显示入口。
 */
const dexIssuer = process.env.DEX_ISSUER || "https://auth.zkun.de/dex"
const dexClientId = process.env.DEX_CLIENT_ID
const dexClientSecret = process.env.DEX_CLIENT_SECRET
const dexEnabled = process.env.DEX_ENABLED !== "false"

const providers: any[] = [
    {
        id: "linuxdo",
        name: "Linux DO",
        type: "oauth",
        authorization: "https://connect.linux.do/oauth2/authorize",
        token: {
            url: "https://connect.linux.do/oauth2/token",
            async conform(response: Response) {
                const contentType = response.headers.get("content-type") || ""
                if (contentType.includes("application/json")) return response

                const body = await response.clone().text()
                const bodyPreview = body.slice(0, 1000)

                console.error("[auth-temp][linuxdo-token]", {
                    status: response.status,
                    contentType,
                    bodyPreview,
                })

                // Some providers return JSON with an unexpected content-type.
                if (bodyPreview.trim().startsWith("{")) {
                    return new Response(body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: { "content-type": "application/json" },
                    })
                }

                return response
            },
        },
        userinfo: "https://connect.linux.do/api/user",
        issuer: "https://connect.linux.do/",
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
        profile(profile: any) {
            return {
                id: String(profile.id),
                name: profile.username || profile.name,
                email: profile.email,
                image: profile.avatar_url,
                trustLevel: profile.trust_level,
                avatar_url: profile.avatar_url,
                username: profile.username,
            }
        },
    }
]

async function resolveExistingGitHubUserIdByUsername(username?: string | null) {
    const normalizedUsername = normalizeGitHubUsername(username, null, null)
    if (!normalizedUsername) return null

    try {
        const rows = await db
            .select({ userId: loginUsers.userId })
            .from(loginUsers)
            .where(sql`LOWER(${loginUsers.username}) = ${normalizedUsername}`)
            .orderBy(sql`COALESCE(${loginUsers.lastLoginAt}, 0) DESC`)
            .limit(1)
        return rows[0]?.userId ?? null
    } catch {
        return null
    }
}

function normalizeAuthScalar(rawValue: unknown): string | null {
    if (rawValue === undefined || rawValue === null) return null
    const normalized = String(rawValue).trim()
    if (!normalized) return null
    const lowered = normalized.toLowerCase()
    if (lowered === "undefined" || lowered === "null" || lowered === "nan") return null
    return normalized
}

function normalizeGitHubUserId(rawId?: string | null) {
    const base = normalizeAuthScalar(rawId)
    if (!base) return null
    let normalized = base
    while (normalized.toLowerCase().startsWith("github:")) {
        normalized = normalized.slice("github:".length)
    }
    const sanitized = normalizeAuthScalar(normalized)
    if (!sanitized) return null
    return `github:${sanitized}`
}

function normalizeGitHubLogin(rawLogin: unknown, fallbackId: unknown): string | null {
    const normalizedLogin = normalizeAuthScalar(rawLogin)?.toLowerCase()
    if (normalizedLogin) return normalizedLogin

    const initialFallback = normalizeAuthScalar(fallbackId)
    if (!initialFallback) return null

    let normalizedFallback = initialFallback
    while (normalizedFallback.toLowerCase().startsWith("github:")) {
        normalizedFallback = normalizedFallback.slice("github:".length)
    }

    const sanitizedFallback = normalizeAuthScalar(normalizedFallback)
    return sanitizedFallback ? sanitizedFallback.toLowerCase() : null
}

function normalizeGitHubUsername(rawUsername: unknown, rawLogin: unknown, fallbackId: unknown): string | null {
    const normalizedUsername = normalizeAuthScalar(rawUsername)?.toLowerCase()
    if (normalizedUsername) {
        const withoutPrefix = normalizedUsername.startsWith("gh_")
            ? normalizedUsername.slice("gh_".length)
            : normalizedUsername
        const normalizedExisting = normalizeGitHubLogin(withoutPrefix, null)
        if (normalizedExisting) return `gh_${normalizedExisting}`
    }

    const normalizedLogin = normalizeGitHubLogin(rawLogin, fallbackId)
    return normalizedLogin ? `gh_${normalizedLogin}` : null
}

function sanitizeDexHandle(rawHandle: unknown): string | null {
    const normalized = normalizeAuthScalar(rawHandle)
    if (!normalized) return null
    const sanitized = normalized
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    return sanitized || null
}

/**
 * DEX 用户 id 一律规范为 `dex:<sub>` 形式。
 *
 * 加前缀是必须的：Linux DO 的 user_id 是裸数字，而 DEX 的 sub 在部分 connector 下
 * 同样可能是纯数字串，一旦碰撞会把两个不同的人合并到同一账号（订单与积分串号）。
 */
function normalizeDexUserId(rawSub: unknown): string | null {
    const base = normalizeAuthScalar(rawSub)
    if (!base) return null
    let normalized = base
    while (normalized.toLowerCase().startsWith("dex:")) {
        normalized = normalized.slice("dex:".length)
    }
    const sanitized = normalizeAuthScalar(normalized)
    return sanitized ? `dex:${sanitized}` : null
}

/**
 * DEX 用户名规范为 `dex_<handle>`，与 GitHub 的 `gh_` 前缀风格保持一致。
 *
 * 依次尝试 preferred_username → name → email 本地部分，全部不可用时回退到 sub
 * 前 12 位（保证 username 不为空，后台列表不会出现空白的用户名列）。
 */
function normalizeDexUsername(rawUsername: unknown, rawName: unknown, rawEmail: unknown, rawSub?: unknown): string | null {
    for (const candidate of [rawUsername, rawName]) {
        const handle = sanitizeDexHandle(candidate)
        if (handle) return `dex_${handle}`
    }

    const email = normalizeAuthScalar(rawEmail)
    if (email && email.includes("@")) {
        const handle = sanitizeDexHandle(email.split("@")[0])
        if (handle) return `dex_${handle}`
    }

    const sub = normalizeDexUserId(rawSub)
    if (sub) return `dex_${sub.slice("dex:".length).slice(0, 12).toLowerCase()}`

    return null
}

async function migrateLegacyUserId(sourceUserId: string, targetUserId: string, username?: string | null) {
    if (!sourceUserId || !targetUserId || sourceUserId === targetUserId) return

    const normalizedUsername = username?.trim().toLowerCase() || null
    try {
        await db.run(sql.raw(`ALTER TABLE login_users ADD COLUMN nickname TEXT`))
    } catch {
        // The column normally already exists. The source query below still fails
        // and preserves the source account if this was not a duplicate-column error.
    }

    try {
        const sourceRows = await db
            .select({
                userId: loginUsers.userId,
                username: loginUsers.username,
                nickname: loginUsers.nickname,
                email: loginUsers.email,
                points: loginUsers.points,
                isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
                desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
                createdAt: loginUsers.createdAt,
                lastLoginAt: loginUsers.lastLoginAt,
            })
            .from(loginUsers)
            .where(sql`${loginUsers.userId} = ${sourceUserId}`)
            .limit(1)
        if (!sourceRows.length) return

        await runAtomicD1Batch(buildLoginUserMergeStatements({
            source: {
                userId: sourceRows[0].userId,
                username: sourceRows[0].username,
                nickname: sourceRows[0].nickname,
                email: sourceRows[0].email,
                points: Number(sourceRows[0].points || 0),
                isBlocked: !!sourceRows[0].isBlocked,
                desktopNotificationsEnabled: !!sourceRows[0].desktopNotificationsEnabled,
                createdAt: sourceRows[0].createdAt,
                lastLoginAt: sourceRows[0].lastLoginAt,
            },
            targetUserId,
            username: normalizedUsername,
        }))
    } catch (error) {
        console.warn("[auth] legacy user id migration failed", {
            sourceUserId,
            targetUserId,
            error,
        })
        throw error
    }
}

if (githubClientId && githubClientSecret) {
    providers.push(
        GitHub({
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            profile(profile) {
                const providerId = normalizeAuthScalar(profile.id)
                if (!providerId) {
                    console.error("[auth] github profile.id missing in provider profile", {
                        profileId: profile.id ?? null,
                        login: profile.login ?? null,
                    })
                    throw new Error("GITHUB_PROFILE_ID_MISSING")
                }

                const username = normalizeGitHubUsername(null, profile.login, providerId)
                if (!username) {
                    console.error("[auth] github profile.login missing in provider profile", {
                        profileId: profile.id ?? null,
                        login: profile.login ?? null,
                    })
                    throw new Error("GITHUB_LOGIN_MISSING")
                }

                const displayLogin = normalizeGitHubLogin(profile.login, providerId)
                return {
                    id: providerId,
                    name: profile.name || displayLogin || providerId,
                    email: profile.email,
                    image: profile.avatar_url,
                    // Prefix GitHub usernames to avoid collisions with Linux DO usernames.
                    username,
                    avatar_url: profile.avatar_url,
                }
            },
        })
    )
} else {
    console.warn("[auth] GitHub login disabled: missing GITHUB_ID/GITHUB_SECRET")
}

if (dexEnabled && dexClientId && dexClientSecret) {
    providers.push({
        id: "dex",
        name: "DEX",
        type: "oidc",
        issuer: dexIssuer,
        clientId: dexClientId,
        clientSecret: dexClientSecret,
        // 手写 provider 必须显式声明 checks。
        //
        // @auth/core 的 parseProviders 对 oauth/oidc 一律取 `c.checks ?? ["pkce"]`，
        // 并没有针对 OIDC 的额外默认值；不写这一行时 state 与 nonce 都不会启用：
        //   - authorization-url.js 里 `checks.state.create()` 直接 return，
        //     所以授权 URL 不带 state；回调侧 callback.js 也据此走 `o.skipStateCheck`
        //   - 同理 `checks.nonce.create()` 直接 return，id_token 不校验 nonce
        // 内置的 OIDC provider（okta / roblox / salesforce / vipps / bankid-no 等）
        // 都显式写了 checks，就是为了绕开这个默认值。
        //
        // 注：PKCE S256 已能挡住「把他人授权码塞进受害者浏览器」这类登录 CSRF，
        // 因此缺 state 不构成立即可利用的漏洞；但 state 是零成本的双保险，
        // 且非 code 流程下 PKCE 不生效。nonce 则用于把 id_token 绑定到本次浏览器会话。
        checks: ["pkce", "state", "nonce"],
        authorization: {
            params: {
                // 不申请 offline_access：本站不调用 DEX 的任何下游 API，
                // 申请 refresh_token 只会平白扩大令牌泄漏面。
                scope: "openid profile email",
            },
        },
        profile(profile: any) {
            const resolvedId = normalizeDexUserId(profile?.sub)
            if (!resolvedId) {
                console.error("[auth] dex profile.sub missing in provider profile", {
                    sub: profile?.sub ?? null,
                    preferredUsername: profile?.preferred_username ?? null,
                })
                throw new Error("DEX_SUB_MISSING")
            }

            return {
                id: resolvedId,
                name: profile?.name || profile?.preferred_username || resolvedId,
                email: profile?.email,
                image: profile?.picture,
                username: normalizeDexUsername(
                    profile?.preferred_username,
                    profile?.name,
                    profile?.email,
                    profile?.sub,
                ),
                avatar_url: profile?.picture,
            }
        },
    })
} else if (!dexClientId || !dexClientSecret) {
    console.warn("[auth] DEX login disabled: missing DEX_CLIENT_ID/DEX_CLIENT_SECRET")
}

export const { handlers, signIn, signOut, auth } = NextAuth({
    providers,
    events: {
        async signIn({ user, account }) {
            await recordAuditEvent({
                eventName: 'auth.login',
                actorType: 'user',
                actorUserId: user.id ? String(user.id) : null,
                actorUsername: user.username ? String(user.username) : null,
                targetId: user.id ? String(user.id) : null,
                source: 'auth',
                metadata: {
                    provider: account?.provider || null,
                    status: 'success',
                },
            })
        },
    },
    callbacks: {
        async jwt({ token, user, profile, account }) {
            if (user) {
                let resolvedId = String(user.id)
                let resolvedUsername = user.username ? String(user.username) : null

                if (account?.provider === "linuxdo") {
                    // Match legacy working behavior: Linux DO id must come from profile.id only.
                    const rawLinuxDoId = (profile as any)?.id
                    const linuxDoId =
                        rawLinuxDoId === undefined || rawLinuxDoId === null
                            ? null
                            : String(rawLinuxDoId).trim()
                    if (!linuxDoId) {
                        console.error("[auth] linuxdo profile.id missing in jwt callback", {
                            profileId: (profile as any)?.id ?? null,
                            username: (profile as any)?.username ?? null,
                        })
                        throw new Error("LINUXDO_PROFILE_ID_MISSING")
                    }

                    resolvedId = linuxDoId
                    if ((profile as any)?.username) {
                        resolvedUsername = String((profile as any).username)
                    }
                } else if (account?.provider === "github") {
                    resolvedUsername = normalizeGitHubUsername(
                        resolvedUsername,
                        (profile as any)?.login ?? null,
                        account.providerAccountId ?? user.id
                    )

                    // Prefer providerAccountId for GitHub; it's the most stable account identifier.
                    const canonicalGitHubId = normalizeGitHubUserId(account.providerAccountId)
                    if (!canonicalGitHubId) {
                        console.error("[auth] github providerAccountId missing in jwt callback", {
                            providerAccountId: account.providerAccountId ?? null,
                            userId: user.id ?? null,
                            username: resolvedUsername,
                        })
                        throw new Error("GITHUB_PROVIDER_ID_MISSING")
                    }
                    resolvedId = canonicalGitHubId

                    // 用户名只用来找到历史行。裸数字和 github: 前缀都要先规范化，
                    // 不相等说明是另一个 GitHub 账号，绝不能因为改名或用户名回收而合并。
                    const existingUserId = await resolveExistingGitHubUserIdByUsername(resolvedUsername)
                    if (existingUserId && existingUserId !== canonicalGitHubId) {
                        if (!isSameGitHubAccount(existingUserId, canonicalGitHubId)) {
                            console.warn("[auth] refused github username merge", {
                                existingUserId,
                                canonicalGitHubId,
                                username: resolvedUsername,
                            })
                        } else {
                            await migrateLegacyUserId(existingUserId, canonicalGitHubId, resolvedUsername)
                        }
                    }
                } else if (account?.provider === "dex") {
                    // 规范化在 provider profile 阶段已完成，此处再兜底一次，
                    // 防止 profile 字段缺失时 id 退化为裸 sub（会与 Linux DO 数字 id 撞车）。
                    const canonicalDexId =
                        normalizeDexUserId((profile as any)?.sub) ||
                        normalizeDexUserId(account.providerAccountId) ||
                        normalizeDexUserId(resolvedId)
                    if (!canonicalDexId) {
                        console.error("[auth] dex profile.sub missing in jwt callback", {
                            profileSub: (profile as any)?.sub ?? null,
                            providerAccountId: account.providerAccountId ?? null,
                            userId: user.id ?? null,
                        })
                        throw new Error("DEX_SUB_MISSING")
                    }
                    resolvedId = canonicalDexId

                    const dexUsername = normalizeDexUsername(
                        (profile as any)?.preferred_username,
                        (profile as any)?.name,
                        (profile as any)?.email,
                        (profile as any)?.sub,
                    )
                    if (dexUsername) resolvedUsername = dexUsername
                }

                token.id = resolvedId
                if (resolvedUsername) token.username = resolvedUsername
                if (user.trustLevel !== undefined) token.trustLevel = user.trustLevel
                if (user.avatar_url) token.avatar_url = user.avatar_url
                else if (user.image) token.avatar_url = user.image
                return token
            }

            if (profile && account?.provider === "linuxdo") {
                const rawLinuxDoId = (profile as any)?.id
                const linuxDoId =
                    rawLinuxDoId === undefined || rawLinuxDoId === null
                        ? null
                        : String(rawLinuxDoId).trim()
                if (!linuxDoId) {
                    console.error("[auth] linuxdo profile.id missing in profile callback", {
                        profileId: (profile as any)?.id ?? null,
                        username: (profile as any)?.username ?? null,
                    })
                    throw new Error("LINUXDO_PROFILE_ID_MISSING")
                }

                token.id = linuxDoId
                token.username = (profile as any).username
                token.trustLevel = (profile as any).trust_level
                token.avatar_url = (profile as any).avatar_url
            }
            return token
        },
        async session({ session, token }) {
            if (token) {
                session.user.id = token.id as string
                session.user.username = typeof token.username === "string" ? token.username : undefined
                session.user.trustLevel = typeof token.trustLevel === "number" ? token.trustLevel : undefined
                session.user.avatar_url = typeof token.avatar_url === "string" ? token.avatar_url : undefined
            }
            return session
        }
    },
    pages: {
        signIn: "/login",
        // 统一错误落点：DEX 引入的失败模式更多（discovery 不可达、client secret 错误、
        // redirect_uri 未登记），Auth.js 默认错误页不会给出可操作的提示。
        error: "/login",
    },
    // Temporary diagnostics: keep this until OAuth callback issue is resolved.
    logger: {
        error(error) {
            console.error("[auth-temp]", {
                name: error.name,
                message: error.message,
                // Auth.js puts provider details under error.cause when available.
                cause: (error as Error & { cause?: unknown }).cause,
                stack: error.stack,
            })
            void recordServerError('auth.login', error, {
                actorType: 'system',
                auditEvent: {
                    eventName: 'auth.login',
                    actorType: 'system',
                    source: 'auth',
                },
            })
        },
    },
    // Use OAUTH_CLIENT_SECRET as fallback if NEXTAUTH_SECRET is not set
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.OAUTH_CLIENT_SECRET,
    trustHost: true,

})
