/**
 * 通用卡密服务机器 API 的结构化 HTTP 客户端。
 *
 * 职责边界：
 *   - 只做「拼请求 → 发请求 → 解析信封 → 校验契约 → 归类错误」；
 *   - **不做重试**：重试策略属于调用方语境（补货可以短重试，交付必须更保守），
 *     见 `retry.ts`；
 *   - **不写日志**：请求/响应里含卡密与 Bearer 凭据，客户端一律不外发，
 *     需要留痕时调用方取 `LicenseServiceError.toLogContext()`（已脱敏）。
 */

import { fetchWithTimeout } from '../runtime/fetch-with-timeout.ts'
import {
    buildLicenseServiceUrl,
    normalizeLicenseServiceBaseUrl,
    LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES,
    LICENSE_SERVICE_DEFAULT_TIMEOUT_MS,
} from './config.ts'
import { LicenseServiceError, toLicenseServiceError } from './errors.ts'
import { fingerprintIdempotentRequest, isValidIdempotencyKey } from './idempotency.ts'
import {
    extractErrorRequestId,
    fallbackErrorCodeForStatus,
    parseAllocationBatch,
    parseAllocationDetail,
    parseAllocationListPage,
    parseAllocationStatusUpdate,
    parseCardStatus,
    parseErrorEnvelope,
    parseRetryAfterMs,
    parseRevokeResult,
    unwrapSuccessEnvelope,
    type AllocationDetail,
    type AllocationListPage,
    type AllocationStatusUpdate,
    type CardStatusDetail,
    type ContractParseResult,
    type RevokeResult,
} from './contract.ts'

export type LicenseServiceOperation =
    | 'allocate'
    | 'allocateBatch'
    | 'ack'
    | 'sell'
    | 'cancel'
    | 'getAllocation'
    | 'listAllocations'
    | 'getCardStatus'
    | 'revoke'

export interface LicenseServiceClientOptions {
    baseUrl: string
    apiKey: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
    maxResponseBytes?: number
    requestIdFactory?: () => string
    now?: () => number
}

export interface AllocateInput {
    /** 仅本地凭据路由使用，不发送给中心。 */
    productId?: string
    programKey: string
    quantity?: number
    externalRef?: string
    metadata?: Record<string, string>
    idempotencyKey: string
}

export interface AckInput {
    allocationId: string
    receivedCardIds: readonly string[]
    externalRef?: string
    idempotencyKey: string
}

export interface SellInput {
    allocationId: string
    cardIds: readonly string[]
    externalRef?: string
    idempotencyKey: string
}

export interface CancelInput {
    allocationId: string
    cardIds: readonly string[]
    reason: string
    idempotencyKey: string
}

export interface RevokeInput {
    reason: string
    idempotencyKey: string
}

export interface ListAllocationsQuery {
    externalRef?: string
    status?: string
    cursor?: string
    limit?: number
}

export interface LicenseServiceClient {
    readonly baseUrl: string
    allocate(input: AllocateInput): Promise<AllocationDetail>
    allocateBatch(input: AllocateInput): Promise<AllocationDetail[]>
    ack(input: AckInput): Promise<AllocationStatusUpdate>
    sell(input: SellInput): Promise<AllocationStatusUpdate>
    cancel(input: CancelInput): Promise<AllocationStatusUpdate>
    getAllocation(allocationId: string): Promise<AllocationDetail>
    listAllocations(query?: ListAllocationsQuery): Promise<AllocationListPage>
    getCardStatus(cardId: string): Promise<CardStatusDetail>
    revoke(cardId: string, input: RevokeInput): Promise<RevokeResult>
}

interface RequestOptions {
    operation: LicenseServiceOperation
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    idempotencyKey?: string
    query?: Record<string, string>
}

interface LicenseServiceResponse {
    payload: unknown
    status: number
}

/**
 * 本地参数错误的统一出口。
 *
 * 用服务端码 `invalid_request` 表示「请求本身不合法」，类别归 `request`：
 * 既不重试也不告警，直接暴露成调用方的缺陷。这些错误在服务端契约里同样
 * 映射到 `invalid_request`，因此调用方只需处理一种语义。
 */
function localRequestError(operation: LicenseServiceOperation, cause: string): never {
    throw new LicenseServiceError({ code: 'invalid_request', operation, cause })
}

function requireNonEmpty(value: string, field: string, operation: LicenseServiceOperation) {
    if (typeof value !== 'string' || !value.trim()) {
        localRequestError(operation, `${field} is required`)
    }
    return value
}

function requireIdempotencyKey(key: string, operation: LicenseServiceOperation) {
    if (!isValidIdempotencyKey(key)) {
        localRequestError(operation, 'Idempotency-Key must match [A-Za-z0-9._:/-]{8,255}')
    }
    return key
}

function requireIds(ids: readonly string[], field: string, operation: LicenseServiceOperation) {
    if (!Array.isArray(ids) || ids.length === 0) {
        localRequestError(operation, `${field} must not be empty`)
    }
    for (const id of ids) {
        if (typeof id !== 'string' || !id.trim()) {
            localRequestError(operation, `${field} contains an empty id`)
        }
    }
    return ids
}

function takeParsed<T>(result: ContractParseResult<T>, operation: LicenseServiceOperation, httpStatus: number): T {
    if (result.ok) return result.value
    throw new LicenseServiceError({
        code: 'invalid_response',
        httpStatus,
        operation,
        cause: result.reason,
    })
}

/** 读取响应体并施加大小上限；超限立即断开，不把整个响应拖进内存。 */
async function readBodyCapped(
    response: Response,
    maxBytes: number,
    operation: LicenseServiceOperation,
): Promise<string> {
    const declared = Number.parseInt(response.headers.get('content-length') || '', 10)
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new LicenseServiceError({ code: 'response_too_large', httpStatus: response.status, operation })
    }

    const body = response.body
    if (!body) return ''

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0

    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined)
                throw new LicenseServiceError({ code: 'response_too_large', httpStatus: response.status, operation })
            }
            chunks.push(value)
        }
    } finally {
        try {
            reader.releaseLock()
        } catch {
            // 已 cancel 时 releaseLock 可能抛错，忽略。
        }
    }

    if (!chunks.length) return ''
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(merged)
}

function parseJsonBody(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return undefined
    }
}

export function createLicenseServiceClient(options: LicenseServiceClientOptions): LicenseServiceClient {
    const base = normalizeLicenseServiceBaseUrl(options.baseUrl)
    if (!base.ok) {
        throw new LicenseServiceError({ code: 'config_error', cause: base.reason })
    }

    const apiKey = (options.apiKey || '').trim()
    if (!apiKey) throw new LicenseServiceError({ code: 'config_error', cause: 'api key is required' })

    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch)
    const timeoutMs = options.timeoutMs ?? LICENSE_SERVICE_DEFAULT_TIMEOUT_MS
    const maxResponseBytes = options.maxResponseBytes ?? LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES
    const requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID())
    const now = options.now ?? (() => Date.now())
    const baseUrl = base.baseUrl

    async function conflictFingerprint(code: string, body: unknown): Promise<string | null> {
        if (code !== 'idempotency_conflict' || body === undefined) return null
        try {
            return await fingerprintIdempotentRequest(body)
        } catch {
            // 诊断失败不能盖住已经收到的 HTTP 冲突。
            return null
        }
    }

    async function request({ operation, method, path, body, idempotencyKey, query }: RequestOptions): Promise<LicenseServiceResponse> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'X-Request-ID': requestIdFactory(),
        }

        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

        let payload: string | undefined
        if (body !== undefined) {
            payload = JSON.stringify(body)
            headers['Content-Type'] = 'application/json'
        }

        let url = buildLicenseServiceUrl(baseUrl, path)
        if (query) {
            const search = new URLSearchParams()
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== '') search.set(key, value)
            }
            const searchText = search.toString()
            if (searchText) url = `${url}?${searchText}`
        }

        let response: Response
        try {
            response = await fetchWithTimeout(url, {
                method,
                headers,
                body: payload,
                cache: 'no-store',
            }, timeoutMs, fetchImpl)
        } catch (error) {
            // fetch 抛错与超时都没有 HTTP 响应；统一折算成 network_error / timeout，
            // 两者都属于可重试类别，具体重试次数由调用方的退避策略决定。
            throw toLicenseServiceError(error, operation)
        }

        let text: string
        try {
            text = await readBodyCapped(response, maxResponseBytes, operation)
        } catch (error) {
            if (error instanceof LicenseServiceError) throw error
            throw new LicenseServiceError({
                code: 'invalid_response',
                httpStatus: response.status,
                operation,
                cause: (error as { message?: string } | null)?.message ?? null,
            })
        }

        const parsed = parseJsonBody(text)

        if (!response.ok) {
            const envelope = parseErrorEnvelope(parsed)
            const code = envelope.code ?? fallbackErrorCodeForStatus(response.status)
            const upgradeMessage = operation === 'allocateBatch' && response.status === 404
                ? '中心不支持 POST /allocations/batch，请升级中心后重试；客户端不会降级为多次 Allocate 请求。'
                : null
            const error = new LicenseServiceError({
                code,
                httpStatus: response.status,
                requestId: extractErrorRequestId(parsed, response.headers.get('X-Request-ID')),
                retryable: upgradeMessage ? false : envelope.retryable === true,
                operation,
                bodyFingerprint: await conflictFingerprint(code, body),
                retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After'), now()),
                cause: upgradeMessage ?? envelope.message,
            })
            if (upgradeMessage) error.message += `：${upgradeMessage}`
            throw error
        }

        const envelope = unwrapSuccessEnvelope(parsed)
        if (!envelope.ok) {
            throw new LicenseServiceError({
                code: 'invalid_response',
                httpStatus: response.status,
                requestId: extractErrorRequestId(parsed, response.headers.get('X-Request-ID')),
                operation,
                bodyFingerprint: null,
                cause: envelope.reason,
            })
        }

        return { payload: parsed, status: response.status }
    }

    return {
        baseUrl,

        async allocate(input) {
            const operation: LicenseServiceOperation = 'allocate'
            const programKey = requireNonEmpty(input.programKey, 'program_key', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)

            const quantity = input.quantity === undefined ? 1 : Math.trunc(input.quantity)
            if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
                localRequestError(operation, 'quantity must be an integer between 1 and 100')
            }
            if (input.externalRef !== undefined && input.externalRef.length > 128) {
                localRequestError(operation, 'external_ref must be at most 128 characters')
            }

            const response = await request({
                operation,
                method: 'POST',
                path: '/allocations',
                idempotencyKey: input.idempotencyKey,
                // 严格契约：服务端 `DisallowUnknownFields`，多一个字段就是 400。
                body: {
                    program_key: programKey,
                    quantity,
                    ...(input.externalRef ? { external_ref: input.externalRef } : {}),
                    ...(input.metadata ? { metadata: input.metadata } : {}),
                },
            })

            const detail = parseAllocationDetail(response.payload, {
                requireCardKeys: true,
                expectation: { programKey, quantity },
            })
            return takeParsed(detail, operation, response.status)
        },

        async allocateBatch(input) {
            const operation: LicenseServiceOperation = 'allocateBatch'
            const programKey = requireNonEmpty(input.programKey, 'program_key', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)
            const quantity = input.quantity
            if (quantity === undefined || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
                localRequestError(operation, 'quantity 必须是 1 到 100 之间的整数')
            }
            const externalRef = input.externalRef ?? ''
            if (typeof externalRef !== 'string' ||
                (externalRef !== '' && Array.from(externalRef).length + 1 + String(quantity).length > 128)) {
                localRequestError(operation, 'external_ref 加上冒号与最大子序号后不得超过 128 个 Unicode 字符')
            }

            const response = await request({
                operation,
                method: 'POST',
                path: '/allocations/batch',
                idempotencyKey: input.idempotencyKey,
                body: {
                    program_key: programKey,
                    quantity,
                    ...(externalRef ? { external_ref: externalRef } : {}),
                    ...(input.metadata ? { metadata: input.metadata } : {}),
                },
            })
            return takeParsed(parseAllocationBatch(response.payload, { programKey, quantity, externalRef }), operation, response.status)
        },

        async ack(input) {
            const operation: LicenseServiceOperation = 'ack'
            const allocationId = requireNonEmpty(input.allocationId, 'allocation_id', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)
            const cardIds = requireIds(input.receivedCardIds, 'received_card_ids', operation)

            const response = await request({
                operation,
                method: 'POST',
                path: `/allocations/${encodeURIComponent(allocationId)}/ack`,
                idempotencyKey: input.idempotencyKey,
                body: {
                    received_card_ids: [...cardIds],
                    ...(input.externalRef ? { external_ref: input.externalRef } : {}),
                },
            })

            return takeParsed(parseAllocationStatusUpdate(response.payload), operation, response.status)
        },

        async sell(input) {
            const operation: LicenseServiceOperation = 'sell'
            const allocationId = requireNonEmpty(input.allocationId, 'allocation_id', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)
            const cardIds = requireIds(input.cardIds, 'card_ids', operation)

            const response = await request({
                operation,
                method: 'POST',
                path: `/allocations/${encodeURIComponent(allocationId)}/sell`,
                idempotencyKey: input.idempotencyKey,
                body: {
                    card_ids: [...cardIds],
                    ...(input.externalRef ? { external_ref: input.externalRef } : {}),
                },
            })

            return takeParsed(parseAllocationStatusUpdate(response.payload), operation, response.status)
        },

        async cancel(input) {
            const operation: LicenseServiceOperation = 'cancel'
            const allocationId = requireNonEmpty(input.allocationId, 'allocation_id', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)
            const cardIds = requireIds(input.cardIds, 'card_ids', operation)
            requireNonEmpty(input.reason, 'reason', operation)

            const response = await request({
                operation,
                method: 'POST',
                path: `/allocations/${encodeURIComponent(allocationId)}/cancel`,
                idempotencyKey: input.idempotencyKey,
                body: { card_ids: [...cardIds], reason: input.reason },
            })

            return takeParsed(parseAllocationStatusUpdate(response.payload), operation, response.status)
        },

        async getAllocation(allocationId) {
            const operation: LicenseServiceOperation = 'getAllocation'
            const id = requireNonEmpty(allocationId, 'allocation_id', operation)

            const response = await request({
                operation,
                method: 'GET',
                path: `/allocations/${encodeURIComponent(id)}`,
            })

            // 单查接口**不返回明文**：`requireCardKeys: false` 会拒绝带 key 的响应。
            return takeParsed(parseAllocationDetail(response.payload, { requireCardKeys: false }), operation, response.status)
        },

        async listAllocations(query = {}) {
            const operation: LicenseServiceOperation = 'listAllocations'
            const params: Record<string, string> = {}
            if (query.externalRef !== undefined) params.external_ref = query.externalRef
            if (query.status !== undefined) params.status = query.status
            if (query.cursor !== undefined) params.cursor = query.cursor
            if (query.limit !== undefined) {
                const limit = Math.trunc(query.limit)
                if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
                    localRequestError(operation, 'limit must be an integer between 1 and 100')
                }
                params.limit = String(limit)
            }

            const response = await request({ operation, method: 'GET', path: '/allocations', query: params })
            return takeParsed(parseAllocationListPage(response.payload), operation, response.status)
        },

        async getCardStatus(cardId) {
            const operation: LicenseServiceOperation = 'getCardStatus'
            const id = requireNonEmpty(cardId, 'card_id', operation)

            const response = await request({
                operation,
                method: 'GET',
                path: `/cards/${encodeURIComponent(id)}/status`,
            })

            return takeParsed(parseCardStatus(response.payload), operation, response.status)
        },

        async revoke(cardId, input) {
            const operation: LicenseServiceOperation = 'revoke'
            const id = requireNonEmpty(cardId, 'card_id', operation)
            requireIdempotencyKey(input.idempotencyKey, operation)
            requireNonEmpty(input.reason, 'reason', operation)

            const response = await request({
                operation,
                method: 'POST',
                path: `/cards/${encodeURIComponent(id)}/revoke`,
                idempotencyKey: input.idempotencyKey,
                body: { reason: input.reason },
            })

            return takeParsed(parseRevokeResult(response.payload), operation, response.status)
        },
    }
}
