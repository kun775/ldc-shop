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
    assert.match(queries, /lte\(orders\.createdAt, new Date\(fiveMinutesAgoMs\)\)/)
})
