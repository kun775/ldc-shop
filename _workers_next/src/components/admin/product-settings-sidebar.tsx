'use client'

import { Loader2, Zap, PackageOpen, Check } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type ProductSettingsSidebarProps = {
    currentProduct: any
    categories: Array<{ name: string }>
    loading: boolean
    pointDiscountEnabled: boolean
    setPointDiscountEnabled: (value: boolean) => void
    visibilityLevel: string
    setVisibilityLevel: (value: string) => void
    onCancel: () => void
    t: (key: string, params?: Record<string, string | number>) => string
}

export function ProductSettingsSidebar({
    currentProduct,
    categories,
    loading,
    pointDiscountEnabled,
    setPointDiscountEnabled,
    visibilityLevel,
    setVisibilityLevel,
    onCancel,
    t,
}: ProductSettingsSidebarProps) {
    const [fulfillmentMode, setFulfillmentMode] = useState<string>(
        currentProduct?.fulfillmentMode === 'manual' ? 'manual' : 'auto'
    )
    return (
        <div className="space-y-4 lg:sticky lg:top-6">
            <Card className="border-primary/20 bg-primary/[0.03]">
                <CardHeader>
                    <CardTitle>{t('admin.productForm.actionsSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.actionsSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {t('admin.productForm.saving')}
                            </>
                        ) : (
                            t('admin.productForm.saveButton')
                        )}
                    </Button>
                    <Button type="button" variant="outline" className="w-full" onClick={onCancel} disabled={loading}>
                        {t('common.cancel')}
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.publishSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.publishSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <Label htmlFor="category">{t('admin.productForm.categoryLabel')}</Label>
                        <Input
                            id="category"
                            name="category"
                            list="ldc-category-list"
                            defaultValue={currentProduct?.category}
                            placeholder={t('admin.productForm.categoryPlaceholder')}
                        />
                        <datalist id="ldc-category-list">
                            {categories.map((category) => (
                                <option key={category.name} value={category.name} />
                            ))}
                        </datalist>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="visibilityLevel">{t('admin.productForm.visibilityLabel')}</Label>
                        <select
                            id="visibilityLevel"
                            name="visibilityLevel"
                            value={visibilityLevel}
                            onChange={(event) => setVisibilityLevel(event.target.value)}
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-2"
                        >
                            <option value="-1">{t('admin.productForm.visibilityAll')}</option>
                            <option value="0">{t('admin.productForm.visibilityLevel0')}</option>
                            <option value="1">{t('admin.productForm.visibilityLevel1')}</option>
                            <option value="2">{t('admin.productForm.visibilityLevel2')}</option>
                            <option value="3">{t('admin.productForm.visibilityLevel3')}</option>
                        </select>
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.visibilityHint')}</p>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.attributesSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.attributesSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="grid gap-2.5 rounded-xl border border-border/70 bg-muted/20 p-3.5">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs font-semibold tracking-tight text-foreground">
                                {t('admin.productForm.fulfillmentModeLabel')}
                            </Label>
                            <span className="text-[11px] font-medium text-muted-foreground">
                                {fulfillmentMode === 'manual' ? '📦 手工履约' : '⚡ 自动发卡'}
                            </span>
                        </div>

                        {/* Hidden input preserves standard FormData submission */}
                        <input type="hidden" name="fulfillmentMode" value={fulfillmentMode} />

                        {/* Linear Style Segmented Mode Cards */}
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setFulfillmentMode('auto')}
                                className={cn(
                                    "flex flex-col items-start gap-1.5 rounded-lg border p-2.5 text-left transition-all",
                                    fulfillmentMode === 'auto'
                                        ? "border-primary/80 bg-primary/5 shadow-xs ring-1 ring-primary/40 dark:bg-primary/10"
                                        : "border-border/60 bg-background/50 hover:border-border hover:bg-muted/40"
                                )}
                            >
                                <div className="flex w-full items-center justify-between">
                                    <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
                                        <Zap className={cn("h-3.5 w-3.5", fulfillmentMode === 'auto' ? "text-primary" : "text-muted-foreground")} />
                                        <span>{t('admin.productForm.fulfillmentModeAuto')}</span>
                                    </div>
                                    {fulfillmentMode === 'auto' && (
                                        <Check className="h-3 w-3 text-primary" />
                                    )}
                                </div>
                                <span className="text-[10px] text-muted-foreground leading-tight">
                                    绑定库存自动出密
                                </span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setFulfillmentMode('manual')}
                                className={cn(
                                    "flex flex-col items-start gap-1.5 rounded-lg border p-2.5 text-left transition-all",
                                    fulfillmentMode === 'manual'
                                        ? "border-primary/80 bg-primary/5 shadow-xs ring-1 ring-primary/40 dark:bg-primary/10"
                                        : "border-border/60 bg-background/50 hover:border-border hover:bg-muted/40"
                                )}
                            >
                                <div className="flex w-full items-center justify-between">
                                    <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
                                        <PackageOpen className={cn("h-3.5 w-3.5", fulfillmentMode === 'manual' ? "text-primary" : "text-muted-foreground")} />
                                        <span>{t('admin.productForm.fulfillmentModeManual')}</span>
                                    </div>
                                    {fulfillmentMode === 'manual' && (
                                        <Check className="h-3 w-3 text-primary" />
                                    )}
                                </div>
                                <span className="text-[10px] text-muted-foreground leading-tight">
                                    人工交付/文件附件
                                </span>
                            </button>
                        </div>

                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                            {t('admin.productForm.fulfillmentModeHint')}
                        </p>

                        {fulfillmentMode === 'manual' && (
                            <div className="grid gap-2 border-t border-border/50 pt-3">
                                <Label htmlFor="manualStockCount">
                                    {t('admin.productForm.manualStockLabel')}
                                </Label>
                                <Input
                                    id="manualStockCount"
                                    name="manualStockCount"
                                    type="number"
                                    min={0}
                                    step={1}
                                    required
                                    defaultValue={Math.max(0, Number(currentProduct?.manualStockCount || 0))}
                                    onWheel={(event) => event.currentTarget.blur()}
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    {t('admin.productForm.manualStockHint')}
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                        <Checkbox
                            id="isShared"
                            name="isShared"
                            defaultChecked={currentProduct?.isShared ?? false}
                            className="mt-0.5"
                        />
                        <div className="space-y-1">
                            <Label htmlFor="isShared" className="cursor-pointer font-medium">
                                {t('admin.productForm.isSharedLabel')}
                            </Label>
                            <p className="text-xs text-muted-foreground">{t('admin.productForm.isSharedHint')}</p>
                        </div>
                    </div>

                    <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                        <Checkbox
                            id="isHot"
                            name="isHot"
                            defaultChecked={!!currentProduct?.isHot}
                            className="mt-0.5"
                        />
                        <div className="space-y-1">
                            <Label htmlFor="isHot" className="cursor-pointer font-medium">
                                {t('admin.productForm.isHotLabel')}
                            </Label>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.pointsSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.pointsSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                        <div className="flex items-start gap-3">
                            <input
                                id="pointDiscountEnabled"
                                name="pointDiscountEnabled"
                                type="checkbox"
                                checked={pointDiscountEnabled}
                                onChange={(event) => setPointDiscountEnabled(event.target.checked)}
                                className="mt-0.5 h-4 w-4 accent-primary"
                            />
                            <div className="space-y-1">
                                <Label htmlFor="pointDiscountEnabled" className="cursor-pointer font-medium">
                                    {t('admin.productForm.pointDiscountEnabledLabel')}
                                </Label>
                                <p className="text-xs text-muted-foreground">{t('admin.productForm.pointDiscountEnabledHint')}</p>
                            </div>
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="pointDiscountPercent">{t('admin.productForm.pointDiscountPercentLabel')}</Label>
                            <Input
                                id="pointDiscountPercent"
                                name="pointDiscountPercent"
                                type="number"
                                min={1}
                                max={100}
                                step="1"
                                defaultValue={currentProduct?.pointDiscountPercent || ''}
                                placeholder={t('admin.productForm.pointDiscountPercentPlaceholder')}
                                disabled={!pointDiscountEnabled}
                                onWheel={(event) => event.currentTarget.blur()}
                            />
                            <p className="text-xs text-muted-foreground">{t('admin.productForm.pointDiscountPercentHint')}</p>
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="variantGroupId">{t('admin.productForm.variantGroupLabel')}</Label>
                        <Input
                            id="variantGroupId"
                            name="variantGroupId"
                            defaultValue={currentProduct?.variantGroupId || ''}
                            placeholder={t('admin.productForm.variantGroupPlaceholder')}
                        />
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.variantGroupHint')}</p>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="variantLabel">{t('admin.productForm.variantLabelLabel')}</Label>
                        <Input
                            id="variantLabel"
                            name="variantLabel"
                            defaultValue={currentProduct?.variantLabel || ''}
                            placeholder={t('admin.productForm.variantLabelPlaceholder')}
                        />
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.variantLabelHint')}</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
