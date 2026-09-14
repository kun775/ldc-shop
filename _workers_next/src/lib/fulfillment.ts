export const FULFILLMENT_MODES = ["auto", "manual"] as const

export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number]

export function parseFulfillmentMode(value: unknown): FulfillmentMode {
    return value === "manual" ? "manual" : "auto"
}

export function isManualFulfillment(value: unknown): boolean {
    return parseFulfillmentMode(value) === "manual"
}
