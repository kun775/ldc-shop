import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 限流是「防滥用的旁路能力」：它不在任何业务断言里，一旦被重构顺手删掉，
 * 类型检查、单测和构建都会照常通过。因此这里用源码级守卫把关键不变量钉住
 * （与 `security-remediation.test.ts` 同一套做法）。
 *
 * 覆盖三条不变量：
 *   1. 计数必须是单条原子 UPSERT，不能退化成 SELECT + UPDATE 的 check-then-write；
 *   2. 任何基础设施异常都必须 fail-open，绝不能因限流自身故障拦住下单；
 *   3. 三个写入口（下单 / 收款 / 评价）必须真的接上限流。
 */

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

test('rate limit counter increments atomically in a single statement', () => {
    const rateLimit = source('./rate-limit.ts')

    assert.match(rateLimit, /INSERT INTO rate_limit_counters/)
    assert.match(rateLimit, /ON CONFLICT\(bucket, subject, window_start\)/)
    assert.match(rateLimit, /DO UPDATE SET count = count \+ 1/)
    assert.match(rateLimit, /RETURNING count/)
})

test('rate limit fails open when the counter store is unavailable', () => {
    const rateLimit = source('./rate-limit.ts')

    // catch 分支必须放行：allowed 为 true 且剩余额度视为满额。
    assert.match(rateLimit, /fail-open/)
    assert.match(rateLimit, /return \{ allowed: true, remaining: rule\.max, retryAfterSeconds: 0 \}/)
})

test('rate limit subject never stores a plaintext IP', () => {
    const rateLimit = source('./rate-limit.ts')

    assert.match(rateLimit, /hashIdentifier\(context\.ip\)/)
    assert.match(rateLimit, /ip:\$\{hashed\}/)
    // 不允许把 context.ip 直接拼进 subject。
    assert.doesNotMatch(rateLimit, /`ip:\$\{context\.ip\}`/)
})

test('write entry points enforce a rate limit', () => {
    const checkout = source('../actions/checkout.ts')
    const payment = source('../actions/payment.ts')
    const reviews = source('../actions/reviews.ts')

    assert.match(checkout, /enforceRateLimit\('order:create'/)
    assert.match(payment, /enforceRateLimit\('payment:create'/)
    assert.match(reviews, /enforceRateLimit\('review:submit'/)
})

test('rate limit table has its own upgrade item and drift probe', () => {
    const registry = source('./db/database-upgrade-registry.ts')
    const drift = source('./db/schema-drift.ts')
    const queries = source('./db/queries.ts')

    assert.match(registry, /0036_rate_limit_counters/)
    assert.match(drift, /RATE_LIMIT_SCHEMA_DRIFT_PROBES/)
    assert.match(queries, /'0036_rate_limit_counters'/)
    assert.match(queries, /verifyRateLimitStructure/)
})

test('review order id uniqueness is enforced at the database level', () => {
    const queries = source('./db/queries.ts')
    const registry = source('./db/database-upgrade-registry.ts')
    const reviews = source('../actions/reviews.ts')

    assert.match(registry, /0035_review_order_id_unique/)
    assert.match(queries, /CREATE UNIQUE INDEX IF NOT EXISTS reviews_order_id_uq/)
    assert.match(queries, /reviewExistsForOrder/)
    // 并发下唯一索引会先抛错，action 层必须把该错误翻译成「已评价过」。
    assert.match(reviews, /isUniqueConstraintError/)
})

test('outbound notification and mail helpers sanitize thrown errors', () => {
    for (const file of ['./email.ts', './notifications.ts', './epay.ts'] as const) {
        const content = source(file)
        assert.doesNotMatch(content, /error: e\.message/)
        assert.match(content, /sanitizeClientErrorMessage\(/)
    }
})

test('shared card selection avoids an unbounded ORDER BY RANDOM()', () => {
    const checkout = source('../actions/checkout.ts')
    const orderProcessing = source('./order-processing.ts')

    assert.match(checkout, /SHARED_CARD_CANDIDATE_WINDOW/)
    assert.match(orderProcessing, /SHARED_CARD_CANDIDATE_WINDOW/)
    // 两处都不应再直接对整表候选做全量随机排序。
    assert.doesNotMatch(checkout, /\.orderBy\(sql`RANDOM\(\)`\)/)
    assert.doesNotMatch(orderProcessing, /\.orderBy\(sql`RANDOM\(\)`\)/)
})
