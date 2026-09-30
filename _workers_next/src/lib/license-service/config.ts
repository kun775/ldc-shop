/**
 * 通用卡密服务（license-key-service）的运行时配置解析。
 *
 * 凭据**只**从 Worker Secret（`process.env`）读取，理由与阶段 B 一致：
 * D1 `settings` 会被管理端组件读取并进入全量数据导出，API Key 一旦落库
 * 就等于同时泄露给浏览器与备份文件。
 *
 * Base URL 必须是受控的 HTTPS 固定域名，不允许商品管理员填任意目标：
 * 否则一个被改写的商品配置就能让 Worker 带着 Bearer Key 去请求内网地址
 * （SSRF）。这里在解析阶段就把协议、凭据部分、Query 与 Fragment 全部否掉。
 */

export const LICENSE_SERVICE_API_PATH = '/api/v1'

export const LICENSE_SERVICE_ENV_BASE_URL = 'LICENSE_SERVICE_BASE_URL'
export const LICENSE_SERVICE_ENV_API_KEY = 'LICENSE_SERVICE_API_KEY'

export const LICENSE_SERVICE_DEFAULT_TIMEOUT_MS = 10_000
export const LICENSE_SERVICE_MIN_TIMEOUT_MS = 1_000
export const LICENSE_SERVICE_MAX_TIMEOUT_MS = 30_000
export const LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024

export interface LicenseServiceConfig {
    /** 形如 `https://lks.example.com`，已去除尾部斜杠，且不含 `/api/v1`。 */
    baseUrl: string
    apiKey: string
    timeoutMs: number
    maxResponseBytes: number
}

export type LicenseServiceConfigFailure =
    | 'missing_base_url'
    | 'invalid_base_url'
    | 'insecure_base_url'
    | 'missing_api_key'

export type LicenseServiceBaseUrlResult =
    | { ok: true; baseUrl: string }
    | { ok: false; reason: LicenseServiceConfigFailure }

export type LicenseServiceConfigResult =
    | { ok: true; config: LicenseServiceConfig }
    | { ok: false; reason: LicenseServiceConfigFailure }

/** 面向运维的中文说明；只应记录该文案与 `reason`，不要回显原始环境变量值。 */
export const LICENSE_SERVICE_CONFIG_FAILURE_MESSAGES: Record<LicenseServiceConfigFailure, string> = {
    missing_base_url: '未配置 LICENSE_SERVICE_BASE_URL，通用卡密服务不可用',
    invalid_base_url: 'LICENSE_SERVICE_BASE_URL 不是合法的绝对 URL',
    insecure_base_url: 'LICENSE_SERVICE_BASE_URL 必须使用 HTTPS，且不得携带凭据、Query 或 Fragment',
    missing_api_key: '未配置 LICENSE_SERVICE_API_KEY，通用卡密服务不可用',
}

function normalizeTimeout(value: number | undefined, fallback: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const rounded = Math.trunc(value)
    if (rounded < LICENSE_SERVICE_MIN_TIMEOUT_MS) return LICENSE_SERVICE_MIN_TIMEOUT_MS
    if (rounded > LICENSE_SERVICE_MAX_TIMEOUT_MS) return LICENSE_SERVICE_MAX_TIMEOUT_MS
    return rounded
}

/**
 * 解析并校验 Base URL。
 *
 * 只接受 `https:`、无用户名/密码、无 Query、无 Fragment 的绝对地址。
 * 路径部分允许存在（反向代理挂在前缀下），但 `/api/v1` 由本模块统一拼接，
 * 因此运维若把 `/api/v1` 也写进环境变量，这里会去掉，避免拼成
 * `/api/v1/api/v1`。
 */
export function normalizeLicenseServiceBaseUrl(raw: string | null | undefined): LicenseServiceBaseUrlResult {
    const trimmed = (raw || '').trim()
    if (!trimmed) return { ok: false, reason: 'missing_base_url' }

    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        return { ok: false, reason: 'invalid_base_url' }
    }

    if (url.protocol !== 'https:') return { ok: false, reason: 'insecure_base_url' }
    if (!url.hostname) return { ok: false, reason: 'invalid_base_url' }
    if (url.username || url.password) return { ok: false, reason: 'insecure_base_url' }
    if (url.search || url.hash) return { ok: false, reason: 'insecure_base_url' }

    let pathname = url.pathname.replace(/\/+$/, '')
    if (pathname === LICENSE_SERVICE_API_PATH) pathname = ''
    else if (pathname.endsWith(LICENSE_SERVICE_API_PATH)) {
        pathname = pathname.slice(0, -LICENSE_SERVICE_API_PATH.length).replace(/\/+$/, '')
    }

    return { ok: true, baseUrl: `${url.origin}${pathname}` }
}

export interface ResolveLicenseServiceConfigOptions {
    timeoutMs?: number
    maxResponseBytes?: number
}

export function resolveLicenseServiceConfig(
    env: Record<string, string | undefined> = process.env,
    options: ResolveLicenseServiceConfigOptions = {},
): LicenseServiceConfigResult {
    const base = normalizeLicenseServiceBaseUrl(env[LICENSE_SERVICE_ENV_BASE_URL])
    if (!base.ok) return { ok: false, reason: base.reason }

    const apiKey = (env[LICENSE_SERVICE_ENV_API_KEY] || '').trim()
    if (!apiKey) return { ok: false, reason: 'missing_api_key' }

    return {
        ok: true,
        config: {
            baseUrl: base.baseUrl,
            apiKey,
            timeoutMs: normalizeTimeout(options.timeoutMs, LICENSE_SERVICE_DEFAULT_TIMEOUT_MS),
            maxResponseBytes: options.maxResponseBytes && options.maxResponseBytes > 0
                ? Math.trunc(options.maxResponseBytes)
                : LICENSE_SERVICE_DEFAULT_MAX_RESPONSE_BYTES,
        },
    }
}

/** 拼接业务接口地址，避免调用方各自拼字符串拼出 `//api/v1` 或漏掉前缀。 */
export function buildLicenseServiceUrl(baseUrl: string, path: string) {
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${baseUrl}${LICENSE_SERVICE_API_PATH}${suffix}`
}

/** 运维面板要展示的必填项（**只有名称，绝不含取值**）。 */
export type LicenseServiceMissingSetting = 'base_url' | 'api_key'

export interface LicenseServiceConfigStatus {
    /** 中心调用是否可用（Base URL + API Key 齐备）。 */
    configured: boolean
    /** 缺失或不合法的必填项。 */
    missing: LicenseServiceMissingSetting[]
    /** 不满足时的具体原因；configured 为 true 时为 `null`。 */
    reason: LicenseServiceConfigFailure | null
    /** API Key 是否已填写；权限由服务端在请求时校验。 */
    apiKeyPresent: boolean
    /** 规范化后的 Base URL（公开信息，不含凭据）。未配置为 `null`。 */
    baseUrl: string | null
}

/**
 * 汇总配置状态供运维面板展示。
 *
 * 刻意与 `resolveLicenseServiceConfig` 分开：后者的契约是「不可用就失败」，
 * 而面板需要的是「哪里没配、差在哪一步」，并且**任何情况下都不能回显密钥**。
 */
export function describeLicenseServiceConfig(
    env: Record<string, string | undefined> = process.env,
): LicenseServiceConfigStatus {
    const base = normalizeLicenseServiceBaseUrl(env[LICENSE_SERVICE_ENV_BASE_URL])
    const apiKey = (env[LICENSE_SERVICE_ENV_API_KEY] || '').trim()

    const missing: LicenseServiceMissingSetting[] = []
    if (!base.ok) missing.push('base_url')
    if (!apiKey) missing.push('api_key')

    const reason: LicenseServiceConfigFailure | null = !base.ok
        ? base.reason
        : (!apiKey ? 'missing_api_key' : null)

    return {
        configured: base.ok && Boolean(apiKey),
        missing,
        reason,
        apiKeyPresent: Boolean(apiKey),
        baseUrl: base.ok ? base.baseUrl : null,
    }
}
