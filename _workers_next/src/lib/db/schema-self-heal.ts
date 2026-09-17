import { isMissingColumnError, isMissingRelationError, isMissingSchemaError } from './schema-errors.ts'

/**
 * 读取路径的「结构自愈并重试一次」执行器（共享工具）。
 *
 * 为什么需要它：
 *   历史实现把「缺表/缺列」的异常静默吞成空结果或 null，用户看到的是
 *   「暂无数据」或 404，而真正的结构漂移永远不会被修复；另一侧又把
 *   任意异常（网络、限流、超时）误判成结构问题，导致偶发失败被升级成
 *   一次全量迁移。这里把策略收敛为一处，输入输出都显式化。
 *
 * 契约（与 schema-drift 的既有约定一致）：
 *   1. 只有 `isSchemaError` 判定为真才执行修复，其余异常原样抛出；
 *   2. 修复只执行一次，且必须幂等；修复后重跑原操作，仍失败则抛出重跑的错误；
 *   3. 修复自身失败时，抛出**原始结构错误**而不是修复错误 ——
 *      原始错误才是「缺了什么」的权威描述，便于日志对账；
 *   4. 本模块不依赖任何运行时上下文（不 import db），因此可被单测直接加载。
 *
 * 注意：判定函数默认使用 `isMissingSchemaError`（严格模式），
 * 不接受「does not exist」等宽泛文本匹配。
 */

export interface SchemaSelfHealOptions<T> {
    /** 原始读取操作 */
    run: () => Promise<T>
    /** 幂等结构修复操作（CREATE/ALTER ... IF NOT EXISTS 等） */
    repair: () => Promise<void>
    /** 结构错误判定，默认 isMissingSchemaError */
    isSchemaError?: (error: unknown) => boolean
    /** 日志前缀，便于区分模块 */
    label?: string
}

export interface SchemaSelfHealResult<T> {
    value: T
    /** 本次是否触发了结构修复（供上层决定是否上报/记录） */
    repaired: boolean
}

export async function runWithSchemaSelfHeal<T>(
    options: SchemaSelfHealOptions<T>
): Promise<SchemaSelfHealResult<T>> {
    const {
        run,
        repair,
        isSchemaError = isMissingSchemaError,
        label = 'Schema',
    } = options

    try {
        return { value: await run(), repaired: false }
    } catch (error) {
        if (!isSchemaError(error)) throw error

        // 缺列与缺表在日志里区分开，便于判断是「表没建」还是「列没补」
        const missingObject = isMissingColumnError(error) && !isMissingRelationError(error)
            ? 'column'
            : 'relation'
        console.warn(`[${label}] missing ${missingObject}, running idempotent repair`, error)

        try {
            await repair()
        } catch (repairError) {
            console.error(`[${label}] idempotent repair failed`, repairError)
            throw error
        }

        return { value: await run(), repaired: true }
    }
}

/**
 * 便捷包装：只取返回值，忽略 repaired 标记。
 */
export async function withSchemaSelfHeal<T>(options: SchemaSelfHealOptions<T>): Promise<T> {
    const result = await runWithSchemaSelfHeal(options)
    return result.value
}

export { isMissingColumnError, isMissingRelationError, isMissingSchemaError }
