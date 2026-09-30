/**
 * 源码级守卫：**每个会改动本地卡池的入口，都必须在返回前重算前台库存聚合**。
 *
 * 为什么用源码级守卫而不是单测：`index.ts` 是唯一依赖 `@/lib/db/queries` 的
 * 装配层，它没法在 `node --test` 里被加载（`@/` 别名与 drizzle/D1 都拿不到）。
 * 而这里要防的恰恰是「新增一个入口时忘了重算」—— 那种缺陷在运行期极难察觉：
 * 补货明明成功，商品页却一直显示缺货。
 *
 * 子模块（`restock.ts` / `reconcile.ts` / `revoke.ts`）不在此列：它们只做
 * 「卡池与账本」，重算是装配层的职责，也因此它们仍能被 `node --test` 直接加载。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'index.ts'), 'utf8')

/** 取一个顶层函数的源码片段（本文件的顶层函数收尾花括号都在第 0 列）。 */
function functionBody(name: string): string {
    const start = SOURCE.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `index.ts 里找不到函数 ${name}`)
    const end = SOURCE.indexOf('\n}', start)
    assert.ok(end > start, `${name} 的函数体没找到收尾花括号`)
    return SOURCE.slice(start, end)
}

test('聚合回写入口只有一个，且集中在装配层', () => {
    assert.match(SOURCE, /import \{ recalcProductAggregatesForMany \} from '@\/lib\/db\/queries'/)

    // 子模块必须保持「纯端口」，否则它们就不能被 node --test 加载 —— 一旦有人
    // 为了方便把 queries 引进子模块，整条单测链会静默失效。
    // 判据取**导入语句**而不是函数名：注释里提到它是允许的（而且应当被提到）。
    const offenders = readdirSync(HERE)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts')
        .filter((file) => /from '@\/lib\/db\/queries'/.test(readFileSync(join(HERE, file), 'utf8')))
    assert.deepEqual(offenders, [], `只有 index.ts 可以依赖 queries.ts，实际违规：${offenders.join(', ')}`)
})

test('重算本身是「尽力而为」：空列表直接返回，失败只记日志', () => {
    const body = functionBody('recalcStorefrontStock')
    assert.match(body, /if \(!ids\.length\) return/)
    assert.match(body, /try \{[\s\S]*recalcProductAggregatesForMany\(ids\)[\s\S]*\} catch \(error\) \{/)
    assert.match(body, /console\.error\(/)
    // 绝不能把异常再抛出去：补货/退款不该因为一次统计查询失败而回滚。
    assert.doesNotMatch(body, /throw /)
})

test('单张补货：只有真正把卡搬进 cards（restocked）才重算', () => {
    const body = functionBody('restockProductCard')
    assert.match(body, /result\.status === 'restocked'/)
    assert.match(body, /recalcStorefrontStock\(\[productId\]\)/)
})

test('低水位补货与对账：按本轮真正变化的商品重算', () => {
    for (const [name, summaryCall] of [
        ['replenishCardStock', 'replenishLowStockProducts'],
        ['reconcileCardService', 'reconcileCardServiceState'],
    ] as const) {
        const body = functionBody(name)
        assert.match(body, new RegExp(`${summaryCall}\\(`), `${name} 应当调用 ${summaryCall}`)
        assert.match(body, /await recalcStorefrontStock\(summary\.changedProductIds\)/, `${name} 缺少重算`)
    }
})

test('退款作废：凭据齐全与缺失两条路径都要重算（两条路径都会动本地卡）', () => {
    const body = functionBody('executeOrderRevokePlan')
    assert.match(body, /failRevokesWithoutClient\(/)
    assert.match(body, /await recalcStockForRevokedCards\(database, input\.orderId, input\.cards\)/)
    // 重算必须在两个分支之后，而不是只在成功分支里。
    assert.ok(
        body.indexOf('recalcStockForRevokedCards') > body.indexOf('failRevokesWithoutClient'),
        '重算要覆盖缺凭据分支，不能只放在成功分支',
    )
})

test('作废重放：按受影响订单反查商品再重算', () => {
    const body = functionBody('replayPendingCardServiceRevokes')
    assert.match(body, /outcome\.orderIds/)
    assert.match(body, /resolveAffectedProductIds\(deps\.database, \{ orderId \}\)/)
    assert.match(body, /await recalcStorefrontStock\(Array\.from\(productIds\)\)/)
})

test('反查用的是「多来源并集」，且不会因为缺表/缺列而中断', () => {
    const helper = functionBody('recalcStockForRevokedCards')
    assert.match(helper, /resolveAffectedProductIds\(database, \{/)
    assert.match(helper, /localCardIds: cards\.map/)
    assert.match(helper, /remoteCardIds: cards\.map/)

    const source = readFileSync(join(HERE, 'affected-products.ts'), 'utf8')
    // 三路来源都要在：台账 / 本地卡 / 订单。
    assert.match(source, /CARD_SERVICE_CARDS_TABLE/)
    assert.match(source, /FROM cards WHERE id IN/)
    assert.match(source, /FROM orders WHERE order_id = \?/)
    assert.match(source, /isMissingTableError/)
})
