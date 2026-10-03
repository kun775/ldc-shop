/**
 * 翻译插值。
 *
 * 没有占位符时直接返回原文，不为 currencyUnit 这类总会传入的参数编译正则。
 * 占位符按参数顺序替换；先替换的值里即使含有 `{{name}}` 或 `$`，
 * 也不会被后续参数再次解释。
 */
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

export function interpolateTranslation(
    text: string,
    params?: Record<string, string | number>,
): string {
    if (!params || !text.includes('{{')) return text
    return text.replace(PLACEHOLDER, (match, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(params, name)) return match
        return String(params[name])
    })
}
