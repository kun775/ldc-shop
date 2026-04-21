'use client'

import { getProductForAdminAction, saveProduct } from "@/actions/admin"
import { ProductContentSection } from "@/components/admin/product-content-section"
import { ProductMediaSection } from "@/components/admin/product-media-section"
import { ProductQuestionsSection } from "@/components/admin/product-questions-section"
import { ProductSettingsSidebar } from "@/components/admin/product-settings-sidebar"
import { prepareUploadedImage } from "@/lib/client-image"
import { Loader2 } from "lucide-react"
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { useI18n } from "@/lib/i18n/context"
import {
    PRODUCT_GALLERY_MAX_ITEMS,
    normalizeProductImageRefs,
    parseStoredProductImages,
} from "@/lib/product-images"

const PRODUCT_IMAGE_UPLOAD_MAX_BYTES = 500 * 1024

export default function ProductForm({ product, categories = [] }: { product?: any; categories?: Array<{ name: string }> }) {
    const router = useRouter()
    const [loading, setLoading] = useState(false)
    const submitLock = useRef(false)
    const productImageFileInputRef = useRef<HTMLInputElement | null>(null)
    const productGalleryFileInputRef = useRef<HTMLInputElement | null>(null)
    const [currentProduct, setCurrentProduct] = useState(product)
    const [formSeed, setFormSeed] = useState(0)
    // Only show warning section if purchaseWarning has actual content
    const [showWarning, setShowWarning] = useState(Boolean(product?.purchaseWarning && String(product.purchaseWarning).trim()))
    const [pointDiscountEnabled, setPointDiscountEnabled] = useState(Boolean(product?.pointDiscountEnabled))
    const [visibilityLevel, setVisibilityLevel] = useState(String(product?.visibilityLevel ?? -1))
    const [productImageValue, setProductImageValue] = useState(product?.image || '')
    const [productGalleryValues, setProductGalleryValues] = useState<string[]>(() => parseStoredProductImages(product?.productImages))
    const [galleryImageInputValue, setGalleryImageInputValue] = useState('')
    const [processingProductImageFile, setProcessingProductImageFile] = useState(false)
    const [processingProductGalleryFiles, setProcessingProductGalleryFiles] = useState(false)
    const [purchaseQuestions, setPurchaseQuestions] = useState<Array<{ q: string; a: string }>>(() => {
        try {
            const raw = product?.purchaseQuestions
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed) && parsed.length > 0) return parsed
            }
        } catch { /* ignore */ }
        return []
    })
    const [showQuestions, setShowQuestions] = useState(purchaseQuestions.length > 0)
    const { t } = useI18n()
    const hasRoomForMoreGalleryImages = productGalleryValues.length < PRODUCT_GALLERY_MAX_ITEMS - 1

    useEffect(() => {
        setCurrentProduct(product)
        setShowWarning(Boolean(product?.purchaseWarning && String(product.purchaseWarning).trim()))
        setPointDiscountEnabled(Boolean(product?.pointDiscountEnabled))
        setVisibilityLevel(String(product?.visibilityLevel ?? -1))
        setProductImageValue(product?.image || '')
        setProductGalleryValues(parseStoredProductImages(product?.productImages))
        setGalleryImageInputValue('')
        try {
            const raw = product?.purchaseQuestions
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setPurchaseQuestions(parsed)
                    setShowQuestions(true)
                } else {
                    setPurchaseQuestions([])
                    setShowQuestions(false)
                }
            } else {
                setPurchaseQuestions([])
                setShowQuestions(false)
            }
        } catch {
            setPurchaseQuestions([])
            setShowQuestions(false)
        }
        setFormSeed((s) => s + 1)
    }, [product?.id])

    useEffect(() => {
        if (!product?.id) return
        let active = true
            ; (async () => {
                try {
                    const latest = await getProductForAdminAction(product.id)
                    if (!active || !latest) return
                    setCurrentProduct(latest as any)
                    setShowWarning(Boolean(latest?.purchaseWarning && String(latest.purchaseWarning).trim()))
                    setPointDiscountEnabled(Boolean((latest as any)?.pointDiscountEnabled))
                    setVisibilityLevel(String(latest?.visibilityLevel ?? -1))
                    setProductImageValue(latest?.image || '')
                    setProductGalleryValues(parseStoredProductImages((latest as any)?.productImages))
                    setGalleryImageInputValue('')
                    try {
                        const raw = (latest as any)?.purchaseQuestions
                        if (raw) {
                            const parsed = JSON.parse(raw)
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                setPurchaseQuestions(parsed)
                                setShowQuestions(true)
                            }
                        }
                    } catch { /* ignore */ }
                    setFormSeed((s) => s + 1)
                } catch {
                    // ignore
                }
            })()
        return () => {
            active = false
        }
    }, [product?.id])

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (submitLock.current) return

        const formData = new FormData(event.currentTarget)

        submitLock.current = true
        setLoading(true)
        try {
            await saveProduct(formData)
            toast.success(t('common.success'))
            router.push('/admin/products')
        } catch (e: any) {
            console.error('Save product error:', e)
            toast.error(e?.message || t('common.error'))
        } finally {
            setLoading(false)
            submitLock.current = false
        }
    }

    const handleSelectProductImageFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return

        setProcessingProductImageFile(true)
        try {
            const prepared = await prepareUploadedImage(file, {
                maxBytes: PRODUCT_IMAGE_UPLOAD_MAX_BYTES,
                maxDimension: 1600,
            })
            setProductImageValue(prepared.dataUrl)
            toast.success(
                prepared.wasCompressed
                    ? t('admin.productForm.imageFileCompressed')
                    : t('admin.productForm.imageFileReady')
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message === 'image_compression_unsupported') {
                toast.error(t('admin.productForm.imageFileCompressionUnsupported'))
                return
            }
            if (message === 'image_compression_failed') {
                toast.error(t('admin.productForm.imageFileCompressionFailed'))
                return
            }
            toast.error(t('admin.productForm.imageFileInvalid'))
        } finally {
            setProcessingProductImageFile(false)
        }
    }

    const handleAddGalleryImage = () => {
        const nextImage = galleryImageInputValue.trim()
        if (!nextImage) return
        setProductGalleryValues((prev) => normalizeProductImageRefs([...prev, nextImage]).slice(0, PRODUCT_GALLERY_MAX_ITEMS - 1))
        setGalleryImageInputValue('')
    }

    const handlePromoteGalleryImage = (index: number) => {
        const nextPrimary = productGalleryValues[index]
        if (!nextPrimary) return
        const currentPrimary = productImageValue.trim()

        setProductImageValue(nextPrimary)
        setProductGalleryValues((prev) => {
            const remaining = prev.filter((_, i) => i !== index)
            return normalizeProductImageRefs(currentPrimary ? [currentPrimary, ...remaining] : remaining)
        })
    }

    const handleRemoveGalleryImage = (index: number) => {
        setProductGalleryValues((prev) => prev.filter((_, i) => i !== index))
    }

    const handleSelectProductGalleryFiles = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (!files.length) return

        setProcessingProductGalleryFiles(true)
        try {
            const preparedImages: string[] = []
            let compressedCount = 0

            for (const file of files) {
                const prepared = await prepareUploadedImage(file, {
                    maxBytes: PRODUCT_IMAGE_UPLOAD_MAX_BYTES,
                    maxDimension: 1600,
                })
                preparedImages.push(prepared.dataUrl)
                if (prepared.wasCompressed) compressedCount += 1
            }

            setProductGalleryValues((prev) =>
                normalizeProductImageRefs([...prev, ...preparedImages]).slice(0, PRODUCT_GALLERY_MAX_ITEMS - 1)
            )

            toast.success(
                compressedCount > 0
                    ? t('admin.productForm.galleryFileCompressed')
                    : t('admin.productForm.galleryFileReady')
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message === 'image_compression_unsupported') {
                toast.error(t('admin.productForm.imageFileCompressionUnsupported'))
                return
            }
            if (message === 'image_compression_failed') {
                toast.error(t('admin.productForm.imageFileCompressionFailed'))
                return
            }
            toast.error(t('admin.productForm.imageFileInvalid'))
        } finally {
            setProcessingProductGalleryFiles(false)
        }
    }

    return (
        <div className="mx-auto max-w-7xl space-y-6">
            <div className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight">
                    {product ? t('admin.productForm.editTitle') : t('admin.productForm.addTitle')}
                </h1>
                <p className="text-sm text-muted-foreground">{t('admin.productForm.layoutHint')}</p>
            </div>

            <div className="relative rounded-2xl">
                {loading && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/70 backdrop-blur-sm">
                        <div
                            role="status"
                            aria-live="polite"
                            className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/95 px-4 py-3 text-sm font-medium shadow-lg"
                        >
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            <span>{t('admin.productForm.saving')}</span>
                        </div>
                    </div>
                )}

                <form key={formSeed} onSubmit={handleSubmit} className="relative" aria-busy={loading}>
                    <fieldset disabled={loading} className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_360px]">
                        {currentProduct && <input type="hidden" name="id" value={currentProduct.id} />}

                        <div className="space-y-6">
                            <ProductContentSection
                                currentProduct={currentProduct}
                                showWarning={showWarning}
                                setShowWarning={setShowWarning}
                                productIdReadonly={!!currentProduct}
                                t={t}
                            />
                            <ProductMediaSection
                                currentProduct={currentProduct}
                                loading={loading}
                                productImageValue={productImageValue}
                                setProductImageValue={setProductImageValue}
                                productGalleryValues={productGalleryValues}
                                galleryImageInputValue={galleryImageInputValue}
                                setGalleryImageInputValue={setGalleryImageInputValue}
                                processingProductImageFile={processingProductImageFile}
                                processingProductGalleryFiles={processingProductGalleryFiles}
                                hasRoomForMoreGalleryImages={hasRoomForMoreGalleryImages}
                                galleryLimit={PRODUCT_GALLERY_MAX_ITEMS - 1}
                                productImageFileInputRef={productImageFileInputRef}
                                productGalleryFileInputRef={productGalleryFileInputRef}
                                handleAddGalleryImage={handleAddGalleryImage}
                                handlePromoteGalleryImage={handlePromoteGalleryImage}
                                handleRemoveGalleryImage={handleRemoveGalleryImage}
                                handleSelectProductImageFile={handleSelectProductImageFile}
                                handleSelectProductGalleryFiles={handleSelectProductGalleryFiles}
                                t={t}
                            />
                            <ProductQuestionsSection
                                showQuestions={showQuestions}
                                setShowQuestions={setShowQuestions}
                                purchaseQuestions={purchaseQuestions}
                                setPurchaseQuestions={setPurchaseQuestions}
                                t={t}
                            />
                        </div>

                        <ProductSettingsSidebar
                            currentProduct={currentProduct}
                            categories={categories}
                            loading={loading}
                            pointDiscountEnabled={pointDiscountEnabled}
                            setPointDiscountEnabled={setPointDiscountEnabled}
                            visibilityLevel={visibilityLevel}
                            setVisibilityLevel={setVisibilityLevel}
                            onCancel={() => router.back()}
                            t={t}
                        />
                    </fieldset>
                </form>
            </div>
        </div>
    )
}
