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

/** 只向已配置的 HTTPS 站点发送 Cron 凭据，配置错误时不回退到进程内执行。 */
function resolveCronOrigin(env) {
    const appUrl = typeof env?.NEXT_PUBLIC_APP_URL === "string" ? env.NEXT_PUBLIC_APP_URL.trim() : "";
    if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is required for scheduled cron dispatch");

    let url;
    try {
        url = new URL(appUrl);
    } catch {
        throw new Error("NEXT_PUBLIC_APP_URL must be a valid HTTPS site origin");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("NEXT_PUBLIC_APP_URL must be an HTTPS site origin without credentials, path, query or fragment");
    }
    return url.origin;
}

/** `[cron-cleanup]` / `[cron-license-service]` —— 沿用既有日志前缀习惯。 */
function cronLabel(path) {
    const segment = path.split("/").filter(Boolean).pop() || "cron";
    return `cron-${segment}`;
}

async function postInternalCron(env, path) {
    const label = cronLabel(path);
    const token = resolveCronToken(env);
    if (!token) {
        console.warn(
            `[${label}] skipped: neither CRON_CLEANUP_TOKEN nor OAUTH_CLIENT_SECRET is configured`
        );
        return;
    }

    const request = new Request(`${resolveCronOrigin(env)}${path}`, {
        method: "POST",
        // 自定义凭据头不能随跨站重定向转发；站点地址必须直接命中当前 Worker。
        redirect: "manual",
        headers: {
            [CRON_TOKEN_HEADER]: token,
        },
    });

    // 通过公共入口触发独立 HTTP 执行，避免 Next.js 与两个任务共用 Cron 的 10ms CPU。
    // 同站点请求依赖 wrangler.json 中的 global_fetch_strictly_public。
    const response = await fetch(request);
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
async function runScheduledCrons(env) {
    for (const path of SCHEDULED_CRON_PATHS) {
        try {
            await postInternalCron(env, path);
        } catch (error) {
            console.error(`[${cronLabel(path)}] threw`, error);
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        // 图标别名直接跳转，避免为一次别名解析加载 Next 服务端处理器。
        if (request.method === "GET" || request.method === "HEAD") {
            const url = new URL(request.url);
            if (url.pathname === "/favicon.ico") {
                url.pathname = "/favicon";
                return new Response(null, {
                    status: 307,
                    headers: { Location: url.toString(), "Cache-Control": "public, max-age=86400" },
                });
            }
        }
        return nextWorker.fetch(request, env, ctx);
    },
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledCrons(env));
    },
};

export * from "./.open-next/worker.js";
