import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativeUrl: string): string {
    return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('coupon requests never repair database schema in-band', () => {
    const repository = source('./repository.ts')
    assert.doesNotMatch(repository, /ensureCouponTables/)
    assert.doesNotMatch(repository, /withSchemaSelfHeal/)
    assert.doesNotMatch(repository, /schema-self-heal/)
})

test('coupon edit server page only calls server-safe form conversion code', () => {
    const page = source('../../app/admin/coupons/[id]/edit/page.tsx')
    assert.match(page, /import \{ toCouponFormInitial \} from '@\/lib\/coupons\/form-initial'/)
    assert.doesNotMatch(page, /import \{[^}]*toCouponFormInitial[^}]*\} from '@\/components\/admin\/coupons\/coupon-form'/)
})
