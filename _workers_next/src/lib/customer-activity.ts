const DAY_MS = 24 * 60 * 60 * 1000
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

export function getCustomerActivityThresholds(nowMs = Date.now()) {
    if (!Number.isFinite(nowMs)) {
        throw new RangeError('nowMs must be a finite timestamp')
    }

    // Customer activity is grouped by Shanghai calendar days.
    const todayStartMs = Math.floor((nowMs + SHANGHAI_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_UTC_OFFSET_MS

    return {
        todayStartMs,
        last7DaysStartMs: todayStartMs - (6 * DAY_MS),
        last30DaysStartMs: todayStartMs - (29 * DAY_MS),
    }
}
