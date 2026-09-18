export function isGitHubUsername(username?: string | null) {
    if (!username) return false
    return username.trim().toLowerCase().startsWith("gh_")
}

export function isGitHubUser(username?: string | null, userId?: string | null) {
    if (isGitHubUsername(username)) return true
    if (!userId) return false
    return userId.trim().toLowerCase().startsWith("github:")
}

export function getDisplayUsername(username?: string | null, userId?: string | null) {
    if (!username) return null
    const trimmed = username.trim()
    if (!trimmed) return null

    if (isGitHubUser(trimmed, userId)) {
        const normalized = trimmed.toLowerCase()
        return normalized.startsWith("gh_") ? normalized : `gh_${normalized}`
    }

    return trimmed
}

export function getAdminUserProfileUrl(userId?: string | null) {
    const trimmed = userId?.trim()
    return trimmed ? `/admin/users/${encodeURIComponent(trimmed)}` : null
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

    return `https://linux.do/u/${encodeURIComponent(trimmed)}`
}
