/**
 * 原子计数式限流（Cloudflare D1 实现）。
 *
 * 背景:
 *   站内所有写入口此前**没有任何限流** —— `createOrder`、`createPaymentOrder`、
 *   `submitReview` 都可以被无限次调用。攻击者（或单纯的脚本误用）可以：
 *     ① 刷出大量 pending 订单，占满卡密预留（`cards.reserved_at`）把库存锁死；
 *     ② 反复写 `orders` 放大 D1 写次数账单；
 *     ③ 反复触发 `recalcProductAggregates` 制造写热点。
 *
 * 为什么不用内存计数器:
 *   Workers isolate 会被随时回收、且全球多实例，内存计数器既不准也不共享。
 *   限流必须落在共享存储上。D1 没有事务，所以这里用**单条 UPSERT** 保证原子性：
 *
 *       INSERT ... ON CONFLICT(bucket, subject, window_start)
 *       DO UPDATE SET count = count + 1
 *       RETURNING count
 *
 *   SQLite/D1 对 INSERT..ON CONFLICT 的冲突处理与 RETURNING 是同一条语句，
 *   因此并发调用不会丢计数，也不会出现 check-then-write 的竞态。
 *
 * 固定窗口（fixed window）而非滑动窗口:
 *   固定窗口只需要一行一列（`window_start` 是主键的一部分），写入量恒定；
 *   滑动窗口要么存每一条请求，要么存分桶计数，在 D1 上都不划算。
 *   固定窗口的边界突刺（窗口切换瞬间最多 2 倍）对本站业务量完全可以接受。
 *
 * 安全约定（重要）:
 *   - 限流是**防御性旁路**，任何基础设施异常（D1 抖动、表未建、超时）都必须
 *     **放行（fail-open）**并记警告。绝不能因为限流自身故障而拦住正常下单。
 *   - subject 里绝不放明文 IP：IP 属于个人信息，与审计模块一致，统一走
 *     `hashIdentifier()` 盐化后再入库。
 */

import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import { hashIdentifier } from '@/lib/audit/sanitize'
import { getAuditRequestContext } from '@/lib/audit/request-context'
import {
    RATE_LIMIT_CREATE_INDEX_STATEMENT,
    RATE_LIMIT_CREATE_TABLE_STATEMENT,
    RATE_LIMIT_EXPIRES_INDEX_NAME,
    RATE_LIMIT_TABLE_NAME,
} from '@/lib/db/rate-limit-schema'

export { RATE_LIMIT_EXPIRES_INDEX_NAME, RATE_LIMIT_TABLE_NAME }

export interface RateLimitRule {
    /** 计数窗口长度（毫秒） */
    windowMs: number
    /** 单个窗口内允许的最大次数 */
    max: number
}

/**
 * 各写入口的限流规则。
 *
 * 阈值取「正常用户绝不会触发、脚本一定会触发」的量级：
 *   - 下单/收款：1 分钟 10 次。真人手点不可能达到，脚本刷单立刻被挡。
 *   - 评价：10 分钟 5 次。评价必须基于已交付订单，正常用户一次就够。
 */
export const RATE_LIMIT_RULES = {
    'order:create': { windowMs: 60_000, max: 10 },
    'payment:create': { windowMs: 60_000, max: 10 },
    'review:submit': { windowMs: 10 * 60_000, max: 5 },
} as const satisfies Record<string, RateLimitRule>

export type RateLimitBucket = keyof typeof RATE_LIMIT_RULES

export interface RateLimitOutcome {
    /** false 表示已超限，调用方必须拒绝本次请求 */
    allowed: boolean
    /** 本窗口剩余可用次数（仅用于日志与提示，不作为判断依据） */
    remaining: number
    /** 被限流时建议的重试秒数 */
    retryAfterSeconds: number
}

/** 计数器行在窗口结束后仍保留一小段时间，避免窗口边界处误判 */
const COUNTER_RETENTION_MS = 5 * 60 * 1000

/** 结构就绪标记（isolate 级）。与 preview/reviewReplies 的 ensure 同构。 */
const rateLimitEnsureState = { ready: false, pending: null as Promise<void> | null }

/** 由 resetSchemaReadyFlags 调用：漂移修复时必须让 ensure 重新执行。 */
export function resetRateLimitSchemaReady() {
    rateLimitEnsureState.ready = false
    rateLimitEnsureState.pending = null
}

/**
 * ensureRateLimitTable 确保计数表与过期索引存在（幂等，每 isolate 一次）。
 *
 * 为什么允许在请求路径上执行 DDL:
 *   注册升级项（0036）负责版本记账与结构修复，但需要管理员在 /admin/database
 *   手动触发。而下单/收款/评价是**正在被攻击的入口**，等管理员操作才生效
 *   等于修复窗口敞开。因此这里用与 `ensureReviewRepliesTable()` 相同的模式，
 *   在首个请求上做一次幂等 `CREATE TABLE IF NOT EXISTS`。
 *   表已存在时该语句是纯 no-op，成本可忽略。
 */
async function ensureRateLimitTable() {
    if (rateLimitEnsureState.ready) return
    if (rateLimitEnsureState.pending) {
        await rateLimitEnsureState.pending
        return
    }

    const pending = (async () => {
        await db.run(sql.raw(RATE_LIMIT_CREATE_TABLE_STATEMENT))
        await db.run(sql.raw(RATE_LIMIT_CREATE_INDEX_STATEMENT))
        rateLimitEnsureState.ready = true
    })()

    rateLimitEnsureState.pending = pending
    try {
        await pending
    } finally {
        rateLimitEnsureState.pending = null
    }
}

/**
 * 按固定窗口对计数行做原子自增，返回自增后的计数。
 *
 * 返回 null 表示数据库没有回传计数（驱动差异），调用方需要回读。
 */
async function incrementCounter(
    bucket: RateLimitBucket,
    subject: string,
    windowStart: number,
    expiresAt: number,
): Promise<number | null> {
    const rows = await db.all(sql`
        INSERT INTO rate_limit_counters (bucket, subject, window_start, count, expires_at)
        VALUES (${bucket}, ${subject}, ${windowStart}, 1, ${expiresAt})
        ON CONFLICT(bucket, subject, window_start)
        DO UPDATE SET count = count + 1
        RETURNING count
    `) as Array<{ count?: number | string }>

    const parsed = Number((rows || [])[0]?.count)
    return Number.isFinite(parsed) ? parsed : null
}

/** 回读当前窗口计数（仅在 UPSERT 未回传 count 时使用） */
async function readCounter(
    bucket: RateLimitBucket,
    subject: string,
    windowStart: number,
): Promise<number> {
    const rows = await db.all(sql`
        SELECT count FROM rate_limit_counters
        WHERE bucket = ${bucket} AND subject = ${subject} AND window_start = ${windowStart}
    `) as Array<{ count?: number | string }>

    const parsed = Number((rows || [])[0]?.count)
    return Number.isFinite(parsed) ? parsed : 0
}

/**
 * resolveRateLimitSubject 计算限流主体键。
 *
 * 顺序:
 *   1. 登录用户 → `u:<userId>`（最准确，且不受 NAT 共享出口 IP 影响）
 *   2. 未登录 → `ip:<sha256 盐化后的 IP>`
 *   3. 都取不到 → `anon`（宁可多挡匿名流量，也不能完全放开）
 */
export async function resolveRateLimitSubject(userId?: string | null): Promise<string> {
    const normalizedUserId = String(userId ?? '').trim()
    if (normalizedUserId) return `u:${normalizedUserId}`

    try {
        const context = await getAuditRequestContext()
        const hashed = hashIdentifier(context.ip)
        if (hashed) return `ip:${hashed}`
    } catch {
        // 取不到请求上下文时退化为 anon，不影响主流程。
    }

    return 'anon'
}

/**
 * pruneExpiredRateLimits 清理已过期窗口的计数行。
 *
 * 计数器表是「只增不减」的，必须定期清理，否则会随窗口数无限增长。
 * 由 consumeRateLimit 以低概率内联触发（按索引删除几行），
 * 避免为清理单独引入 cron 与跨 isolate 协调。
 */
export async function pruneExpiredRateLimits(): Promise<void> {
    try {
        await db.run(sql`DELETE FROM rate_limit_counters WHERE expires_at < ${Date.now()}`)
    } catch {
        // best effort：清理失败不影响限流判定
    }
}

/** 清理的触发概率：约每 100 次限流调用清理一次，均摊开销可忽略。 */
const PRUNE_PROBABILITY = 0.01

/**
 * consumeRateLimit 消耗一次配额。
 *
 * 参数:
 *   - bucket: 规则名（见 RATE_LIMIT_RULES）
 *   - subject: 主体键（建议用 resolveRateLimitSubject 生成）
 */
export async function consumeRateLimit(
    bucket: RateLimitBucket,
    subject: string,
): Promise<RateLimitOutcome> {
    const rule = RATE_LIMIT_RULES[bucket]
    const now = Date.now()
    const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
    const expiresAt = windowStart + rule.windowMs + COUNTER_RETENTION_MS

    let count: number
    try {
        await ensureRateLimitTable()
        count = await incrementCounter(bucket, subject, windowStart, expiresAt)
            ?? await readCounter(bucket, subject, windowStart)
    } catch (error) {
        // fail-open：限流表缺失或 D1 抖动时放行，只留告警。
        console.warn('[RateLimit] counter update failed, failing open', bucket, error)
        return { allowed: true, remaining: rule.max, retryAfterSeconds: 0 }
    }

    if (Math.random() < PRUNE_PROBABILITY) {
        await pruneExpiredRateLimits()
    }

    const allowed = count <= rule.max
    return {
        allowed,
        remaining: Math.max(0, rule.max - count),
        retryAfterSeconds: allowed
            ? 0
            : Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000)),
    }
}

/**
 * enforceRateLimit 解析主体并消耗配额的一步式入口。
 *
 * Server Action 里推荐直接用它，避免忘记传 subject。
 */
export async function enforceRateLimit(
    bucket: RateLimitBucket,
    userId?: string | null,
): Promise<RateLimitOutcome> {
    const subject = await resolveRateLimitSubject(userId)
    return consumeRateLimit(bucket, subject)
}
