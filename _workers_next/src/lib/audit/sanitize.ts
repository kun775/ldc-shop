import { createHash } from 'crypto'

/**
 * 审计日志脱敏、截断与错误指纹（纯函数，不访问数据库）。
 *
 * 为什么单独成文件：
 *   脱敏是**安全边界**，必须能被单测逐条覆盖。生产事故里最危险的不是
 *   「日志写少了」，而是「日志把凭据写进去了」—— 审计表一旦落库，卡密、
 *   Token、SQL 绑定参数就会被后台页面原样展示，等于把可用凭据发给了管理员
 *   终端和任何能读到这张表的人。
 *
 * 约定：
 *   - 白名单式输出：`metadata` 只保留允许的键，未知键一律丢弃（不是过滤敏感词，
 *     而是默认不写）。敏感词黑名单永远会漏，白名单不会。
 *   - 文本类字段统一走 `redactText()`：先替换已知凭据模式，再截断。
 *   - 邮箱与 IP 不做明文存储，只存盐化哈希 + 可选掩码，兼顾「可关联」与「不可还原」。
 *   - 单条记录必须有长度上限：D1 单行写入有大小限制，超长堆栈会直接让
 *     整条日志写入失败 —— 而失败又会触发新的错误记录，形成放大效应。
 */

/** 单条审计事件 metadata 的上限 */
export const AUDIT_METADATA_MAX_LENGTH = 2000
/** 错误消息上限 */
export const AUDIT_MESSAGE_MAX_LENGTH = 800
/** 错误链（cause 串联）上限 */
export const AUDIT_ERROR_CHAIN_MAX_LENGTH = 1500
/** 堆栈上限 —— 只保留最有价值的头部帧 */
export const AUDIT_STACK_MAX_LENGTH = 2000
/** User-Agent 上限 */
export const AUDIT_USER_AGENT_MAX_LENGTH = 200

/**
 * 允许写入审计 metadata 的键白名单。
 *
 * 只写「业务排障确实需要」的字段。任何未列出的键都不会出现在日志里，
 * 因此新增业务字段若需要审计，必须显式加到这里 —— 这个「麻烦」是有意的：
 * 它把「不小心写入敏感数据」变成一个必须主动决定的行为。
 */
export const AUDIT_METADATA_ALLOWED_KEYS: readonly string[] = [
    'orderId',
    'productId',
    'productName',
    'amount',
    'amountCents',
    'currency',
    'status',
    'previousStatus',
    'nextStatus',
    'direction',
    'points',
    'balanceAfter',
    'delta',
    'couponId',
    'couponCode',
    'couponCount',
    'discountAmountCents',
    'subtotalAmountCents',
    'pointsDiscountAmountCents',
    'paymentAmount',
    'refundId',
    'refundAmount',
    'refundStatus',
    'fulfillmentMode',
    'deliveryFileCount',
    'cardCount',
    'reason',
    'channel',
    'provider',
    'userId',
    'username',
    'quantity',
    'variants',
    'durationMs',
    'attemptCount',
    'itemCount',
    'changedFields',
    'errorKey',
    'errorId',
    'noteLength',
]

/**
 * 必须整体替换为占位符的模式。
 *
 * 顺序重要：
 *   1. Authorization 整行先吃掉（`Authorization: Bearer xxx` 的值模式若只
 *      匹配到第一个 token，会把真正的密钥留在原文里）；
 *   2. 再处理其它 key=value 与 Cookie；
 *   3. JWT / 长十六进制等无 key 的独立凭据最后处理。
 *
 * **值字符类必须排除 `[`**：这些规则会依次作用于同一段文本，而本模块产出的
 * 占位符形如 `[redacted]`。若 `[` 未被排除，后续规则会把刚插入的
 * `[redacted` 当成新的「值」再次替换，产出 `[redacted]]` 这类畸形结果
 * （已由单测 `redactText is idempotent` 守护）。
 */
const CREDENTIAL_VALUE_CHARS = '[^\\s"\'&,;}\\[\\]]'

const CREDENTIAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
    // Authorization 头：整行替换。注意**不能**把值模式写成「非空白 token」，
    // 否则 `Authorization: Bearer <secret>` 只会吃掉 "Bearer" 而漏掉密钥。
    { pattern: /\b(authorization|proxy-authorization)\b\s*[:=]\s*[^\n\r]+/gi, replacement: '$1=[redacted]' },
    // Basic/Bearer 出现在非 Authorization 上下文时（如日志片段）。
    // 刻意不含 `digest`：它与英文单词 digest（摘要）冲突，会把
    // 「digest 长十六进制」这条真实凭据误判成方案名而走错替换分支。
    { pattern: /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{6,}/gi, replacement: '$1=[redacted]' },
    // Cookie / Set-Cookie 整行
    { pattern: /\b(cookie|set-cookie)\b\s*[:=]\s*[^\n\r]+/gi, replacement: '$1=[redacted]' },
    // 常见 key=value / key: value 形式的凭据。
    // 单独出现的 `token` 也纳入：漏掉的代价远高于偶尔过度脱敏。
    { pattern: new RegExp(`\\b(authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|sign|signature|private[_-]?key)\\b\\s*[:=]\\s*("?)(${CREDENTIAL_VALUE_CHARS}{3,})\\2`, 'gi'), replacement: '$1=[redacted]' },
    // 常见会话 cookie 名
    { pattern: new RegExp(`\\b(authjs[._-][A-Za-z0-9._-]+|next-auth[._-][A-Za-z0-9._-]+|ldc_pending_order|session|sessionid|csrf[_-]?token)\\b\\s*[:=]\\s*${CREDENTIAL_VALUE_CHARS}+`, 'gi'), replacement: '$1=[redacted]' },
    // 卡密 / 兑换码 / 卡号（业务凭据，绝不可入库）
    { pattern: new RegExp(`\\b(card[_-]?key|card[_-]?no|cardkey|license[_-]?key|redeem[_-]?code|serial[_-]?number)\\b\\s*[:=]\\s*("?)(${CREDENTIAL_VALUE_CHARS}{3,})\\2`, 'gi'), replacement: '$1=[redacted]' },
    // 支付网关密钥
    { pattern: new RegExp(`\\b(epay[_-]?key|merchant[_-]?key|pay[_-]?key|app[_-]?secret|mch[_-]?key)\\b\\s*[:=]\\s*("?)(${CREDENTIAL_VALUE_CHARS}{3,})\\2`, 'gi'), replacement: '$1=[redacted]' },
    // JWT（三段 base64url）
    { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replacement: '[redacted-jwt]' },
    // 长十六进制串（如密钥、签名摘要）
    { pattern: /\b[a-f0-9]{40,}\b/gi, replacement: '[redacted-hash]' },
    // 邮箱明文
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[redacted-email]' },
    // IPv4（含端口）
    { pattern: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, replacement: '[redacted-ip]' },
    // IPv6（简化：含冒号的十六进制组）
    { pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, replacement: '[redacted-ip]' },
]

/**
 * SQL 语句与其绑定参数的清理。
 *
 * Drizzle/D1 的错误消息形如：
 *   `Failed query: insert into "user_point_ledger" (...) params: 10785,...`
 * 这类文本既泄漏表结构，也泄漏参数值（可能包含邮箱、卡密）。直接整体替换。
 */
const SQL_PATTERNS: ReadonlyArray<RegExp> = [
    /failed query:\s*[\s\S]*/gi,
    /\bparams?\s*:\s*[^\n\r]*/gi,
    /\binsert\s+into\b[\s\S]*?(?:\bvalues\b[\s\S]*)?/gi,
    /\b(update|delete\s+from)\b[\s\S]*?(?:\bwhere\b[\s\S]*)?/gi,
    /\bselect\b[\s\S]*?\bfrom\b[\s\S]*/gi,
    /\bon\s+conflict\b[\s\S]*/gi,
    /\breturning\s+[^\n\r]*/gi,
    /\bsqlite_[a-z_]+\b/gi,
    /\bd1_[a-z_]+\b/gi,
    /\bno such (table|column|index)\b[^\n\r]*/gi,
]

export interface SanitizeTextOptions {
    /** 截断长度，默认取 AUDIT_MESSAGE_MAX_LENGTH */
    maxLength?: number
    /** 是否执行 SQL 结构清理（错误消息默认执行） */
    stripSql?: boolean
}

/**
 * redactText 清理任意文本中的凭据、邮箱、IP 与 SQL 片段。
 *
 * 注意：这是**纵深防御的一层**，不是安全保证。真正保证「凭据不落库」的是
 * 调用方只传白名单字段（见 `sanitizeMetadata`）。
 */
export function redactText(input: unknown, options: SanitizeTextOptions = {}): string {
    const { maxLength = AUDIT_MESSAGE_MAX_LENGTH, stripSql = true } = options
    let text = typeof input === 'string' ? input : String(input ?? '')
    if (!text) return ''

    for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
        text = text.replace(pattern, replacement)
    }
    if (stripSql) {
        for (const pattern of SQL_PATTERNS) {
            text = text.replace(pattern, '[redacted-sql]')
        }
    }
    // 收敛连续占位符，避免出现 [redacted-sql] [redacted-sql] [redacted-sql]
    text = text.replace(/(\[redacted-[a-z]+\])(?:\s*\1)+/g, '$1')

    return truncateText(text.trim(), maxLength)
}

/**
 * truncateText 按字符截断并标注省略。
 *
 * 用 `slice`（UTF-16 码元）而非按字节切分：截断点可能落在代理对中间，
 * 因此额外剔除末尾的孤立高位代理，避免产生非法字符串导致 JSON 序列化异常。
 *
 * 边界：`maxLength` 小于省略标记长度时，**只返回省略标记**。
 * 这里必须显式处理 —— 若照搬「先切片再拼后缀」，结果会比上限更长，
 * 在最严格的字段（如 8 字符的简短标识）上反而放大体积，与调用意图相反。
 */
export function truncateText(text: string, maxLength: number): string {
    if (!Number.isFinite(maxLength) || maxLength <= 0) return ''
    if (text.length <= maxLength) return text

    const suffix = '…[truncated]'
    if (maxLength <= suffix.length) return suffix.slice(0, maxLength)

    const keep = maxLength - suffix.length
    const cut = text.slice(0, keep)
    const lastCode = cut.charCodeAt(cut.length - 1)
    const safeCut = lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut
    return `${safeCut}${suffix}`
}

const AUDIT_SALT_SETTING_ENV_KEYS = ['AUDIT_LOG_SALT', 'NEXTAUTH_SECRET', 'OAUTH_CLIENT_SECRET'] as const

function resolveAuditSalt(): string {
    for (const key of AUDIT_SALT_SETTING_ENV_KEYS) {
        const value = process.env[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    // 未配置盐时仍必须产出稳定哈希（否则无法按用户/IP 关联），
    // 因此退化为固定前缀而不是随机盐。这属于「可关联性 > 抗彩虹表」的取舍：
    // 明文本身已经在同一条记录里被替换掉，哈希只用于聚合与统计。
    return 'ldc-shop-audit'
}

/**
 * hashIdentifier 对邮箱、IP 等标识做盐化哈希。
 *
 * 不返回明文也不返回可逆编码；同值必然同哈希，因此仍可按用户/IP 聚合，
 * 但无法从日志反推出原始值。
 */
export function hashIdentifier(value: unknown): string | null {
    const text = String(value ?? '').trim()
    if (!text) return null
    // 已经是占位符的输入不再二次哈希，避免 [redacted-email] 变成无意义的哈希值
    if (text.startsWith('[redacted')) return null
    return createHash('sha256')
        .update(`${resolveAuditSalt()}::${text.toLowerCase()}`)
        .digest('hex')
        .slice(0, 32)
}

/** maskEmail 生成可直接展示的邮箱掩码（脱敏后仍需让管理员认出是谁） */
export function maskEmail(value: unknown): string | null {
    const text = String(value ?? '').trim()
    if (!text || text.startsWith('[redacted')) return null
    const at = text.lastIndexOf('@')
    // 非邮箱形态（没有 @ 或 @ 在首位）：按输入原样截断展示，
    // **不走邮箱掩码**，否则会把普通标识压成单纯的省略标记而丢失信息
    if (at <= 0) return truncateText(text, 32)
    const local = text.slice(0, at)
    const domain = text.slice(at + 1)
    const head = local.slice(0, 1)
    return `${head}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`
}

/**
 * sanitizeMetadata 按白名单提取 metadata 并序列化。
 *
 * 返回 null 表示没有任何可写字段 —— 调用方应写入 null 而不是 '{}'，
 * 便于后台区分「无元数据」与「元数据为空对象」。
 */
export function sanitizeMetadata(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null

    const output: Record<string, string | number | boolean | null> = {}
    const source = metadata as Record<string, unknown>

    for (const key of AUDIT_METADATA_ALLOWED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue
        const value = source[key]
        if (value === undefined) continue

        if (value === null || typeof value === 'number' || typeof value === 'boolean') {
            output[key] = value
            continue
        }
        if (typeof value === 'string') {
            // 白名单键里的字符串仍要脱敏：`reason` 是自由文本，管理员可能粘贴了卡密
            output[key] = redactText(value, { maxLength: 300, stripSql: false })
            continue
        }
        if (Array.isArray(value)) {
            const items = value
                .filter((item) => item === null || typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string')
                .slice(0, 20)
                .map((item) => (typeof item === 'string'
                    ? redactText(item, { maxLength: 100, stripSql: false })
                    : item))
            output[key] = items.join(',')
            continue
        }
        // 嵌套对象一律丢弃：白名单只覆盖扁平业务字段，
        // 允许嵌套就等于允许把任意结构带进日志（包括敏感字段）。
    }

    if (Object.keys(output).length === 0) return null

    let serialized: string
    try {
        serialized = JSON.stringify(output)
    } catch {
        return null
    }
    return truncateText(serialized, AUDIT_METADATA_MAX_LENGTH)
}

/**
 * normalizeFingerprintSource 把变化的部分抹平，使「同一个错误」能稳定聚合。
 *
 * 否则一个带自增 id、订单号或时间戳的错误消息，每次都是新指纹，聚合完全失效
 * —— 而聚合失效的后果是错误列表刷屏，管理员反而看不见正在爆发的那个问题。
 *
 * 归一顺序：先具体（邮箱/IP/UUID/十六进制），再通用（日期、长 ID、纯数字）。
 * 顺序错会让通用规则先吃掉具体结构，产出无意义的占位符串。
 */
export function normalizeFingerprintSource(input: unknown): string {
    let text = String(input ?? '').trim()
    if (!text) return ''
    text = text.toLowerCase()
    text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<ip>')
    text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    text = text.replace(/\b[a-f0-9]{16,}\b/g, '<hex>')
    // ISO 日期时间：必须先于「长 ID」规则，否则 `2026-09-17t10:30:00` 会被
    // 拆成若干段无意义占位符
    text = text.replace(/\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>')
    // 含字母与数字的长标识（订单号 ORD…、退款号、交易号、优惠券编码等）。
    // 两个前置断言分别要求「至少一个字母」和「至少一个数字」，
    // 避免把普通英文单词或纯数字误伤成 <id>。
    text = text.replace(/\b(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]{8,}\b/g, '<id>')
    text = text.replace(/\b\d{4,}\b/g, '<n>')
    text = text.replace(/[?&][A-Za-z0-9_\-%]+=[^\s&]*/g, '?<query>')
    text = text.replace(/\s+/g, ' ')
    return truncateText(text, 400)
}

/**
 * buildErrorFingerprint 生成错误指纹（用于聚合）。
 *
 * 组成：范围 + 错误码 + 归一化消息。三者都为空时回退到固定串，
 * 保证唯一索引不会因为 null 而失效（SQLite 唯一索引对 NULL 不去重）。
 */
export function buildErrorFingerprint(input: {
    scope: string
    errorCode?: string | null
    message?: string | null
}): string {
    const scope = String(input.scope ?? '').trim().toLowerCase() || 'unknown'
    const code = String(input.errorCode ?? '').trim().toLowerCase()
    const message = normalizeFingerprintSource(input.message)
    const source = `${scope}|${code}|${message}`
    return createHash('sha256').update(source).digest('hex').slice(0, 32)
}

/** 错误聚合窗口：同指纹在此窗口内只累加计数，不新增行 */
export const ERROR_AGGREGATION_WINDOW_MS = 10 * 60 * 1000

/**
 * buildFingerprintBucket 计算聚合时间桶。
 *
 * 桶值越界会破坏唯一索引语义，因此对非有限输入回退为 0。
 */
export function buildFingerprintBucket(
    nowMs: number,
    windowMs: number = ERROR_AGGREGATION_WINDOW_MS,
): number {
    if (!Number.isFinite(nowMs) || nowMs <= 0) return 0
    const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : ERROR_AGGREGATION_WINDOW_MS
    return Math.floor(nowMs / window)
}
