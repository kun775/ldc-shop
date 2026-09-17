'use client'

import { useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface CouponProductOption {
    id: string
    name: string
}

export function CouponProductPicker({
    products,
    selectedIds,
    onChange,
    disabled = false,
}: {
    products: CouponProductOption[]
    selectedIds: string[]
    onChange: (ids: string[]) => void
    disabled?: boolean
}) {
    const [keyword, setKeyword] = useState('')

    const filtered = useMemo(() => {
        const q = keyword.trim().toLowerCase()
        if (!q) return products
        return products.filter((product) =>
            product.name.toLowerCase().includes(q) || product.id.toLowerCase().includes(q)
        )
    }, [keyword, products])

    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

    const toggle = (id: string, checked: boolean) => {
        if (disabled) return
        if (checked) {
            onChange(Array.from(new Set([...selectedIds, id])))
        } else {
            onChange(selectedIds.filter((item) => item !== id))
        }
    }

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Input
                    type="search"
                    aria-label="搜索商品"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索商品名称或 ID"
                    className="h-9 text-xs"
                    disabled={disabled}
                />
                <span className="shrink-0 text-xs text-muted-foreground">已选 {selectedIds.length}</span>
            </div>
            <div
                className={cn(
                    'max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-2',
                    disabled && 'opacity-60'
                )}
            >
                {filtered.length === 0 ? (
                    <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的商品</div>
                ) : (
                    filtered.map((product) => {
                        const checked = selectedSet.has(product.id)
                        return (
                            <label
                                key={product.id}
                                className={cn(
                                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
                                    checked ? 'bg-primary/10' : 'hover:bg-muted/50',
                                    disabled && 'cursor-not-allowed'
                                )}
                            >
                                <Checkbox
                                    checked={checked}
                                    disabled={disabled}
                                    onCheckedChange={(value) => toggle(product.id, Boolean(value))}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium text-foreground">
                                        {product.name}
                                    </span>
                                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                        {product.id}
                                    </span>
                                </span>
                            </label>
                        )
                    })
                )}
            </div>
        </div>
    )
}
