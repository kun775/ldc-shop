/**
 * 积分账本错误码 → 文案 key 收敛。
 *
 * 为什么需要集中定义：
 *   积分链路的错误来源极杂 —— 触发器 RAISE(ABORT, 'POINT_BALANCE_NEGATIVE')、
 *   业务层抛出的内部错误码（`POINT_LEDGER_*`）、D1 的约束/结构错误。
 *   这些错误会经 Server Action 返回值回到前台，而**返回值不会被 Next.js
 *   自动脱敏**（只有 throw 才会）。任何一处漏掉映射，SQL 原文与绑定参数
 *   （例如 `Failed query: insert into "user_point_ledger" (...) params: 10785`）
 *   就会直接显示给管理员。
 *
 * 约定：
 *   - 只有明确属于业务语义的错误码才映射为具体文案；
 *   - 其余一律退化为 `common.error`（或调用方指定的兜底 key）；
 *   - 所有映射目标必须是真实存在的 i18n key（由单测守护）。
 */

/** 后台调整积分时的错误映射 */
export const POINT_ADMIN_ERROR_KEY_MAP: Record<string, string> = {
    // 业务校验
    POINT_REASON_REQUIRED: 'admin.users.adjustReasonRequired',
    POINT_AMOUNT_INVALID: 'admin.users.adjustAmountInvalid',
    POINT_BALANCE_NEGATIVE: 'admin.users.adjustNegativeNotAllowed',
    insufficient_points: 'admin.users.adjustNegativeNotAllowed',
    // 并发/占用：本次操作没抢到或仍在处理中，属于可重试
    POINT_LEDGER_EVENT_IN_PROGRESS: 'admin.users.adjustInProgress',
    POINT_LEDGER_CLAIM_FAILED: 'admin.users.adjustFailed',
    POINT_LEDGER_CLAIM_LOST: 'admin.users.adjustFailed',
    POINT_LEDGER_BUSINESS_KEY_CONFLICT: 'admin.users.adjustConflict',
    // 结构类：确认缺表/缺列时给出「功能暂不可用」而非通用错误
    'no such table': 'admin.users.adjustUnavailable',
    'no such column': 'admin.users.adjustUnavailable',
    'column not found': 'admin.users.adjustUnavailable',
}

/** 用户签到时的错误映射 */
export const POINT_CHECKIN_ERROR_KEY_MAP: Record<string, string> = {
    POINT_LEDGER_EVENT_IN_PROGRESS: 'checkin.inProgress',
    POINT_LEDGER_CLAIM_FAILED: 'checkin.failed',
    POINT_LEDGER_CLAIM_LOST: 'checkin.failed',
    POINT_LEDGER_BUSINESS_KEY_CONFLICT: 'checkin.alreadyCheckedIn',
    POINT_BALANCE_NEGATIVE: 'checkin.balanceNegative',
    insufficient_points: 'checkin.balanceNegative',
}

/** 下单/退款等自动积分事件的错误映射 */
export const POINT_AUTOMATIC_ERROR_KEY_MAP: Record<string, string> = {
    POINT_BALANCE_NEGATIVE: 'points.insufficient',
    insufficient_points: 'points.insufficient',
    POINT_LEDGER_BUSINESS_KEY_CONFLICT: 'common.error',
    POINT_LEDGER_EVENT_IN_PROGRESS: 'common.error',
    POINT_LEDGER_CLAIM_FAILED: 'common.error',
    POINT_LEDGER_CLAIM_LOST: 'common.error',
}
