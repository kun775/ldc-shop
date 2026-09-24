import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ButtonProps = React.ComponentProps<typeof Button>

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "size" | "children"> {
    /**
     * 无障碍名称。**必填**。
     *
     * 只放图标的按钮（`<Trash2 />`、`<X />`、`<Avatar />` …）在屏幕阅读器里
     * 是一个「没有名字的按钮」，读屏用户完全无法判断它的作用；
     * `title` 属性不是可靠的 accessible name（触屏与读屏软件普遍不读它）。
     * 所以这里把它设成必填 prop：编译期强制每个图标按钮都提供名称。
     */
    "aria-label": string
    children: React.ReactNode
    size?: "icon" | "icon-sm" | "icon-lg"
}

/**
 * IconButton —— 纯图标按钮。
 *
 * 与 `<Button size="icon">` 等价，唯一区别是 `aria-label` 必填。
 * 用于一次性治理「成片图标按钮无 accessible name」的问题（见审查报告 §4.1）。
 */
export function IconButton({ className, size = "icon", ...props }: IconButtonProps) {
    return <Button size={size} className={cn(className)} {...props} />
}
