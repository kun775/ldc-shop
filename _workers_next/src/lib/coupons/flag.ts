import { getSetting } from '@/lib/db/queries'

export const COUPONS_ENABLED_SETTING_KEY = 'coupons_enabled'

// isCouponsEnabled 读取优惠券功能开关
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增默认关闭的功能开关，作为优惠券上线的软回滚手段。
export async function isCouponsEnabled(): Promise<boolean> {
    try {
        const value = await getSetting(COUPONS_ENABLED_SETTING_KEY)
        return String(value || '').toLowerCase() === 'true'
    } catch {
        return false
    }
}

export async function getCouponFeatureState(): Promise<{ enabled: boolean }> {
    return { enabled: await isCouponsEnabled() }
}
