import test from 'node:test'
import assert from 'node:assert/strict'
import { getCustomerActivityThresholds } from './customer-activity.ts'

test('customer activity windows use Shanghai calendar days', () => {
    const thresholds = getCustomerActivityThresholds(Date.parse('2026-09-20T10:30:00.000Z'))

    assert.deepEqual(thresholds, {
        todayStartMs: Date.parse('2026-09-19T16:00:00.000Z'),
        last7DaysStartMs: Date.parse('2026-09-13T16:00:00.000Z'),
        last30DaysStartMs: Date.parse('2026-08-21T16:00:00.000Z'),
    })
})

test('customer activity windows reject invalid timestamps', () => {
    assert.throws(() => getCustomerActivityThresholds(Number.NaN), RangeError)
})
