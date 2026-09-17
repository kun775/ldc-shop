import { collectErrorText } from './error-utils.ts'

/**
 * 数据库结构错误判定（共享工具）。
 *
 * 背景: 读取路径历史上用「文本里含 no such table / does not exist」判断结构缺失，
 * 然后把异常吞成 `null`。这带来两个后果：
 *   1. `does not exist` 过宽 —— 驱动版本、网络层的偶发错误也可能命中，
 *      业务错误会被伪装成「记录不存在」，用户看到 404 而不是可追踪的失败；
 *   2. 结构缺失被静默吞掉 —— 本该触发一次幂等结构修复，却直接返回空结果。
 *
 * 因此这里把判定拆成三个语义明确的函数：
 *   - isMissingRelationError: 表/视图不存在（需要补结构）
 *   - isMissingColumnError:   列不存在（需要补列）
 *   - isMissingSchemaError:   以上两者之一（需要补结构）
 *
 * 只有明确的表/列结构错误才返回 true；网络、限流、超时、语法错误一律 false，
 * 避免把偶发失败升级为一次结构迁移。
 */

const RELATION_PATTERNS: RegExp[] = [
    /no such table/i,
    /no such view/i,
    /d1_relation_notfound/i,
    /(relation|table|view)[^.]{0,40}does not exist/i,
    /\b42p01\b/,
]

const COLUMN_PATTERNS: RegExp[] = [
    /no such column/i,
    /column not found/i,
    /d1_column_notfound/i,
    /\bcolumn\b[^.]{0,40}does not exist/i,
    /\b42703\b/,
]

export function isMissingRelationError(error: unknown): boolean {
    const text = collectErrorText(error)
    return RELATION_PATTERNS.some((pattern) => pattern.test(text))
}

export function isMissingColumnError(error: unknown): boolean {
    const text = collectErrorText(error)
    return COLUMN_PATTERNS.some((pattern) => pattern.test(text))
}

export function isMissingSchemaError(error: unknown): boolean {
    return isMissingRelationError(error) || isMissingColumnError(error)
}
