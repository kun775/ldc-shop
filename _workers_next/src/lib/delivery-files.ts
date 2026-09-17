import { getCloudflareContext } from "@opennextjs/cloudflare"
import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { orderDeliveryFiles } from "@/lib/db/schema"

export const DELIVERY_FILE_LIMITS = {
    maxFiles: 10,
    maxNoteLength: 4000,
    r2MaxBytes: 20 * 1024 * 1024,
    d1MaxBytes: 1024 * 1024,
}

const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "zip", "7z"] as const

const CONTENT_TYPES: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    zip: "application/zip",
    "7z": "application/x-7z-compressed",
}

export type DeliveryFileMeta = {
    id: number
    fileName: string
    contentType: string
    size: number
}

function sanitizeFileName(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "file"
}

function fileExtension(name: string) {
    const match = name.toLowerCase().match(/\.([a-z0-9]+)$/)
    return match?.[1] || ""
}

export function resolveDeliveryContentType(fileName: string, fallback?: string | null) {
    const ext = fileExtension(fileName)
    return CONTENT_TYPES[ext] || fallback || "application/octet-stream"
}

export function isAllowedDeliveryFile(fileName: string, mimeType?: string | null) {
    const ext = fileExtension(fileName)
    if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) return false
    if (!mimeType) return true
    const expected = CONTENT_TYPES[ext]
    if (!expected) return true
    if (mimeType === "application/octet-stream") return true
    if (ext === "jpg" || ext === "jpeg") return mimeType === "image/jpeg"
    if (ext === "zip") return mimeType === "application/zip" || mimeType === "application/x-zip-compressed"
    if (ext === "7z") return mimeType === "application/x-7z-compressed" || mimeType === "application/octet-stream"
    return mimeType === expected
}

async function getFilesBucket() {
    try {
        const ctx = await getCloudflareContext({ async: true })
        return ctx.env.FILES ?? null
    } catch {
        return null
    }
}

export async function deleteDeliveryFiles(orderId: string) {
    const rows = await db.select({
        storage: orderDeliveryFiles.storage,
        objectKey: orderDeliveryFiles.objectKey,
    })
        .from(orderDeliveryFiles)
        .where(eq(orderDeliveryFiles.orderId, orderId))

    const bucket = await getFilesBucket()
    const r2Keys = rows
        .filter((row) => row.storage === "r2" && row.objectKey)
        .map((row) => row.objectKey as string)
    if (r2Keys.length && !bucket) {
        throw new Error("DELIVERY_FILE_BUCKET_UNAVAILABLE")
    }
    if (bucket && r2Keys.length) {
        await bucket.delete(r2Keys)
    }

    await db.delete(orderDeliveryFiles).where(eq(orderDeliveryFiles.orderId, orderId))
}

/**
 * deleteDeliveryFileIds 只删除指定 id 的交付附件。
 *
 * 用途：手动发货在「附件已落库、但后续订单状态更新失败」时回滚本次上传，
 * 避免留下没人引用的孤儿附件。回滚是 best-effort —— 即使清理失败也不能
 * 覆盖原始错误，否则管理员看到的原因会被误导。
 */
export async function deleteDeliveryFileIds(orderId: string, fileIds: number[]) {
    const ids = fileIds.filter((id) => Number.isFinite(id))
    if (!ids.length) return

    try {
        const rows = await db.select({
            id: orderDeliveryFiles.id,
            storage: orderDeliveryFiles.storage,
            objectKey: orderDeliveryFiles.objectKey,
        })
            .from(orderDeliveryFiles)
            .where(and(eq(orderDeliveryFiles.orderId, orderId), inArray(orderDeliveryFiles.id, ids)))

        const bucket = await getFilesBucket()
        const r2Keys = rows
            .filter((row) => row.storage === "r2" && row.objectKey)
            .map((row) => row.objectKey as string)
        if (bucket && r2Keys.length) {
            await bucket.delete(r2Keys)
        }
        if (rows.length) {
            await db.delete(orderDeliveryFiles)
                .where(and(eq(orderDeliveryFiles.orderId, orderId), inArray(orderDeliveryFiles.id, rows.map((row) => row.id))))
        }
    } catch (error) {
        console.error('[DeliveryFiles] Rollback of saved files failed:', error)
    }
}

export async function listDeliveryFiles(orderId: string): Promise<DeliveryFileMeta[]> {
    try {
        const rows = await db.select({
            id: orderDeliveryFiles.id,
            fileName: orderDeliveryFiles.fileName,
            contentType: orderDeliveryFiles.contentType,
            size: orderDeliveryFiles.size,
        })
            .from(orderDeliveryFiles)
            .where(eq(orderDeliveryFiles.orderId, orderId))
        return rows
    } catch {
        return []
    }
}

export async function saveDeliveryFiles(orderId: string, files: File[]) {
    if (!files.length) return []
    const existingRows = await db.select({ id: orderDeliveryFiles.id })
        .from(orderDeliveryFiles)
        .where(eq(orderDeliveryFiles.orderId, orderId))
    if (existingRows.length + files.length > DELIVERY_FILE_LIMITS.maxFiles) {
        throw new Error("admin.orders.deliveryTooManyFiles")
    }

    const bucket = await getFilesBucket()
    const saved: DeliveryFileMeta[] = []

    try {
        for (const file of files) {
            const fileName = sanitizeFileName(file.name || "file")
            if (!isAllowedDeliveryFile(fileName, file.type)) {
                throw new Error("admin.orders.deliveryInvalidFile")
            }
            const maxBytes = bucket ? DELIVERY_FILE_LIMITS.r2MaxBytes : DELIVERY_FILE_LIMITS.d1MaxBytes
            if (file.size > maxBytes) {
                throw new Error("admin.orders.deliveryFileTooLarge")
            }

            const contentType = resolveDeliveryContentType(fileName, file.type)
            let storage: "r2" | "d1" = "d1"
            let objectKey: string | null = null
            let content: Uint8Array | null = null

            if (bucket) {
                objectKey = `orders/${orderId}/${crypto.randomUUID()}-${fileName}`
                await bucket.put(objectKey, file.stream(), {
                    httpMetadata: { contentType },
                })
                storage = "r2"
            } else {
                content = new Uint8Array(await file.arrayBuffer())
            }

            try {
                const inserted = await db.insert(orderDeliveryFiles).values({
                    orderId,
                    fileName,
                    contentType,
                    size: file.size,
                    storage,
                    objectKey,
                    content,
                    createdAt: new Date(),
                }).returning({
                    id: orderDeliveryFiles.id,
                    fileName: orderDeliveryFiles.fileName,
                    contentType: orderDeliveryFiles.contentType,
                    size: orderDeliveryFiles.size,
                })

                if (!inserted[0]) {
                    throw new Error("DELIVERY_FILE_METADATA_INSERT_FAILED")
                }
                saved.push(inserted[0])
            } catch (error) {
                if (bucket && objectKey) {
                    try {
                        await bucket.delete(objectKey)
                    } catch {
                        // Keep the original metadata failure; orphan cleanup is best effort.
                    }
                }
                throw error
            }
        }
    } catch (error) {
        if (saved.length) {
            try {
                const savedIds = saved.map((file) => file.id)
                const storedRows = await db.select({
                    id: orderDeliveryFiles.id,
                    storage: orderDeliveryFiles.storage,
                    objectKey: orderDeliveryFiles.objectKey,
                })
                    .from(orderDeliveryFiles)
                    .where(inArray(orderDeliveryFiles.id, savedIds))
                const savedR2Keys = storedRows
                    .filter((row) => row.storage === "r2" && row.objectKey)
                    .map((row) => row.objectKey as string)
                if (bucket && savedR2Keys.length) await bucket.delete(savedR2Keys)
                await db.delete(orderDeliveryFiles).where(inArray(orderDeliveryFiles.id, savedIds))
            } catch {
                // Preserve the original upload failure. Existing metadata keeps any object reachable.
            }
        }
        throw error
    }

    return saved
}

export async function getDeliveryFile(orderId: string, fileId: number) {
    const row = await db.query.orderDeliveryFiles.findFirst({
        where: and(eq(orderDeliveryFiles.orderId, orderId), eq(orderDeliveryFiles.id, fileId)),
    })
    if (!row) return null

    if (row.storage === "r2" && row.objectKey) {
        const bucket = await getFilesBucket()
        if (!bucket) return null
        const object = await bucket.get(row.objectKey)
        if (!object) return null
        return {
            fileName: row.fileName,
            contentType: row.contentType,
            size: row.size,
            body: object.body,
        }
    }

    if (!row.content) return null
    const raw = row.content
    const body = raw instanceof ArrayBuffer
        ? raw
        : raw instanceof Uint8Array
            ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
            : new Uint8Array(raw as ArrayBuffer).buffer
    return {
        fileName: row.fileName,
        contentType: row.contentType,
        size: row.size,
        body,
    }
}
