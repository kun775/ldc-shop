/**
 * 数据库端口（纯类型 + 纯函数）。
 *
 * 与 `database.ts` 分开的原因很具体：本文件必须能被 `node --test` 直接加载，
 * 而 `database.ts` 要 `import { getD1Database } from '@/lib/db'` —— `@/` 别名在
 * 测试运行器里解析不了。业务模块因此只依赖这里的端口，D1 的具体实现留给
 * `database.ts` 的单一工厂。
 *
 * 端口只有两个方法：
 *   - `query`：按列名读若干行；
 *   - `write`：**整批原子**地执行多条写语句。
 *
 * 「Ack 成功后才把卡搬进可售库存」这条不变式完全依赖 `write` 的原子性，
 * 所以端口刻意不提供「逐条写」的入口。
 */

export interface CardServiceStatement {
    sql: string
    params?: readonly unknown[]
}

export interface CardServiceWriteResult {
    /** `INSERT` 后新行的 rowid；其它语句为 `null`。 */
    lastRowId: number | null
    changes: number
}

export interface CardServiceDatabase {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
    write(statements: readonly CardServiceStatement[]): Promise<CardServiceWriteResult[]>
}

/**
 * 判断异常是否为「表不存在」。
 *
 * 阶段 B 的 `0038_license_service_ledger` 需要管理员手动执行，在「代码已发布、
 * 升级未执行」的窗口内这几张表确实不存在。读取路径必须把它当成「功能未启用」
 * 而不是崩溃。
 */
export function isMissingTableError(error: unknown): boolean {
    if (!error) return false
    const text = `${(error as { message?: string } | null)?.message ?? ''} ${safeStringify(error)}`.toLowerCase()
    return text.includes('no such table')
}

function safeStringify(value: unknown) {
    try {
        return JSON.stringify(value) ?? ''
    } catch {
        return ''
    }
}
