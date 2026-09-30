/**
 * 源码级守卫：**已接入卡密中心的商品不得再走旧的单次 GET 补货入口**。
 *
 * `card-api.ts` 依赖 `@/lib/db`，没法在 `node --test` 里加载，所以这里守的是
 * 源码契约（分流闸门的位置与判定口径），`pullOneCardFromApi` 的行为无法在单元
 * 测试里直接跑。
 *
 * 要防的缺陷很具体：只拦住「切离」那一刻不够 —— 旧配置（`cards_api_*`）与
 * 供应配置（`supply_mode`）是两套独立数据，管理员接入中心后旧入口仍可能被
 * Cron / 手工触发。旧入口取到的卡**没有任何远端映射**，中心那边永远显示
 * 「未售出」；它混进同一商品的库存后，多卡订单还会因 `mixed_inventory` 阻断
 * 交付。所以分流必须在**这条路径的最前面**，不能等到读完旧配置再判断。
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

const CARD_API = source('../card-api.ts')

test('pullOneCardFromApi 在读取旧 GET 配置之前就做完供应模式分流', () => {
    // `pullOneCardFromApi` 是文件里最后一个函数，故一直取到文件末尾。
    const region = sliceBetween(CARD_API, 'export async function pullOneCardFromApi(', '')
    const gateAt = region.indexOf('evaluateLegacyGetGate(productId)')
    const legacyConfigAt = region.indexOf('getProductCardApiConfig(productId)')

    assert.ok(gateAt >= 0, 'pullOneCardFromApi 缺少供应模式分流')
    assert.ok(legacyConfigAt >= 0, '找不到旧的取卡配置读取点，断言前提失效')
    assert.ok(gateAt < legacyConfigAt, '分流必须排在读取旧配置之前，否则仍会继续走旧入口')
    // `skip` 不是故障：明确的 skipped，调用方据此不再重试、只记 info。
    assert.match(region, /if \(gate\.kind === 'skip'\) return \{ ok: false, skipped: true, error: gate\.error \}/)
    // ⚠️ 读取异常必须**停下来报错**，绝不能兜底成「允许」——
    // 供应模式未知时取回来的卡没有任何远端映射，会造成混合库存。
    assert.match(region, /if \(gate\.kind === 'error'\) return \{ ok: false, error: gate\.error \}/)
})

test('分流闸门：未配置放行（历史兼容）、显式 legacy_get 放行、local 与 license_service 拒绝', () => {
    const region = sliceBetween(CARD_API, 'async function evaluateLegacyGetGate(', 'export async function pullOneCardFromApi(')

    // 配置项读的是唯一的受控来源，不能另起一套判断。
    assert.match(region, /loadCardServiceProductConfig\(createD1CardServiceDatabase\(\), productId\)/)
    // 没有配置行 → 历史兼容，允许旧入口（既有商品行为不变）。
    assert.match(region, /if \(!configured\) return \{ kind: 'allow' \}/)
    // 显式 local 模式不得联网取卡（「只用本地库存」的契约）。
    assert.match(region, /if \(supplyMode === 'local'\) return \{ kind: 'skip', error: 'api_local_supply_mode' \}/)
    assert.match(region, /if \(supplyMode === 'license_service'\) return \{ kind: 'skip', error: 'api_card_service_supplied' \}/)
    // 走到最后 = 显式 legacy_get。
    assert.match(region, /return \{ kind: 'allow' \}/)
    // ⚠️ 读取异常必须转成 error 停手，**不能** `return { kind: 'allow' }`。
    const catchBlock = region.slice(region.indexOf('catch (error)'))
    assert.match(catchBlock, /return \{ kind: 'error', error: 'api_supply_config_unreadable' \}/)
    assert.ok(
        !/catch[\s\S]{0,120}kind: 'allow'/.test(region),
        '读取异常不得兜底成放行 —— 那会让供应模式未知的商品继续用旧入口取卡',
    )
})
