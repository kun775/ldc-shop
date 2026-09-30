/**
 * 通用卡密服务的错误模型与分类。
 *
 * 契约（`docs/API.md` §3.2/§4）约定：错误信封为
 * `{ ok:false, error:{ code, message, retryable }, request_id }`，其中
 * **`request_id` 位于顶层**，`error` 内只有三个字段。本模块把「HTTP 响应」
 * 归一成携带稳定 `code` 与**处置类别**（category）的错误对象，调用方据此
 * 决定重试、放弃还是换新任务，而不是各自去解析状态码。
 *
 * 安全约束：错误对象不得携带卡密、Authorization 或响应原文，
 * 需要落日志时用 `toLogContext()`。
 */

import { FetchTimeoutError } from '../runtime/fetch-with-timeout.ts'

/** 服务端稳定错误码（`docs/API.md` §4），与实现 `internal/adapters/http/errors.go` 对齐。 */
export const LICENSE_SERVICE_SERVER_ERROR_CODES = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'idempotency_conflict',
    'reservation_conflict',
    'allocation_conflict',
    'allocation_expired',
    'card_unavailable',
    'card_exhausted',
    'card_expired',
    'reservation_expired',
    'program_not_allowed',
    'grant_invalid',
    'rate_limited',
    'internal_error',
    'temporarily_unavailable',
] as const

export type LicenseServiceServerErrorCode = (typeof LICENSE_SERVICE_SERVER_ERROR_CODES)[number]

/** 本地产生的错误码：网络、超时、契约不符、配置缺失等。 */
export const LICENSE_SERVICE_LOCAL_ERROR_CODES = [
    'network_error',
    'timeout',
    'invalid_response',
    'response_too_large',
    'config_error',
    'revoke_key_missing',
] as const

export type LicenseServiceLocalErrorCode = (typeof LICENSE_SERVICE_LOCAL_ERROR_CODES)[number]

export type LicenseServiceErrorCode = LicenseServiceServerErrorCode | LicenseServiceLocalErrorCode

/**
 * 处置类别 —— 调用方真正需要判断的东西。
 *
 *   expired      中心 Ack 窗口已过且卡密已被回收：本地副本必须作废并换新任务
 *   conflict     状态机/幂等冲突：停止重试，先查真实状态再决定
 *   auth         Scope/凭据不足：停止自动重试，转运维
 *   request      请求本身不合法（含 404）：代码缺陷，不重试
 *   invalid      响应不符合契约：不重试（5xx 时降级为 unavailable）
 *   config       本地配置缺失：不重试
 *   unavailable  429/503/超时/网络/5xx：按同幂等键退避重试
 *   unknown      未归类：保守按不重试处理，并产生可见告警
 */
export const LICENSE_SERVICE_ERROR_CATEGORIES = [
    'expired',
    'conflict',
    'auth',
    'request',
    'invalid',
    'config',
    'unavailable',
    'unknown',
] as const

export type LicenseServiceErrorCategory = (typeof LICENSE_SERVICE_ERROR_CATEGORIES)[number]

const SERVER_CODE_CATEGORY: Record<LicenseServiceServerErrorCode, LicenseServiceErrorCategory> = {
    invalid_request: 'request',
    unauthorized: 'auth',
    forbidden: 'auth',
    program_not_allowed: 'auth',
    not_found: 'request',
    idempotency_conflict: 'conflict',
    reservation_conflict: 'conflict',
    allocation_conflict: 'conflict',
    allocation_expired: 'expired',
    card_unavailable: 'conflict',
    card_exhausted: 'conflict',
    card_expired: 'conflict',
    reservation_expired: 'conflict',
    grant_invalid: 'conflict',
    rate_limited: 'unavailable',
    internal_error: 'unavailable',
    temporarily_unavailable: 'unavailable',
}

function isServerErrorCode(code: string): code is LicenseServiceServerErrorCode {
    return (LICENSE_SERVICE_SERVER_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * 把 `(code, httpStatus, retryable)` 映射为处置类别。
 *
 * `invalid_response` 单独处理：代理返回 502/504 时是暂时故障（可重试），
 * 而 200 上收到非法 JSON 属于确定性契约破坏（不重试）。
 */
export function classifyLicenseServiceError(
    code: string,
    httpStatus: number,
    retryable: boolean,
): LicenseServiceErrorCategory {
    if (isServerErrorCode(code)) return SERVER_CODE_CATEGORY[code]

    if (code === 'timeout' || code === 'network_error') return 'unavailable'
    if (code === 'response_too_large') return httpStatus >= 500 ? 'unavailable' : 'invalid'
    if (code === 'invalid_response') return httpStatus >= 500 ? 'unavailable' : 'invalid'
    if (code === 'config_error' || code === 'revoke_key_missing') return 'config'

    // 未知 code：仅当服务端显式声明可重试，或状态码本身是暂时性错误时才重试。
    if (retryable) return 'unavailable'
    if (httpStatus === 429 || httpStatus === 408 || httpStatus >= 500) return 'unavailable'
    return 'unknown'
}

/** 只有 `unavailable` 类别允许按同一幂等键自动重试。 */
export function isRetryableCategory(category: LicenseServiceErrorCategory) {
    return category === 'unavailable'
}

/** 需要「作废本地副本 + 换新任务」的类别。 */
export function requiresNewRestockTask(category: LicenseServiceErrorCategory) {
    return category === 'expired'
}

export interface LicenseServiceErrorInit {
    /**
     * 服务端码或本地码。
     *
     * 类型放宽为 `string` 而非上面的联合类型：错误码清单由中心演进，客户端
     * 遇到未见过的 code 必须能如实把它带出来（并落到 `unknown` 类别），
     * 而不是在类型层被拦下后丢掉诊断信息。
     */
    code: string
    /** 无 HTTP 响应（网络/超时/本地校验失败）时传 0。 */
    httpStatus?: number
    requestId?: string | null
    retryable?: boolean
    operation?: string | null
    /** 幂等请求体指纹，用于排查 `idempotency_conflict`。不含卡密。 */
    bodyFingerprint?: string | null
    /** 折算出的退避时长（毫秒），来自 `Retry-After`。 */
    retryAfterMs?: number | null
    /** 服务端 message；只用于运维展示，不得据此分支。 */
    cause?: string | null
}

export class LicenseServiceError extends Error {
    readonly code: string
    readonly httpStatus: number
    readonly requestId: string | null
    readonly retryable: boolean
    readonly category: LicenseServiceErrorCategory
    readonly operation: string | null
    readonly bodyFingerprint: string | null
    readonly retryAfterMs: number | null
    /** 服务端原始 message（已由服务端保证不含 Secret）；不要用于程序分支。 */
    readonly causeMessage: string | null

    constructor(init: LicenseServiceErrorInit) {
        const httpStatus = init.httpStatus ?? 0
        const category = classifyLicenseServiceError(init.code, httpStatus, init.retryable === true)
        super(`license-service ${init.operation ? `${init.operation} ` : ''}${init.code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`)
        this.name = 'LicenseServiceError'
        this.code = init.code
        this.httpStatus = httpStatus
        this.requestId = init.requestId ?? null
        this.retryable = init.retryable ?? isRetryableCategory(category)
        this.category = category
        this.operation = init.operation ?? null
        this.bodyFingerprint = init.bodyFingerprint ?? null
        this.retryAfterMs = init.retryAfterMs ?? null
        this.causeMessage = init.cause ?? null
    }

    /**
     * 结构化日志用上下文。**刻意不包含**请求体、响应体、卡密与 Authorization：
     * 卡密只在暂存表里出现，绝不能经由错误日志外流。
     */
    toLogContext() {
        return {
            code: this.code,
            category: this.category,
            httpStatus: this.httpStatus,
            requestId: this.requestId,
            operation: this.operation,
            retryable: this.retryable,
        }
    }
}

export function isLicenseServiceError(error: unknown): error is LicenseServiceError {
    return error instanceof LicenseServiceError
}

/**
 * 把任意异常折算成 `LicenseServiceError`。
 *
 * `fetch` 在 Workers 上抛的是 `TypeError`，超时由 `fetchWithTimeout` 抛
 * `FetchTimeoutError`；两者都没有 HTTP 响应，因此 `httpStatus = 0`。
 */
export function toLicenseServiceError(error: unknown, operation?: string): LicenseServiceError {
    if (isLicenseServiceError(error)) return error

    const name = (error as { name?: string } | null)?.name
    if (error instanceof FetchTimeoutError || name === 'FetchTimeoutError') {
        return new LicenseServiceError({ code: 'timeout', operation: operation ?? null })
    }

    return new LicenseServiceError({
        code: 'network_error',
        operation: operation ?? null,
        cause: (error as { message?: string } | null)?.message ?? null,
    })
}
