import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { isAdminUsername } from "@/lib/admin-auth"
import { getDeliveryFile } from "@/lib/delivery-files"
import { ensureDatabaseInitialized } from "@/lib/db/queries"

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
        }
    })
    if (!order || order.status !== "delivered") {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const session = await auth()
    const user = session?.user
    const cookieStore = await cookies()
    const pending = cookieStore.get("ldc_pending_order")?.value === id
    const isOwner = !!(user && (user.id === order.userId || user.username === order.username))
    const isAdmin = isAdminUsername(user?.username)
    if (!isOwner && !pending && !isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const file = await getDeliveryFile(id, numericFileId)
    if (!file) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const raw = file.body
    const body = raw instanceof ArrayBuffer
        ? raw
        : raw instanceof Uint8Array
            ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
            : new Uint8Array(raw as ArrayBuffer).buffer

    return new NextResponse(body as ArrayBuffer, {
        headers: {
            "Content-Type": file.contentType || "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            "Content-Length": String(file.size),
            "Cache-Control": "private, no-store",
        },
    })
}
