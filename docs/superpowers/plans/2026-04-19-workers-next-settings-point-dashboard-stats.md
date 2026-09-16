# _workers_next 店铺设置页积分统计增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `_workers_next` 的 `/admin/settings` 顶部四张时间统计卡中，同时展示订单数、LDC 收入、签到积分产出、订单积分消耗。

**Architecture:** 继续复用 `getDashboardStats(nowMs)` 作为页面唯一统计入口，在 `queries.ts` 内拆成“订单聚合 + 积分账本聚合”两段查询后合并为统一 `stats` 结构。UI 层只扩展 `Stats` 类型和卡片次级信息，不新增页面级查询、不改顾客数卡片；由于当前仓库没有独立 `test` script，本计划用编译期契约检查加 `npm run build` 和页面手动回归来做红绿验证。

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Drizzle ORM, Cloudflare D1, Wrangler, i18n JSON locales

---

## File Structure

- Modify: `_workers_next/src/lib/db/queries.ts`
  - 扩展 `getDashboardStats(nowMs)` 返回结构。
  - 在积分聚合前调用 `ensureUserPointLedgerSchema()`，避免账本表不存在时后台页面直接报错。
  - 仅统计 `checkin_reward` 和 `order_deduction`，并把 `order_deduction` 的负数和转成正数展示值。
- Review only: `_workers_next/src/app/admin/settings/page.tsx`
  - 保持页面继续只调用一次 `getDashboardStats(nowMs)` 并透传 `stats`。
  - 预期无需业务逻辑改动；这里只作为编译契约检查点。
- Modify: `_workers_next/src/components/admin/settings-content.tsx`
  - 扩展 `Stats` 类型。
  - 调整顶部四张时间卡结构，保留订单数主值，新增三行次级统计文案。
  - 顾客数卡片保持原样。
- Modify: `_workers_next/src/locales/zh.json`
  - 新增 `admin.stats.ldcRevenue` / `admin.stats.pointsProduced` / `admin.stats.pointsConsumed`。
- Modify: `_workers_next/src/locales/en.json`
  - 同步新增英文文案。

## Constraints And Notes

- 不新增数据库表，不写迁移脚本；只复用现有 `user_point_ledger`。
- 订单统计继续使用 `orders.status = 'delivered'` 和 `orders.paid_at`。
- 积分统计只使用：
  - `event_type = 'checkin_reward'` 作为积分产出
  - `event_type = 'order_deduction'` 作为积分消耗
- 明确排除：
  - `refund_return`
  - `admin_adjust`
- `order_deduction.delta` 在账本里是负数，UI 展示必须转成正数消耗量。
- 现有 `page.tsx` 已经只拉一次 `getDashboardStats(nowMs)`，不要额外加第二套统计查询。

### Task 1: 抬高设置页统计契约并补齐展示文案

**Files:**
- Modify: `_workers_next/src/components/admin/settings-content.tsx:21-25`
- Modify: `_workers_next/src/components/admin/settings-content.tsx:390-442`
- Modify: `_workers_next/src/locales/zh.json:509-517`
- Modify: `_workers_next/src/locales/en.json:509-517`
- Review: `_workers_next/src/app/admin/settings/page.tsx:10-36`

- [ ] **Step 1: 先把设置页 `Stats` 类型和卡片结构改成积分增强版，让编译先暴露服务端返回结构还没跟上的问题**

```tsx
interface StatPeriod {
    count: number
    revenue: number
    pointsProduced: number
    pointsConsumed: number
}

interface Stats {
    today: StatPeriod
    week: StatPeriod
    month: StatPeriod
    total: StatPeriod
}

const statCards = [
    { key: "today", title: t("admin.stats.today"), icon: ShoppingCart, value: stats.today },
    { key: "week", title: t("admin.stats.week"), icon: TrendingUp, value: stats.week },
    { key: "month", title: t("admin.stats.month"), icon: CreditCard, value: stats.month },
    { key: "total", title: t("admin.stats.total"), icon: Package, value: stats.total },
] as const
```

```tsx
<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
    {statCards.map(({ key, title, icon: Icon, value }) => (
        <Card key={key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-2">
                <div className="text-2xl font-bold">{value.count}</div>
                <div className="space-y-1 text-xs text-muted-foreground">
                    <p>{t("admin.stats.ldcRevenue")}: {value.revenue.toFixed(0)} {t("common.credits")}</p>
                    <p>{t("admin.stats.pointsProduced")}: {value.pointsProduced}</p>
                    <p>{t("admin.stats.pointsConsumed")}: {value.pointsConsumed}</p>
                </div>
            </CardContent>
        </Card>
    ))}

    <Link href="/admin/users" className="block">
        <Card className="hover:bg-accent/50 transition-colors h-full">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{t("admin.stats.visitors")}</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{visitorCount}</div>
                <p className="text-xs text-muted-foreground">{t("home.visitorCount", { count: visitorCount })}</p>
            </CardContent>
        </Card>
    </Link>
</div>
```

- [ ] **Step 2: 同步补齐中英文文案，避免 UI 渲染时回退成 key**

```json
"stats": {
    "today": "今日",
    "week": "近7天",
    "month": "本月",
    "total": "总计",
    "visitors": "顾客数",
    "ldcRevenue": "LDC 收入",
    "pointsProduced": "积分产出",
    "pointsConsumed": "积分消耗",
    "lowStock": "库存预警",
    "lowStockHint": "阈值 ≤ {{threshold}}",
    "recentOrders": "最近订单"
}
```

```json
"stats": {
    "today": "Today",
    "week": "Last 7 Days",
    "month": "This Month",
    "total": "Total",
    "visitors": "Customers",
    "ldcRevenue": "LDC Revenue",
    "pointsProduced": "Points Produced",
    "pointsConsumed": "Points Consumed",
    "lowStock": "Low stock",
    "lowStockHint": "Threshold ≤ {{threshold}}",
    "recentOrders": "Recent Orders"
}
```

- [ ] **Step 3: 运行编译，确认现在是“前端契约先行、服务端未跟上”的失败状态**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run build
```

Expected: `FAIL`，并在 `src/app/admin/settings/page.tsx` 或 `src/components/admin/settings-content.tsx` 附近看到类型错误，指向 `getDashboardStats()` 返回对象缺少 `pointsProduced` / `pointsConsumed` 字段。

### Task 2: 扩展 `getDashboardStats()`，把积分产出和消耗聚合进统一统计对象

**Files:**
- Modify: `_workers_next/src/lib/db/queries.ts:1-7`
- Modify: `_workers_next/src/lib/db/queries.ts:1223-1260`
- Review: `_workers_next/src/app/admin/settings/page.tsx:10-36`

- [ ] **Step 1: 引入账本 schema 和 schema guard，确保设置页查询在冷库或新环境里也不会因为表未创建而直接炸掉**

```ts
import { products, cards, orders, settings, reviews, reviewReplies, loginUsers, categories, userNotifications, wishlistItems, wishlistVotes, userPointLedger } from "./schema";
import { applyUserAutomaticPointEvent, ensurePointLedgerUserRecord, ensureUserPointLedgerSchema } from "@/lib/points/ledger-db";
```

- [ ] **Step 2: 把 `getDashboardStats(nowMs)` 改成“订单聚合 + 积分聚合 + 返回合并”的结构**

```ts
export async function getDashboardStats(nowMs: number) {
    return await withOrderColumnFallback(async () => {
        const now = new Date(nowMs);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const todayStartMs = todayStart.getTime();
        const weekStartMs = weekStart.getTime();
        const monthStartMs = monthStart.getTime();

        const orderStats = await db.select({
            totalCount: sql<number>`count(*)`,
            totalRevenue: sql<number>`COALESCE(sum(CAST(${orders.amount} AS REAL)), 0)`,
            todayCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN 1 ELSE 0 END), 0)`,
            todayRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            weekCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN 1 ELSE 0 END), 0)`,
            weekRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            monthCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN 1 ELSE 0 END), 0)`,
            monthRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
        })
            .from(orders)
            .where(eq(orders.status, "delivered"));

        const orderRow = orderStats[0] || {
            totalCount: 0,
            totalRevenue: 0,
            todayCount: 0,
            todayRevenue: 0,
            weekCount: 0,
            weekRevenue: 0,
            monthCount: 0,
            monthRevenue: 0,
        };

        const emptyPointRow = {
            totalProduced: 0,
            totalConsumed: 0,
            todayProduced: 0,
            todayConsumed: 0,
            weekProduced: 0,
            weekConsumed: 0,
            monthProduced: 0,
            monthConsumed: 0,
        };

        let pointRow = emptyPointRow;

        try {
            await ensureUserPointLedgerSchema();

            const pointStats = await db.select({
                totalProduced: sql<number>`COALESCE(SUM(CASE WHEN ${userPointLedger.eventType} = 'checkin_reward' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                totalConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${userPointLedger.eventType} = 'order_deduction' THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                todayProduced: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} AND ${userPointLedger.eventType} = 'checkin_reward' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                todayConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${todayStartMs} AND ${userPointLedger.eventType} = 'order_deduction' THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                weekProduced: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${weekStartMs} AND ${userPointLedger.eventType} = 'checkin_reward' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                weekConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${weekStartMs} AND ${userPointLedger.eventType} = 'order_deduction' THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
                monthProduced: sql<number>`COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${monthStartMs} AND ${userPointLedger.eventType} = 'checkin_reward' THEN ${userPointLedger.delta} ELSE 0 END), 0)`,
                monthConsumed: sql<number>`ABS(COALESCE(SUM(CASE WHEN ${normalizeTimestampMs(userPointLedger.createdAt)} >= ${monthStartMs} AND ${userPointLedger.eventType} = 'order_deduction' THEN ${userPointLedger.delta} ELSE 0 END), 0))`,
            }).from(userPointLedger);

            pointRow = pointStats[0] || emptyPointRow;
        } catch (error: any) {
            if (!isMissingTableOrColumn(error)) throw error;
        }

        return {
            today: {
                count: orderRow.todayCount || 0,
                revenue: orderRow.todayRevenue || 0,
                pointsProduced: pointRow.todayProduced || 0,
                pointsConsumed: pointRow.todayConsumed || 0,
            },
            week: {
                count: orderRow.weekCount || 0,
                revenue: orderRow.weekRevenue || 0,
                pointsProduced: pointRow.weekProduced || 0,
                pointsConsumed: pointRow.weekConsumed || 0,
            },
            month: {
                count: orderRow.monthCount || 0,
                revenue: orderRow.monthRevenue || 0,
                pointsProduced: pointRow.monthProduced || 0,
                pointsConsumed: pointRow.monthConsumed || 0,
            },
            total: {
                count: orderRow.totalCount || 0,
                revenue: orderRow.totalRevenue || 0,
                pointsProduced: pointRow.totalProduced || 0,
                pointsConsumed: pointRow.totalConsumed || 0,
            },
        };
    });
}
```

- [ ] **Step 3: 再跑一次编译，确认红转绿**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run build
```

Expected: `PASS`，输出中至少应出现 `Compiled successfully`，且不再出现 `pointsProduced` / `pointsConsumed` 缺失、`Cannot find name`、或 `getDashboardStats` 返回类型不匹配的错误。

- [ ] **Step 4: 手动回归 `/admin/settings` 页面，并用只读 D1 查询交叉核对总计卡**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run dev
```

Open: `http://localhost:3000/admin/settings`

Verify in browser:
- 四张时间卡主值仍然是订单数。
- 每张卡都出现三行小字：`LDC 收入`、`积分产出`、`积分消耗`。
- 顾客数卡片仍保持原来的样式、数值和跳转到 `/admin/users` 的行为。
- `积分消耗` 不显示负号。

Read-only cross-check commands:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npx wrangler d1 execute ldc-shop-next --local --command "SELECT COUNT(*) AS total_count, COALESCE(SUM(CAST(amount AS REAL)), 0) AS total_revenue FROM orders WHERE status = 'delivered';"
npx wrangler d1 execute ldc-shop-next --local --command "SELECT COALESCE(SUM(CASE WHEN event_type = 'checkin_reward' THEN delta ELSE 0 END), 0) AS total_points_produced, ABS(COALESCE(SUM(CASE WHEN event_type = 'order_deduction' THEN delta ELSE 0 END), 0)) AS total_points_consumed FROM user_point_ledger;"
```

Expected:
- `/admin/settings` 的“总计”卡与上述两条只读查询结果一致。
- `refund_return`、`admin_adjust` 不会影响第二条查询结果。

- [ ] **Step 5: 提交一个干净的功能提交**

```powershell
Set-Location 'E:\local_project\git\ldc-shop'
git add _workers_next/src/lib/db/queries.ts _workers_next/src/components/admin/settings-content.tsx _workers_next/src/locales/zh.json _workers_next/src/locales/en.json
git commit -m "feat(settings): 增加店铺设置页积分产出与消耗统计"
```

## Self-Review

- 规格覆盖检查：
  - 今日 / 近 7 天 / 本月 / 总计四个时间范围已覆盖。
  - 订单数、LDC 收入、积分产出、积分消耗四类值都已落入统一 `stats` 结构。
  - 只统计 `checkin_reward` 和 `order_deduction`，排除了 `refund_return`、`admin_adjust`。
  - 顾客数卡片保持不变，没有引入第二排统计卡。
- 占位符扫描：
  - 计划中的文件路径、命令、代码片段、验证方式都已具体化，没有留 `TODO` 或“后续补充”类占位。
- 类型一致性：
  - UI 端统一使用 `pointsProduced` / `pointsConsumed`。
  - 服务端返回结构也统一使用 `pointsProduced` / `pointsConsumed`，避免前后命名漂移。
