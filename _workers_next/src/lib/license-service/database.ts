/**
 * D1 适配层：`db-port.ts` 里那个「读若干行 + 一次原子写多行」端口的具体实现。
 *
 * 本文件是 license-service 模块里唯一与 D1 耦合的地方，因此不做源码级单测。
 * 语句本身（DDL、原子批次、守卫）由 `restock.test.ts` / `reconcile.test.ts`
 * 用真实 SQLite 覆盖 —— 那里跑的正是这些 SQL 原文。
 */

import { getD1Database, runAtomicD1Batch } from '@/lib/db'
import type { CardServiceDatabase, CardServiceWriteResult } from './db-port.ts'

export type {
    CardServiceDatabase,
    CardServiceStatement,
    CardServiceWriteResult,
} from './db-port.ts'

function toWriteResult(raw: unknown): CardServiceWriteResult {
    const meta = (raw as { meta?: { last_row_id?: unknown; changes?: unknown } } | null)?.meta
    const lastRowId = Number(meta?.last_row_id)
    const changes = Number(meta?.changes)
    return {
        lastRowId: Number.isFinite(lastRowId) && lastRowId > 0 ? lastRowId : null,
        changes: Number.isFinite(changes) ? changes : 0,
    }
}

export function createD1CardServiceDatabase(): CardServiceDatabase {
    return {
        async query<T>(sql: string, params?: readonly unknown[]) {
            const client = await getD1Database()
            const statement = client.prepare(sql)
            const bound = params?.length ? statement.bind(...(params as unknown[])) : statement
            const result = await bound.all()
            return ((result?.results ?? []) as T[])
        },

        async write(statements) {
            if (!statements.length) return []
            // runAtomicD1Batch 已保证「整批原子、任一失败全批回滚」，
            // 不要在这里改成分条执行。
            const results = await runAtomicD1Batch(
                statements.map((statement) => ({ query: statement.sql, bindings: statement.params })),
            )
            return (results as unknown[]).map(toWriteResult)
        },
    }
}
