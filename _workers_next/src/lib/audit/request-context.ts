/**
 * 审计上下文采集：从当前请求中提取 IP、User-Agent、方法与路径。
 *
 * 为什么独立成文件：
 *   `next/headers` 只能在请求作用域内调用，且在定时任务、构建期、
 *   单元测试里会抛异常。审计是**旁路**，采集上下文失败绝不能影响业务，
 *   因此这里把所有取值都包在 try/catch 里，任何失败都退化为「无上下文」。
 *
 * 安全约定：
 *   本模块**只返回原始值**，不做脱敏。脱敏发生在写入层
 *   （`service.ts` 里 hashIdentifier / redactText），因为哈希需要盐，
 *   而盐来自环境变量，属于写入层的职责。
 */

export interface AuditRequestContext {
    ip: string | null
    userAgent: string | null
    method: string | null
    path: string | null
}

const EMPTY_CONTEXT: AuditRequestContext = {
    ip: null,
    userAgent: null,
    method: null,
    path: null,
}

/**
 * 从转发头中取客户端 IP。
 *
 * 顺序遵循 Cloudflare 与通用代理约定：
 *   CF-Connecting-IP 是 Cloudflare 写入的、不可被客户端伪造；
 *   X-Forwarded-For 可取第一段；X-Real-IP 作最后兜底。
 * 取不到时返回 null，而不是回退成空字符串 —— 空字符串会被哈希成
 * 一个固定的「伪 IP」，让所有无 IP 的记录聚成同一实体。
 */
export function resolveClientIp(headers: Headers): string | null {
    const candidates = [
        headers.get('cf-connecting-ip'),
        headers.get('x-forwarded-for')?.split(',')[0],
        headers.get('x-real-ip'),
    ]
    for (const candidate of candidates) {
        const value = String(candidate ?? '').trim()
        if (value) return value
    }
    return null
}

/**
 * getAuditRequestContext 读取当前请求上下文。
 *
 * 任何异常（非请求作用域、无 headers、字段缺失）都返回空上下文。
 */
export async function getAuditRequestContext(): Promise<AuditRequestContext> {
    try {
        const { headers } = await import('next/headers')
        const headerList = await headers()

        let path: string | null = null
        try {
            const { pathname } = new URL(headerList.get('referer') || '')
            path = pathname || null
        } catch {
            path = null
        }

        return {
            ip: resolveClientIp(headerList),
            userAgent: headerList.get('user-agent'),
            method: headerList.get('x-http-method-override') || null,
            path,
        }
    } catch {
        return EMPTY_CONTEXT
    }
}

export { EMPTY_CONTEXT as EMPTY_AUDIT_CONTEXT }
