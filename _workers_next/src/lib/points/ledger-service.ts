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
    }): Promise<{ claimed: boolean; record: PointLedgerRecord | null }>
    applyBalanceDelta(
        userId: string,
        delta: number,
    ): Promise<{ ok: true; balanceAfter: number } | { ok: false }>
    finalizeAutomaticEvent(
        id: number,
        patch: { balanceAfter: number },
    ): Promise<PointLedgerRecord>
    rollbackAutomaticEvent(id: number): Promise<void>
    insertManualAdjustment(input: {
        userId: string
        delta: number
        businessKey: string
        sourceId?: string | null
        reason: string
        operatorUserId: string | null
        operatorUsername: string | null
        metadata?: string | null
    }): Promise<PointLedgerRecord>
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
        return existing
    }

    const claimed = await repo.claimAutomaticEvent(input)
    if (!claimed.claimed || !claimed.record) {
        if (!claimed.record) {
            throw new Error("POINT_LEDGER_CLAIM_FAILED")
        }
        return claimed.record
    }

    const balanceResult = await repo.applyBalanceDelta(input.userId, input.delta)
    if (!balanceResult.ok) {
        await repo.rollbackAutomaticEvent(claimed.record.id)
        throw new Error("POINT_BALANCE_NEGATIVE")
    }

    return repo.finalizeAutomaticEvent(claimed.record.id, {
        balanceAfter: balanceResult.balanceAfter,
    })
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
    const currentBalance = await repo.getCurrentBalance(input.userId)
    if (currentBalance + delta < 0) {
        throw new Error("POINT_BALANCE_NEGATIVE")
    }

    return repo.insertManualAdjustment({
        userId: input.userId,
        delta,
        businessKey: input.businessKey,
        reason: normalizedReason,
        operatorUserId: input.operatorUserId,
        operatorUsername: input.operatorUsername,
    })
}
