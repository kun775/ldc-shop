/**
 * 待办队列（`card_service_operations`）的**排序与重试预算** —— sell / revoke / ack
 * 三处共用同一份口径。
 *
 * 这一层解决的是一个非常具体的堵塞：重放查询是
 * `WHERE state IN ('pending','failed') ... LIMIT n` 的，而「不可重试失败」被写成
 * `state = 'failed'` **且 `next_retry_at = NULL`**。把这两种状态混在一条队列里按
 * 到期时间排序时，`COALESCE(next_retry_at, 0)` 会把死信恒定排到**队首**：
 *
 *   - 只要有 n 条死信，`LIMIT n` 每一轮都被它们吃光，新进队的 `pending` 永远轮不到；
 *   - 而 `failed` 又不会被自动清掉（要人工核查），于是队列**永久卡死**。
 *
 * 三条规则合起来解决它：
 *
 *   1. **分层排序**：`failed` 恒排在 `pending` 之后 —— 活着的工作优先于死信；
 *   2. **退避**：失败落账时写 `next_retry_at = now + base * 2^attempts`（有上限），
 *      让死信之间也拉开距离，不再每轮一起挤占队列；
 *   3. **尝试上限**：连续失败到上限就转 `abandoned` —— 离开重试队列，但
 *      **仍出现在运维面板的复核清单里**（`ops.ts` 的复核查询包含
 *      `failed` / `abandoned`），不会静默消失。
 *
 * `next_retry_at` 在这里是**优先级提示**而不是硬闸门：重放入口（定时任务与面板上
 * 的「重试」）不按它过滤，因为一次退避不该挡住「凭据刚刚配好、现在就能补上」的
 * 重放。真正的节奏控制来自外部调度（cron 每分钟一次）。
 */

/**
 * 连续失败多少次之后转 `abandoned`（死信）。
 *
 * 取值偏大是刻意的：`failed` 里混着两类东西 —— 真正的数据/权限问题，以及
 * 「凭据还没配好」这种**环境**问题（`failRevokesWithoutClient`）。后者往往要等
 * 运维处理，过早死信会让它失去自动补上的机会。配合指数退避，累积到上限约需数小时。
 */
export const CARD_SERVICE_MAX_OPERATION_ATTEMPTS = 12

/** 退避基数（毫秒）：第一次失败后至少等这么久再被优先重放。 */
export const CARD_SERVICE_RETRY_BACKOFF_BASE_MS = 60_000

/** 退避倍数上限（`1 << 6` = 64 倍，即基数 1 分钟 → 最多约 1 小时）。 */
export const CARD_SERVICE_RETRY_BACKOFF_MAX_SHIFT = 6

/**
 * 队列排序片段（**不含绑定参数**，可安全拼接进 `LIMIT` 之前）。
 *
 * 三处重放查询必须共用它：任何一处只按 `next_retry_at` 排序，死信就会在那里
 * 重新堵塞队列。
 */
export const CARD_SERVICE_OPERATION_QUEUE_ORDER_SQL =
    "ORDER BY CASE WHEN state = 'failed' THEN 1 ELSE 0 END ASC, COALESCE(next_retry_at, 0) ASC, created_at ASC"

/**
 * 「一次不可重试的失败」要写进待办行的两个表达式。
 *
 * 刻意在 SQL 里算而不是在 TS 里算：`attempts` 只存在于行上，读出来再写回去会
 * 与并发重放互相覆盖（重放是并发的，失败判定是逐条的）。一条 UPDATE 里用
 * `attempts + 1` 作为判定依据，天然与自增保持同一口径。
 *
 * `nowMs` 被**内联**成整数字面量而不是占位符：它由本进程生成（`Date.now()` 或
 * 测试传入），不是外部输入；而把 `?` 夹在 CASE 表达式里会让占位符顺序变得难以
 * 肉眼核对 —— 绑错位置不会报错，只会静默写错时间。
 */
export function buildOperationFailureClauses(nowMs: number): { state: string; nextRetryAt: string } {
    const cap = CARD_SERVICE_MAX_OPERATION_ATTEMPTS
    const base = CARD_SERVICE_RETRY_BACKOFF_BASE_MS
    const shiftCap = CARD_SERVICE_RETRY_BACKOFF_MAX_SHIFT
    const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0

    return {
        state: `CASE WHEN attempts + 1 >= ${cap} THEN 'abandoned' ELSE 'failed' END`,
        nextRetryAt: `CASE WHEN attempts + 1 >= ${cap} THEN NULL
                ELSE ${now} + (${base} * (1 << MIN(attempts, ${shiftCap}))) END`,
    }
}
