/**
 * 订单领域错误码。
 *
 * 客户端只认识这些稳定的 i18n key；服务端任何其它异常一律走通用文案 + errorId，
 * 绝不允许把 SQL 原文、绑定参数或内部结构泄漏到前台。
 *
 * 新增错误码时必须同步：
 *   1. 两个语言包（zh.json / en.json）中的键；
 *   2. 本文件；
 *   3. 本目录的 order-definition-codes.test.ts。
 */
export const ORDER_ERROR_CODES = {
    deliveryContentRequired: 'admin.orders.deliveryContentRequired',
    deliveryNoteTooLong: 'admin.orders.deliveryNoteTooLong',
    deliveryTooManyFiles: 'admin.orders.deliveryTooManyFiles',
    deliveryInvalidFile: 'admin.orders.deliveryInvalidFile',
    deliveryFileTooLarge: 'admin.orders.deliveryFileTooLarge',
} as const

export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[keyof typeof ORDER_ERROR_CODES]

/**
 * 服务端内部抛出 → 客户端展示 key 的映射。
 *
 * 只有「业务语义明确、文案对用户有意义」的错误才登记在这里。
 * 例如 `Order cannot be cancelled` 这类依赖订单实时状态的判断，
 * 无法预先映射，交由客户端 fallback（common.error + errorId）处理。
 */
export const ORDER_ERROR_KEY_MAP: Record<string, string> = {
    [ORDER_ERROR_CODES.deliveryContentRequired]: 'admin.orders.deliveryContentRequired',
    [ORDER_ERROR_CODES.deliveryNoteTooLong]: 'admin.orders.deliveryNoteTooLong',
    [ORDER_ERROR_CODES.deliveryTooManyFiles]: 'admin.orders.deliveryTooManyFiles',
    [ORDER_ERROR_CODES.deliveryInvalidFile]: 'admin.orders.deliveryInvalidFile',
    [ORDER_ERROR_CODES.deliveryFileTooLarge]: 'admin.orders.deliveryFileTooLarge',
}

/** 手动发货相关错误码集合，供客户端在失败后保留用户输入时判定 */
export const DELIVERY_INPUT_ERROR_KEYS = new Set<string>([
    'admin.orders.deliveryContentRequired',
    'admin.orders.deliveryNoteTooLong',
    'admin.orders.deliveryTooManyFiles',
    'admin.orders.deliveryInvalidFile',
    'admin.orders.deliveryFileTooLarge',
])
