# LDC Shop 代码审查报告（2026-09-24）

**审查对象**：`_workers_next/`（CF Workers + D1，版本 2.1.1）
**审查维度**：效率 · 安全 · UI/UX · Cloudflare D1 查询与写入
**审查方式**：只读代码走查 + 本机实测（eslint / tsc / 单测 / npm audit / 构建产物分析）
**对照基线**：`outputs/ldc-shop-code-review-2026-09-16.md`

---

## 0. 质量门禁实测结果

| 检查 | 结果 |
|---|---|
| `eslint src` | **0 error / 357 warning**（几乎全是 `no-explicit-any`，配置已将其降为 warn） |
| `tsc --noEmit` | **通过**（exit 0，无输出） |
| `node --test src/lib/**/*.test.ts` | **273 项全部通过**，耗时 3.1s |
| `npm audit --omit=dev` | **8 个漏洞（1 low / 4 moderate / 3 high）**，全部为传递依赖 |
| 构建产物 | `.open-next/server-functions/default/handler.mjs` 约 7.4 MB |

结论：**工程规范面是健康的**——类型安全、单测、lint 均已接通且有实际约束力（对比 09-16 报告中「lint 门禁已失效 / 测试覆盖严重不足」已是明显改善）。下面的问题集中在**运行时成本、并发正确性与无障碍/本地化**，而非「代码写得乱」。

---

## 1. 与 09-16 审查的对比：已确认修复

先确认历史问题状态，避免重复劳动：

| 09-16 编号 | 问题 | 现状 | 证据 |
|---|---|---|---|
| P0-1 | 订单详情/卡密 Cookie 授权绕过 | **已修复** | `app/order/[id]/page.tsx:29-38` 明确 `isOwner \|\| isAdmin \|\| hasGuestAccess`，未授权走 `notFound()`；`order/[id]/files/[fileId]/route.ts:41-49` 同样三选一 |
| P0-2 | 生产依赖 Critical 漏洞 | **部分修复** | 无 critical 了，剩 3 high（见 §3.6） |
| P0-3 | 履约失败仍回 `success` | **已修复** | `api/notify/route.ts:101-105` 返回 503 让网关重试；`:107-110` 返回 500 |
| P0-4 | 自动发卡缺订单级并发 claim | **已修复** | `lib/order-processing.ts:400-435` 用 `fulfillmentClaimId` + 条件 UPDATE 抢占，10 分钟 TTL 可重入；后续所有终态更新都带 `eq(orders.fulfillmentClaimId, claimId)` 兜底 |
| P1-1 | 管理员仅按 OAuth username 判定 | **已修复** | `lib/admin-auth.ts:21-31` 优先 `ADMIN_USER_IDS`，username 仅作遗留回退，注释已标注 |
| P1-2 | 出站请求无超时 | **基本修复** | 新增 `lib/runtime/fetch-with-timeout.ts`，card-api / email / epay / notifications / registry 均已换用；**剩余 2 处未覆盖**（§3.7） |
| P1-3 | 运行时热路径承担迁移/回填 | **大部分修复** | `ensureDatabaseInitialized()`（`queries.ts:754-766`）已瘦身为单条 `SELECT 1`，DDL 全部收敛到管理员手动升级路径；**残留**见 §3.8 |

**残留未修复**：P2-1 首页全量商品（§2.1）、P2-7 Footer 可执行管理员 HTML（§3.4）、P1-6 表单可访问名称（§4.1）。

---

## 2. 🔴 阻断级（建议本迭代内修）

### 2.1 首页把**全量商品**读进内存再下发客户端做筛选/排序/分页

- `lib/db/queries.ts:1456-1496` `getActiveProducts()` — **没有 LIMIT**，无搜索/分类/排序参数，`ORDER BY sort_order, created_at` 后整体返回。
- `app/page.tsx:41-46` 已经解析出 `q / category / sort / page`，但 `:110-122` 只是把它们当作 `filters`/`pagination` **透传给客户端**，从未进入 SQL。
- `components/home-content.tsx:111-147` 在浏览器里 `filter → sort → slice(pageSize=24)`。

**为什么是阻断**：这是 D1 计费与首屏体验的双重放大器。

1. **D1 读行放大**：每来一个首页 PV（包括爬虫、预取、未登录访客），就扫一遍 `products` 全表并**传输全部字段**（含 `description`，只有超 1000 字符才截断）。商品数到 500 时，单次首页 = 500 行读 + 数百 KB RSC payload。
2. **RSC 载荷**：整份商品 JSON 会被序列化进 Flight 流，`priority={index < 4}` 的图片预加载也随之错位。
3. **已有更优实现却未启用**：`queries.ts:2342-2434` 的 `searchActiveProducts()` 已经支持 `q/category/sort/page/pageSize` 且 `pageSize` 上限 60 —— 首页完全没用它。

**建议**：
- 首页改调 `searchActiveProducts({ q, category, sort, page, pageSize: 24 })`，实现真正的 SQL 侧分页。
- 注意 `searchActiveProducts` 因为要按 `variant_group_id` 聚合，最终仍是 `groupProductsAsVariants(rows).slice()`（`:2424-2426`）。**变体聚合与 SQL 分页天然冲突**，两个可选路线：
  - 路线 A（推荐，改动小）：商品总量可控（< 200）时保持现状但**给 `getActiveProducts` 加 `LIMIT`**（如 200），超出后强制走搜索页；
  - 路线 B：为变体组建立 `variant_groups` 汇总行（或物化 `representative_id`），让分页以「组」为单位在 SQL 完成。
- 顺手把 `description` 从列表查询里去掉（列表只用 `descriptionPlain`，而 `page.tsx:88` 已经在服务端 `stripMarkdown`——不如直接只传 `descriptionPlain`，省一半传输）。

---

### 2.2 全站**没有任何速率限制**

`grep rateLimit|ratelimit|throttle` 在 `src/` 下只命中 `cleanupExpiredCardsIfNeeded` 的节流参数，**业务侧零限流**。

暴露面（均为无需登录或低成本登录即可调用）：

| 入口 | 危害 |
|---|---|
| `actions/checkout.ts:57 createOrder` | 每次调用写 `orders` + **最多 3 条 `coupon_usages`** + 逐张 `cards` UPDATE。并发刷单可把全部卡密锁进 5 分钟 `reserved` 状态（`RESERVATION_TTL_MS`），造成**库存耗尽型拒绝服务** |
| `actions/payment.ts:21 createPaymentOrder` | 金额完全由客户端决定（`normalizeAmount` 只校验 > 0，**无上限**），且未登录也可创建。可批量写入 `orders` |
| `actions/reviews.ts:10 submitReview` | 无频率限制 + 无 `reviews(order_id)` 唯一约束，check-then-insert（`:73-91`）存在竞态，可刷评价 |
| `actions/wishlist.ts` / `actions/user-messages.ts` | 同上，无限制写入 |

**建议**：
- 复用现有 D1，建一张 `rate_limits(key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER)`，用 `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` 做**单语句原子计数**（与 `reserveCouponUsages` 用触发器保证原子的思路一致）。
- 关键动作分别限流：`createOrder` 按 `userId|ip`（如 10 次/分钟）；`createPaymentOrder` 同；`submitReview` 按 `userId + productId`。
- `createPaymentOrder` 补一个金额上限（譬如 ≤ 10000）并考虑要求登录。

---

### 2.3 首页首屏被两个「一个组件就带进来的大依赖」拖累约 **231 KB**（未压缩）

实测（`.next` 构建产物）：

| chunk | 体积 | 来源 | 是否进首页 |
|---|---|---|---|
| `7313-1682ae680deddff2.js` | **115,060 B** | `framer-motion` | ✅ `.next/server/app/page_client-reference-manifest.js` 命中 |
| `8426-1316fa6e5560164c.js` | **116,013 B** | `react-markdown` + micromark | ✅ 同上 |

- `components/navigation-pill.tsx:3 import { motion } from 'framer-motion'` —— **全项目唯一 framer-motion 使用点**，而它只用来做一个「药丸指示器」的 `left/width` 弹簧动画（`:44-56`）。被 `home-content.tsx:16` 静态引入 → 113 KB 进首屏。**CSS `transition` + `transform` 完全可替代**。
- `components/announcement-popup.tsx:8 import ReactMarkdown` —— 被 `home-content.tsx:9` **静态**引入，而弹窗只在有公告时才渲染。改成 `next/dynamic(() => import(...), { ssr: false })`，或干脆用 `page.tsx:9-16` 已有的 `stripMarkdown` 输出纯文本，即可从首页 bundle 摘掉 113 KB。

合计可让首页首屏 JS 降约 1/3。

---

### 2.4 `navigation-pill.tsx` 的 `useEffect` 依赖内联数组，存在渲染抖动

```tsx
// components/navigation-pill.tsx:17-39
useEffect(() => { /* 读 offsetLeft/offsetWidth → setIndicatorStyle(新对象) */ }, [selectedKey, items])
```

调用侧 `home-content.tsx:221-230` 每次渲染都**新建** `items` 数组（`[{key:'',...}, ...categories.map(...)]`），因此：

1. 父组件每次渲染 → `items` 引用变化 → effect 重跑 → `setIndicatorStyle` 传入**新对象** → 触发一次额外渲染；
2. 任何让 `home-content` 重渲染的状态（搜索框输入、`useDeferredValue` 变化）都会连带抖动一次。

**建议**：`items` 用 `useMemo` 缓存（依赖 `categories`/`categoryConfig`/`t`），或改 `useLayoutEffect` + `ResizeObserver` 只在尺寸变化时 `setState`，并加 `prev => (prev.left === next.left && prev.width === next.width ? prev : next)` 的相等短路。

---

## 3. 🟡 重要问题

### 3.1 D1：后台总览对 `orders` 做**无 WHERE 的全表聚合**

`queries.ts:1986-1998`：

```ts
db.select({
  todayRevenue: sql`COALESCE(SUM(CASE WHEN ${orders.status} IN ('paid','delivered') AND ... END), 0)`,
  // ... 另外 9 个 SUM(CASE ...)
}).from(orders)          // ← 没有 where
```

一次 `getAdminOverview` 里 `financeRows` 读**整张 orders 表**；同批的 `trendRows`（`:2006-2014`）、`topProductRows`（`:2015-2023`）也都是 orders 上的聚合/排序，且都通过 `normalizeTimestampMs()` 包列，**索引一律失效**。后台首页每次刷新 = 全表 ×3。

**建议**：给 `financeRows` 补 `WHERE status IN ('paid','delivered','refunded')`（能吃到 `orders_status_paid_at_idx`）；总/月维度的历史聚合改用 `settings` 计账（写入时增量维护）或单独的 `daily_stats` 汇总表，后台只读汇总行。

### 3.2 D1：`normalizeTimestampMs()` 系统性让时间索引失效

```ts
// queries.ts:2670-2672
export function normalizeTimestampMs(column: any) {
  return sql<number>`CASE WHEN ${column} < ${TIMESTAMP_MS_THRESHOLD} THEN ${column} * 1000 ELSE ${column} END`
}
```

在 WHERE/ORDER BY/GROUP BY 里包一层 `CASE`，SQLite 无法下推索引，`orders_status_paid_at_idx`、`orders_status_created_at_idx`、`reviews_product_created_at_idx` 全部作废。使用点包括 `getRecentOrders:1902`、`canUserReview:2606`、`getAdminOverview:1988-2014`、`getUserPendingOrders:3564`、`admin/data/download:123`。

时间戳已在 `migrateTimestampColumnsToMs()`（`:2674+`）统一成毫秒，这个兼容层是历史遗留。

**建议**：确认线上 `orders.created_at/paid_at` 已无非毫秒值后，把 ORDER BY / WHERE 直接换成裸列；确需兼容时改为**一次性数据修复 + 加 `CHECK`**，不要让每个查询都付出索引失效的代价。`cancelExpiredOrders:3360` 已经用的是裸列 `lte(orders.createdAt, ...)`，可作为对照良好实践。

### 3.3 D1：`cancelExpiredOrders()` 每分钟跑一轮 N+1 循环

`queries.ts:3330-3462`，由 `worker-entry.mjs:43-45` 的 `* * * * *` cron 触发（`wrangler.json` 每分钟）：

```
for (const expired of candidates) {
  UPDATE orders SET status='cancelled' WHERE ... RETURNING     // 1 次
  ensurePointLedgerUserRecord(...)                             // 1 次
  applyUserAutomaticPointEvent(...)                             // 1+ 次
  UPDATE cards SET reserved_... WHERE reserved_order_id = ...  // 1 次
  releaseCouponUsages(...)                                      // 1 次
}
for (const pid of productIds) await recalcProductAggregates(pid) // 每个商品 4 次查询
```

单次超时取消最坏 ≈ 5 + 4 条往返。积压 50 单时就是 450 条串行 D1 往返 —— Worker 单请求子请求上限（默认 1000，且受 CPU 时间限制）会被顶到，且**整个 cron 是串行 await**。

**建议**：
1. 订单状态流转用一条 `UPDATE orders SET status='cancelled' WHERE status='pending' AND created_at <= ? AND <filters> RETURNING order_id, product_id, user_id, ...` 批量完成（`order-processing` 里已在用 `RETURNING`，证明 D1 支持）；
2. 归集 `productIds` 后改用**已存在的** `recalcProductAggregatesForMany()`（`:1145`，内部已按 50 分批 + CASE WHEN 批量 UPDATE），而不是逐个 `recalcProductAggregates`；
3. 每轮给 `candidates` 加 `LIMIT`（如 200），避免单次请求吃满；
4. 积分返还/优惠券释放这类非关键路径放到 `after()` 或下一轮处理。

### 3.4 安全：footer 的 `dangerouslySetInnerHTML` 接受管理员未净化输入

```tsx
// components/footer-content.tsx:66-69
<p className="... footer-html" dangerouslySetInnerHTML={{ __html: footerText }} />
```

`footerText` 来自 `settings.shop_footer`，写入路径 `actions/admin.ts:775-787 saveShopFooter` **只做 500 字长度校验，无任何净化**；渲染位置在**全站每个页面的页脚**。

同一文件 `:17-60` 有一个完整的 `linkify()` 实现（把 URL 转成 `<a>` 且只输出文本节点）—— **它定义了却从未被调用**，说明原本的设计意图就是「纯文本 + 安全链接」，被后来的 `dangerouslySetInnerHTML` 覆盖了。

**风险定位**：当前写入需要管理员身份，属于「管理员自伤」级别；但一旦满足以下任一条件即升级为普通用户的存储型 XSS：
- 管理员账号被钓/被盗；
- `actions/data.ts:70 importData` 允许管理员**上传任意 SQL 文件**导入（`:181` 直接拼 `INSERT OR IGNORE` 原文执行），可写入任意 `settings` 值；
- 未来任何低权限入口能改这个 setting。

**建议**：删掉 `dangerouslySetInnerHTML`，改用现成的 `linkify()`（先 `text.split('\n')` 保留换行）；若确实需要富文本，用白名单 sanitizer（只允许 `<a href http(s)>`、`<b>/<i>`、`<br>`），并在**写入侧**做同样净化（双端防御）。

### 3.5 D1 / 内存：管理端数据导出把**整库读进内存再拼字符串**

`app/admin/data/download/route.ts:274-301, 311-417`（`admin/export/download/route.ts` 只是 re-export）：

```ts
["orders", () => db.select().from(orders).all()],   // 无 LIMIT
["cards",  () => db.select().from(cards).all()],    // 无 LIMIT
// ... 17 张表全部 .all()
```

随后 `:393-405` 把全部行拼成一个巨型 SQL 字符串。Worker 内存上限 128 MB，`cards`/`orders` 到十万级即 OOM；且 D1 单查询也有 result 大小限制。

另外 `:421-423` 直接把 `e.message` 返回给前端：

```ts
const message = e?.message || "Export failed"
return NextResponse.json({ error: message }, { status: ... })
```

这与项目自己的约定相悖 —— `lib/errors/safe-error.ts:1-13` 的注释明确写了「任何把 error.message 直接放进返回值的地方都会把数据库结构、SQL 原文和绑定参数暴露给前台」，并提供 `sanitizeClientErrorMessage` / `logServerError`。虽为 admin-only，仍建议统一。

**建议**：改为**流式分页导出**（`WHERE id > ? LIMIT 1000` 循环 + `ReadableStream`），或把导出改走 `after()` 异步任务写 R2，前端轮询下载；错误统一 `logServerError` + 返回 `errorId`。另 `:121-124 orders` 分支同样无 LIMIT。

### 3.6 依赖：8 个生产依赖漏洞（`npm audit fix` 可解）

`npm audit --omit=dev`：**1 low / 4 moderate / 3 high**，全部为传递依赖：

| 包 | 严重度 | 来源 |
|---|---|---|
| `form-data` 4.0.0–4.0.5（CRLF 注入） | high | 传递 |
| `brace-expansion`（多处 ReDoS/OOM） | high | `@node-minify/core`、`glob`（构建期） |
| `fast-xml-builder` / `fast-xml-parser`（XML 注入） | high/moderate | `@aws-sdk/xml-builder`（构建期） |
| `qs`（DoS） | moderate | 传递 |
| `body-parser`（limit 静默失效） | moderate | 传递 |
| `baseline-browser-mapping`（DoS） | moderate | `browserslist` |

**判断**：这些基本都在 `@opennextjs/cloudflare` / `wrangler` 的**构建链路或 AWS SDK** 里，不进 Worker 的请求处理热路径，**当前不构成可直接利用的运行时漏洞**。但 `form-data` 的 CRLF 注入与 `qs` 的 DoS 值得清掉。

**建议**：跑 `npm audit fix`（非 `--force`），然后**必须重新执行 `next build --webpack` + 273 项单测 + 一次预览部署回归**；若 `fix` 需要升 `@opennextjs/cloudflare` 大版本，改为 `overrides` 定点抬传递版本。

### 3.7 出站请求：2 处仍未套 `fetchWithTimeout`

```
actions/refund.ts:218        await fetch('https://credit.linux.do/epay/api.php', {...})   // 无超时
actions/registry.ts:43,62,98,116  await fetch(`${baseUrl}/challenge|submit|remove`, ...)    // 无超时
```

`lib/runtime/fetch-with-timeout.ts` 已存在且被 5 个模块使用，这两处属遗漏。

**建议**：统一换成 `fetchWithTimeout(url, init, 10_000)`。`refund.ts` 在**管理员点击退款**时同步等待第三方，无超时会直接挂住整个请求。

### 3.8 热路径残留 DDL / 回填

`ensureDatabaseInitialized()` 已瘦身，但以下仍在业务请求里执行结构变更：

| 位置 | 每次调用执行 |
|---|---|
| `actions/reviews.ts:59-70, 125-134` | `CREATE TABLE IF NOT EXISTS reviews` / `review_replies` —— **每次提交评价/回复都跑一遍 DDL** |
| `queries.ts:2464` `getProductReviews` | `ensureReviewRepliesTable()` |
| `queries.ts:3471, 3311` `getUsers` / visitor 缓存 | `backfillLoginUsersFromOrdersAndReviews()` |
| `queries.ts:3543-3545` `toggleUserBlock` | `ALTER TABLE login_users ADD COLUMN is_blocked` |

`ensure*` 有 isolate 级 ready 标记，命中后是内存判断，成本可忽略；但 `reviews.ts` 里那两处是**裸 SQL，没有 ready 标记**，每次都真的发给 D1。

**建议**：`reviews.ts` 两处删除，改调 `ensureReviewRepliesTable()` / 让 `createReview` 路径统一走 `ensureStructuralSchema` 的既有标记机制；评价表补唯一约束见 §3.9。

### 3.9 缺索引与唯一约束（D1 读写成本）

| 缺失 | 影响 |
|---|---|
| `reviews(order_id)` | `hasUserReviewedOrder:2646`、`submitReview` 查重、`canUserReview:2599` 的 `LEFT JOIN reviews ON reviews.order_id = orders.order_id` 全部走扫表 |
| `reviews(order_id)` **UNIQUE** | 现在靠 `SELECT` 再 `INSERT` 判重（`reviews.ts:73-91`），并发下同一订单可产生多条评价 |
| `orders(email)` | `createOrder:270-281` 的购买限额校验按 `user_id OR email` 过滤，email 分支无法用索引 |

**正向**：其余索引覆盖相当完整——`ensureIndexes()`（`queries.ts:284-310`）、`ensureCouponTables`（`:957-969`，含 `coupon_usages(order_id, sequence)`、`coupon_usages(coupon_id, status, reserved_at)` 等 12 条）、积分账本（`point-ledger-schema.ts:92-112`）、审计（`audit-schema.ts:80-99`）都有针对性索引。建议把新增索引**按项目约定做成独立升级项**（不要塞回 `ensureIndexes`）。

### 3.10 写路径：`createOrder` 逐张卡密 UPDATE + 非原子编排

`actions/checkout.ts`：

1. **`:526-533` 逐条 UPDATE**：
   ```ts
   for (const cid of cardIds) {
     await db.update(cards).set({ isUsed: true, ... }).where(eq(cards.id, cid));
   }
   ```
   一次买 100 张 = 100 条串行 D1 写入。同一文件的**回滚路径 `:685` 反而用了 `inArray(cards.id, uniqueCardIds)`** —— 说明作者知道正确写法，正路径漏了。建议改为 `inArray` + 单条 UPDATE（或 `runAtomicD1Batch`）。

2. **`:340-461` 预留循环**：每次 for 迭代至少 1 次 `UPDATE ... RETURNING`，quantity = N 即 N 次往返。`lib/order-processing.ts:249-262` 的 `reserveCardsForFulfillment` 已经示范了「一条 `UPDATE ... WHERE id IN (SELECT ... LIMIT N) RETURNING` 批量预留」，此处可复用同一写法。

3. **整体非原子**：`reserveAndCreate()` → `createOrderRecord()` 期间依次写 `cards` / `coupon_usages` / `orders` / 积分账本，失败靠 `:668-706` 的补偿式回滚。D1 的 `batch()` 是**原子**的（项目已有 `runAtomicD1Batch`），建议把「插入订单 + 扣积分 + 消费券 + 标记卡密」这一组无中间读取依赖的语句收进一个 batch。

4. **购买限额有 TOCTOU**：`:273-286` 先 `SUM(quantity)` 再 `INSERT`，并发请求可越过 `purchaseLimit`。可用「插入订单时由触发器校验」或下单前对 `products` 行做条件更新占位来收敛。

### 3.11 效率：布局树每请求约 **20 次** `getSetting`

`app/layout.tsx:49-56`（`generateMetadata` 6 次）+ `:103-108`（3 次）+ `site-header.tsx`（7 次）+ `mobile-nav-wrapper.tsx`（2 次）+ `site-footer.tsx`（1 次）。`getSetting` 已是主键单行查询且带 React `cache()`（`queries.ts:2140`），但 `cache()` **只对完全相同的 key 去重**，实际是 13~15 个不同 key = 13~15 次独立往返。

**建议**：改用**已存在但未被布局使用**的 `getAllSettings()`（`queries.ts:2156`）一次读全表（`settings` 是小表，单次 `SELECT key, value` 成本远低于 15 次往返），在布局入口取一次往下传。注意本项目 OpenNext 的 incremental/tag 缓存是 dummy，别指望 `updateTag` 兜底跨请求缓存。

### 3.12 `reserveCardsForFulfillment` 用了 `ORDER BY RANDOM()`

`lib/order-processing.ts:461-468`（共享卡商品）与 `actions/checkout.ts:318-326`：

```ts
.orderBy(sql`RANDOM()`).limit(1)
```

SQLite 的 `ORDER BY RANDOM()` 需要**物化全部候选行再排序**，无法用索引。卡密表越大越慢。共享卡场景只是「取任意一张未使用的卡」。

**建议**：改为 `WHERE id > (随机起点) ORDER BY id LIMIT 1`，取不到再从头回绕；或直接 `ORDER BY id LIMIT 1`（若不需要随机性）。

### 3.13 效率：`revalidatePath` / `updateTag` 调用密度过高

全项目 `revalidatePath` **190 处**、`updateTag` **90 处**，其中 `actions/admin.ts` 单文件 135 处。典型如 `saveShopFooter`（`admin.ts:783-787`）改了页脚文案，却连带 `revalidatePath('/admin/settings')` + `revalidatePath('/')` + `updateTag('home:products')` + `updateTag('home:product-categories')`。

在 OpenNext 缓存为 dummy 的前提下，这些调用**不产生跨请求收益**，只增加无谓开销与认知负担。

**建议**：按资源粒度收敛（`home:*` 系列 tag 已存在，可只留命中的那个），并删掉与本次写入无关的 `revalidatePath`。

### 3.14 客户端重复拉取服务端已可取到的数据

| 位置 | 问题 |
|---|---|
| `header-client-parts.tsx:157-160` | 每次 `pathname` 变化都调 server action `getMyUnreadCount()` |
| `checkin-button.tsx:32-35` | 挂载后再取签到状态（首屏服务端可直出） |
| `buy-content.tsx:246-274` | 挂载后二次拉评价元数据 |
| `refresh-on-mount.tsx:10-14` | 挂载即 `router.refresh()`（整页 RSC 重取），用在 `admin/product/edit/[id]/page.tsx:21` |

**建议**：改为服务端首屏直出 + 交互后局部更新；未读数改为事件驱动或低频轮询。

---

## 4. UI/UX 与可访问性

### 4.1 🟡 无障碍：成片的图标按钮无 accessible name

| 位置 | 问题 |
|---|---|
| `components/admin/sidebar.tsx:201-207` | 移动端 `SheetContent` 内 `SidebarContent showTitle={false}`，**全项目无任何 `SheetTitle`** → Radix 报 “DialogContent requires a DialogTitle”，屏幕阅读器读不出抽屉标题 |
| `components/star-rating.tsx:37-55` | 5 个交互星按钮无 `aria-label`（应形如「第 N 星」） |
| `components/star-rating-static.tsx:22-35` | 静态评分无 `aria-label`，读屏完全读不到评分 |
| `admin/cards-content.tsx:430-461`、`wishlist-section.tsx:201-209` | `size="icon"` 仅含 `<Trash2/>`，无 `aria-label`/`title` |
| `admin/order-detail-content.tsx:358-367`、`product-questions-section.tsx:79-87` | 同上（前者只有 `title`，它不是可靠的 accessible name） |
| `site-header.tsx:121-127` | 头像 `DropdownMenuTrigger` 仅含 `<Avatar/>` |
| `ui/dialog.tsx:60` | 多数 `Dialog` 有 `DialogTitle` 但无 `DialogDescription`，且全项目无 `aria-describedby={undefined}` → Radix “Missing Description” 警告 |

**建议**：抽一个 `IconButton`，把 `aria-label` 设为**必填 prop**，一次性治理成片问题；`ui/dialog.tsx` 的 `DialogContent` 默认注入 `aria-describedby={undefined}` 消除警告；`SheetContent` 补 `SheetTitle`（可 `sr-only`）。

### 4.2 🟡 i18n：整块业务文案硬编码中文（英文用户直接看到中文）

字典本身是健康的——`src/lib/i18n/locales/en.json` 与 `zh.json` 各 **1164 键，完全一致无缺失**。问题在组件绕过 `t()`：

| 位置 | 内容 |
|---|---|
| `components/buy-content.tsx:941-986` | 整块「履约与保障看板」：人工专人履约 / 交付附件查验 / 7×24h 自动 / 资金安全 / 即买即用… |
| `components/order-content.tsx:243-253` | 履约状态与 4 步进度：提交订单 / 支付核验 / 人工交付 / 交付查验 |
| `components/home-content.tsx:251,264,277,290,315,397-402,467-497` | 全部/秒发/手工/仅现货/件/起/抵/库存/已售/**手工交付** |
| `admin/audit-content.tsx:61-78,160-275`、`admin/audit-detail-content.tsx` | 审计后台整页中文 |
| `buy-button.tsx:323,344,506`、`profile-content.tsx:450-935`、`mobile-nav.tsx:24,42` | 零散硬编码 |

**建议**：优先补 §4.2 前两行（**用户可见的核心购买路径**），其余按模块回填。

### 4.3 空态 / 错误态：缺 `not-found.tsx`

`src/app/` 下已有 `error.tsx` / `loading.tsx`，**但没有 `not-found.tsx`** —— 未知路由落在 Next 默认英文 404，不套主题、不走 i18n。也没有 `global-error.tsx`（根布局崩溃无兜底）。后台除 `admin/coupons/error.tsx` 外无独立 `error.tsx`。

正向：空态覆盖很全（`home-content.tsx:324`、`search-content.tsx:136`、`orders-content.tsx:172`、`wishlist-section.tsx:175`、各 admin 列表…）。

### 4.4 正向发现（值得保留的做法）

- **暗色模式干净**：未发现 `text-black` / `bg-white` / `#fff` / `bg-gray-*` 这类破坏主题的硬编码，颜色统一走语义 token，`globals.css:121+` 有完整 `.dark` 覆盖。
- **表格横向溢出已被兜住**：`min-w-[1024px..1330px]` 的表格都包在 `AdminListScroll`（`admin-page-shell.tsx:63`）内，不会造成页面级溢出。
- **`<img>` alt 齐全**；`orders-content.tsx:116` 的 `alt=""` 属装饰图，用法正确。
- **`loading` / `Suspense` 分层合理**：`layout.tsx:196` 用 `<Suspense fallback={<RootLayoutFallback/>}>`，兜底是纯 CSS 转圈（不参与水合、无闪烁风险），考虑得比一般项目细。
- **`error.tsx` 图标带 `aria-hidden`**，`motion-reduce:animate-none` 也考虑到了。
- **Markdown 渲染安全**：`react-markdown` 未接 `rehype-raw`，不会执行原始 HTML；`search-content.tsx:182` 还用 `allowedElements` 做了白名单收窄。

---

## 5. 💭 Nit

1. `components/footer-content.tsx:17-60` `linkify()` 是死代码（见 §3.4，建议反向复活它）。
2. `components/home-content.tsx:331-343` 「重置筛选」按钮复用 `t("common.all")`（"全部"），语义与动作不符。
3. `app/layout.tsx:158` 的 `pb-16` 未叠加 `env(safe-area-inset-bottom)`，全面屏机型底部留白偏紧（`mobile-nav.tsx:49` 已加）。
4. `actions/payment.ts:71,81` 与 `actions/checkout.ts:830,840` 用 `process.env.MERCHANT_ID!` / `MERCHANT_KEY!` 非空断言；未配置时 `generateSign` 会静默把 `undefined` 拼进签名串，应改为显式校验 + 明确错误。
5. `queries.ts:2144+` 等处的 `catch { /* best effort */ }` 面很广，D1 限流/网络错误会被吞掉且不产生审计事件，排障时缺少线索。
6. `reviews.ts:100` 等 catch 块统一 `console.error` + 返回通用错误，未走 `recordServerError`，评价失败无 errorId 可对账。
7. `next.config.ts:13-16` `images.unoptimized: true` 是安全权衡（避免把 Worker 变成任意图片代理），但首页 `home-content.tsx:379` 又对每个卡片用了 `next/image + fill + priority`，收益被抹平。可考虑对**受控对象存储域名**白名单放开优化。
8. `lib/db/index.ts` 的 `D1Proxy` 用 `async` 方法伪造同步 Drizzle 接口，`batch()` 时再「从代理重建真实语句」（`:47-61`）；配合 `getD1()` 的 build-time mock（`:71-90`），本地构建与线上行为存在**两套路径**，新增查询时容易踩坑。建议在文档里显式标注这份 shim 的约束。
9. `auth.ts:497-516` 的 `[auth-temp]` 诊断 logger 仍带注释 “Temporary diagnostics: keep this until OAuth callback issue is resolved” —— 确认问题已解后可回收。

---

## 6. 推荐修复顺序

**第一批（阻断，本迭代）**
1. §2.1 首页 SQL 侧分页（先给 `getActiveProducts` 加 `LIMIT` 止血，再切 `searchActiveProducts`）
2. §2.3 移出 framer-motion / react-markdown 出首页首屏（收益最直观、改动最小）
3. §2.2 给 `createOrder` / `createPaymentOrder` / `submitReview` 加原子计数限流
4. §2.4 + §3.13 `navigation-pill` 依赖抖动 + `revalidatePath` 收敛

**第二批（下一次发布前）**
5. §3.4 footer XSS 双端净化
6. §3.2 + §3.1 去掉 `normalizeTimestampMs` 包列、`getAdminOverview` 补 WHERE
7. §3.10 卡密批量 UPDATE + 关键写入收进 `runAtomicD1Batch`
8. §3.9 补 `reviews(order_id)` 索引与唯一约束（做成独立升级项）
9. §3.5 导出台账流式化 + 错误脱敏对齐 `safe-error.ts`
10. §3.3 `cancelExpiredOrders` 批量化 + `recalcProductAggregatesForMany`
11. §3.6 `npm audit fix` 并回归

**第三批（体验与技术债）**
12. §4.1 `IconButton` + `DialogDescription` 统一治理
13. §4.2 购买路径 i18n 回填、§4.3 补 `not-found.tsx`
14. §3.11 `getAllSettings()` 收口布局查询、§3.14 去掉客户端重复拉取
15. §5 各项清理

---

## 7. 一句话总结

这是一份**工程质量高于同类项目平均水平、但运行时成本设计尚未收敛**的代码库：类型/单测/lint 三件套齐备，09-16 的 P0 全部落地（订单鉴权、履约 claim、回调重试、管理员 ID 判定、出站超时），优惠券与积分账本用数据库触发器保证原子性、索引覆盖也很完整。

真正需要立刻处理的是**「D1 读写成本随数据量线性放大」这一族问题**——首页全量商品、后台总览全表聚合、索引失效的 `normalizeTimestampMs`、逐条 UPDATE 与 N+1 的取消/预留循环，它们单看都是小瑕疵，但叠加「每分钟 cron + 无任何限流」后会直接转化成账单与可用性风险。其次是**首页 231 KB 的无谓首屏依赖**，以及**购买路径上的中英混排与无障碍缺口**。
