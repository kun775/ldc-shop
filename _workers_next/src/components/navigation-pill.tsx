'use client'

import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'

interface NavigationPillProps {
    items: Array<{ key: string; label: string }>
    selectedKey: string | null
    onSelect?: (key: string) => void
}

interface IndicatorStyle {
    left: number
    width: number
}

/**
 * 分类药丸导航。
 *
 * 这里的指示器动画刻意不用 framer-motion：它在本项目里只有这一处使用，
 * 却要给首页首屏额外背上 ~113KB（未压缩）的 JS。等价的位移/宽度过渡用
 * 一条 CSS transition 就能表达，且 `motion-reduce:transition-none` 能直接
 * 覆盖「减少动态效果」偏好。
 *
 * 另外，指示器位置只由「选中项 + 容器/子项尺寸」决定，因此 `items` 必须由
 * 调用方 `useMemo` 保持引用稳定，否则父组件每次渲染都会触发一次多余的测量。
 */
export function NavigationPill({ items, selectedKey, onSelect }: NavigationPillProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [indicatorStyle, setIndicatorStyle] = useState<IndicatorStyle | null>(null)

    const measure = useCallback(() => {
        const container = containerRef.current
        if (!container) return

        const activeIndex = items.findIndex(item => item.key === selectedKey)
        const activeElement = container.children[activeIndex >= 0 ? activeIndex : 0] as HTMLElement | undefined
        if (!activeElement) return

        const next: IndicatorStyle = {
            left: activeElement.offsetLeft,
            width: activeElement.offsetWidth,
        }
        // 值相等时返回原对象，避免「测量 → setState → 重渲染 → 再测量」的空转。
        setIndicatorStyle(prev => (
            prev && prev.left === next.left && prev.width === next.width ? prev : next
        ))
    }, [items, selectedKey])

    useEffect(() => {
        measure()

        const container = containerRef.current
        if (!container || typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(() => measure())
        observer.observe(container)
        for (const child of Array.from(container.children)) {
            observer.observe(child)
        }
        return () => observer.disconnect()
    }, [measure])

    return (
        <div className="relative inline-flex items-center rounded-full bg-muted/60 p-1 backdrop-blur-sm">
            {/* Animated background indicator */}
            <div
                aria-hidden="true"
                className={cn(
                    'pointer-events-none absolute top-1 bottom-1 rounded-full bg-background shadow-sm',
                    'transition-[left,width] duration-300 ease-out motion-reduce:transition-none',
                    indicatorStyle ? 'opacity-100' : 'opacity-0'
                )}
                style={indicatorStyle ? { left: indicatorStyle.left, width: indicatorStyle.width } : undefined}
            />

            {/* Navigation items */}
            <div ref={containerRef} className="relative z-10 flex items-center">
                {items.map((item) => (
                    <button
                        key={item.key}
                        type="button"
                        className={cn(
                            'relative px-4 py-1.5 text-sm font-medium transition-colors duration-200 rounded-full whitespace-nowrap',
                            selectedKey === item.key
                                ? 'text-foreground'
                                : 'text-muted-foreground hover:text-foreground/80'
                        )}
                        onClick={() => onSelect?.(item.key)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </div>
    )
}
