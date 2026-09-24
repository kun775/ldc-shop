import ProductForm from "@/components/admin/product-form"
import { getCategories, getProductForAdmin } from "@/lib/db/queries"
import { notFound } from "next/navigation"
import { unstable_noStore } from "next/cache"
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

    // 这里原本还挂了 <RefreshOnMount/>（挂载后 router.refresh() 整页重取一次）。
    // 本页已经调用 unstable_noStore()，每次请求都是新鲜的，refresh 属于纯浪费的
    // 第二次 RSC 往返，已移除。
    return (
        <ProductForm product={product} categories={categories} supportedCoupons={supportedCoupons} />
    )
}
