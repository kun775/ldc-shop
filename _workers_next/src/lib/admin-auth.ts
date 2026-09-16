export function getAdminUsernames() {
    return (process.env.ADMIN_USERS || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
}

export function getAdminUserIds() {
    return (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
}

export function isAdminUsername(username?: string | null) {
    if (!username) return false
    const adminUsers = getAdminUsernames()
    return adminUsers.some((name) => name.toLowerCase() === username.toLowerCase())
}

export function isAdminIdentity(user?: { id?: string | null; username?: string | null } | null) {
    if (!user) return false
    const adminUserIds = getAdminUserIds()
    if (adminUserIds.length > 0) {
        return !!user.id && adminUserIds.includes(user.id)
    }

    // Legacy fallback for existing deployments. Configure ADMIN_USER_IDS to switch
    // authorization to immutable provider account IDs.
    return isAdminUsername(user.username)
}
