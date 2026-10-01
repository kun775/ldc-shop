# Worker CPU 超限排查

`Worker exceeded CPU time limit` 表示本次调用的代码执行时间超出预算。数据库、网络的等待时间不计入 CPU；不能把请求总耗时当成 CPU 耗时。

## 先确认套餐及实际预算

Cloudflare 官方当前说明：Workers Free 的 HTTP 与 Cron CPU 预算均为 10 ms；Workers Paid 的 HTTP 默认预算为 30,000 ms，可配置到 300,000 ms。本站 Cron 每分钟运行，Paid 下该 Cron 的 CPU 上限为 30 秒。

本站使用 Next.js 服务端渲染。若当前是 Free，首页与后台都失败时，应优先检查是否撞到免费预算。修改 `limits.cpu_ms` 不能把 Free 变成 Paid。若已是 Paid，需查看失败调用的 CPU Time 和已部署版本的设置，确认是否设置了过低预算，或代码存在热点。

在 Cloudflare 控制台选择当前 Worker：

1. Settings 中确认 CPU 限额与当前 Workers 套餐。
2. Observability / Logs 中打开失败的 `/`、`/admin` 调用，记录 CPU Time、Wall Time、Invocation Status 与部署版本。
3. 对照冷启动与连续访问；用本地 DevTools CPU profiler 定位热点。

只有已确认 Paid、实际 CPU 超过所设预算且业务需要时，才调整 `wrangler.json` 的 `limits.cpu_ms`；发布前重新验证。不要直接把上限拉满掩盖问题。

## 此次代码优化及验证范围

- `/favicon.ico` 的 GET / HEAD 在 Worker 入口直接跳转到 `/favicon`，保留版本查询参数，避免加载 Next 服务端处理器来解析别名。
- 图标路由一次读取五项必要配置；图片缓存命中先于 Base64 解码。
- 缓存按完整图片原值识别，同长度图片更新不会误用旧缓存。
- 本地测试使用模拟数据库和请求，验证处理器调用与解码次数。其结果不能证明线上首页或后台 CPU 已低于预算。
- 本次没有调整 CPU 配置、升级套餐、部署或访问生产 API。上线后的恢复需以 Cloudflare 的 CPU Time 和调用结果确认。

官方资料：

- https://developers.cloudflare.com/workers/platform/limits/#cpu-time
- https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/
- https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/limits.mdx