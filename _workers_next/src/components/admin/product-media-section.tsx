'use client'

import type { ChangeEvent, RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type ProductMediaSectionProps = {
    currentProduct: any
    loading: boolean
    productImageValue: string
    setProductImageValue: (value: string) => void
    productGalleryValues: string[]
    galleryImageInputValue: string
    setGalleryImageInputValue: (value: string) => void
    processingProductImageFile: boolean
    processingProductGalleryFiles: boolean
    hasRoomForMoreGalleryImages: boolean
    galleryLimit: number
    productImageFileInputRef: RefObject<HTMLInputElement | null>
    productGalleryFileInputRef: RefObject<HTMLInputElement | null>
    handleAddGalleryImage: () => void
    handlePromoteGalleryImage: (index: number) => void
    handleRemoveGalleryImage: (index: number) => void
    handleSelectProductImageFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
    handleSelectProductGalleryFiles: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
    t: (key: string, params?: Record<string, string | number>) => string
}

export function ProductMediaSection({
    currentProduct,
    loading,
    productImageValue,
    setProductImageValue,
    productGalleryValues,
    galleryImageInputValue,
    setGalleryImageInputValue,
    processingProductImageFile,
    processingProductGalleryFiles,
    hasRoomForMoreGalleryImages,
    galleryLimit,
    productImageFileInputRef,
    productGalleryFileInputRef,
    handleAddGalleryImage,
    handlePromoteGalleryImage,
    handleRemoveGalleryImage,
    handleSelectProductImageFile,
    handleSelectProductGalleryFiles,
    t,
}: ProductMediaSectionProps) {
    const usingUploadedProductImage = productImageValue.startsWith('data:')
    const productImageInputValue = usingUploadedProductImage ? '' : productImageValue

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.mediaSectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.mediaSectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-2">
                        <Label htmlFor="image">{t('admin.productForm.imageLabel')}</Label>
                        <input type="hidden" name="image" value={productImageValue} />
                        <Input
                            id="image"
                            value={productImageInputValue}
                            onChange={(event) => setProductImageValue(event.target.value)}
                            placeholder={t('admin.productForm.imagePlaceholder')}
                        />
                        {usingUploadedProductImage && (
                            <p className="text-xs text-muted-foreground">{t('admin.productForm.imageUploadedHint')}</p>
                        )}
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
                        <Label htmlFor="product-image-file" className="text-sm font-medium">
                            {t('admin.productForm.imageUpload')}
                        </Label>
                        <input
                            ref={productImageFileInputRef}
                            id="product-image-file"
                            type="file"
                            className="hidden"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.svg,.ico,.bmp"
                            onChange={handleSelectProductImageFile}
                            disabled={processingProductImageFile}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            className="w-fit"
                            onClick={() => productImageFileInputRef.current?.click()}
                            disabled={loading || processingProductImageFile}
                        >
                            {processingProductImageFile ? t('common.processing') : t('admin.productForm.imageUpload')}
                        </Button>
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.imageUploadHint')}</p>
                    </div>

                    {productImageValue && (
                        <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-3">
                            <img
                                src={productImageValue}
                                alt={currentProduct?.name || 'Product preview'}
                                className="h-20 w-20 rounded-md object-contain"
                            />
                            <span className="text-sm text-muted-foreground">{t('admin.productForm.imagePreview')}</span>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.productForm.gallerySectionTitle')}</CardTitle>
                    <CardDescription>{t('admin.productForm.gallerySectionHint')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-3">
                        <Label htmlFor="galleryImageInput">{t('admin.productForm.galleryLabel')}</Label>
                        <input type="hidden" name="productImages" value={JSON.stringify(productGalleryValues)} />
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <Input
                                id="galleryImageInput"
                                value={galleryImageInputValue}
                                onChange={(event) => setGalleryImageInputValue(event.target.value)}
                                placeholder={t('admin.productForm.galleryPlaceholder')}
                                disabled={!hasRoomForMoreGalleryImages}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleAddGalleryImage}
                                disabled={loading || !galleryImageInputValue.trim() || !hasRoomForMoreGalleryImages}
                            >
                                {t('admin.productForm.galleryAdd')}
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
                        <Label htmlFor="product-gallery-file" className="text-sm font-medium">
                            {t('admin.productForm.galleryUpload')}
                        </Label>
                        <input
                            ref={productGalleryFileInputRef}
                            id="product-gallery-file"
                            type="file"
                            className="hidden"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.svg,.ico,.bmp"
                            multiple
                            onChange={handleSelectProductGalleryFiles}
                            disabled={processingProductGalleryFiles || !hasRoomForMoreGalleryImages}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            className="w-fit"
                            onClick={() => productGalleryFileInputRef.current?.click()}
                            disabled={loading || processingProductGalleryFiles || !hasRoomForMoreGalleryImages}
                        >
                            {processingProductGalleryFiles ? t('common.processing') : t('admin.productForm.galleryUpload')}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t('admin.productForm.galleryUploadHint', { count: galleryLimit })}
                        </p>
                    </div>

                    {productGalleryValues.length > 0 ? (
                        <div className="grid gap-3 md:grid-cols-2">
                            {productGalleryValues.map((image, index) => (
                                <div key={`${image}-${index}`} className="rounded-lg border bg-muted/30 p-3">
                                    <div className="mb-3 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-background">
                                        <img
                                            src={image}
                                            alt={`${currentProduct?.name || 'Product'} gallery ${index + 1}`}
                                            className="h-full w-full object-contain"
                                        />
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button type="button" size="sm" variant="outline" onClick={() => handlePromoteGalleryImage(index)}>
                                            {t('admin.productForm.gallerySetCover')}
                                        </Button>
                                        <Button type="button" size="sm" variant="ghost" onClick={() => handleRemoveGalleryImage(index)}>
                                            {t('admin.productForm.galleryRemove')}
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.galleryEmpty')}</p>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
