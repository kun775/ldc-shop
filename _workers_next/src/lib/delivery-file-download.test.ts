import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { shouldRecordDeliveryFileDownload } from "./delivery-file-download.ts"

test("only customer access to a manual fulfillment file records a download", () => {
    assert.equal(shouldRecordDeliveryFileDownload({
        fulfillmentMode: "manual",
        isOwner: true,
        hasGuestAccess: false,
    }), true)
    assert.equal(shouldRecordDeliveryFileDownload({
        fulfillmentMode: "manual",
        isOwner: false,
        hasGuestAccess: true,
    }), true)
    assert.equal(shouldRecordDeliveryFileDownload({
        fulfillmentMode: "manual",
        isOwner: false,
        hasGuestAccess: false,
    }), false)
    assert.equal(shouldRecordDeliveryFileDownload({
        fulfillmentMode: "auto",
        isOwner: true,
        hasGuestAccess: false,
    }), false)
})

test("download tracking happens only after authorization and file lookup", () => {
    const source = readFileSync(
        new URL("../app/order/[id]/files/[fileId]/route.ts", import.meta.url),
        "utf8"
    )
    const forbidden = source.indexOf('status: 403')
    const fileLookup = source.indexOf('const file = await getDeliveryFile')
    const tracking = source.indexOf('await markDeliveryFileDownloaded')
    const response = source.indexOf('return new NextResponse(file.body')

    assert.ok(forbidden >= 0 && forbidden < fileLookup)
    assert.ok(fileLookup < tracking)
    assert.ok(tracking < response)
})

test("repeat downloads preserve the first recorded time", () => {
    const source = readFileSync(new URL("./delivery-files.ts", import.meta.url), "utf8")
    assert.match(source, /isNull\(orderDeliveryFiles\.downloadedAt\)/)
    assert.match(source, /\.set\(\{ downloadedAt \}\)/)
})
