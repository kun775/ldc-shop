export const DATABASE_UPGRADE_RUNNING_TIMEOUT_MS = 5 * 60 * 1000

export const DATABASE_UPGRADE_DEFINITIONS = [
    {
        id: '0028_database_upgrade_registry',
        name: '数据库升级管理与结构自检',
        description: '补齐当前版本所需的表、字段、索引和触发器，并启用可追踪的自动升级记录。',
        verifiesStructure: true,
    },
] as const

export type DatabaseUpgradeId = (typeof DATABASE_UPGRADE_DEFINITIONS)[number]['id']
export type DatabaseUpgradeState = 'pending' | 'running' | 'applied' | 'failed'

export interface DatabaseUpgradeRecord {
    id: string
    name: string
    description: string | null
    status: DatabaseUpgradeState
    claimId: string | null
    startedAt: number | null
    executedAt: number | null
    durationMs: number | null
    errorId: string | null
    errorMessage: string | null
    updatedAt: number | null
}

export interface DatabaseUpgradeItem {
    id: DatabaseUpgradeId
    name: string
    description: string
    status: DatabaseUpgradeState
    repairRequired: boolean
    startedAt: number | null
    executedAt: number | null
    durationMs: number | null
    errorId: string | null
    errorMessage: string | null
}

export interface DatabaseUpgradeStatus {
    total: number
    applied: number
    pending: number
    running: number
    failed: number
    structureHealthy: boolean
    checkedAt: number
    items: DatabaseUpgradeItem[]
}

export function buildDatabaseUpgradeStatus(
    records: DatabaseUpgradeRecord[],
    structureHealthy: boolean,
    checkedAt: number = Date.now(),
): DatabaseUpgradeStatus {
    const recordsById = new Map(records.map((record) => [record.id, record]))

    const items = DATABASE_UPGRADE_DEFINITIONS.map((definition): DatabaseUpgradeItem => {
        const record = recordsById.get(definition.id)
        const repairRequired = definition.verifiesStructure
            && record?.status === 'applied'
            && !structureHealthy

        let status: DatabaseUpgradeState = record?.status || 'pending'
        let errorMessage = record?.errorMessage || null

        if (repairRequired) {
            status = 'pending'
            errorMessage = '检测到数据库结构不完整，需要重新执行结构修复。'
        } else if (
            status === 'running'
            && record?.startedAt
            && checkedAt - record.startedAt >= DATABASE_UPGRADE_RUNNING_TIMEOUT_MS
        ) {
            status = 'failed'
            errorMessage = '上次升级执行已中断，可以重新执行。'
        }

        return {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            status,
            repairRequired,
            startedAt: record?.startedAt || null,
            executedAt: record?.executedAt || null,
            durationMs: record?.durationMs || null,
            errorId: record?.errorId || null,
            errorMessage,
        }
    })

    const applied = items.filter((item) => item.status === 'applied').length
    const running = items.filter((item) => item.status === 'running').length
    const failed = items.filter((item) => item.status === 'failed').length
    const pending = items.filter((item) => item.status === 'pending' || item.status === 'failed').length

    return {
        total: items.length,
        applied,
        pending,
        running,
        failed,
        structureHealthy,
        checkedAt,
        items,
    }
}
