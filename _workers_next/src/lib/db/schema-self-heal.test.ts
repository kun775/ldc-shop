import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./schema-self-heal.ts', import.meta.url).href)
const { runWithSchemaSelfHeal, withSchemaSelfHeal } = mod

test('returns the value directly when no error occurs', async () => {
    let repairCalls = 0
    const result = await runWithSchemaSelfHeal({
        run: async () => 42,
        repair: async () => { repairCalls += 1 },
    })
    assert.equal(result.value, 42)
    assert.equal(result.repaired, false)
    assert.equal(repairCalls, 0)
})

test('repairs once and retries when a missing table error occurs', async () => {
    let attempts = 0
    let repairCalls = 0
    const result = await runWithSchemaSelfHeal({
        run: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('no such table: coupons')
            return ['ok']
        },
        repair: async () => { repairCalls += 1 },
    })
    assert.deepEqual(result.value, ['ok'])
    assert.equal(result.repaired, true)
    assert.equal(attempts, 2)
    assert.equal(repairCalls, 1)
})

test('repairs for missing column errors too', async () => {
    let attempts = 0
    const result = await withSchemaSelfHeal({
        run: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('no such column: rate_bps')
            return 'done'
        },
        repair: async () => { /* noop */ },
    })
    assert.equal(result, 'done')
    assert.equal(attempts, 2)
})

test('does not repair transient errors and rethrows them as-is', async () => {
    const transient = new Error('D1_ERROR: database is locked')
    let repairCalls = 0
    await assert.rejects(
        () => runWithSchemaSelfHeal({
            run: async () => { throw transient },
            repair: async () => { repairCalls += 1 },
        }),
        (error: unknown) => error === transient
    )
    assert.equal(repairCalls, 0)
})

test('only repairs once — a second schema error propagates', async () => {
    let attempts = 0
    let repairCalls = 0
    await assert.rejects(
        () => runWithSchemaSelfHeal({
            run: async () => {
                attempts += 1
                throw new Error(`no such table: attempt_${attempts}`)
            },
            repair: async () => { repairCalls += 1 },
        }),
        /no such table: attempt_2/
    )
    assert.equal(attempts, 2)
    assert.equal(repairCalls, 1)
})

test('throws the original schema error when repair itself fails', async () => {
    const original = new Error('no such table: coupon_usages')
    await assert.rejects(
        () => runWithSchemaSelfHeal({
            run: async () => { throw original },
            repair: async () => { throw new Error('repair blew up') },
        }),
        (error: unknown) => error === original
    )
})

test('honours a custom isSchemaError predicate', async () => {
    let repairCalls = 0
    await assert.rejects(
        () => runWithSchemaSelfHeal({
            run: async () => { throw new Error('no such table: x') },
            repair: async () => { repairCalls += 1 },
            isSchemaError: () => false,
        })
    )
    assert.equal(repairCalls, 0)
})
