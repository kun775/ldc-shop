"use server"

import { checkAdmin } from "@/actions/admin"
import { getSetting, setSetting } from "@/lib/db/queries"
import { ensureRegistryInstanceId, getRegistryBaseUrl, normalizeOrigin } from "@/lib/registry"
import { revalidatePath } from "next/cache"
import { fetchWithTimeout } from "@/lib/runtime/fetch-with-timeout"

interface RegistryResult {
    ok: boolean
    error?: string
}

function revalidateRegistryPages() {
    revalidatePath("/")
    revalidatePath("/admin/settings")
    revalidatePath("/nav")
    revalidatePath("/navi")
}

export async function dismissRegistryPrompt(): Promise<RegistryResult> {
    await checkAdmin()
    await setSetting("registry_prompted", "true")
    await setSetting("registry_opt_in", "false")
    return { ok: true }
}

export async function joinRegistry(origin: string): Promise<RegistryResult> {
    await checkAdmin()
    const baseUrl = getRegistryBaseUrl()
    if (!baseUrl) {
        return { ok: false, error: "registry_not_configured" }
    }

    let normalized: string
    try {
        normalized = normalizeOrigin(origin)
    } catch (error: any) {
        return { ok: false, error: error?.message || "invalid_origin" }
    }

    await ensureRegistryInstanceId()

    const challengeRes = await fetchWithTimeout(`${baseUrl}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalized }),
    }, 10_000)

    if (!challengeRes.ok) {
        return { ok: false, error: `challenge_failed_${challengeRes.status}` }
    }

    const challengeData = await challengeRes.json()
    const token = (challengeData?.token || "").toString()
    if (!token) {
        return { ok: false, error: "challenge_token_missing" }
    }

    await setSetting("registry_challenge_token", token)
    await setSetting("registry_origin", normalized)

    const submitRes = await fetchWithTimeout(`${baseUrl}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalized }),
    }, 10_000)

    if (!submitRes.ok) {
        const errorText = await submitRes.text()
        return { ok: false, error: `submit_failed_${submitRes.status}:${errorText}` }
    }

    await setSetting("registry_opt_in", "true")
    await setSetting("registry_hide_nav", "false")
    await setSetting("registry_prompted", "true")
    await setSetting("registry_last_submit_at", String(Date.now()))

    revalidateRegistryPages()

    return { ok: true }
}

export async function leaveRegistry(): Promise<RegistryResult> {
    await checkAdmin()

    const baseUrl = getRegistryBaseUrl()
    const originRaw = (await getSetting("registry_origin")) || ""
    const origin = originRaw.trim()

    if (baseUrl && origin) {
        let normalized: string
        try {
            normalized = normalizeOrigin(origin)
        } catch (error: any) {
            return { ok: false, error: error?.message || "invalid_origin" }
        }

        const challengeRes = await fetchWithTimeout(`${baseUrl}/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: normalized }),
        }, 10_000)

        if (!challengeRes.ok) {
            return { ok: false, error: `challenge_failed_${challengeRes.status}` }
        }

        const challengeData = await challengeRes.json()
        const token = (challengeData?.token || "").toString()
        if (!token) {
            return { ok: false, error: "challenge_token_missing" }
        }

        await setSetting("registry_challenge_token", token)

        const removeRes = await fetchWithTimeout(`${baseUrl}/remove`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: normalized }),
        }, 10_000)

        if (!removeRes.ok) {
            const errorText = await removeRes.text()
            return { ok: false, error: `remove_failed_${removeRes.status}:${errorText}` }
        }
    }

    await Promise.all([
        setSetting("registry_opt_in", "false"),
        setSetting("registry_hide_nav", "true"),
        setSetting("registry_origin", ""),
        setSetting("registry_challenge_token", ""),
        setSetting("registry_last_submit_at", ""),
        setSetting("registry_prompted", "true"),
    ])
    revalidateRegistryPages()
    return { ok: true }
}

export async function getRegistryStatus() {
    await checkAdmin()
    const [optIn, origin, lastSubmit] = await Promise.all([
        getSetting("registry_opt_in"),
        getSetting("registry_origin"),
        getSetting("registry_last_submit_at"),
    ])
    return {
        optIn: optIn === "true",
        origin: origin || null,
        lastSubmitAt: lastSubmit ? Number(lastSubmit) : null,
    }
}
