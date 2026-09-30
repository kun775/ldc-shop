/**
 * 幂等键与外部引用的生成规则。
 *
 * 三条硬约束（均来自服务实现，不是文档习惯）：
 *
 * 1. **键的字符集**：服务端中间件用 `^[A-Za-z0-9._:/-]{8,255}$` 校验
 *    `Idempotency-Key`（`internal/infra/http/middleware/middleware.go`），
 *    长度不足或不含非法字符一律 `400 invalid_request`。订单号、卡 ID 等
 *    外部值因此必须先过 `sanitizeIdempotencyKeySegment()`，不能直接拼。
 * 2. **同键必须同体**：键绑定「path + 规范化请求体 hash」，重试时增删字段
 *    （例如首次带 `external_ref`、重试省略）会得到 `409 idempotency_conflict`。
 *    所以请求体只能由**同一份冻结意图**派生，见 `restock.ts` 的 `RestockIntent`。
 * 3. **`external_ref` 终身唯一**：中心 `card_allocations` 有
 *    `UNIQUE(tenant_id, client_id, external_ref)`，且 `cancelled` / `expired`
 *    的分配**不释放**该值。因此任务一旦作废或超窗，必须换新 `task_id`
 *    与新 `external_ref`，复用旧值只会拿到 `409 allocation_conflict`。
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:/-]{8,255}$/

export const LICENSE_SERVICE_EXTERNAL_REF_MAX_LENGTH = 128

export const RESTOCK_EXTERNAL_REF_PREFIX = 'ldc-shop:restock:'

/** 幂等键与外部引用共用的字符集；不合法的字符替换为 `-` 并折叠连续 `-`。 */
export function sanitizeIdempotencyKeySegment(value: unknown): string {
    const text = typeof value === 'string' ? value : String(value ?? '')
    const cleaned = text.replace(/[^A-Za-z0-9._:/-]+/g, '-').replace(/-{2,}/g, '-')
    return cleaned.replace(/^[-.]+/, '').replace(/[-.]+$/, '')
}

export function isValidIdempotencyKey(key: unknown): key is string {
    return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key)
}

/**
 * 生成补货任务 ID。
 *
 * 刻意用随机值而不是「商品 + 时间」这类可推导的串：任务 ID 决定
 * `external_ref` 与幂等键，一旦可预测就可能被并发触发复用，而
 * `external_ref` 一旦被占用就永久占用（见文件头第 3 条）。
 */
export function buildRestockTaskId(randomUUID: () => string = () => globalThis.crypto.randomUUID()): string {
    return sanitizeIdempotencyKeySegment(randomUUID())
}

export function buildRestockExternalRef(taskId: string): string {
    const ref = `${RESTOCK_EXTERNAL_REF_PREFIX}${sanitizeIdempotencyKeySegment(taskId)}`
    // 上限 128 由服务端强制；这里先截断，宁可本地报错也不要发出注定被拒的请求。
    return ref.slice(0, LICENSE_SERVICE_EXTERNAL_REF_MAX_LENGTH)
}

export function buildAllocateIdempotencyKey(taskId: string): string {
    return `restock:${sanitizeIdempotencyKeySegment(taskId)}:allocate`.slice(0, 255)
}

export function buildAckIdempotencyKey(taskId: string): string {
    return `restock:${sanitizeIdempotencyKeySegment(taskId)}:ack`.slice(0, 255)
}

export function buildCancelIdempotencyKey(taskId: string): string {
    return `restock:${sanitizeIdempotencyKeySegment(taskId)}:cancel`.slice(0, 255)
}

/** Sell 的幂等键按「分配 + 订单」固定：同一订单重放返回首次结果，不会重复售出。 */
export function buildSellIdempotencyKey(allocationId: string, orderId: string): string {
    return `sell:${sanitizeIdempotencyKeySegment(allocationId)}:${sanitizeIdempotencyKeySegment(orderId)}`.slice(0, 255)
}

/** Revoke 的幂等键按「卡 + 订单」固定，保证同一退款不会作废两次。 */
export function buildRevokeIdempotencyKey(cardId: string, orderId: string): string {
    return `revoke:${sanitizeIdempotencyKeySegment(cardId)}:${sanitizeIdempotencyKeySegment(orderId)}`.slice(0, 255)
}

/**
 * 规范化 JSON 请求体：对象键排序、丢弃 `undefined`、保留数组顺序。
 *
 * 数组顺序必须保留 —— `received_card_ids` / `card_ids` 的顺序不同会让
 * 服务端算出的请求体 hash 不同，从而把一次合法重试判成
 * `409 idempotency_conflict`。这也是 `restock.ts` 坚持「从持久化记录
 * 按确定顺序重建 Ack 体」的原因。
 */
export function canonicalizeJsonBody(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
    if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJsonBody(item)).join(',')}]`

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJsonBody(item)}`).join(',')}}`
}

/**
 * 请求体指纹（SHA-256 十六进制前 16 位）。
 *
 * 仅用于把「同键不同体」这类冲突指向具体的本地请求体，**不参与任何密钥
 * 派生**；结果里不含卡密原文，可以安全落日志。
 */
export async function fingerprintIdempotentRequest(body: unknown): Promise<string> {
    const canonical = canonicalizeJsonBody(body)
    const bytes = new TextEncoder().encode(canonical)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16)
}
