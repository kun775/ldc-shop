import test from 'node:test'
import assert from 'node:assert/strict'

import {
    buildLicenseServiceUrl,
    describeLicenseServiceConfig,
    normalizeLicenseServiceBaseUrl,
    resolveLicenseServiceConfig,
    LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES,
    LICENSE_SERVICE_DEFAULT_TIMEOUT_MS,
    LICENSE_SERVICE_ENV_API_KEY,
    LICENSE_SERVICE_ENV_BASE_URL,
    LICENSE_SERVICE_ENV_REVOKE_API_KEY,
    LICENSE_SERVICE_MAX_TIMEOUT_MS,
    LICENSE_SERVICE_MIN_TIMEOUT_MS,
} from './config.ts'

test('Base URL 必须存在且为 HTTPS：缺省、非 URL、HTTP 一律拒绝', () => {
    assert.deepEqual(normalizeLicenseServiceBaseUrl(undefined), { ok: false, reason: 'missing_base_url' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('   '), { ok: false, reason: 'missing_base_url' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('not a url'), { ok: false, reason: 'invalid_base_url' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('http://lks.example.com'), { ok: false, reason: 'insecure_base_url' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('ftp://lks.example.com'), { ok: false, reason: 'insecure_base_url' })
})

test('Base URL 不得携带凭据、Query 或 Fragment（SSRF 与密钥外泄面）', () => {
    assert.deepEqual(
        normalizeLicenseServiceBaseUrl('https://user:pass@lks.example.com'),
        { ok: false, reason: 'insecure_base_url' },
    )
    assert.deepEqual(
        normalizeLicenseServiceBaseUrl('https://lks.example.com?target=10.0.0.1'),
        { ok: false, reason: 'insecure_base_url' },
    )
    assert.deepEqual(
        normalizeLicenseServiceBaseUrl('https://lks.example.com#frag'),
        { ok: false, reason: 'insecure_base_url' },
    )
})

test('Base URL 规范化：去尾部斜杠，并吞掉误写的 /api/v1，避免拼成双层路径', () => {
    assert.deepEqual(normalizeLicenseServiceBaseUrl('https://lks.example.com/'), { ok: true, baseUrl: 'https://lks.example.com' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('https://lks.example.com///'), { ok: true, baseUrl: 'https://lks.example.com' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('https://lks.example.com/api/v1'), { ok: true, baseUrl: 'https://lks.example.com' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('https://lks.example.com/api/v1/'), { ok: true, baseUrl: 'https://lks.example.com' })
    assert.deepEqual(normalizeLicenseServiceBaseUrl('https://gw.example.com/lks/'), { ok: true, baseUrl: 'https://gw.example.com/lks' })
    assert.deepEqual(
        normalizeLicenseServiceBaseUrl('https://gw.example.com/lks/api/v1'),
        { ok: true, baseUrl: 'https://gw.example.com/lks' },
    )
})

test('配置解析：缺 API Key 失败，齐全时给出默认超时与响应上限', () => {
    const missingKey = resolveLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
    })
    assert.deepEqual(missingKey, { ok: false, reason: 'missing_api_key' })

    const ok = resolveLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
    })
    assert.equal(ok.ok, true)
    assert.ok(ok.ok)
    assert.deepEqual(ok.config, {
        baseUrl: 'https://lks.example.com',
        apiKey: 'cs_live_sales',
        revokeApiKey: null,
        timeoutMs: LICENSE_SERVICE_DEFAULT_TIMEOUT_MS,
        maxResponseBytes: LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES,
    })

    const withRevoke = resolveLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
        // 作废 Key 必须签在原销售 Client 上（N5），这里只校验它被单独读取。
        [LICENSE_SERVICE_ENV_REVOKE_API_KEY]: 'cs_live_revoke',
    })
    assert.ok(withRevoke.ok)
    assert.equal(withRevoke.config.revokeApiKey, 'cs_live_revoke')
})

test('超时被夹在安全区间内，非法值回落默认', () => {
    const env = {
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
    }
    const clamp = (value: number) => {
        const result = resolveLicenseServiceConfig(env, { timeoutMs: value })
        assert.ok(result.ok)
        return result.config.timeoutMs
    }

    assert.equal(clamp(100), LICENSE_SERVICE_MIN_TIMEOUT_MS)
    assert.equal(clamp(600_000), LICENSE_SERVICE_MAX_TIMEOUT_MS)
    assert.equal(clamp(Number.NaN), LICENSE_SERVICE_DEFAULT_TIMEOUT_MS)
    assert.equal(clamp(4_321.9), 4_321)
})

test('URL 拼接只在 base 与 /api/v1 之间加一层，路径参数由调用方给出', () => {
    assert.equal(buildLicenseServiceUrl('https://lks.example.com', '/allocations'), 'https://lks.example.com/api/v1/allocations')
    assert.equal(buildLicenseServiceUrl('https://lks.example.com', 'allocations'), 'https://lks.example.com/api/v1/allocations')
    assert.equal(
        buildLicenseServiceUrl('https://gw.example.com/lks', '/cards/card_01/revoke'),
        'https://gw.example.com/lks/api/v1/cards/card_01/revoke',
    )
})

// ---------------------------------------------------------------------------
// describeLicenseServiceConfig（运维面板展示用）
// ---------------------------------------------------------------------------

test('配置齐全时状态为可用，并保留独立的作废 Key 标记', () => {
    const status = describeLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com/',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
        [LICENSE_SERVICE_ENV_REVOKE_API_KEY]: 'cs_live_revoke',
    })

    assert.equal(status.configured, true)
    assert.deepEqual(status.missing, [])
    assert.equal(status.reason, null)
    assert.equal(status.revokeKeyPresent, true)
    // Base URL 已规范化（去尾斜杠），且不含 `/api/v1`。
    assert.equal(status.baseUrl, 'https://lks.example.com')
})

test('销售 Key 可用但缺作废 Key 时仍算可用，只是 revokeKeyPresent 为 false', () => {
    const status = describeLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
    })

    assert.equal(status.configured, true)
    assert.equal(status.revokeKeyPresent, false)
})

test('缺失项被逐项列出，且 reason 指向第一个卡点', () => {
    const blank = describeLicenseServiceConfig({})
    assert.equal(blank.configured, false)
    assert.deepEqual(blank.missing, ['base_url', 'api_key'])
    assert.equal(blank.reason, 'missing_base_url')
    assert.equal(blank.baseUrl, null)

    const noKey = describeLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
    })
    assert.deepEqual(noKey.missing, ['api_key'])
    assert.equal(noKey.reason, 'missing_api_key')
})

test('非 HTTPS 的 Base URL 归类为 base_url 缺失，不泄露原始取值', () => {
    const status = describeLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'http://user:pass@lks.example.com/?token=leak',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
    })

    assert.equal(status.configured, false)
    assert.deepEqual(status.missing, ['base_url'])
    assert.equal(status.reason, 'insecure_base_url')
    assert.equal(status.baseUrl, null)
})

test('状态对象任何字段都不回显密钥取值', () => {
    const serialized = JSON.stringify(describeLicenseServiceConfig({
        [LICENSE_SERVICE_ENV_BASE_URL]: 'https://lks.example.com',
        [LICENSE_SERVICE_ENV_API_KEY]: 'cs_live_sales',
        [LICENSE_SERVICE_ENV_REVOKE_API_KEY]: 'cs_live_revoke',
    }))

    assert.equal(serialized.includes('cs_live'), false)
})
