/**
 * 卡密服务的定时任务入口（接入方案阶段 E 第 5 条）。
 *
 * 四件事，按「用户感知优先」的顺序串行执行：
 *
 *   1. **交付重放** —— 台账里还有 `sell` 待办的订单，按原幂等键再推一次。
 *      用户已付款，这是最该先修好的。
 *   2. **对账** —— 推进未 Ack 的分配、清理超窗残留（口径以 `GET /allocations/{id}`
 *      为准，不用重放响应）。
 *   3. **作废重放** —— 退款时中心不可达/凭据缺失留下的 `pending`/`failed`。
 *   4. **低水位补货** —— 目标库存不足的商品再领几张。
 *
 * 刻意串行：四步都要写 D1，并发只会互相抢锁、并让失败归因变模糊。
 * 任一步抛错即整体返回 500（外部定时器据此告警），已完成步骤的结果照常回传。
 *
 * 未接入中心（缺少 Base URL / 销售 Key）时返回 `skipped` 而不是报错 ——
 * 绝大多数部署都是「根本没接」这个状态，把它算成故障会让告警失效。
 */

import { NextResponse } from "next/server";
import { getCronToken, isAuthorizedCronRequest } from "@/lib/cron-auth";
import {
    isLicenseServiceConfigured,
    reconcileCardService,
    replenishCardStock,
    replayPendingCardServiceRevokes,
} from "@/lib/license-service";
import { retryPendingCardServiceDeliveries } from "@/lib/order-processing";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function clampLimit(raw: string | null): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

export async function POST(request: Request) {
    const expectedToken = getCronToken();
    if (!expectedToken) {
        return NextResponse.json(
            { success: false, error: "cron_token_not_configured" },
            { status: 500 }
        );
    }

    if (!isAuthorizedCronRequest(request, expectedToken)) {
        return NextResponse.json(
            { success: false, error: "unauthorized" },
            { status: 401 }
        );
    }

    if (!isLicenseServiceConfigured()) {
        return NextResponse.json({
            success: true,
            skipped: "license_service_not_configured",
        });
    }

    const startedAt = Date.now();
    const limit = clampLimit(new URL(request.url).searchParams.get("limit"));
    const steps: Record<string, unknown> = {};

    try {
        steps.deliveries = await retryPendingCardServiceDeliveries({ limit });
        steps.reconcile = await reconcileCardService({ limit });
        steps.revokes = await replayPendingCardServiceRevokes({ limit });
        steps.replenish = await replenishCardStock({});
    } catch (error) {
        console.error("[cron-license-service] failed", error);
        return NextResponse.json(
            {
                success: false,
                error: "license_service_cron_failed",
                durationMs: Date.now() - startedAt,
                steps,
            },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        durationMs: Date.now() - startedAt,
        steps,
    });
}
