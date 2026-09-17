/**
 * 审计事件目录：稳定的事件名、分类、严重级别与结果枚举。
 *
 * 为什么要有目录而不是随手写字符串：
 *   事件名会被**持久化并用于筛选**。一旦某个写操作写成 `user.login`、
 *   另一个写成 `auth.login`，后台筛选与统计就会静默漏数据 —— 而且这种错
 *   不会报错，只会「少显示几行」。因此所有事件名集中定义，并由单测保证
 *   实际写入方使用的名字都在目录内。
 *
 * 命名约定：`<域>.<动作>`，全小写点分。域按业务归属划分：
 *   auth / points / order / refund / coupon / admin
 */

/** 审计事件分类 */
export const AUDIT_CATEGORIES = ['auth', 'points', 'order', 'refund', 'coupon', 'admin'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

/** 审计结果 */
export const AUDIT_RESULTS = ['success', 'failure'] as const
export type AuditResult = (typeof AUDIT_RESULTS)[number]

/** 严重级别（与平台错误日志共用同一套取值，便于后台统一筛选） */
export const AUDIT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number]

/** 操作者类型：普通用户 / 管理员 / 系统（定时任务、支付回调等） */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system'] as const
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]

export interface AuditEventDefinition {
    name: string
    category: AuditCategory
    /** 默认严重级别；失败写入时由写入方按需提升 */
    severity: AuditSeverity
    targetType: string | null
    description: string
}

/**
 * 事件目录。
 *
 * 覆盖开发计划 §九「业务接入」列出的全部事件，外加管理员优惠券与手动发货。
 */
export const AUDIT_EVENT_DEFINITIONS: readonly AuditEventDefinition[] = [
    {
        name: 'auth.login',
        category: 'auth',
        severity: 'info',
        targetType: 'user',
        description: '用户登录成功或失败',
    },
    {
        name: 'points.checkin',
        category: 'points',
        severity: 'info',
        targetType: 'user',
        description: '每日签到积分发放',
    },
    {
        name: 'order.created',
        category: 'order',
        severity: 'info',
        targetType: 'order',
        description: '创建订单',
    },
    {
        name: 'order.paid',
        category: 'order',
        severity: 'info',
        targetType: 'order',
        description: '订单支付成功',
    },
    {
        name: 'order.fulfilled',
        category: 'order',
        severity: 'info',
        targetType: 'order',
        description: '订单发货完成（自动或手动）',
    },
    {
        name: 'refund.requested',
        category: 'refund',
        severity: 'info',
        targetType: 'refund',
        description: '用户提交退款申请',
    },
    {
        name: 'refund.approved',
        category: 'refund',
        severity: 'warning',
        targetType: 'refund',
        description: '管理员同意退款',
    },
    {
        name: 'refund.rejected',
        category: 'refund',
        severity: 'warning',
        targetType: 'refund',
        description: '管理员拒绝退款',
    },
    {
        name: 'refund.completed',
        category: 'refund',
        severity: 'warning',
        targetType: 'refund',
        description: '退款完成（可能触发积分返还）',
    },
    {
        name: 'admin.points.adjusted',
        category: 'admin',
        severity: 'warning',
        targetType: 'user',
        description: '管理员手动增减用户积分',
    },
    {
        name: 'admin.order.fulfillment',
        category: 'admin',
        severity: 'warning',
        targetType: 'order',
        description: '管理员手动发货',
    },
    {
        name: 'admin.error.handled',
        category: 'admin',
        severity: 'warning',
        targetType: 'platform_error',
        description: '管理员标记平台错误已处理',
    },
    {
        name: 'admin.error.reopened',
        category: 'admin',
        severity: 'warning',
        targetType: 'platform_error',
        description: '管理员重新打开平台错误',
    },
    {
        name: 'coupon.created',
        category: 'coupon',
        severity: 'warning',
        targetType: 'coupon',
        description: '管理员创建优惠券',
    },
    {
        name: 'coupon.updated',
        category: 'coupon',
        severity: 'warning',
        targetType: 'coupon',
        description: '管理员修改优惠券',
    },
    {
        name: 'database.upgrade',
        category: 'admin',
        severity: 'warning',
        targetType: 'database',
        description: '数据库升级执行结果',
    },
] as const

export const AUDIT_EVENT_NAMES = AUDIT_EVENT_DEFINITIONS.map((item) => item.name)

const AUDIT_EVENT_BY_NAME = new Map(AUDIT_EVENT_DEFINITIONS.map((item) => [item.name, item]))

/** isKnownAuditEvent 判断事件名是否在目录内（写入方契约校验用） */
export function isKnownAuditEvent(name: string): boolean {
    return AUDIT_EVENT_BY_NAME.has(name)
}

/** getAuditEventDefinition 读取事件定义；未注册事件返回 null */
export function getAuditEventDefinition(name: string): AuditEventDefinition | null {
    return AUDIT_EVENT_BY_NAME.get(name) ?? null
}

export interface AuditEventInput {
    eventName: string
    result?: AuditResult
    severity?: AuditSeverity
    actorType?: AuditActorType
    actorUserId?: string | null
    actorUsername?: string | null
    targetType?: string | null
    targetId?: string | null
    errorId?: string | null
    errorKey?: string | null
    source?: string | null
    /** 原始 IP（写入时哈希，不落明文） */
    ip?: string | null
    /** 原始邮箱（写入时哈希 + 掩码，不落明文） */
    email?: string | null
    userAgent?: string | null
    metadata?: unknown
}

export interface ResolvedAuditEvent {
    eventName: string
    category: AuditCategory
    severity: AuditSeverity
    result: AuditResult
    actorType: AuditActorType
    targetType: string | null
}

/**
 * resolveAuditEvent 把写入输入规范化成可持久化的字段集合（纯函数）。
 *
 * 未注册事件名：**保留原名**（便于发现遗漏），分类退化为 'admin'，
 * 严重级别退化为 'warning' 而不是 'info' —— 退化的记录比丢失的记录有用，
 * 且必须能在「只看 warning 以上」的筛选里被看到，否则写错事件名的代价
 * 就是这条日志永远不会被发现。
 *
 * 失败结果自动把级别提升到至少 'warning'：筛选「只看严重」时不该漏掉失败。
 * 显式传入的 severity 优先，不做降级。
 */
export function resolveAuditEvent(input: AuditEventInput): ResolvedAuditEvent {
    const definition = getAuditEventDefinition(input.eventName)
    const result: AuditResult = input.result === 'failure' ? 'failure' : 'success'

    const fallbackSeverity: AuditSeverity = definition ? definition.severity : 'warning'
    let severity: AuditSeverity = input.severity ?? fallbackSeverity
    if (result === 'failure' && severity === 'info') severity = 'warning'

    return {
        eventName: definition?.name ?? String(input.eventName ?? '').trim(),
        category: definition?.category ?? 'admin',
        severity,
        result,
        actorType: input.actorType ?? 'system',
        targetType: input.targetType ?? definition?.targetType ?? null,
    }
}
