export function isGitHubUsername(username?: string | null) {
    if (!username) return false
    return username.trim().toLowerCase().startsWith("gh_")
}

export function isGitHubUser(username?: string | null, userId?: string | null) {
    if (isGitHubUsername(username)) return true
    if (!userId) return false
    return userId.trim().toLowerCase().startsWith("github:")
}

export const DEX_USER_ID_PREFIX = "dex:"
export const DEX_USERNAME_PREFIX = "dex_"

export function isDexUsername(username?: string | null) {
    if (!username) return false
    return username.trim().toLowerCase().startsWith(DEX_USERNAME_PREFIX)
}

export function isDexUser(username?: string | null, userId?: string | null) {
    if (isDexUsername(username)) return true
    if (!userId) return false
    return userId.trim().toLowerCase().startsWith(DEX_USER_ID_PREFIX)
}

export function getDisplayUsername(username?: string | null, userId?: string | null) {
    if (!username) return null
    const trimmed = username.trim()
    if (!trimmed) return null

    if (isDexUser(trimmed, userId)) {
        const normalized = trimmed.toLowerCase()
        return normalized.startsWith(DEX_USERNAME_PREFIX) ? normalized : `${DEX_USERNAME_PREFIX}${normalized}`
    }

    if (isGitHubUser(trimmed, userId)) {
        const normalized = trimmed.toLowerCase()
        return normalized.startsWith("gh_") ? normalized : `gh_${normalized}`
    }

    return trimmed
}

export function getAdminUserProfileUrl(userId?: string | null) {
    const trimmed = userId?.trim()
    return trimmed ? `/admin/users/detail?userId=${encodeURIComponent(trimmed)}` : null
}

export function normalizeAdminUserProfileId(value?: string | null) {
    const trimmed = value?.trim()
    if (!trimmed) return null

    let candidate = trimmed
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (/^(dex|github):/i.test(candidate)) return candidate
        if (!candidate.includes('%')) break

        try {
            const decoded = decodeURIComponent(candidate)
            if (decoded === candidate) break
            candidate = decoded
        } catch {
            break
        }
    }

    return /^(dex|github):/i.test(candidate) ? candidate : trimmed
}

export function getExternalProfileUrl(username?: string | null, userId?: string | null) {
    if (!username) return null
    const trimmed = username.trim()
    if (!trimmed) return null

    if (isGitHubUser(trimmed, userId)) {
        const normalized = trimmed.toLowerCase()
        const githubLogin = normalized.startsWith("gh_") ? normalized.slice(3).trim() : normalized
        if (githubLogin) {
            return `https://github.com/${encodeURIComponent(githubLogin)}`
        }
        return null
    }

    if (isDexUser(trimmed, userId)) {
        // DEX 账号没有可公开访问的个人主页，返回 null 让调用方降级为纯文本展示；
        // 否则会被下方默认分支错误地链接到 linux.do 的用户页。
        return null
    }

    return `https://linux.do/u/${encodeURIComponent(trimmed)}`
}
