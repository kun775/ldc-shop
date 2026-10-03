import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('expired order cleanup runs every minute and includes the exact TTL boundary', () => {
    const wrangler = JSON.parse(source('../../wrangler.json'))
    const queries = source('./db/queries.ts')

    assert.deepEqual(wrangler.triggers?.crons, ['* * * * *'])
    // 边界用 lte（含等于）；截止时间经 selectExpiredCleanupCandidates 透传为 input.deadlineMs。
    assert.match(queries, /lte\(orders\.createdAt, new Date\(input\.deadlineMs\)\)/)
    assert.match(queries, /deadlineMs: fiveMinutesAgoMs/)
    assert.match(queries, /const fiveMinutesAgoMs = Date\.now\(\) - RESERVATION_TTL_MS/)
})
