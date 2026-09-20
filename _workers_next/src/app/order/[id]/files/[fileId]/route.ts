import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { isAdminIdentity } from "@/lib/admin-auth"
import { getDeliveryFile, markDeliveryFileDownloaded } from "@/lib/delivery-files"
import { shouldRecordDeliveryFileDownload } from "@/lib/delivery-file-download"
import { ensureDatabaseInitialized } from "@/lib/db/queries"
import { hasOrderAccessToken, ORDER_ACCESS_COOKIE } from "@/lib/order-access"

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string; fileId: string }> }
) {
    await ensureDatabaseInitialized()
    const { id, fileId } = await params
    const numericFileId = Number.parseInt(fileId, 10)
    if (!id || !Number.isFinite(numericFileId)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const order = await db.query.orders.findFirst({
        where: eq(orders.orderId, id),
        columns: {
            orderId: true,
            userId: true,
            username: true,
            status: true,
            fulfillmentMode: true,
        }
    })
    if (!order || order.status !== "delivered") {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const session = await auth()
    const user = session?.user
    const cookieStore = await cookies()
    const hasGuestAccess = !order.userId && hasOrderAccessToken(
        cookieStore.get(ORDER_ACCESS_COOKIE)?.value,
        id
    )
    const isOwner = !!(user?.id && user.id === order.userId)
    const isAdmin = isAdminIdentity(user)
    if (!isOwner && !hasGuestAccess && !isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const file = await getDeliveryFile(id, numericFileId)
    if (!file) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    if (shouldRecordDeliveryFileDownload({
        fulfillmentMode: order.fulfillmentMode,
        isOwner,
        hasGuestAccess,
    })) {
        try {
            await markDeliveryFileDownloaded(id, numericFileId)
        } catch (error) {
            // 下载优先于统计写入；数据库尚未执行 0032 升级或瞬时写入失败时不阻断取件。
            console.error("[DeliveryFiles] Failed to record customer download:", error)
        }
    }

    return new NextResponse(file.body, {
        headers: {
            "Content-Type": file.contentType || "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            "Content-Length": String(file.size),
            "Cache-Control": "private, no-store",
        },
    })
}
