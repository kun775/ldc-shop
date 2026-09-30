import { NextResponse } from "next/server";
import { getCronToken, isAuthorizedCronRequest } from "@/lib/cron-auth";
import { cancelExpiredOrders, cleanupExpiredCardsIfNeeded } from "@/lib/db/queries";

const CARD_CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
    const expectedToken = getCronToken();
    if (!expectedToken) {
        return NextResponse.json(
            { success: false, error: "cleanup_token_not_configured" },
            { status: 500 }
        );
    }

    if (!isAuthorizedCronRequest(request, expectedToken)) {
        return NextResponse.json(
            { success: false, error: "unauthorized" },
            { status: 401 }
        );
    }

    const startedAt = Date.now();
    const [cardsResult, ordersResult] = await Promise.allSettled([
        cleanupExpiredCardsIfNeeded(CARD_CLEANUP_THROTTLE_MS),
        cancelExpiredOrders(),
    ]);

    const durationMs = Date.now() - startedAt;

    if (cardsResult.status === "rejected" || ordersResult.status === "rejected") {
        console.error("[cron-cleanup] failed", {
            cardsError: cardsResult.status === "rejected" ? String(cardsResult.reason) : null,
            ordersError: ordersResult.status === "rejected" ? String(ordersResult.reason) : null,
        });

        return NextResponse.json(
            { success: false, error: "cleanup_failed", durationMs },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        durationMs,
        cardsCleanupRan: cardsResult.value,
        cancelledOrderCount: ordersResult.value.length,
    });
}
