export type AsyncOnceState = {
    ready: boolean
    pending: Promise<void> | null
}

export function createAsyncOnceState(): AsyncOnceState {
    return {
        ready: false,
        pending: null,
    }
}

export async function ensureOnce(
    state: AsyncOnceState,
    task: () => Promise<void>,
) {
    if (state.ready) return
    if (state.pending) {
        await state.pending
        return
    }

    const pending = (async () => {
        await task()
        state.ready = true
    })()

    state.pending = pending
    try {
        await pending
    } finally {
        if (state.pending === pending) {
            state.pending = null
        }
    }
}

export function parseSchemaVersion(value: unknown): number | null {
    const normalized = String(value ?? "").trim()
    if (!normalized) return null

    const parsed = Number.parseInt(normalized, 10)
    return Number.isFinite(parsed) ? parsed : null
}

export function isSchemaVersionSatisfied(value: unknown, minimumVersion: number) {
    const parsed = parseSchemaVersion(value)
    return parsed !== null && parsed >= minimumVersion
}
