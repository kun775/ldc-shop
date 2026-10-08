# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库布局

- 唯一维护的工程是 `_workers_next/`（Next.js 16 App Router + OpenNext → Cloudflare Workers，D1 + Drizzle，R2，Shadcn UI）。仓库根目录只有总 README；Docker/Vercel 等旧版本已移除，不要恢复。
- `outputs/` 是历史评审报告与开发计划（中文），只作背景参考，不代表当前代码状态。
- `_workers_next/docs/` 是专项设计文档（卡密服务、积分退款、Worker CPU 限额等）；`_workers_next/DESIGN.md` 是 UI 设计规范（前台 Stripe 风格、后台 Linear 风格）。

## 常用命令（均在 `_workers_next/` 下执行）

```bash
npm run dev          # next dev --webpack
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src
npm test             # node --test src/lib/**/*.test.ts
npm run check        # typecheck + lint + test
npm run build        # next build --webpack
```

- 单个测试：`node --test src/lib/license-service/restock.test.ts`（依赖 Node 22 原生 TS 类型擦除，无需编译）。
- `npm test` 只覆盖 `src/lib/**`。`src/actions/*.test.mjs`（用 `typescript.transpileModule` + `vm` 加载 action/组件源码做测试）需单独运行：`node --test src/actions/card-service-restock.test.mjs`。
- 部署由 Cloudflare Workers Builds 执行（`npx opennextjs-cloudflare build` + `npx wrangler deploy`）；不要在本地执行 `npm run deploy`。
- 本地验证构建可设置 `NEXT_DIST_DIR=.next-verify-xxx` 把产物隔离到临时目录（已在 `.gitignore` 中）。

## 测试约定

- 测试使用 `node:test` + `node:assert/strict`，**必须用相对路径并带 `.ts` 扩展名导入**；`@/` 别名在 `node --test` 下无法解析。因此需要被测试的业务模块不能（直接或间接）导入 `@/lib/db` 等依赖 Cloudflare 运行时的模块。
- 卡密服务采用端口模式：业务逻辑只依赖 `src/lib/license-service/db-port.ts` 的 `CardServiceDatabase`（`query` / 原子 `write`），D1 实现在 `database.ts`。测试用 `test-support.ts` 中基于 `node:sqlite` 内存库的真实 SQLite 实现和记录调用的假客户端。
- 存在大量"接线守卫"测试，通过读取源码文本断言关键调用没有被漏掉（如 `cron-wiring.test.ts`、`*-wiring.test.ts`）。修改相关文件后若这类测试失败，先确认是否确实漏了接线。

## 架构要点

### Worker 入口与定时任务
- `worker-entry.mjs` 包装 OpenNext 生成的 `.open-next/worker.js`。`scheduled()` 每分钟（`wrangler.json` crons）**通过公网 HTTP** POST 到 `SCHEDULED_CRON_PATHS` 中的 `/api/internal/cron/*`，带 `x-cron-cleanup-token` 头（`CRON_CLEANUP_TOKEN`，回退为 `OAUTH_CLIENT_SECRET`），使每个任务拥有独立的 CPU 预算。
- **新增 `src/app/api/internal/cron/<name>/route.ts` 时必须在 `SCHEDULED_CRON_PATHS` 中登记**，否则不会被调度（`cron-wiring.test.ts` 会守卫）。
- Workers Free 的 HTTP/Cron CPU 预算只有 10 ms，CPU 是持续约束：定时任务要有单轮处理上限，避免读放大的 SQL（参见 `docs/WORKER_CPU_LIMITS.md`）。

### 数据访问
- `src/lib/db/index.ts` 通过 `getCloudflareContext()` 获取 `env.DB`，并用代理包装成同步的 Drizzle 实例 `db`；构建阶段使用模拟 D1。多条相关写入使用 `runAtomicD1Batch`（D1 batch 原子提交）。
- `src/lib/db/queries.ts` 很大（约 170 KB），集中了大部分查询以及数据库升级执行器；修改时按符号定位，不要整体读取。
- D1 单条语句的绑定参数有数量上限，批量操作需要分块。

### 数据库结构升级（不使用 drizzle 迁移）
- 生产结构变更**不是**通过 drizzle-kit 迁移完成，而是由管理员在后台"数据库升级"页面手动触发。普通请求不执行 DDL。
- 新增升级需同时修改：
  1. `src/lib/db/database-upgrade-registry.ts` 的 `DATABASE_UPGRADE_DEFINITIONS`（按序号 `00NN_xxx` 追加 id/名称/说明）；
  2. `src/lib/db/queries.ts` 中对应的执行器（必须幂等，例如容忍重复列）以及结构自检映射；
  3. `src/lib/db/schema.ts` 及相关的 `*-schema.ts`。
- `schema-drift`、`database-upgrade-*` 测试负责守卫注册表、执行器与结构之间的一致性。
- `drizzle-kit push` 只用于本地 `local.sqlite`（`LOCAL_DB_PATH`）。

### 业务分层
- `src/actions/*.ts`：Server Actions（后台操作入口先调用 `checkAdmin()`）。`src/app/`：页面与 API 路由（支付回调 `api/notify`、NextAuth `api/auth`、内部 cron）。`src/components/`：大量客户端组件（`*-content.tsx`），后台组件位于 `components/admin/`。
- `src/lib/` 按领域拆分子目录：`license-service/`（外部卡密中心对接：补货、交付、对账、作废、撤销与操作队列）、`orders/`、`points/`（积分账本，余额由 DB 触发器维护）、`coupons/`、`audit/`（审计事件与平台错误日志）、`errors/`（`logServerError` 生成可查询的错误 ID）。
- 订单履约主流程位于 `src/lib/order-processing.ts`；支付使用 EPay（`src/lib/epay.ts`）。
- 认证：`src/lib/auth.ts`（NextAuth v5 beta），支持 Linux DO OIDC、GitHub（用户名前缀 `gh_`）、DEX（前缀 `dex_`，ID 为 `dex:<sub>`）。管理员由环境变量 `ADMIN_USERS` / `ADMIN_USER_IDS` 决定（`src/lib/admin-auth.ts`）。

### i18n
- 文案位于 `src/locales/zh.json` 与 `src/locales/en.json`，新增 key 必须两边同时添加（部分测试会检查）。

## 版本与发布约定

- 版本号在 `_workers_next/package.json` 中维护（`APP_VERSION` 从中读取，并用于后台更新检查）。发版时同步修改 `package-lock.json`，并在 `_workers_next/README.md` 与 `README_EN.md` 顶部追加"当前状态（日期，vX.Y.Z）"段落；提交信息以 `(vX.Y.Z)` 结尾。
- 新增功能或接口时升 minor，修复实现细节时升 patch。
- `README.md` 与 `README_EN.md`（根目录和 `_workers_next/` 各一份）内容保持中英对应。
