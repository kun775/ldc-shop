'use client'

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

type ProductContentSectionProps = {
    currentProduct: any
    showWarning: boolean
    setShowWarning: (value: boolean) => void
    productIdReadonly: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}

export function ProductContentSection({
    currentProduct,
    showWarning,
    setShowWarning,
    productIdReadonly,
    t,
}: ProductContentSectionProps) {
    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.basicSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.basicSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-2">
                        <Label htmlFor="name">{t('admin.productForm.nameLabel')}</Label>
                        <Input
                            id="name"
                            name="name"
                            defaultValue={currentProduct?.name}
                            placeholder={t('admin.productForm.namePlaceholder')}
                            required
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="slug">{t('admin.productForm.slugLabel')}</Label>
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground">/buy/</span>
                            <Input
                                id="slug"
                                name="slug"
                                defaultValue={currentProduct?.id || ''}
                                placeholder={t('admin.productForm.slugPlaceholder')}
                                pattern="^[a-zA-Z0-9_-]+$"
                                className="flex-1"
                                disabled={productIdReadonly}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {productIdReadonly ? t('admin.productForm.slugReadonly') : t('admin.productForm.slugHint')}
                        </p>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="description">{t('admin.productForm.descLabel')}</Label>
                        <Textarea
                            id="description"
                            name="description"
                            defaultValue={currentProduct?.description}
                            placeholder={t('admin.productForm.descPlaceholder')}
                            className="min-h-[220px]"
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.pricingSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.pricingSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor="price">{t('admin.productForm.priceLabel')}</Label>
                            <Input
                                id="price"
                                name="price"
                                type="number"
                                step="0.01"
                                defaultValue={currentProduct?.price}
                                placeholder={t('admin.productForm.pricePlaceholder')}
                                required
                                onWheel={(event) => event.currentTarget.blur()}
                            />
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="compareAtPrice">{t('admin.productForm.compareAtPriceLabel')}</Label>
                            <Input
                                id="compareAtPrice"
                                name="compareAtPrice"
                                type="number"
                                step="0.01"
                                defaultValue={currentProduct?.compareAtPrice || ''}
                                placeholder={t('admin.productForm.compareAtPricePlaceholder')}
                                onWheel={(event) => event.currentTarget.blur()}
                            />
                        </div>

                        <div className="grid gap-2 md:col-span-2">
                            <Label htmlFor="purchaseLimit">{t('admin.productForm.purchaseLimitLabel')}</Label>
                            <Input
                                id="purchaseLimit"
                                name="purchaseLimit"
                                type="number"
                                defaultValue={currentProduct?.purchaseLimit}
                                placeholder={t('admin.productForm.purchaseLimitPlaceholder')}
                                onWheel={(event) => event.currentTarget.blur()}
                            />
                        </div>
                    </div>

                    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                        <div className="flex items-center gap-2">
                            <input
                                id="showWarning"
                                type="checkbox"
                                checked={showWarning}
                                onChange={(event) => setShowWarning(event.target.checked)}
                                className="h-4 w-4 accent-primary"
                            />
                            <Label htmlFor="showWarning" className="cursor-pointer">
                                {t('admin.productForm.purchaseWarningLabel')}
                            </Label>
                        </div>
                        {showWarning && (
                            <div className="grid gap-2">
                                <Label htmlFor="purchaseWarning">{t('admin.productForm.purchaseWarningLabel')}</Label>
                                <Textarea
                                    id="purchaseWarning"
                                    name="purchaseWarning"
                                    defaultValue={currentProduct?.purchaseWarning || ''}
                                    placeholder={t('admin.productForm.purchaseWarningPlaceholder')}
                                    className="min-h-[120px]"
                                />
                                <p className="text-xs text-muted-foreground">{t('admin.productForm.purchaseWarningHint')}</p>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
