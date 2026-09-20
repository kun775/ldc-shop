import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { settings } from "@/lib/db/schema"
import { setSetting } from "@/lib/db/queries"

export const CARD_DELIVERY_NOTE_MAX_LENGTH = 4000

export function getProductCardDeliveryNoteSettingKey(productId: string) {
    return `cards_delivery_note_${productId}`
}

function getErrorText(error: unknown) {
    let serialized = ""
    try {
        serialized = JSON.stringify(error)
    } catch {
        // Ignore serialization failures and fall back to the standard error message.
    }
    return `${error instanceof Error ? error.message : ""}${serialized}`.toLowerCase()
}

export async function getProductCardDeliveryNote(productId: string): Promise<string> {
    const id = String(productId || "").trim()
    if (!id) return ""

    try {
        const key = getProductCardDeliveryNoteSettingKey(id)
        const rows = await db.select({ value: settings.value })
            .from(settings)
            .where(eq(settings.key, key))
            .limit(1)
        return rows[0]?.value || ""
    } catch (error: unknown) {
        const text = getErrorText(error)
        if (text.includes("no such table") && text.includes("settings")) return ""
        throw error
    }
}

export async function saveProductCardDeliveryNote(productId: string, rawNote: string) {
    const id = String(productId || "").trim()
    if (!id) throw new Error("Invalid product id")

    const note = String(rawNote || "").trim()
    if (note.length > CARD_DELIVERY_NOTE_MAX_LENGTH) {
        throw new Error("admin.cards.deliveryNoteTooLong")
    }

    await setSetting(getProductCardDeliveryNoteSettingKey(id), note)
    return note
}

export async function deleteProductCardDeliveryNote(productId: string) {
    const id = String(productId || "").trim()
    if (!id) return
    await db.delete(settings)
        .where(eq(settings.key, getProductCardDeliveryNoteSettingKey(id)))
}
