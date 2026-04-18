export interface ProductPointDiscountConfig {
  pointDiscountEnabled: boolean
  pointDiscountPercent: number
}

export interface PointDiscountPreview extends ProductPointDiscountConfig {
  shouldShowPointOption: boolean
  maxDiscountPoints: number
  pointsToUse: number
  finalAmount: number
}

function sanitizeRuntimeProductPointDiscountConfig(input: {
  pointDiscountEnabled: boolean
  pointDiscountPercent: number | string | null | undefined
}): ProductPointDiscountConfig {
  if (!input.pointDiscountEnabled) {
    return {
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    }
  }

  const value = Number(input.pointDiscountPercent)
  if (!Number.isInteger(value) || value <= 0) {
    return {
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    }
  }

  return {
    pointDiscountEnabled: true,
    pointDiscountPercent: Math.min(value, 100),
  }
}

function parseIntegerPercent(raw: number | string | null | undefined) {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === "string" && raw.trim() === "") {
    throw new Error("POINT_DISCOUNT_PERCENT_REQUIRED")
  }

  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new Error("INVALID_POINT_DISCOUNT_PERCENT")
  }
  return value
}

// normalizeProductPointDiscountConfig 归一化商品积分抵扣配置
//
// 参数:
//   - input.pointDiscountEnabled: 是否开启积分抵扣
//   - input.pointDiscountPercent: 抵扣百分比原始值
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-04-18
//   - 更新时间: 2026-04-18
//   - 更新内容: 新增商品积分抵扣配置归一化逻辑。
export function normalizeProductPointDiscountConfig(input: {
  pointDiscountEnabled: boolean
  pointDiscountPercent: number | string | null | undefined
}): ProductPointDiscountConfig {
  if (!input.pointDiscountEnabled) {
    return {
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    }
  }

  const percent = parseIntegerPercent(input.pointDiscountPercent)
  if (percent < 1 || percent > 100) {
    throw new Error("POINT_DISCOUNT_PERCENT_OUT_OF_RANGE")
  }

  return {
    pointDiscountEnabled: true,
    pointDiscountPercent: percent,
  }
}

// calculatePointDiscountPreview 计算商品积分抵扣预览结果
//
// 参数:
//   - input.orderAmount: 订单原始金额
//   - input.availablePoints: 用户当前可用积分
//   - input.usePoints: 用户是否勾选积分抵扣
//   - input.pointDiscountEnabled: 商品是否允许积分抵扣
//   - input.pointDiscountPercent: 商品最多可抵扣百分比
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-04-18
//   - 更新时间: 2026-04-18
//   - 更新内容: 新增前后端共用的积分抵扣金额计算逻辑。
export function calculatePointDiscountPreview(input: {
  orderAmount: number
  availablePoints: number
  usePoints: boolean
  pointDiscountEnabled: boolean
  pointDiscountPercent: number
}): PointDiscountPreview {
  const config = sanitizeRuntimeProductPointDiscountConfig({
    pointDiscountEnabled: input.pointDiscountEnabled,
    pointDiscountPercent: input.pointDiscountPercent,
  })

  const safeAmount = Number.isFinite(input.orderAmount) && input.orderAmount > 0
    ? input.orderAmount
    : 0
  const safePoints = Number.isFinite(input.availablePoints) && input.availablePoints > 0
    ? Math.floor(input.availablePoints)
    : 0
  const maxDiscountPoints = config.pointDiscountEnabled
    ? Math.max(0, Math.floor((safeAmount * config.pointDiscountPercent) / 100))
    : 0
  const shouldShowPointOption = config.pointDiscountEnabled && safePoints > 0 && maxDiscountPoints > 0
  const pointsToUse = shouldShowPointOption && input.usePoints
    ? Math.min(safePoints, maxDiscountPoints)
    : 0
  const finalAmount = Math.max(0, safeAmount - pointsToUse)

  return {
    ...config,
    shouldShowPointOption,
    maxDiscountPoints,
    pointsToUse,
    finalAmount,
  }
}

// resolveCheckoutPointUsage 计算服务端结算阶段实际积分使用结果
//
// 参数:
//   - input: 与 calculatePointDiscountPreview 相同的结算输入
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-04-18
//   - 更新时间: 2026-04-18
//   - 更新内容: 提供服务端下单逻辑复用的统一入口。
export function resolveCheckoutPointUsage(input: {
  orderAmount: number
  availablePoints: number
  usePoints: boolean
  pointDiscountEnabled: boolean
  pointDiscountPercent: number
}) {
  return calculatePointDiscountPreview(input)
}
