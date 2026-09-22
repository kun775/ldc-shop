const LDC_DECIMAL_PATTERN = /^(-)?(\d*)(?:\.(\d*))?$/

// parseLdcToCents 将 LDC 金额（字符串或数字）解析为整数分
//
// 参数:
//   - value: 形如 "12.50" / 12.5 / "0.01" 的金额，允许负数
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增基于字符串截断的舍入逻辑，避免浮点乘法误差。
export function parseLdcToCents(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    const raw = typeof value === 'number' ? String(value) : String(value).trim()
    if (!raw) return null

    const match = LDC_DECIMAL_PATTERN.exec(raw)
    if (!match) return null

    const sign = match[1] === '-' ? -1 : 1
    const intPart = match[2] || '0'
    const fracPart = match[3] || ''

    const keptFrac = fracPart.slice(0, 2).padEnd(2, '0')
    const roundingDigit = fracPart.charAt(2)

    let cents = Number(intPart) * 100 + Number(keptFrac)
    if (!Number.isFinite(cents)) return null
    if (roundingDigit && Number(roundingDigit) >= 5) {
        cents += 1
    }

    return sign * cents
}

export function parseLdcToCentsOrZero(value: string | number | null | undefined): number {
    return parseLdcToCents(value) ?? 0
}

// centsToLdcString 将整数分格式化为 LDC 金额字符串
//
// 参数:
//   - cents: 整数分
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新时间: 2026-03-05
//   - 更新内容: 新增整数分到两位小数字符串的转换。
export function centsToLdcString(cents: number): string {
    const safe = Number.isFinite(cents) ? Math.round(cents) : 0
    const negative = safe < 0
    const abs = Math.abs(safe)
    const intPart = Math.floor(abs / 100)
    const fracPart = abs % 100
    return `${negative ? '-' : ''}${intPart}.${String(fracPart).padStart(2, '0')}`
}

export function centsToLdcNumber(cents: number): number {
    return Math.round(Number.isFinite(cents) ? cents : 0) / 100
}

// multiplyCentsByQuantity 计算单价分与数量的乘积
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增订单小计计算，防止 Number(price) * quantity 的浮点误差。
export function multiplyCentsByQuantity(unitPriceCents: number, quantity: number): number {
    const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0
    return Math.round(unitPriceCents) * safeQuantity
}

// applyRateBps 按基点计算应付金额（四舍五入到分）
//
// 参数:
//   - amountCents: 参与计算的金额
//   - rateBps: 支付比例基点，10000 表示原价，9000 表示九折
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-03-05
//   - 更新内容: 新增百分比券应付金额计算。
export function applyRateBps(amountCents: number, rateBps: number): number {
    const safeAmount = Math.max(0, Math.round(amountCents))
    const safeRate = Math.max(0, Math.min(10000, Math.round(rateBps)))
    return Math.round((safeAmount * safeRate) / 10000)
}
