import { logServerError } from '@/lib/errors/safe-error'
import { getAuditRequestContext } from './request-context'
import {
    recordFailure,
    writeAuditEvent,
    writePlatformError,
    type PlatformErrorInput,
} from './service'
import type { AuditEventInput } from './events'

type RequestFields = Pick<AuditEventInput, 'ip' | 'userAgent'>

export type ServerErrorAuditOptions = Omit<
    PlatformErrorInput,
    'scope' | 'error' | 'errorId' | 'ip' | 'userAgent' | 'method' | 'path'
> & {
    auditEvent?: Omit<AuditEventInput, 'result' | 'errorId' | 'ip' | 'userAgent'>
}

/**
 * 为业务审计补充当前请求上下文。
 *
 * 写入服务本身永不抛出；这里也保持 best-effort，避免审计影响原业务结果。
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
    const context = await getAuditRequestContext()
    await writeAuditEvent({
        ...input,
        ip: input.ip ?? context.ip,
        userAgent: input.userAgent ?? context.userAgent,
    })
}

/**
 * 记录服务端错误并返回用户可见 errorId。
 *
 * 与旧的 console-only `logServerError` 相比，本函数会同步等待 best-effort
 * 平台日志写入，确保 Cloudflare 请求结束前日志已经提交；若传入 auditEvent，
 * 同时写入一条失败的用户操作审计。
 */
export async function recordServerError(
    scope: string,
    error: unknown,
    options: ServerErrorAuditOptions = {},
): Promise<string> {
    const errorId = logServerError(scope, error, undefined, { persist: false })
    const context = await getAuditRequestContext()
    const requestFields: RequestFields = {
        ip: context.ip,
        userAgent: context.userAgent,
    }

    if (options.auditEvent) {
        await recordFailure({
            ...options.auditEvent,
            ...requestFields,
            error,
            errorId,
            scope,
            method: context.method,
            path: context.path,
        })
        return errorId
    }

    await writePlatformError({
        scope,
        error,
        errorId,
        severity: options.severity,
        actorType: options.actorType,
        actorUserId: options.actorUserId,
        actorUsername: options.actorUsername,
        metadata: options.metadata,
        method: context.method,
        path: context.path,
        ...requestFields,
    })
    return errorId
}
