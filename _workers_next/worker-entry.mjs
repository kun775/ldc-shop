import nextWorker from "./.open-next/worker.js";

const CRON_TOKEN_HEADER = "x-cron-cleanup-token";

/**
 * 定时任务入口清单。
 *
 * ⚠️ 新增一个 `src/app/api/internal/cron/<name>/route.ts` 时，**必须**在这里登记一行，
 * 否则那个入口只在有人手动发请求时才会跑 —— 路由存在不等于被调度。
 * (曾有 `/api/internal/cron/license-service` 就这样静默漏接线，四步补偿一次都没执行。)
 * `src/lib/cron-wiring.test.ts` 会读本文件文本做守卫，漏登记即测试失败。
 */
const SCHEDULED_CRON_PATHS = [
    "/api/internal/cron/cleanup",
    "/api/internal/cron/license-service",
];

function resolveCronToken(env) {
    const cronToken = typeof env?.CRON_CLEANUP_TOKEN === "string" ? env.CRON_CLEANUP_TOKEN.trim() : "";
    if (cronToken) return cronToken;

    const oauthSecret = typeof env?.OAUTH_CLIENT_SECRET === "string" ? env.OAUTH_CLIENT_SECRET.trim() : "";
    return oauthSecret;
}

/** `[cron-cleanup]` / `[cron-license-service]` —— 沿用既有日志前缀习惯。 */
function cronLabel(path) {
    const segment = path.split("/").filter(Boolean).pop() || "cron";
    return `cron-${segment}`;
}

async function postInternalCron(env, ctx, path) {
    const label = cronLabel(path);
    const token = resolveCronToken(env);
    if (!token) {
        console.warn(
            `[${label}] skipped: neither CRON_CLEANUP_TOKEN nor OAUTH_CLIENT_SECRET is configured`
        );
        return;
    }

    const request = new Request(`https://cron.internal${path}`, {
        method: "POST",
        headers: {
            [CRON_TOKEN_HEADER]: token,
        },
    });

    const response = await nextWorker.fetch(request, env, ctx);
    const body = await response.text();
    if (!response.ok) {
        console.error(`[${label}] failed: ${response.status} ${body.slice(0, 500)}`);
        return;
    }

    console.log(`[${label}] ok: ${body}`);
}

/**
 * 逐个入口串行执行，**每个入口独立 try/catch**：
 * 一个入口失败（或抛错）不能阻断其余入口，否则「清理挂了」会连带让卡密补偿停摆。
 */
async function runScheduledCrons(env, ctx) {
    for (const path of SCHEDULED_CRON_PATHS) {
        try {
            await postInternalCron(env, ctx, path);
        } catch (error) {
            console.error(`[${cronLabel(path)}] threw`, error);
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        return nextWorker.fetch(request, env, ctx);
    },
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledCrons(env, ctx));
    },
};

export * from "./.open-next/worker.js";
