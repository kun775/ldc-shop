/**
 * 源码级守卫：**所有会物理删除卡/订单的既有路径都必须先过远端映射守卫**。
 *
 * 这三条路径的实现文件（`actions/admin.ts`、`actions/admin-orders.ts`）都依赖
 * `@/lib/db`，没法在 `node --test` 里加载，所以这里守的是源码契约。
 * 判定逻辑本身由 `guards.test.ts` 用真实 SQLite 覆盖。
 *
 * 要防的缺陷是「漏了一条路径」：批量删卡有守卫、单卡删除没有，等于给管理员
 * 留了一个（看起来更无害的）删除入口，删掉的却是中心那边仍在流通的卡。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relativePath: string) {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

/** 取 `startMarker` 到 `endMarker` 之间的源码（用于把断言限定在某个函数内）。 */
function sliceBetween(text: string, startMarker: string, endMarker: string): string {
    const start = text.indexOf(startMarker)
    assert.ok(start >= 0, `找不到起点：${startMarker}`)
    const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : -1
    assert.ok(!endMarker || end > start, `找不到终点：${endMarker}`)
    return end > start ? text.slice(start, end) : text.slice(start)
}

const ADMIN = source('../../actions/admin.ts')
const ADMIN_ORDERS = source('../../actions/admin-orders.ts')

test('批量删卡：守卫在删除语句之前，且判定失败时宁可少删', () => {
    const region = sliceBetween(ADMIN, 'export async function deleteCards(', 'export async function saveCardsApiConfig(')
    const guardAt = region.indexOf('partitionDeletableLocalCardIds(')
    const deleteAt = region.indexOf('db.delete(cards)')

    assert.ok(guardAt >= 0, 'deleteCards 必须先过分区守卫')
    assert.ok(deleteAt > guardAt, '守卫必须排在删除语句之前')
    assert.match(region, /catch \(error\) \{[\s\S]{0,200}skippedRemoteMapped \+= batch\.length/)
})

test('单条删卡同样过守卫（不能只在批量路径上守）', () => {
    const region = sliceBetween(ADMIN, 'export async function deleteCard(', 'export async function deleteCards(')
    const guardAt = region.indexOf('partitionDeletableLocalCardIds(createD1CardServiceDatabase(), [cardId])')
    const deleteAt = region.indexOf('db.delete(cards)')

    assert.ok(guardAt >= 0, 'deleteCard 缺少远端映射守卫')
    assert.ok(deleteAt > guardAt, '守卫必须排在删除语句之前')
    // 被拦住时要给管理员一个可翻译的原因，而不是静默跳过。
    assert.match(region, /throw new Error\("admin\.cards\.remoteMapped"\)/)
    // 判定失败（查询报错）时同样不许删。
    assert.match(region, /catch \(error\) \{[\s\S]{0,200}protectedByRemoteMapping = true/)
})

test('删除订单：守卫覆盖「远端映射」与「未了结的中心待办」两路', () => {
    const region = sliceBetween(ADMIN_ORDERS, 'async function deleteOneOrder(', 'export async function deleteOrder(')
    const guardAt = region.indexOf('orderHasUnsettledCardServiceLedger(')
    const deleteAt = region.indexOf('db.delete(orders)')

    assert.ok(guardAt >= 0, 'deleteOneOrder 必须用总闸门判定')
    assert.ok(deleteAt > guardAt, '守卫必须排在删除语句之前')
    // 总闸门是「映射 || 待办」，两路都要在 guards.ts 里真实存在。
    const guards = source('./guards.ts')
    assert.match(guards, /export async function orderHasRemoteMappings/)
    assert.match(guards, /export async function orderHasPendingCardServiceOperations/)
    assert.match(guards, /export async function orderHasUnsettledCardServiceLedger/)
    assert.match(guards, /if \(await orderHasRemoteMappings\(database, orderId\)\) return true/)
})

test('新增的拒绝文案在 zh / en 两侧都有（键集合 1:1）', () => {
    const zh = JSON.parse(source('../../locales/zh.json'))
    const en = JSON.parse(source('../../locales/en.json'))
    assert.ok(zh.admin?.cards?.remoteMapped, 'zh 缺少 admin.cards.remoteMapped')
    assert.ok(en.admin?.cards?.remoteMapped, 'en 缺少 admin.cards.remoteMapped')

    const zhKeys = Object.keys(zh.admin.cards).sort()
    const enKeys = Object.keys(en.admin.cards).sort()
    assert.deepEqual(zhKeys, enKeys)
})

test('删除商品：级联删除之前先过「未结清中心台账」守卫', () => {
    // `deleteProduct` 会级联带走本地 `cards` 与 `card_service_cards` 映射行，而
    // 供应配置行**不随商品删除消失** —— 漏了守卫就是「中心那几张卡永远无法作废
    // + 低水位扫描对着不存在的商品持续领卡」。判定逻辑由 guards.test.ts 覆盖，
    // 这里守的是接线：守卫必须在 `db.delete(products)` 之前，且失败时宁可拦下。
    const region = sliceBetween(ADMIN, 'export async function deleteProduct(', 'export async function toggleProductStatus(')
    const guardAt = region.indexOf('productHasUnsettledCardServiceLedger(createD1CardServiceDatabase(), id)')
    const deleteAt = region.indexOf('db.delete(products)')

    assert.ok(guardAt >= 0, 'deleteProduct 缺少中心台账守卫')
    assert.ok(deleteAt > guardAt, '守卫必须排在删除语句之前')
    // 判定失败（数据库异常）时宁可拦下，不能静默放行。
    assert.match(region, /catch \(error\) \{[\s\S]{0,200}hasUnsettledLedger = true/)
    // 被拦住时给管理员一个可翻译的原因，而不是静默跳过。
    assert.match(region, /throw new Error\("admin\.products\.unsettledCardService"\)/)
})

test('商品删除的拒绝文案在 zh / en 两侧都有', () => {
    const zh = JSON.parse(source('../../locales/zh.json'))
    const en = JSON.parse(source('../../locales/en.json'))
    assert.ok(zh.admin?.products?.unsettledCardService, 'zh 缺少 admin.products.unsettledCardService')
    assert.ok(en.admin?.products?.unsettledCardService, 'en 缺少 admin.products.unsettledCardService')

    const zhKeys = Object.keys(zh.admin.products).sort()
    const enKeys = Object.keys(en.admin.products).sort()
    assert.deepEqual(zhKeys, enKeys)
})
