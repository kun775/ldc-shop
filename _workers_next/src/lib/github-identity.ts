/**
 * GitHub 账号身份。
 *
 * user_id 只是店铺侧的稳定主键。能否把两行当成同一个人，
 * 只能看规范化后的 GitHub 数字 ID 是否完全相同。
 * 用户名可被回收，裸数字 ID 也会被新账号撞上，都不能当合并条件。
 */

export interface GitHubIdentity {
    provider: "github"
    providerAccountId: string
    userId: string
}

function normalizeAuthScalar(rawValue: unknown): string | null {
    if (rawValue === undefined || rawValue === null) return null
    const normalized = String(rawValue).trim()
    if (!normalized) return null
    const lowered = normalized.toLowerCase()
    if (lowered === "undefined" || lowered === "null" || lowered === "nan") return null
    return normalized
}

export function githubProviderAccountId(rawId: unknown): string | null {
    const base = normalizeAuthScalar(rawId)
    if (!base) return null
    let normalized = base
    while (normalized.toLowerCase().startsWith("github:")) {
        normalized = normalized.slice("github:".length)
    }
    const accountId = normalizeAuthScalar(normalized)
    if (!accountId || !/^\d+$/.test(accountId)) return null
    return accountId
}

export function canonicalGitHubUserId(rawId: unknown): string | null {
    const accountId = githubProviderAccountId(rawId)
    return accountId ? `github:${accountId}` : null
}

export function parseGitHubIdentity(rawId: unknown): GitHubIdentity | null {
    const providerAccountId = githubProviderAccountId(rawId)
    if (!providerAccountId) return null
    return {
        provider: "github",
        providerAccountId,
        userId: `github:${providerAccountId}`,
    }
}

/**
 * 只有规范化后仍指向同一个 GitHub 数字 ID，才允许把旧行迁到当前登录。
 * `123`、`github:123` 视为同一身份；`github:123` 与 `github:456` 必须拒绝。
 */
export function isSameGitHubAccount(existingUserId: unknown, canonicalUserId: unknown): boolean {
    const existing = canonicalGitHubUserId(existingUserId)
    const current = canonicalGitHubUserId(canonicalUserId)
    return !!existing && !!current && existing === current
}
