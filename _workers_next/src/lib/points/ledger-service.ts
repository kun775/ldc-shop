export type PointLedgerEventType =
    | "checkin_reward"
    | "order_deduction"
    | "refund_return"
    | "admin_adjust"

export interface PointLedgerRecord {
    id: number
    userId: string
    eventType: PointLedgerEventType
    delta: number
    businessKey: string
    sourceType: string
    sourceId: string | null
    reason: string
    operatorUserId: string | null
    operatorUsername: string | null
    metadata: string | null
    balanceAfter: number | null
    status: "pending" | "completed"
    claimId: string | null
    claimedAt: Date | null
    createdAt: Date
}

export interface PointLedgerRepository {
    getCurrentBalance(userId: string): Promise<number>
    findByBusinessKey(businessKey: string): Promise<PointLedgerRecord | null>
    claimAutomaticEvent(input: {
        userId: string
        eventType: PointLedgerEventType
        delta: number
        businessKey: string
        sourceType: string
        sourceId?: string | null
        reason: string
        metadata?: string | null
    }): Promise<{ claimed: boolean; claimId: string | null; record: PointLedgerRecord | null }>
    finalizeAutomaticEvent(
        id: number,
        claimId: string,
    ): Promise<PointLedgerRecord>
    rollbackAutomaticEvent(id: number, claimId: string): Promise<void>
    /**
     * 注意：这里**刻意不提供**独立的「改余额」方法。
     *
     * 余额只在 `finalizeAutomaticEvent` 内由数据库触发器
     * （`user_point_ledger_apply_balance`）随状态迁移原子变更。
     * 历史上存在过一个 `applyBalanceDelta`，它让余额变更成为与账本
     * 分离的第二次写入 —— 一旦中间失败就会出现「账本已完成但余额没变」
     * 或「余额变了但账本未完成」的撕裂状态。移除它是为了从接口层面
     * 消除这种写法。
     */
    claimManualAdjustment(input: {
        userId: string
        delta: number
        businessKey: string
        sourceId?: string | null
        reason: string
        operatorUserId: string | null
        operatorUsername: string | null
        metadata?: string | null
    }): Promise<{ claimed: boolean; claimId: string | null; record: PointLedgerRecord | null }>
}

/**
 * applyAutomaticPointEvent 处理自动积分事件并保证业务键幂等。
 *
 * 参数:
 *   - repo PointLedgerRepository: 账本仓储实现
 *   - input object: 自动积分事件输入
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化自动积分事件统一处理逻辑。
 */
function assertMatchingAutomaticEvent(
    record: PointLedgerRecord,
    input: {
        userId: string
        eventType: PointLedgerEventType
        delta: number
        sourceType: string
        sourceId?: string | null
    },
) {
    if (
        record.userId !== input.userId ||
        record.eventType !== input.eventType ||
        record.delta !== input.delta ||
        record.sourceType !== input.sourceType ||
        record.sourceId !== (input.sourceId ?? null)
    ) {
        throw new Error("POINT_LEDGER_BUSINESS_KEY_CONFLICT")
    }
}

export async function applyAutomaticPointEvent(
    repo: PointLedgerRepository,
    input: {
        userId: string
        eventType: PointLedgerEventType
        delta: number
        businessKey: string
        sourceType: string
        sourceId?: string | null
        reason: string
        metadata?: string | null
    },
) {
    const existing = await repo.findByBusinessKey(input.businessKey)
    if (existing) {
        assertMatchingAutomaticEvent(existing, input)
        if (existing.status === "completed") return existing
    }

    const claimed = await repo.claimAutomaticEvent(input)
    if (!claimed.record) {
        throw new Error("POINT_LEDGER_CLAIM_FAILED")
    }
    assertMatchingAutomaticEvent(claimed.record, input)
    if (claimed.record.status === "completed") {
        return claimed.record
    }
    if (!claimed.claimed || !claimed.claimId) {
        throw new Error("POINT_LEDGER_EVENT_IN_PROGRESS")
    }

    try {
        return await repo.finalizeAutomaticEvent(claimed.record.id, claimed.claimId)
    } catch (error) {
        await repo.rollbackAutomaticEvent(claimed.record.id, claimed.claimId)
        throw error
    }
}

/**
 * applyAdminPointAdjustment 处理后台积分增减并校验原因和余额。
 *
 * 参数:
 *   - repo PointLedgerRepository: 账本仓储实现
 *   - input object: 后台调整输入
 *
 * 元数据:
 *   - 作者: VitaHuang
 *   - 创建时间: 2026-04-18
 *   - 更新时间: 2026-04-18
 *   - 更新内容: 初始化后台积分调整统一处理逻辑。
 */
export async function applyAdminPointAdjustment(
    repo: PointLedgerRepository,
    input: {
        userId: string
        direction: "increase" | "decrease"
        amount: number
        reason: string
        operatorUserId: string | null
        operatorUsername: string | null
        businessKey: string
    },
) {
    const normalizedReason = input.reason.trim()
    if (!normalizedReason) {
        throw new Error("POINT_REASON_REQUIRED")
    }

    if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new Error("POINT_AMOUNT_INVALID")
    }

    const delta = input.direction === "increase" ? input.amount : -input.amount
    const claimed = await repo.claimManualAdjustment({
        userId: input.userId,
        delta,
        businessKey: input.businessKey,
        reason: normalizedReason,
        operatorUserId: input.operatorUserId,
        operatorUsername: input.operatorUsername,
    })
    if (!claimed.record) throw new Error("POINT_LEDGER_CLAIM_FAILED")
    if (claimed.record.userId !== input.userId || claimed.record.delta !== delta || claimed.record.eventType !== "admin_adjust") {
        throw new Error("POINT_LEDGER_BUSINESS_KEY_CONFLICT")
    }
    if (claimed.record.status === "completed") return claimed.record
    if (!claimed.claimed || !claimed.claimId) throw new Error("POINT_LEDGER_EVENT_IN_PROGRESS")

    try {
        return await repo.finalizeAutomaticEvent(claimed.record.id, claimed.claimId)
    } catch (error) {
        await repo.rollbackAutomaticEvent(claimed.record.id, claimed.claimId)
        throw error
    }
}
