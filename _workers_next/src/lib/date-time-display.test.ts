import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('shared date-time display includes seconds and is the default format', () => {
    const clientDate = source('../components/client-date.tsx')

    assert.match(clientDate, /format = 'dateTime'/)
    assert.match(clientDate, /timeStyle: 'medium'/)
})

test('custom time windows and datetime-local inputs include seconds', () => {
    const couponList = source('../components/admin/coupons/coupon-list-content.tsx')
    const couponInitial = source('./coupons/form-initial.ts')
    const couponForm = source('../components/admin/coupons/coupon-form.tsx')
    const announcementForm = source('../components/admin/announcement-form.tsx')

    assert.match(couponList, /getSeconds\(\)/)
    assert.match(couponInitial, /getSeconds\(\)/)
    assert.match(announcementForm, /getSeconds\(\)/)
    assert.equal((couponForm.match(/step=\{1\}/g) || []).length, 2)
    assert.equal((announcementForm.match(/step=\{1\}/g) || []).length, 2)
})
