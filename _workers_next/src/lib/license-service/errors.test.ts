import test from 'node:test'
import assert from 'node:assert/strict'

import {
    classifyLicenseServiceError,
    isLicenseServiceError,
    isRetryableCategory,
    LicenseServiceError,
    requiresNewRestockTask,
    toLicenseServiceError,
    LICENSE_SERVICE_SERVER_ERROR_CODES,
    LICENSE_SERVICE_ERROR_CATEGORIES,
} from './errors.ts'
import { FetchTimeoutError } from '../runtime/fetch-with-timeout.ts'

test('每个服务端错误码都有归属类别，且类别取值合法', () => {
    for (const code of LICENSE_SERVICE_SERVER_ERROR_CODES) {
        const category = classifyLicenseServiceError(code, 400, false)
        assert.ok(
            (LICENSE_SERVICE_ERROR_CATEGORIES as readonly string[]).includes(category),
            `${code} 未映射到合法类别`,
        )
    }
})

test('超窗（allocation_expired）单独成类且不可重试：卡密已回池，只能换新任务', () => {
    const category = classifyLicenseServiceError('allocation_expired', 409, false)
    assert.equal(category, 'expired')
    assert.equal(isRetryableCategory(category), false)
    assert.equal(requiresNewRestockTask(category), true)

    const error = new LicenseServiceError({ code: 'allocation_expired', httpStatus: 409, retryable: false })
    assert.equal(error.category, 'expired')
    assert.equal(error.retryable, false)
})

test('冲突类错误不重试，凭据类错误不重试，暂时性错误才重试', () => {
    const cases: Array<[string, string]> = [
        ['idempotency_conflict', 'conflict'],
        ['allocation_conflict', 'conflict'],
        ['card_unavailable', 'conflict'],
        ['card_exhausted', 'conflict'],
        ['reservation_expired', 'conflict'],
        ['unauthorized', 'auth'],
        ['forbidden', 'auth'],
        ['program_not_allowed', 'auth'],
        ['invalid_request', 'request'],
        ['not_found', 'request'],
        ['rate_limited', 'unavailable'],
        ['temporarily_unavailable', 'unavailable'],
        ['internal_error', 'unavailable'],
    ]

    for (const [code, expected] of cases) {
        assert.equal(classifyLicenseServiceError(code, 409, false), expected, code)
        assert.equal(isRetryableCategory(expected), expected === 'unavailable', code)
    }
})

test('invalid_response 的归类看 HTTP 状态：5xx 是可重试，2xx 是确定性契约破坏', () => {
    assert.equal(classifyLicenseServiceError('invalid_response', 200, false), 'invalid')
    assert.equal(classifyLicenseServiceError('invalid_response', 502, false), 'unavailable')
    assert.equal(classifyLicenseServiceError('response_too_large', 200, false), 'invalid')
    assert.equal(classifyLicenseServiceError('response_too_large', 503, false), 'unavailable')
})

test('未知错误码不会被当成可重试，除非状态码本身就是暂时性错误', () => {
    assert.equal(classifyLicenseServiceError('brand_new_code', 400, false), 'unknown')
    assert.equal(classifyLicenseServiceError('brand_new_code', 429, false), 'unavailable')
    assert.equal(classifyLicenseServiceError('brand_new_code', 503, false), 'unavailable')
    assert.equal(classifyLicenseServiceError('brand_new_code', 400, true), 'unavailable')
    assert.equal(isRetryableCategory('unknown'), false)
})

test('本地错误码同样被归类，配置类错误不重试', () => {
    assert.equal(classifyLicenseServiceError('timeout', 0, false), 'unavailable')
    assert.equal(classifyLicenseServiceError('network_error', 0, false), 'unavailable')
    assert.equal(classifyLicenseServiceError('config_error', 0, false), 'config')
    assert.equal(classifyLicenseServiceError('revoke_key_missing', 0, false), 'config')
})

test('异常折算：FetchTimeoutError → timeout，fetch 的 TypeError → network_error', () => {
    const timeout = toLicenseServiceError(new FetchTimeoutError(8_000), 'allocate')
    assert.equal(timeout.code, 'timeout')
    assert.equal(timeout.httpStatus, 0)
    assert.equal(timeout.operation, 'allocate')
    assert.equal(timeout.category, 'unavailable')

    const network = toLicenseServiceError(new TypeError('fetch failed'), 'ack')
    assert.equal(network.code, 'network_error')
    assert.equal(network.category, 'unavailable')

    const already = new LicenseServiceError({ code: 'allocation_expired', httpStatus: 409 })
    assert.equal(toLicenseServiceError(already, 'ack'), already)
    assert.equal(isLicenseServiceError(already), true)
    assert.equal(isLicenseServiceError(new Error('x')), false)
})

test('toLogContext 只暴露脱敏字段，绝不带请求体、卡密或 Authorization', () => {
    const error = new LicenseServiceError({
        code: 'allocation_conflict',
        httpStatus: 409,
        requestId: 'req_01K',
        operation: 'ack',
        bodyFingerprint: 'abc123',
        cause: 'card id set does not match the allocation',
    })

    const context = error.toLogContext()
    assert.deepEqual(Object.keys(context).sort(), [
        'category',
        'code',
        'httpStatus',
        'operation',
        'requestId',
        'retryable',
    ])
    assert.equal(context.requestId, 'req_01K')
    // 指纹与 message 是刻意不进日志上下文的（指纹只在排查 409 时按需取用）。
    assert.equal(JSON.stringify(context).includes('CS-'), false)
    assert.equal(JSON.stringify(context).toLowerCase().includes('bearer'), false)
})
