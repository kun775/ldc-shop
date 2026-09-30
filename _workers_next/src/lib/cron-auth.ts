/**
 * 内部定时任务的共享鉴权。
 *
 * 抽出来的理由很直白：`/api/internal/cron/*` 下会有多个入口（清理、卡密服务
 * 对账…），如果每个文件各自实现一遍「取 token + 比较」，迟早会出现某一个漏改
 * 或者比较方式不一致（例如某处用了 `===` 而不是常量时间比较）。
 * 所有入口共用下面这两个函数，新入口只需调用它们。
 */

import { secretsEqual } from "@/lib/crypto";

/**
 * token 头名沿用既有约定，不新造名字：现有的外部定时器（如云函数、cron 服务）
 * 已经按 `x-cron-cleanup-token` 配置，换名字等于要求运维同步改配置。
 */
export const CRON_TOKEN_HEADER = "x-cron-cleanup-token";

/**
 * 取期望的 token。
 *
 * 回退到 `OAUTH_CLIENT_SECRET` 是为了兼容「运维还没配 `CRON_CLEANUP_TOKEN`」
 * 的既有部署：这个回退行为已经存在，改动它会让线上定时任务直接失效。
 */
export function getCronToken(
    env: Record<string, string | undefined> = process.env,
): string | null {
    const token = (env.CRON_CLEANUP_TOKEN || "").trim();
    if (token) return token;
    const oauthSecret = (env.OAUTH_CLIENT_SECRET || "").trim();
    return oauthSecret || null;
}

/** 常量时间比较，避免通过响应时间差猜测 token。 */
export function isAuthorizedCronRequest(request: Request, expectedToken: string): boolean {
    const received = request.headers.get(CRON_TOKEN_HEADER)?.trim();
    return !!received && secretsEqual(received, expectedToken);
}
