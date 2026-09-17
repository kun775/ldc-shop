import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const serviceSource = readFileSync(new URL('../service.ts', import.meta.url), 'utf8')
const repositorySource = readFileSync(new URL('../repository.ts', import.meta.url), 'utf8')

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start + startMarker.length)
    assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
    assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
    return source.slice(start, end)
}

test('ordinary audit writes never run schema repair DDL', () => {
    const eventWriteSource = sourceBetween(
        serviceSource,
        'export async function writeAuditEvent',
        'export interface PlatformErrorInput',
    )
    const errorWriteSource = sourceBetween(
        serviceSource,
        'export async function writePlatformError',
        'export async function recordFailure',
    )

    for (const source of [eventWriteSource, errorWriteSource]) {
        assert.doesNotMatch(source, /ensureAuditTables\(/)
        assert.doesNotMatch(source, /repairAudit(?:Base|ErrorId)?Structure/)
        assert.doesNotMatch(source, /CREATE\s+(?:TABLE|INDEX)/i)
        assert.doesNotMatch(source, /ALTER\s+TABLE/i)
    }
})

test('audit reads require the current structure without repairing it', () => {
    const eventReadSource = sourceBetween(
        repositorySource,
        'export async function readAuditEvents',
        'export async function readAuditEvent',
    )
    const errorReadSource = sourceBetween(
        repositorySource,
        'export async function readPlatformErrors',
        'export async function readPlatformError',
    )

    for (const source of [eventReadSource, errorReadSource]) {
        assert.match(source, /await assertAuditStructureReady\(\)/)
        assert.doesNotMatch(source, /ensureAuditTables\(/)
        assert.doesNotMatch(source, /repairAudit(?:Base|ErrorId)?Structure/)
    }
})
