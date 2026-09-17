export const DATABASE_UPGRADE_RUNNING_TIMEOUT_MS = 5 * 60 * 1000
export const DATABASE_UPGRADE_BASELINE_SCHEMA_VERSION = 27

export const DATABASE_UPGRADE_DEFINITIONS = [
    {
        id: '0028_database_upgrade_registry',
        name: '数据库升级管理与结构自检',
        description: '补齐当前版本所需的表、字段、索引和触发器，并启用可追踪的管理员手动升级记录。',
        verifiesStructure: true,
    },
    {
        id: '0029_point_ledger_balance_trigger',
        name: '积分账本余额触发器重建',
        description: '重建积分账本余额触发器，补齐余额不足守卫与 NULL 余额处理，并把历史 NULL 余额归零，保证账本与余额始终一致。',
        verifiesStructure: true,
    },
    {
        id: '0030_audit_infrastructure',
        name: '审计基础设施',
        description: '新增 audit_events 与 platform_error_logs 两张审计表及全部查询索引，建立事件记录与错误聚合的持久化基础。',
        verifiesStructure: true,
    },
] as const

export type DatabaseUpgradeId = (typeof DATABASE_UPGRADE_DEFINITIONS)[number]['id']
export type DatabaseUpgradeState = 'pending' | 'running' | 'applied' | 'failed'
export type DatabaseUpgradeHealth = Record<DatabaseUpgradeId, boolean>

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

export function supportsRegisteredDatabaseUpgrades(schemaVersion: number | null): boolean {
    return schemaVersion !== null
        && schemaVersion >= DATABASE_UPGRADE_BASELINE_SCHEMA_VERSION
}

export function buildDatabaseUpgradeStatus(
    records: DatabaseUpgradeRecord[],
    structureHealth: DatabaseUpgradeHealth,
    checkedAt: number = Date.now(),
): DatabaseUpgradeStatus {
    const recordsById = new Map(records.map((record) => [record.id, record]))

    const items = DATABASE_UPGRADE_DEFINITIONS.map((definition): DatabaseUpgradeItem => {
        const record = recordsById.get(definition.id)
        const itemHealthy = structureHealth[definition.id]
        let status: DatabaseUpgradeState = record?.status || 'pending'
        let errorId = record?.errorId || null
        let errorMessage = record?.errorMessage || null
        let repairRequired = false
        const staleRunning = status === 'running'
            && !!record?.startedAt
            && checkedAt - record.startedAt >= DATABASE_UPGRADE_RUNNING_TIMEOUT_MS

        if (status === 'running' && !staleRunning) {
            // 仍在有效声明窗口内，保持 running，避免并发管理员重复执行。
        } else if (itemHealthy) {
            // 真实结构优先于历史记录。兼容升级注册表建立前已完成的结构，
            // 也修复“后续升级漂移导致早期升级被误标失败”的历史状态。
            status = 'applied'
            errorId = null
            errorMessage = null
        } else if (record?.status === 'applied') {
            repairRequired = definition.verifiesStructure
            status = 'pending'
            errorMessage = '检测到数据库结构不完整，需要重新执行结构修复。'
        } else if (staleRunning) {
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
            errorId,
            errorMessage,
        }
    })

    const applied = items.filter((item) => item.status === 'applied').length
    const running = items.filter((item) => item.status === 'running').length
    const failed = items.filter((item) => item.status === 'failed').length
    const pending = items.filter((item) => item.status === 'pending' || item.status === 'failed').length
    const structureHealthy = DATABASE_UPGRADE_DEFINITIONS.every(
        (definition) => structureHealth[definition.id],
    )

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
