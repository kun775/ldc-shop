/**
 * 源码级守卫：履约声明（`fulfillment_claim_id` + 10 分钟租约）**必须可回收**。
 *
 * `order-processing.ts` 依赖 `@/lib/db`（drizzle + D1），无法在 `node --test`
 * 里加载，所以这里守的是源码契约。要防的缺陷很隐蔽：把
 * `status === 'processing'` 写成无条件早退，等于给订单加了一个不可逆的终态 ——
 * 一次进程被杀、或响应途中 Worker 被回收，就足以让订单永久停在 `processing`：
 *
 *   - 不会再被认领（本模块的入口全部早退）；
 *   - 不会被 `cancelExpiredOrders` 清理（那只处理 `pending`）；
 *   - 零元订单尤其致命：它不走支付回调，没有另一条重放路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./order-processing.ts', import.meta.url), 'utf8')

/** 取一个顶层函数的源码片段（该文件顶层函数收尾花括号都在第 0 列）。 */
function functionBody(name: string): string {
    const start = SOURCE.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `order-processing.ts 里找不到函数 ${name}`)
    const end = SOURCE.indexOf('\n}', start)
    assert.ok(end > start, `${name} 的函数体没找到收尾花括号`)
    return SOURCE.slice(start, end)
}

test('零元订单入口不会把 processing 当成不可逆终态', () => {
    const body = functionBody('completePaidOrderDelivery')

    // 曾经的反模式：processing 与 pending 一起无条件早退。
    assert.doesNotMatch(
        body,
        /FULFILLMENT_CLAIM_STATUS \|\| existing\.status === "pending"/,
        'processing 不能与 pending 合并成无条件早退',
    )
    assert.match(body, /if \(existing\.status === "pending"\)/)
    assert.match(body, /if \(existing\.status === FULFILLMENT_CLAIM_STATUS\)/)
})

test('过期声明可以重新认领：早退之前必须比较租约，过期后必须放行', () => {
    const body = functionBody('completePaidOrderDelivery')

    assert.match(body, /existing\.fulfillmentClaimedAt/)
    assert.match(body, /FULFILLMENT_CLAIM_TTL_MS/)
    assert.match(body, /if \(leaseUntilMs > Date\.now\(\)\)/)

    const leaseCheck = body.indexOf('leaseUntilMs > Date.now()')
    const finalGate = body.indexOf('existing.cardKey || (existing.status !== "paid"')
    assert.ok(leaseCheck >= 0, '租约比较必须存在')
    assert.ok(finalGate >= 0, '最终闸门必须存在')
    // 比较必须出现在最终闸门之前：晚于闸门就永远走不到。
    assert.ok(leaseCheck < finalGate, '租约比较必须排在最终闸门之前')

    // ⚠️ 仅仅「比较了租约」不够：过期之后必须**真的往下走**。
    // 曾经这里漏了一手 —— 租约过期后继续执行，却又被下面的
    // `existing.status !== "paid"` 挡回去，认领次数恒为 0（零元订单永久卡住）。
    assert.match(body, /let reclaimableStaleClaim = false/)
    assert.match(body, /reclaimableStaleClaim = true/)
    assert.match(body, /!reclaimableStaleClaim/, '最终闸门必须放行租约已过期的声明')
})

test('原子认领条件与租约口径一致：容忍「声明为空」或「已过期」', () => {
    const body = functionBody('completePaidOrderDelivery')
    assert.match(body, /isNull\(orders\.fulfillmentClaimedAt\), lt\(orders\.fulfillmentClaimedAt, staleBefore\)/)
    assert.match(body, /const staleBefore = new Date\(now\.getTime\(\) - FULFILLMENT_CLAIM_TTL_MS\)/)
})

test('交付失败仍然回落到 paid（不是 pending），否则会被过期取消误杀', () => {
    const body = functionBody('completePaidOrderDelivery')
    assert.match(body, /restoreClaimAfterFailure\(existing, claimId, \{ paidAt:/)
    assert.match(body, /return \{ orderStatus: "paid", delivered: false/)

    // 回落的落点必须是 `paid`：`restoreClaimAfterFailure` 只在传入 asPaid 时才这么写。
    const restore = functionBody('restoreClaimAfterFailure')
    assert.match(restore, /status: asPaid \? "paid" : \(order\.status \|\| "pending"\)/)
})
