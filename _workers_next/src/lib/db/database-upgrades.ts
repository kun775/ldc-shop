import { sql } from 'drizzle-orm'
import { db } from './index'
import { isDuplicateColumnError } from './error-utils'
import { createAsyncOnceState, ensureOnce } from '@/lib/runtime/async-once'
import { logServerError } from '@/lib/errors/safe-error'
import {
    buildDatabaseUpgradeStatus,
    DATABASE_UPGRADE_DEFINITIONS,
    DATABASE_UPGRADE_RUNNING_TIMEOUT_MS,
    type DatabaseUpgradeId,
    type DatabaseUpgradeRecord,
    type DatabaseUpgradeStatus,
} from './database-upgrade-registry'

type DatabaseUpgradeExecutors = Record<DatabaseUpgradeId, () => Promise<void>>
const migrationsTableState = createAsyncOnceState()

export interface DatabaseUpgradeRunResult {
    appliedIds: DatabaseUpgradeId[]
    skippedIds: DatabaseUpgradeId[]
    failed: { id: DatabaseUpgradeId; errorId: string } | null
}

function rowsFromResult<T>(result: unknown): T[] {
    const value = result as { results?: T[]; rows?: T[] }
    return value?.results || value?.rows || []
}

async function addMigrationColumn(column: string, definition: string) {
    try {
        await db.run(sql.raw(`ALTER TABLE database_migrations ADD COLUMN ${column} ${definition}`))
    } catch (error: unknown) {
        if (isDuplicateColumnError(error)) return
        throw error
    }
}

export async function ensureDatabaseMigrationsTable() {
    await ensureOnce(migrationsTableState, async () => {
        await db.run(sql`
        CREATE TABLE IF NOT EXISTS database_migrations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'running',
            claim_id TEXT,
            started_at INTEGER,
            executed_at INTEGER,
            duration_ms INTEGER,
            error_id TEXT,
            error_message TEXT,
            updated_at INTEGER DEFAULT (unixepoch() * 1000)
        )
        `)

        const columns: Array<[string, string]> = [
        ['name', "TEXT NOT NULL DEFAULT ''"],
        ['description', 'TEXT'],
        ['status', "TEXT NOT NULL DEFAULT 'running'"],
        ['claim_id', 'TEXT'],
        ['started_at', 'INTEGER'],
        ['executed_at', 'INTEGER'],
        ['duration_ms', 'INTEGER'],
        ['error_id', 'TEXT'],
        ['error_message', 'TEXT'],
        ['updated_at', 'INTEGER'],
        ]

        const columnResult = await db.run(sql`PRAGMA table_info(database_migrations)`)
        const existingColumns = new Set(
            rowsFromResult<{ name?: unknown }>(columnResult).map((row) => String(row.name || '')),
        )
        for (const [column, definition] of columns) {
            if (!existingColumns.has(column)) {
                await addMigrationColumn(column, definition)
            }
        }

        await db.run(sql`
        CREATE INDEX IF NOT EXISTS database_migrations_status_idx
        ON database_migrations (status, updated_at DESC)
        `)
    })
}

export async function readDatabaseUpgradeRecords(): Promise<DatabaseUpgradeRecord[]> {
    await ensureDatabaseMigrationsTable()
    const result = await db.run(sql`
        SELECT
            id,
            name,
            description,
            status,
            claim_id AS claimId,
            started_at AS startedAt,
            executed_at AS executedAt,
            duration_ms AS durationMs,
            error_id AS errorId,
            error_message AS errorMessage,
            updated_at AS updatedAt
        FROM database_migrations
        ORDER BY id ASC
    `)
    return rowsFromResult<DatabaseUpgradeRecord>(result)
}

export async function readDatabaseUpgradeStatus(structureHealthy: boolean): Promise<DatabaseUpgradeStatus> {
    return buildDatabaseUpgradeStatus(
        await readDatabaseUpgradeRecords(),
        structureHealthy,
    )
}

function createClaimId() {
    return `migration_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

async function claimDatabaseUpgrade(id: DatabaseUpgradeId, repairRequired: boolean): Promise<string | null> {
    const definition = DATABASE_UPGRADE_DEFINITIONS.find((item) => item.id === id)
    if (!definition) return null

    const now = Date.now()
    const staleBefore = now - DATABASE_UPGRADE_RUNNING_TIMEOUT_MS
    const claimId = createClaimId()

    await db.run(sql`
        INSERT INTO database_migrations (
            id, name, description, status, claim_id, started_at, executed_at,
            duration_ms, error_id, error_message, updated_at
        ) VALUES (
            ${definition.id}, ${definition.name}, ${definition.description}, 'running', ${claimId}, ${now}, NULL,
            NULL, NULL, NULL, ${now}
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            status = 'running',
            claim_id = excluded.claim_id,
            started_at = excluded.started_at,
            executed_at = NULL,
            duration_ms = NULL,
            error_id = NULL,
            error_message = NULL,
            updated_at = excluded.updated_at
        WHERE
            (database_migrations.status <> 'running'
                OR database_migrations.started_at IS NULL
                OR database_migrations.started_at < ${staleBefore})
            AND (database_migrations.status <> 'applied' OR ${repairRequired ? 1 : 0} = 1)
    `)

    const result = await db.run(sql`
        SELECT claim_id AS claimId
        FROM database_migrations
        WHERE id = ${id}
        LIMIT 1
    `)
    const row = rowsFromResult<{ claimId?: string | null }>(result)[0]
    return row?.claimId === claimId ? claimId : null
}

async function markDatabaseUpgradeApplied(id: DatabaseUpgradeId, claimId: string, startedAt: number) {
    const now = Date.now()
    await db.run(sql`
        UPDATE database_migrations
        SET
            status = 'applied',
            executed_at = ${now},
            duration_ms = ${Math.max(0, now - startedAt)},
            error_id = NULL,
            error_message = NULL,
            updated_at = ${now}
        WHERE id = ${id} AND claim_id = ${claimId}
    `)
}

async function markDatabaseUpgradeFailed(
    id: DatabaseUpgradeId,
    claimId: string,
    startedAt: number,
    errorId: string,
) {
    const now = Date.now()
    await db.run(sql`
        UPDATE database_migrations
        SET
            status = 'failed',
            duration_ms = ${Math.max(0, now - startedAt)},
            error_id = ${errorId},
            error_message = '数据库升级执行失败，请根据错误 ID 查看 Worker 日志。',
            updated_at = ${now}
        WHERE id = ${id} AND claim_id = ${claimId}
    `)
}

export async function executeDatabaseUpgrades(input: {
    executors: DatabaseUpgradeExecutors
    verifyStructure: () => Promise<boolean>
}): Promise<DatabaseUpgradeRunResult> {
    await ensureDatabaseMigrationsTable()

    const initialStatus = await readDatabaseUpgradeStatus(await input.verifyStructure())
    const result: DatabaseUpgradeRunResult = {
        appliedIds: [],
        skippedIds: [],
        failed: null,
    }

    for (const item of initialStatus.items) {
        if (item.status === 'applied' || item.status === 'running') {
            result.skippedIds.push(item.id)
            continue
        }

        const claimId = await claimDatabaseUpgrade(item.id, item.repairRequired)
        if (!claimId) {
            result.skippedIds.push(item.id)
            continue
        }

        const startedAt = Date.now()
        try {
            await input.executors[item.id]()
            const definition = DATABASE_UPGRADE_DEFINITIONS.find((entry) => entry.id === item.id)
            if (definition?.verifiesStructure && !(await input.verifyStructure())) {
                throw new Error('DATABASE_SCHEMA_VERIFY_FAILED')
            }
            await markDatabaseUpgradeApplied(item.id, claimId, startedAt)
            result.appliedIds.push(item.id)
        } catch (error: unknown) {
            const errorId = logServerError(`database.upgrade.${item.id}`, error)
            try {
                await markDatabaseUpgradeFailed(item.id, claimId, startedAt, errorId)
            } catch (recordError: unknown) {
                console.error(`[database.upgrade.${item.id}] failed to persist failure state`, recordError)
            }
            result.failed = { id: item.id, errorId }
            break
        }
    }

    return result
}
