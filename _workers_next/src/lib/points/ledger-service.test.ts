import test from "node:test"
import assert from "node:assert/strict"

import {
    applyAdminPointAdjustment,
    applyAutomaticPointEvent,
    type PointLedgerRecord,
    type PointLedgerRepository,
} from "./ledger-service.ts"

const input = {
    userId: "user-1",
    eventType: "order_deduction" as const,
    delta: -10,
    businessKey: "order_deduction:ORD1",
    sourceType: "order",
    sourceId: "ORD1",
    reason: "test",
}

function record(status: "pending" | "completed", claimId: string | null = null): PointLedgerRecord {
    return {
        id: 1,
        userId: input.userId,
        eventType: input.eventType,
        delta: input.delta,
        businessKey: input.businessKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reason: input.reason,
        operatorUserId: null,
        operatorUsername: null,
        metadata: null,
        balanceAfter: status === "completed" ? 90 : null,
        status,
        claimId,
        claimedAt: claimId ? new Date() : null,
        createdAt: new Date(),
    }
}

function repo(overrides: Partial<PointLedgerRepository> = {}): PointLedgerRepository {
    return {
        async getCurrentBalance() { return 100 },
        async findByBusinessKey() { return null },
        async claimAutomaticEvent() {
            return { claimed: true, claimId: "claim-1", record: record("pending", "claim-1") }
        },
        async finalizeAutomaticEvent() { return record("completed") },
        async rollbackAutomaticEvent() {},
        async claimManualAdjustment() {
            return { claimed: true, claimId: "claim-1", record: record("pending", "claim-1") }
        },
        ...overrides,
    }
}

test("completed automatic point event is idempotent", async () => {
    let claimed = false
    const existing = record("completed")
    const result = await applyAutomaticPointEvent(repo({
        async findByBusinessKey() { return existing },
        async claimAutomaticEvent() {
            claimed = true
            return { claimed: false, claimId: null, record: existing }
        },
    }), input)

    assert.equal(result, existing)
    assert.equal(claimed, false)
})

test("fresh pending event is not treated as completed", async () => {
    await assert.rejects(
        applyAutomaticPointEvent(repo({
            async findByBusinessKey() { return record("pending", "other-claim") },
            async claimAutomaticEvent() {
                return { claimed: false, claimId: null, record: record("pending", "other-claim") }
            },
        }), input),
        /POINT_LEDGER_EVENT_IN_PROGRESS/,
    )
})

test("claimed pending event finalizes with its claim token", async () => {
    let finalizedWith: [number, string] | null = null
    const result = await applyAutomaticPointEvent(repo({
        async findByBusinessKey() { return record("pending") },
        async finalizeAutomaticEvent(id, claimId) {
            finalizedWith = [id, claimId]
            return record("completed")
        },
    }), input)

    assert.deepEqual(finalizedWith, [1, "claim-1"])
    assert.equal(result.status, "completed")
})

test("failed finalization releases only the owned claim", async () => {
    let rolledBackWith: [number, string] | null = null
    await assert.rejects(
        applyAutomaticPointEvent(repo({
            async finalizeAutomaticEvent() { throw new Error("POINT_BALANCE_NEGATIVE") },
            async rollbackAutomaticEvent(id, claimId) { rolledBackWith = [id, claimId] },
        }), input),
        /POINT_BALANCE_NEGATIVE/,
    )

    assert.deepEqual(rolledBackWith, [1, "claim-1"])
})

test("same business key with a different payload is rejected", async () => {
    await assert.rejects(
        applyAutomaticPointEvent(repo({
            async findByBusinessKey() { return record("completed") },
        }), { ...input, delta: -20 }),
        /POINT_LEDGER_BUSINESS_KEY_CONFLICT/,
    )
})

test("manual adjustment uses the same claimed atomic finalization path", async () => {
    let finalizedWith: [number, string] | null = null
    const manualRecord = { ...record("pending", "manual-claim"), eventType: "admin_adjust" as const, delta: 5, sourceType: "admin" }
    const result = await applyAdminPointAdjustment(repo({
        async claimManualAdjustment() {
            return { claimed: true, claimId: "manual-claim", record: manualRecord }
        },
        async finalizeAutomaticEvent(id, claimId) {
            finalizedWith = [id, claimId]
            return { ...manualRecord, status: "completed", claimId: null, claimedAt: null, balanceAfter: 105 }
        },
    }), {
        userId: "user-1",
        direction: "increase",
        amount: 5,
        reason: "manual test",
        operatorUserId: "admin-1",
        operatorUsername: "admin",
        businessKey: "admin_adjust:1",
    })

    assert.deepEqual(finalizedWith, [1, "manual-claim"])
    assert.equal(result.balanceAfter, 105)
})
