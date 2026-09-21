import ProductForm from "@/components/admin/product-form"
import { getCategories, getProductForAdmin } from "@/lib/db/queries"
import { notFound } from "next/navigation"
import { unstable_noStore } from "next/cache"
import { RefreshOnMount } from "@/components/refresh-on-mount"
import { listCouponsForProduct } from "@/lib/coupons/repository"

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
    unstable_noStore()
    const { id } = await params
    const [product, categories, supportedCoupons] = await Promise.all([
        getProductForAdmin(id),
        getCategories(),
        listCouponsForProduct(id).catch(() => []),
    ])

    if (!product) return notFound()

    return (
        <>
            <RefreshOnMount />
            <ProductForm product={product} categories={categories} supportedCoupons={supportedCoupons} />
        </>
    )
}
