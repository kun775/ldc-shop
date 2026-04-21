import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

const runtime = await import(new URL("./async-once.ts", import.meta.url).href)
const {
    createAsyncOnceState,
    ensureOnce,
    isSchemaVersionSatisfied,
    parseSchemaVersion,
} = runtime

test("ensureOnce coalesces concurrent calls into one execution", async () => {
    const state = createAsyncOnceState()
    let runCount = 0

    await Promise.all(
        Array.from({ length: 5 }, () =>
            ensureOnce(state, async () => {
                runCount += 1
                await delay(10)
            }),
        ),
    )

    assert.equal(runCount, 1)
    assert.equal(state.ready, true)
    assert.equal(state.pending, null)
})

test("ensureOnce skips rerun after state becomes ready", async () => {
    const state = createAsyncOnceState()
    let runCount = 0

    await ensureOnce(state, async () => {
        runCount += 1
    })
    await ensureOnce(state, async () => {
        runCount += 1
    })

    assert.equal(runCount, 1)
})

test("parseSchemaVersion normalizes valid persisted values", () => {
    assert.equal(parseSchemaVersion("21"), 21)
    assert.equal(parseSchemaVersion("  7 "), 7)
    assert.equal(parseSchemaVersion(null), null)
    assert.equal(parseSchemaVersion(""), null)
    assert.equal(parseSchemaVersion("abc"), null)
})

test("isSchemaVersionSatisfied accepts equal or higher schema versions", () => {
    assert.equal(isSchemaVersionSatisfied("21", 21), true)
    assert.equal(isSchemaVersionSatisfied("22", 21), true)
    assert.equal(isSchemaVersionSatisfied("20", 21), false)
    assert.equal(isSchemaVersionSatisfied(null, 21), false)
})
