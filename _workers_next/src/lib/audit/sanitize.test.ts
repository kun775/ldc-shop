import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./sanitize.ts', import.meta.url).href)
const {
    AUDIT_METADATA_ALLOWED_KEYS,
    AUDIT_METADATA_MAX_LENGTH,
    AUDIT_MESSAGE_MAX_LENGTH,
    AUDIT_STACK_MAX_LENGTH,
    buildErrorFingerprint,
    buildFingerprintBucket,
    hashIdentifier,
    maskEmail,
    normalizeFingerprintSource,
    redactText,
    sanitizeMetadata,
    truncateText,
    ERROR_AGGREGATION_WINDOW_MS,
} = mod

test('redactText is idempotent', () => {
    // 各规则依次作用于同一段文本，本模块自身产出的 [redacted] 占位符
    // 绝不能被后续规则再次吃掉。否则会出现 `[redacted]]` 这类畸形输出 ——
    // 曾因值字符类未排除 `[` 而真实发生。
    const samples = [
        'Authorization: Bearer abcdef1234567890',
        'api_key=abcd1234efgh',
        'card_key=LDC-AAAA-BBBB-CCCC',
        'Cookie: authjs.session-token=abc123def456',
        'user alice@example.com from 203.0.113.42',
        'Failed query: insert into "t" values (null, ?) params: 10785,alice@example.com',
    ]
    for (const sample of samples) {
        const once = redactText(sample)
        const twice = redactText(once)
        assert.equal(twice, once, `not idempotent for: ${sample}\n once=${once}\n twice=${twice}`)
        assert.ok(!/\]\]/.test(once), `malformed placeholder for: ${sample} -> ${once}`)
    }
})

test('redactText removes authorization credentials', () => {
    // Authorization 整行替换：把值模式写成「非空白 token」会只吃掉 "Bearer"
    // 而把真正的密钥留在原文里，这里固化正确行为。
    assert.equal(redactText('Authorization: Bearer abcdef1234567890'), 'Authorization=[redacted]')
    assert.equal(redactText('authorization = "Bearer sk-live-abcdefghijklmn"'), 'authorization=[redacted]')
    assert.ok(!redactText('authorization: Basic dXNlcjpwYXNzd29yZA==').includes('dXNlcjpwYXNzd29yZA'))
    assert.ok(!redactText('token=abcdef123456').includes('abcdef123456'))

    // Bearer 出现在非 Authorization 上下文（日志片段）时仍要脱敏
    assert.ok(!redactText('sent Bearer abcdef1234567890 upstream').includes('abcdef1234567890'))
})

test('redactText removes common secret key=value pairs', () => {
    const cases: Array<[string, string]> = [
        ['api_key=abcd1234efgh', 'abcd1234efgh'],
        ['apiKey: zzzz9999yyyy', 'zzzz9999yyyy'],
        ['client_secret=supersecretvalue', 'supersecretvalue'],
        ['password=hunter2hunter2', 'hunter2hunter2'],
        ['sign=deadbeefcafe1234', 'deadbeefcafe1234'],
        ['access_token=abcdef123456', 'abcdef123456'],
    ]
    for (const [sample, secret] of cases) {
        const output = redactText(sample)
        assert.ok(output.includes('[redacted]'), `expected redaction for: ${sample} (got ${output})`)
        assert.ok(!output.includes(secret), `secret leaked for: ${sample} (got ${output})`)
    }
})

test('redactText removes card keys and payment gateway secrets', () => {
    for (const sample of [
        'card_key=LDC-AAAA-BBBB-CCCC',
        'cardkey: 1234-5678-9012-3456',
        'redeem_code=XXXXYYYYZZZZ',
        'epay_key=abcd1234abcd1234',
        'merchant_key=zzzz8888zzzz8888',
    ]) {
        const output = redactText(sample)
        assert.ok(
            !/AAAA-BBBB-CCCC|1234-5678-9012-3456|XXXXYYYYZZZZ|abcd1234abcd1234|zzzz8888zzzz8888/.test(output),
            `card/secret leaked for: ${sample} (got ${output})`,
        )
    }
})

test('redactText removes cookies and session identifiers', () => {
    const output = redactText('Cookie: authjs.session-token=abc123def456; theme=dark')
    assert.ok(!output.includes('abc123def456'), output)
    assert.ok(output.includes('[redacted]'), output)

    const pending = redactText('ldc_pending_order=ORD123456789')
    assert.ok(!pending.includes('ORD123456789'), pending)
})

test('redactText removes JWTs and long hex digests', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    assert.equal(redactText(`token ${jwt}`).includes('eyJhbGciOiJIUzI1NiJ9'), false)
    // 40+ 位十六进制（密钥/摘要）必须整体替换。这里刻意用英文词 digest 而非
    // `digest <hex>`：`digest` 曾是 Bearer/Basic 规则里的方案名，会把值模式
    // 写成「非空白 token」从而漏掉真正的密钥，因此该规则已移除。
    const hashed = redactText('hash 0123456789abcdef0123456789abcdef01234567')
    assert.ok(hashed.includes('[redacted-hash]'), hashed)
    assert.ok(!hashed.includes('0123456789abcdef'), hashed)
})

test('redactText removes plaintext emails and IP addresses', () => {
    const output = redactText('user alice@example.com from 203.0.113.42:5321 failed')
    assert.ok(!output.includes('alice@example.com'), output)
    assert.ok(!output.includes('203.0.113.42'), output)
    assert.ok(output.includes('[redacted-email]'), output)
    assert.ok(output.includes('[redacted-ip]'), output)
})

test('redactText strips SQL statements and binding parameters', () => {
    const drizzleError = 'Failed query: insert into "user_point_ledger" ("id", "user_id") values (null, ?, ?) params: 10785,alice@example.com'
    const output = redactText(drizzleError)
    assert.ok(!/\binsert\s+into\b/i.test(output), `SQL leaked: ${output}`)
    assert.ok(!output.includes('alice@example.com'), `param leaked: ${output}`)
    assert.ok(!output.includes('user_point_ledger'), `table leaked: ${output}`)

    const noSuch = redactText('no such column: checkout_field_values')
    assert.ok(!noSuch.includes('checkout_field_values'), noSuch)
})

test('redactText collapses repeated placeholders', () => {
    const output = redactText('Failed query: select * from t params: 1 no such table: t')
    assert.ok(!/\[redacted-sql\]\s*\[redacted-sql\]/.test(output), output)
})

test('truncateText marks truncation and never splits a surrogate pair', () => {
    const long = 'a'.repeat(50)
    const cut = truncateText(long, 20)
    assert.ok(cut.length <= 20, `length ${cut.length}`)
    assert.ok(cut.endsWith('…[truncated]'))

    // 代理对（emoji）在截断点处必须被剔除，否则会产生非法字符串
    const emoji = '😀'.repeat(20)
    const emojiCut = truncateText(emoji, 10)
    assert.ok(!/[\uD800-\uDBFF]$/.test(emojiCut), 'trailing high surrogate must be dropped')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(emojiCut), 'leading low surrogate must not appear')

    assert.equal(truncateText('short', 20), 'short')
    assert.equal(truncateText('anything', 0), '')
})

test('redactText enforces the message length cap', () => {
    const output = redactText('x'.repeat(5000))
    assert.ok(output.length <= AUDIT_MESSAGE_MAX_LENGTH, `length ${output.length}`)
})

test('sanitizeMetadata only keeps whitelisted keys', () => {
    const output = sanitizeMetadata({
        orderId: 'ORD1',
        points: 10,
        amountCents: 9900,
        status: 'paid',
        // 以下都不在白名单内，必须被丢弃
        cardKey: 'LDC-SECRET-KEY',
        authorization: 'Bearer abcdefghijkl',
        cookie: 'authjs.session-token=secretvalue',
        email: 'alice@example.com',
        nested: { token: 'x' },
    })
    assert.ok(output, 'expected metadata output')
    const parsed = JSON.parse(output)
    assert.equal(parsed.orderId, 'ORD1')
    assert.equal(parsed.points, 10)
    assert.equal(parsed.amountCents, 9900)
    assert.equal(parsed.cardKey, undefined)
    assert.equal(parsed.authorization, undefined)
    assert.equal(parsed.cookie, undefined)
    assert.equal(parsed.email, undefined)
    assert.equal(parsed.nested, undefined)
    assert.ok(!output.includes('LDC-SECRET-KEY'), output)
})

test('sanitizeMetadata redacts free-text whitelisted fields', () => {
    // reason 是白名单字段，但管理员可能把卡密粘贴进去
    const output = sanitizeMetadata({ reason: 'refund for card_key=LDC-AAAA-BBBB-CCCC' })
    assert.ok(output)
    assert.ok(!output.includes('LDC-AAAA-BBBB-CCCC'), `leaked: ${output}`)
})

test('sanitizeMetadata returns null instead of an empty object', () => {
    assert.equal(sanitizeMetadata(undefined), null)
    assert.equal(sanitizeMetadata(null), null)
    assert.equal(sanitizeMetadata('text'), null)
    assert.equal(sanitizeMetadata([]), null)
    assert.equal(sanitizeMetadata({ unknownFieldOnly: 1 }), null)
})

test('sanitizeMetadata truncates oversized payloads', () => {
    const output = sanitizeMetadata({ reason: 'y'.repeat(5000) })
    assert.ok(output)
    assert.ok(output.length <= AUDIT_METADATA_MAX_LENGTH, `length ${output.length}`)
})

test('metadata whitelist never contains lookalike credential keys', () => {
    for (const key of AUDIT_METADATA_ALLOWED_KEYS) {
        assert.ok(
            !/password|secret|token|cookie|authorization|card[_-]?key/i.test(key),
            `whitelist must not include credential-looking key: ${key}`,
        )
    }
})

test('hashIdentifier is stable, salted and never returns the input', () => {
    const first = hashIdentifier('alice@example.com')
    const second = hashIdentifier('ALICE@example.com')
    assert.ok(first)
    assert.equal(first, second, 'case-insensitive hashing keeps aggregation stable')
    assert.ok(!first.includes('alice'))
    assert.equal(first.length, 32)
    assert.notEqual(first, hashIdentifier('bob@example.com'))
    assert.equal(hashIdentifier(''), null)
    assert.equal(hashIdentifier(null), null)
})

test('hashIdentifier ignores already-redacted input', () => {
    // 否则 [redacted-email] 会被哈希成一个固定的伪身份，污染聚合口径
    assert.equal(hashIdentifier('[redacted-email]'), null)
})

test('maskEmail keeps the domain recognisable but hides the local part', () => {
    assert.equal(maskEmail('alice@example.com'), 'a***@example.com')
    assert.equal(maskEmail('a@example.com'), 'a*@example.com')
    // 非邮箱形态按原样截断而不是压成纯省略标记，避免丢失可辨识信息
    assert.equal(maskEmail('not-an-email'), 'not-an-email')
    assert.equal(maskEmail('[redacted-email]'), null)
    assert.equal(maskEmail(''), null)
})

test('normalizeFingerprintSource collapses volatile identifiers', () => {
    const a = normalizeFingerprintSource('Order ORD123456789 failed for alice@example.com at 2026-09-17')
    const b = normalizeFingerprintSource('Order ORD987654321 failed for bob@example.com at 2026-09-16')
    assert.equal(a, b, 'volatile parts must normalize away')

    assert.ok(!normalizeFingerprintSource('from 203.0.113.42').includes('203.0.113.42'))
    assert.ok(!normalizeFingerprintSource('id 0f8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d').includes('0f8b1c2d'))
    assert.ok(!normalizeFingerprintSource('uuid 123e4567-e89b-12d3-a456-426614174000').includes('123e4567'))
    assert.ok(!normalizeFingerprintSource('at 2026-09-17T10:30:00Z').includes('2026-09-17'))
})

test('normalizeFingerprintSource keeps plain words intact', () => {
    // 长 ID 规则必须要求「同时含字母和数字」，否则英文单词会被误伤
    const value = normalizeFingerprintSource('connection refused by upstream')
    assert.ok(value.includes('connection'), value)
    assert.ok(value.includes('upstream'), value)
    assert.ok(!value.includes('<id>'), value)
})

test('buildErrorFingerprint is stable for the same error and differs across scope', () => {
    const base = buildErrorFingerprint({ scope: 'checkin', errorCode: 'POINT_BALANCE_NEGATIVE', message: 'insufficient' })
    const same = buildErrorFingerprint({ scope: 'checkin', errorCode: 'POINT_BALANCE_NEGATIVE', message: 'insufficient' })
    const otherScope = buildErrorFingerprint({ scope: 'checkout', errorCode: 'POINT_BALANCE_NEGATIVE', message: 'insufficient' })
    const otherCode = buildErrorFingerprint({ scope: 'checkin', errorCode: 'POINT_LEDGER_CLAIM_FAILED', message: 'insufficient' })

    assert.equal(base, same)
    assert.equal(base.length, 32)
    assert.notEqual(base, otherScope)
    assert.notEqual(base, otherCode)
})

test('buildErrorFingerprint differentiates messages within the same scope', () => {
    const a = buildErrorFingerprint({ scope: 'api', errorCode: 'E', message: 'connection refused' })
    const b = buildErrorFingerprint({ scope: 'api', errorCode: 'E', message: 'timeout exceeded' })
    assert.notEqual(a, b)
})

test('buildErrorFingerprint never returns an empty fingerprint', () => {
    // 空字符串会让唯一索引意义上的「未知错误」全部折叠或全部散开，
    // 必须始终产出稳定的固定长度哈希
    for (const input of [
        { scope: '' },
        { scope: 'x', errorCode: null, message: null },
        { scope: '   ', errorCode: '  ', message: '   ' },
    ]) {
        const value = buildErrorFingerprint(input)
        assert.equal(typeof value, 'string')
        assert.equal(value.length, 32)
        assert.ok(/^[0-9a-f]{32}$/.test(value), value)
    }
    assert.equal(
        buildErrorFingerprint({ scope: '' }),
        buildErrorFingerprint({ scope: '   ' }),
        'blank scopes must collapse into the same fingerprint source',
    )
})

test('buildFingerprintBucket groups errors inside the same window', () => {
    const window = ERROR_AGGREGATION_WINDOW_MS
    // 基准必须落在窗口边界上，否则 now 与 now+window-1 会跨桶：
    // `floor(t/w)` 的分组由 t 相对窗口起点的偏移决定，取任意时刻做基准
    // 会让「同一窗口」的断言在边界处失效。
    const base = Math.floor(1_700_000_000_000 / window) * window
    assert.equal(buildFingerprintBucket(base), buildFingerprintBucket(base + window - 1))
    assert.equal(buildFingerprintBucket(base) + 1, buildFingerprintBucket(base + window))
})

test('truncateText never exceeds the cap even for tiny limits', () => {
    // 曾出现的缺陷：maxLength 小于省略标记长度时结果反而比上限更长
    for (const limit of [1, 2, 5, 11, 12, 13]) {
        const output = truncateText('abcdefghijklmnopqrstuvwxyz', limit)
        assert.ok(output.length <= limit, `limit=${limit} produced length ${output.length}: ${output}`)
    }
    assert.equal(truncateText('longer-than-limit', 4).length, 4)
})

test('buildFingerprintBucket falls back safely for invalid input', () => {
    assert.equal(buildFingerprintBucket(NaN), 0)
    assert.equal(buildFingerprintBucket(0), 0)
    assert.equal(buildFingerprintBucket(-1), 0)
    // 非法窗口不得产生 NaN（NaN 会让唯一索引比较全部失败）
    assert.equal(Number.isFinite(buildFingerprintBucket(1_700_000_000_000, NaN)), true)
    assert.equal(Number.isFinite(buildFingerprintBucket(1_700_000_000_000, 0)), true)
})

test('stack and user-agent caps keep single-row size bounded', () => {
    assert.ok(AUDIT_STACK_MAX_LENGTH > 0 && AUDIT_STACK_MAX_LENGTH <= 4000)
    assert.ok(AUDIT_METADATA_MAX_LENGTH <= 4000)
    assert.ok(AUDIT_MESSAGE_MAX_LENGTH <= 2000)
})
