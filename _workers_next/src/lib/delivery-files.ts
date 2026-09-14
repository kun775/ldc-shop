import { getCloudflareContext } from "@opennextjs/cloudflare"
import { and, eq } from "drizzle-orm"
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
        return (ctx as any)?.env?.FILES ?? null
    } catch {
        return null
    }
}

export async function deleteDeliveryFiles(orderId: string) {
    try {
        const rows = await db.select({
            storage: orderDeliveryFiles.storage,
            objectKey: orderDeliveryFiles.objectKey,
        })
            .from(orderDeliveryFiles)
            .where(eq(orderDeliveryFiles.orderId, orderId))

        const bucket = await getFilesBucket()
        if (bucket) {
            for (const row of rows) {
                if (row.storage === "r2" && row.objectKey) {
                    try {
                        await bucket.delete(row.objectKey)
                    } catch {
                        // best effort
                    }
                }
            }
        }

        await db.delete(orderDeliveryFiles).where(eq(orderDeliveryFiles.orderId, orderId))
    } catch {
        // table may not exist yet
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
    if (files.length > DELIVERY_FILE_LIMITS.maxFiles) {
        throw new Error("admin.orders.deliveryTooManyFiles")
    }

    const bucket = await getFilesBucket()
    const saved: DeliveryFileMeta[] = []

    for (const file of files) {
        const fileName = sanitizeFileName(file.name || "file")
        if (!isAllowedDeliveryFile(fileName, file.type)) {
            throw new Error("admin.orders.deliveryInvalidFile")
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        const maxBytes = bucket ? DELIVERY_FILE_LIMITS.r2MaxBytes : DELIVERY_FILE_LIMITS.d1MaxBytes
        if (bytes.byteLength > maxBytes) {
            throw new Error("admin.orders.deliveryFileTooLarge")
        }

        const contentType = resolveDeliveryContentType(fileName, file.type)
        let storage: "r2" | "d1" = "d1"
        let objectKey: string | null = null
        let content: Uint8Array | null = bytes

        if (bucket) {
            objectKey = `orders/${orderId}/${crypto.randomUUID()}-${fileName}`
            await bucket.put(objectKey, bytes, {
                httpMetadata: { contentType },
            })
            storage = "r2"
            content = null
        }

        const inserted = await db.insert(orderDeliveryFiles).values({
            orderId,
            fileName,
            contentType,
            size: bytes.byteLength,
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

        if (inserted[0]) saved.push(inserted[0])
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
        const body = await object.arrayBuffer()
        return {
            fileName: row.fileName,
            contentType: row.contentType,
            size: row.size,
            body,
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
