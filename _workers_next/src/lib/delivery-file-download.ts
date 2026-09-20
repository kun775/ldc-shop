export function shouldRecordDeliveryFileDownload(input: {
    fulfillmentMode: unknown
    isOwner: boolean
    hasGuestAccess: boolean
}) {
    return input.fulfillmentMode === "manual"
        && (input.isOwner || input.hasGuestAccess)
}
