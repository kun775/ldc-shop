/**
 * 通用卡密服务响应的契约校验。
 *
 * 全部为纯函数：不联网、不读环境、不触碰数据库，便于用单测覆盖
 * 「服务端行为变化」这一类最容易静默出错的地方。
 *
 * 校验强度刻意比文档更严：
 *   - `cards.length` 必须等于 `quantity`，每张卡的 `id` 非空且**不重复**
 *     （重复 id 会在本地暂存表主键上撞车，必须在这里就拦掉）；
 *   - 分配响应必须带非空 `key`，单查/列表响应则**必须没有** `key`
 *     ——若哪天单查接口开始回明文，这里会立刻失败而不是悄悄把明文写进日志；
 *   - `program_key` 与请求不一致即判失败：响应文本不足以证明 Program 归属，
 *     但一旦不一致就说明请求与响应错配，宁可失败也不能入库。
 *
 * 时间统一归一为毫秒时间戳。服务端是 Go `time.Time`，序列化为 RFC3339Nano
 * （小数位可达 9 位），而 ES 规范只认 3 位，`Date.parse` 在部分实现上会
 * 返回 `NaN`，因此先裁剪小数位再解析。
 */

export interface RemoteAllocatedCard {
    id: string
    key: string
    maskedKey: string | null
}

/** 分配（Allocate）与单查（GetAllocation）共用的详情结构。 */
export interface AllocationDetail {
    allocationId: string
    programId: string
    programKey: string
    externalRef: string
    status: string
    quantity: number
    cards: RemoteAllocatedCard[]
    /** Ack 窗口截止时间（毫秒）。中心列表接口不返回它，只能靠本地记录。 */
    expiresAtMs: number
    createdAtMs: number
    acknowledgedAtMs: number | null
}

/**
 * 列表项。**注意与详情不同**：中心的列表项不含 `expires_at`、`quantity` 与
 * `program_key`，且卡集是 `{card_id}` 而不是完整的 `{id,key,masked_key}`。
 */
export interface AllocationSummary {
    allocationId: string
    programId: string
    status: string
    externalRef: string
    cardIds: string[]
    allocatedAtMs: number | null
    acknowledgedAtMs: number | null
}

export interface AllocationListPage {
    items: AllocationSummary[]
    nextCursor: string | null
    hasMore: boolean
}

export interface CardStatusDetail {
    cardId: string
    programId: string
    maskedKey: string | null
    status: string
    allocationStatus: string | null
    usageLimit: number | null
    usageHeld: number | null
    usageCommitted: number | null
    remaining: number | null
    createdAtMs: number | null
}

/** Ack / Sell / Cancel 都只回 `{ allocation_id, status }`。 */
export interface AllocationStatusUpdate {
    allocationId: string
    status: string
}

export interface RevokeResult {
    cardId: string
    status: string
}

export type ContractParseResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: string }

function fail<T>(reason: string): ContractParseResult<T> {
    return { ok: false, reason }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNonEmptyString(source: Record<string, unknown>, field: string): ContractParseResult<string> {
    const value = source[field]
    if (typeof value !== 'string') return fail(`invalid_${field}`)
    if (!value.trim()) return fail(`empty_${field}`)
    return { ok: true, value }
}

function readOptionalString(source: Record<string, unknown>, field: string): string | null {
    const value = source[field]
    if (typeof value !== 'string') return null
    return value.trim() ? value : null
}

function readOptionalInteger(source: Record<string, unknown>, field: string): number | null {
    const value = source[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.trunc(value)
}

/** RFC3339（含纳秒小数）→ 毫秒时间戳；无法解析返回 `null`。 */
export function parseContractTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed) return null
    // 裁剪到毫秒精度：`.123456789Z` → `.123Z`；无小数位则原样透传。
    const normalized = trimmed.replace(/\.(\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$|$)/, '.$1')
    const parsed = Date.parse(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

/**
 * 解包成功信封。`ok` 不是布尔 `true` 一律判失败 —— 契约里 `ok` 是成功标记，
 * 容忍 `undefined` 会把代理返回的错误页当成成功响应。
 */
export function unwrapSuccessEnvelope(payload: unknown): ContractParseResult<unknown> {
    if (!isPlainObject(payload)) return fail('not_object')
    if (payload.ok !== true) return fail('not_ok_envelope')
    if (!('data' in payload)) return fail('missing_data')
    return { ok: true, value: payload.data }
}

function parseRemoteCards(
    source: Record<string, unknown>,
    options: { requireKey: boolean },
): ContractParseResult<RemoteAllocatedCard[]> {
    const raw = source.cards
    if (!Array.isArray(raw)) return fail('invalid_cards')

    const cards: RemoteAllocatedCard[] = []
    const seen = new Set<string>()

    for (const item of raw) {
        if (!isPlainObject(item)) return fail('invalid_cards')
        const id = readNonEmptyString(item, 'id')
        if (!id.ok) return fail('invalid_card_id')
        if (seen.has(id.value)) return fail('duplicate_card_id')
        seen.add(id.value)

        const key = readOptionalString(item, 'key')
        if (options.requireKey && !key) return fail('missing_card_key')
        if (!options.requireKey && key) return fail('unexpected_card_key')

        cards.push({ id: id.value, key: key ?? '', maskedKey: readOptionalString(item, 'masked_key') })
    }

    return { ok: true, value: cards }
}

export interface ParseAllocationExpectation {
    /** 请求时使用的受控 Program；响应不一致直接判失败。 */
    programKey?: string
    /** 请求的卡数量；不一致直接判失败。 */
    quantity?: number
}

/**
 * 解析分配详情（Allocate 响应与 `GET /allocations/{id}` 共用）。
 *
 * `requireCardKeys` 区分两种来源：Allocate 必须回明文，单查**必须不回**明文。
 */
export function parseAllocationDetail(
    payload: unknown,
    options: { requireCardKeys: boolean; expectation?: ParseAllocationExpectation } = { requireCardKeys: true },
): ContractParseResult<AllocationDetail> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')

    const data = envelope.value
    const allocationId = readNonEmptyString(data, 'allocation_id')
    if (!allocationId.ok) return fail(allocationId.reason)
    const programId = readNonEmptyString(data, 'program_id')
    if (!programId.ok) return fail(programId.reason)
    const programKey = readNonEmptyString(data, 'program_key')
    if (!programKey.ok) return fail(programKey.reason)
    const status = readNonEmptyString(data, 'status')
    if (!status.ok) return fail(status.reason)

    const quantity = readOptionalInteger(data, 'quantity')
    if (quantity === null || quantity <= 0) return fail('invalid_quantity')

    const cards = parseRemoteCards(data, { requireKey: options.requireCardKeys })
    if (!cards.ok) return fail(cards.reason)
    if (cards.value.length !== quantity) return fail('quantity_mismatch')
    if (cards.value.length === 0) return fail('empty_cards')

    const expiresAtMs = parseContractTimestamp(data.expires_at)
    if (expiresAtMs === null) return fail('invalid_expires_at')
    const createdAtMs = parseContractTimestamp(data.created_at)
    if (createdAtMs === null) return fail('invalid_created_at')
    const acknowledgedAtMs = parseContractTimestamp(data.acknowledged_at)

    const expectation = options.expectation
    if (expectation?.programKey && expectation.programKey !== programKey.value) {
        return fail('program_key_mismatch')
    }
    if (expectation?.quantity !== undefined && expectation.quantity !== quantity) {
        return fail('quantity_mismatch')
    }

    return {
        ok: true,
        value: {
            allocationId: allocationId.value,
            programId: programId.value,
            programKey: programKey.value,
            externalRef: readOptionalString(data, 'external_ref') ?? '',
            status: status.value,
            quantity,
            cards: cards.value,
            expiresAtMs,
            createdAtMs,
            acknowledgedAtMs,
        },
    }
}

/** 批量分配必须是按请求顺序返回的独立单卡分配，不能复用单次分配的宽松字段归一。 */
export function parseAllocationBatch(
    payload: unknown,
    expectation: { programKey: string; quantity: number; externalRef?: string },
): ContractParseResult<AllocationDetail[]> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')
    const raw = envelope.value.allocations
    if (!Array.isArray(raw)) return fail('invalid_allocations')
    if (raw.length !== expectation.quantity) return fail('allocation_count_mismatch')

    const allocations: AllocationDetail[] = []
    const allocationIds = new Set<string>()
    const cardIds = new Set<string>()
    const parentRef = expectation.externalRef ?? ''
    for (const [index, item] of raw.entries()) {
        if (!isPlainObject(item)) return fail('invalid_allocation')
        if (item.quantity !== 1) return fail('invalid_quantity')
        if (item.status !== 'allocated') return fail('invalid_allocation_status')
        const childRef = parentRef ? `${parentRef}:${index + 1}` : ''
        if (item.external_ref !== childRef) return fail('external_ref_mismatch')
        const detail = parseAllocationDetail({ ok: true, data: item }, {
            requireCardKeys: true,
            expectation: { programKey: expectation.programKey, quantity: 1 },
        })
        if (!detail.ok) return fail(detail.reason)
        const value = detail.value
        if (value.createdAtMs <= 0 || value.expiresAtMs <= value.createdAtMs) return fail('invalid_allocation_time')
        if (allocationIds.has(value.allocationId)) return fail('duplicate_allocation_id')
        if (cardIds.has(value.cards[0].id)) return fail('duplicate_card_id')
        allocationIds.add(value.allocationId)
        cardIds.add(value.cards[0].id)
        allocations.push(value)
    }
    return { ok: true, value: allocations }
}

/** 解析 `GET /allocations` 的分页结果。 */
export function parseAllocationListPage(payload: unknown): ContractParseResult<AllocationListPage> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')

    const data = envelope.value
    if (!Array.isArray(data.items)) return fail('invalid_items')

    const items: AllocationSummary[] = []
    for (const raw of data.items) {
        if (!isPlainObject(raw)) return fail('invalid_items')
        const allocationId = readNonEmptyString(raw, 'allocation_id')
        if (!allocationId.ok) return fail(allocationId.reason)
        const status = readNonEmptyString(raw, 'status')
        if (!status.ok) return fail(status.reason)

        const cardIds: string[] = []
        if (Array.isArray(raw.cards)) {
            for (const card of raw.cards) {
                if (!isPlainObject(card)) continue
                const cardId = readOptionalString(card, 'card_id')
                if (cardId) cardIds.push(cardId)
            }
        }

        items.push({
            allocationId: allocationId.value,
            programId: readOptionalString(raw, 'program_id') ?? '',
            status: status.value,
            externalRef: readOptionalString(raw, 'external_ref') ?? '',
            cardIds,
            allocatedAtMs: parseContractTimestamp(raw.allocated_at),
            acknowledgedAtMs: parseContractTimestamp(raw.acknowledged_at),
        })
    }

    const nextCursor = readOptionalString(data, 'next_cursor')
    return {
        ok: true,
        value: { items, nextCursor, hasMore: data.has_more === true && nextCursor !== null },
    }
}

/** 解析 `GET /cards/{id}/status`。 */
export function parseCardStatus(payload: unknown): ContractParseResult<CardStatusDetail> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')

    const data = envelope.value
    const cardId = readNonEmptyString(data, 'id')
    if (!cardId.ok) return fail(cardId.reason)
    const status = readNonEmptyString(data, 'status')
    if (!status.ok) return fail(status.reason)

    return {
        ok: true,
        value: {
            cardId: cardId.value,
            programId: readOptionalString(data, 'program_id') ?? '',
            maskedKey: readOptionalString(data, 'masked_key'),
            status: status.value,
            allocationStatus: readOptionalString(data, 'allocation_status'),
            usageLimit: readOptionalInteger(data, 'usage_limit'),
            usageHeld: readOptionalInteger(data, 'usage_held'),
            usageCommitted: readOptionalInteger(data, 'usage_committed'),
            remaining: readOptionalInteger(data, 'remaining'),
            createdAtMs: parseContractTimestamp(data.created_at),
        },
    }
}

/** 解析 Ack / Sell / Cancel 的 `{ allocation_id, status }` 回执。 */
export function parseAllocationStatusUpdate(payload: unknown): ContractParseResult<AllocationStatusUpdate> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')

    const allocationId = readNonEmptyString(envelope.value, 'allocation_id')
    if (!allocationId.ok) return fail(allocationId.reason)
    const status = readNonEmptyString(envelope.value, 'status')
    if (!status.ok) return fail(status.reason)

    return { ok: true, value: { allocationId: allocationId.value, status: status.value } }
}

/** 解析 `POST /cards/{id}/revoke` 的 `{ id, status }` 回执。 */
export function parseRevokeResult(payload: unknown): ContractParseResult<RevokeResult> {
    const envelope = unwrapSuccessEnvelope(payload)
    if (!envelope.ok) return fail(envelope.reason)
    if (!isPlainObject(envelope.value)) return fail('invalid_data')

    const cardId = readNonEmptyString(envelope.value, 'id')
    if (!cardId.ok) return fail('missing_id')
    const status = readNonEmptyString(envelope.value, 'status')
    if (!status.ok) return fail(status.reason)

    return { ok: true, value: { cardId: cardId.value, status: status.value } }
}

/**
 * 从错误响应里提取 `request_id`。
 *
 * 契约明确 `request_id` 在信封**顶层**；这里额外容忍响应头，仅作交叉记录，
 * 判断重试与否一律不看它（见 `errors.ts`）。
 */
export function extractErrorRequestId(payload: unknown, headerValue: string | null): string | null {
    if (isPlainObject(payload)) {
        const top = readOptionalString(payload, 'request_id')
        if (top) return top
    }
    const header = (headerValue || '').trim()
    return header || null
}

export interface ErrorEnvelopeFields {
    code: string | null
    message: string | null
    retryable: boolean | null
}

/**
 * 从错误响应里读取 `error` 对象。
 *
 * 只要 `code` / `message` / `retryable` 三个字段，其余一律忽略：契约规定
 * `error` 只含这三个键，多出来的内容既不能作为判断依据，也可能是代理插入的噪音。
 */
export function parseErrorEnvelope(payload: unknown): ErrorEnvelopeFields {
    const empty: ErrorEnvelopeFields = { code: null, message: null, retryable: null }
    if (!isPlainObject(payload)) return empty
    const error = payload.error
    if (!isPlainObject(error)) return empty

    const code = typeof error.code === 'string' && error.code.trim() ? error.code.trim() : null
    const message = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : null
    const retryable = typeof error.retryable === 'boolean' ? error.retryable : null
    return { code, message, retryable }
}

/**
 * 响应体不是合法信封时按 HTTP 状态码兜底推断的错误码。
 *
 * 只用于「拿不到稳定 code」的场景（网关错误页、5xx 无体、超时）。一旦服务端
 * 回了规范信封，永远以信封里的 `code` 为准。
 */
export const HTTP_STATUS_FALLBACK_ERROR_CODES: Record<number, string> = {
    400: 'invalid_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    408: 'timeout',
    409: 'allocation_conflict',
    429: 'rate_limited',
    500: 'internal_error',
    503: 'temporarily_unavailable',
}

export function fallbackErrorCodeForStatus(httpStatus: number): string {
    return HTTP_STATUS_FALLBACK_ERROR_CODES[httpStatus] ?? 'invalid_response'
}

/**
 * 解析 `Retry-After`：支持「秒数」与 HTTP-date 两种形式，返回毫秒。
 *
 * 非法或缺失返回 `null`，由退避策略决定默认时长；绝不返回负数。
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | null {
    const raw = (headerValue || '').trim()
    if (!raw) return null

    if (/^\d+$/.test(raw)) {
        const seconds = Number.parseInt(raw, 10)
        return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null
    }

    const dateMs = Date.parse(raw)
    if (!Number.isFinite(dateMs)) return null
    return Math.max(0, dateMs - nowMs)
}

