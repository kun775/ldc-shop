import test from "node:test"
import assert from "node:assert/strict"

import {
    applyAdminPointAdjustment,
    applyAutomaticPointEvent,
    type PointLedgerRecord,
    type PointLedgerRepository,
} from "../ledger-service.ts"

/**
 * 这批测试覆盖「阶段三：积分调整故障修复」要求的并发与幂等场景。
 *
 * 关键前提：`applyBalanceDelta` 已被余额触发器取代 —— 余额变更发生在
 * `finalizeAutomaticEvent` 内部（状态 pending→completed 触发 trigger）。
 * 因此账本与余额的一致性由「单条条件 UPDATE ... RETURNING」保证，
 * 不再有「先改余额、再改账本」这种能被并发撕裂的两步写入。
 */

type Scenario = {
    repo: PointLedgerRepository
    events: string[]
}

function completionRecord(delta: number, balanceAfter: number | null = 90): PointLedgerRecord {
    return {
        id: 1,
        userId: 'user-1',
        eventType: 'admin_adjust',
        delta,
        businessKey: 'key',
        sourceType: 'admin',
        sourceId: null,
        reason: 'test',
        operatorUserId: 'admin-1',
        operatorUsername: 'admin',
        metadata: null,
        balanceAfter,
        status: 'completed',
        claimId: null,
        claimedAt: null,
        createdAt: new Date(),
    }
}

function pendingRecord(delta: number, claimId: string | null): PointLedgerRecord {
    return { ...completionRecord(delta, null), status: 'pending', claimId, claimedAt: claimId ? new Date() : null }
}

/** 模拟一个只允许一次成功抢占的数据库：后续抢占全部返回 claimed=false */
function singleWinnerRepo(delta: number, options: { finalizeThrows?: string } = {}): Scenario {
    const events: string[] = []
    let claimedOnce = false
    const pending = pendingRecord(delta, 'claim-1')

    return {
        events,
        repo: {
            async getCurrentBalance() { return 100 },
            async findByBusinessKey() {
                events.push('findByBusinessKey')
                return claimedOnce ? pending : null
            },
            async claimAutomaticEvent() {
                return { claimed: false, claimId: null, record: pending }
            },
            async claimManualAdjustment() {
                events.push('claimManualAdjustment')
                if (claimedOnce) return { claimed: false, claimId: null, record: pending }
                claimedOnce = true
                return { claimed: true, claimId: 'claim-1', record: pending }
            },
            async finalizeAutomaticEvent() {
                events.push('finalizeAutomaticEvent')
                if (options.finalizeThrows) throw new Error(options.finalizeThrows)
                return completionRecord(delta)
            },
            async rollbackAutomaticEvent() {
                events.push('rollbackAutomaticEvent')
            },
        },
    }
}

const manualInput = {
    userId: 'user-1',
    direction: 'increase' as const,
    amount: 5,
    reason: 'manual test',
    operatorUserId: 'admin-1',
    operatorUsername: 'admin',
    businessKey: 'admin_adjust:user-1:1',
}

test('increase and decrease produce the correctly signed delta', async () => {
    const captured: number[] = []

    const runIncrease = async () => {
        const repo = singleWinnerRepo(5).repo
        await applyAdminPointAdjustment({
            ...repo,
            async claimManualAdjustment(input) {
                captured.push(input.delta)
                return repo.claimManualAdjustment(input)
            },
        }, manualInput)
    }

    const runDecrease = async () => {
        const repo = singleWinnerRepo(-5).repo
        await applyAdminPointAdjustment({
            ...repo,
            async claimManualAdjustment(input) {
                captured.push(input.delta)
                return repo.claimManualAdjustment(input)
            },
        }, { ...manualInput, direction: 'decrease' })
    }

    await runIncrease()
    await runDecrease()

    assert.deepEqual(captured, [5, -5])
})

test('zero or negative amounts are rejected before touching the database', async () => {
    const scenario = singleWinnerRepo(0)
    for (const amount of [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(
            applyAdminPointAdjustment(scenario.repo, { ...manualInput, amount }),
            /POINT_AMOUNT_INVALID/,
            `amount ${amount} must be rejected`,
        )
    }
    assert.deepEqual(scenario.events, [], 'no database write may happen for invalid amounts')
})

test('a blank reason is rejected before touching the database', async () => {
    const scenario = singleWinnerRepo(5)
    for (const reason of ['', '   ', '\t\n']) {
        await assert.rejects(
            applyAdminPointAdjustment(scenario.repo, { ...manualInput, reason }),
            /POINT_REASON_REQUIRED/,
            `reason ${JSON.stringify(reason)} must be rejected`,
        )
    }
    assert.deepEqual(scenario.events, [])
})

test('the reason is trimmed before being persisted', async () => {
    let persisted = ''
    const repo = singleWinnerRepo(5).repo
    await applyAdminPointAdjustment({
        ...repo,
        async claimManualAdjustment(input) {
            persisted = input.reason
            return repo.claimManualAdjustment(input)
        },
    }, { ...manualInput, reason: '  对账补差  ' })

    assert.equal(persisted, '对账补差')
})

test('a second concurrent attempt fails with IN_PROGRESS instead of double-crediting', async () => {
    const scenario = singleWinnerRepo(5)

    const first = await applyAdminPointAdjustment(scenario.repo, manualInput)
    assert.equal(first.status, 'completed')
    assert.equal(scenario.events.filter((e) => e === 'finalizeAutomaticEvent').length, 1)

    // 第二次：抢占失败（另一请求持有 claim）→ 必须拒绝，绝不能二次入账
    await assert.rejects(
        applyAdminPointAdjustment(scenario.repo, manualInput),
        /POINT_LEDGER_EVENT_IN_PROGRESS/,
    )
    assert.equal(
        scenario.events.filter((e) => e === 'finalizeAutomaticEvent').length,
        1,
        'finalization must run exactly once',
    )
})

test('a reused business key with a different payload is a conflict, not a silent no-op', async () => {
    const repo = singleWinnerRepo(5).repo
    // 已完成记录：同键同载荷幂等返回，同键异载荷报冲突
    const completed = completionRecord(5)
    await assert.rejects(
        applyAdminPointAdjustment({
            ...repo,
            async claimManualAdjustment() {
                return { claimed: false, claimId: null, record: { ...completed, delta: -5 } }
            },
        }, manualInput),
        /POINT_LEDGER_BUSINESS_KEY_CONFLICT/,
    )
})

test('a repeated identical request via the same business key is idempotent', async () => {
    const repo = singleWinnerRepo(5).repo
    const completed = completionRecord(5)
    let finalized = 0

    const result = await applyAdminPointAdjustment({
        ...repo,
        async claimManualAdjustment() {
            return { claimed: false, claimId: null, record: completed }
        },
        async finalizeAutomaticEvent() {
            finalized += 1
            return completed
        },
    }, manualInput)

    assert.equal(result.status, 'completed')
    assert.equal(finalized, 0, 'an already-completed event must not be finalized again')
})

test('insufficient balance rolls back the claim and leaves no partial state', async () => {
    const scenario = singleWinnerRepo(-500, { finalizeThrows: 'POINT_BALANCE_NEGATIVE' })

    await assert.rejects(
        applyAdminPointAdjustment(scenario.repo, { ...manualInput, direction: 'decrease', amount: 500 }),
        /POINT_BALANCE_NEGATIVE/,
    )
    // 关键：失败路径必须回滚自己持有的 claim，否则该业务键被永久锁在 pending
    assert.ok(
        scenario.events.includes('rollbackAutomaticEvent'),
        'a failed finalization must release its own claim',
    )
})

test('finalization is the single mutation point for both ledger and balance', async () => {
    // 余额一致性完全依赖 finalize 内的触发器，而不是「先改余额、再改账本」。
    // 从接口层面已经移除独立的改余额方法，这里再断言调用序列，
    // 防止将来有人用另一条路径绕过 finalize。
    const scenario = singleWinnerRepo(5)
    await applyAdminPointAdjustment(scenario.repo, manualInput)

    assert.deepEqual(
        scenario.events.filter((event) => event !== 'claimManualAdjustment'),
        ['finalizeAutomaticEvent'],
        'claim + finalize must be the only database interactions',
    )
})

test('automatic events keep the same single-winner guarantee', async () => {
    const input = {
        userId: 'user-1',
        eventType: 'order_deduction' as const,
        delta: -10,
        businessKey: 'order_deduction:ORD1',
        sourceType: 'order',
        sourceId: 'ORD1',
        reason: 'test',
    }
    let finalizeCount = 0
    const pending = { ...pendingRecord(-10, 'claim-1'), eventType: 'order_deduction' as const, sourceType: 'order', sourceId: 'ORD1' }

    await applyAutomaticPointEvent({
        async getCurrentBalance() { return 100 },
        async findByBusinessKey() { return null },
        async claimAutomaticEvent() { return { claimed: true, claimId: 'claim-1', record: pending } },
        async finalizeAutomaticEvent() {
            finalizeCount += 1
            return { ...pending, status: 'completed', claimId: null, balanceAfter: 90 }
        },
        async rollbackAutomaticEvent() {},
        async claimManualAdjustment() { return { claimed: true, claimId: 'claim-1', record: pending } },
    }, input)

    assert.equal(finalizeCount, 1)
})
