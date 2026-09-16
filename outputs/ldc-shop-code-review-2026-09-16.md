# LDC Shop 正式版本代码审查报告

- 审查对象：`_workers_next/`（Cloudflare Workers + D1 正式版本）
- 审查日期：2026-09-16
- 维度：安全、数据一致性、性能/可靠性、UI/UX、可访问性、工程质量
- 审查方式：静态代码审查 + 依赖审计 + TypeScript 检查 + 现有单元测试

## 执行摘要

当前版本业务功能较完整，订单列表、个人中心、手动发货与邮件链路已有较好的产品化基础；但尚不适合把当前版本视作“安全加固完成”。本次确认了 **5 个 P0、6 个 P1、7 个 P2**。最优先的不是视觉微调，而是授权边界、依赖漏洞和支付/履约一致性。

### 必须立即处理的 P0

1. **订单详情和交付附件存在 Cookie 授权绕过**：普通客户端 Cookie `ldc_pending_order` 被当作查看卡密、交付说明和下载附件的授权凭证。
2. **生产依赖存在 3 个 Critical / 6 个 High 漏洞**：实际安装 Next.js 16.2.4、next-auth 5.0.0-beta.30、@auth/core 0.41.0，均在已公开安全公告影响范围内。
3. **支付回调履约失败仍返回 `success`**：网关停止重试，可能造成已收款但未发货。
4. **自动发卡履约缺少并发 claim**：回调与主动查单并发时可能重复消费库存或重复履约。
5. **积分账本存在并发窗口**：pending 账本在 `findByBusinessKey` 被视作完成结果，崩溃后会永久留下“账本已占位但余额未变”的半完成状态。

## 审查结论总表

| 维度 | 评分 | 结论 |
|---|---:|---|
| 安全与授权 | 1/4 | 存在高风险 IDOR/授权设计缺陷，依赖树含 Critical 漏洞 |
| 数据一致性 | 1/4 | 订单、卡密、积分多步写缺少统一的幂等 claim/原子边界 |
| 性能与可靠性 | 2/4 | D1 热路径迁移、全量商品/评价、无超时外部请求 |
| 可访问性 | 2/4 | 组件基础不错，但 42 个 placeholder-only 字段和图标按钮缺名 |
| 响应式与 UI/UX | 3/4 | 主要布局已响应式，危险操作确认和新后台布局较好；仍有键盘/文案缺陷 |
| 工程质量 | 1/4 | TypeScript 通过，但 lint 配置不可运行，业务关键链路测试接近空白 |

**综合：10/24（可用，但存在上线级风险）**

---

# P0：阻断级问题

## P0-1 订单详情、卡密与交付附件存在 Cookie 授权绕过

**证据**
- `src/app/order/[id]/page.tsx:23-31`：只要请求 Cookie `ldc_pending_order` 等于 URL 中订单号，就把 `canViewKey` 设为 true。
- `src/app/order/[id]/page.tsx:48`：同一 Cookie 可列出交付附件。
- `src/app/order/[id]/files/[fileId]/route.ts:35-43`：同一 Cookie 可绕过 owner/admin 检查并下载附件。
- `src/actions/order.ts:32-43`：同一 Cookie 可绕过订单所有权执行支付状态查询。
- `src/actions/checkout.ts:629-630`：Cookie 没有签名，也未设置 `httpOnly`；客户端可以自行修改。
- `src/lib/crypto.ts:17-20`：订单号使用 `Date.now() + Math.random()`，不是密码学安全随机值。

**影响**
攻击者若获得或猜到订单号，可伪造 Cookie，查看他人订单卡密、商家交付说明及下载附件。即使订单号猜测难度不是最低，这个授权模型本身仍不成立：普通 Cookie 不能作为访问控制凭据。

**修复建议**
1. 登录订单只允许 `order.userId === session.user.id` 或稳定管理员 ID；不要再用 username 作为 owner 兜底。
2. 删除订单详情、附件下载、查单动作中的 `pending cookie` 授权分支。
3. 如果确实支持游客订单，使用服务端签名、订单绑定、短时有效的 HttpOnly capability token，而不是裸订单号。
4. 新订单号改为 `crypto.randomUUID()` 或 128-bit 以上 CSPRNG；旧订单仍按兼容路径读取。

## P0-2 生产依赖存在 Critical 漏洞

**实际安装版本**
- `next@16.2.4`
- `next-auth@5.0.0-beta.30`
- `@auth/core@0.41.0`

**审计结果**
`npm audit --omit=dev`：**14 项漏洞（3 Critical、6 High、4 Moderate、1 Low）**。

关键项：
- Next.js 16.2.4 命中多个 App Router / Server Action / RSC / Image Optimization 安全公告；当前安全版本线已高于 16.3.2，npm 当前版本为 16.3.5。
- next-auth beta.30 / @auth/core 0.41.0 命中认证绕过、OAuth state/nonce/PKCE cookie 绑定和 malformed bearer DoS 公告；beta.32 / @auth/core 0.41.3 已有修复。

**修复建议**
- 在独立升级分支升级 Next.js 至安全版本（至少 16.3.3，建议验证 16.3.5）。
- 升级 next-auth 至 `5.0.0-beta.32` 或更高、确保 @auth/core ≥ 0.41.3。
- 重新跑 OpenNext Cloudflare 完整 build、OAuth 登录、Server Actions、图片和支付回归，不要只执行 `npm audit fix` 后直接上线。

## P0-3 支付回调履约失败仍向网关返回 success

**证据**
- `src/app/api/notify/route.ts:78-92`：`processOrderFulfillment()` 的普通异常只记录日志。
- `src/app/api/notify/route.ts:97`：随后始终返回 `success`。
- `src/app/api/notify/route.ts:47`：仅处理 `TRADE_SUCCESS`，对支付网关可能返回的 `TRADE_FINISHED` 直接确认 success 而不履约。

**影响**
数据库抖动、卡密更新失败等情况下，网关认为回调处理成功并停止重试，用户已付款但订单可能永久未交付。

**修复建议**
- 幂等的“已经处理”返回 success；可重试的内部错误返回 500/fail；金额或签名错误返回 400/fail。
- 根据支付网关官方协议确认并覆盖所有成功状态，至少明确处理 `TRADE_SUCCESS`/`TRADE_FINISHED`。
- 建立回调失败告警与后台补偿任务。

## P0-4 自动发卡缺少订单级并发 claim

**证据**
- `src/lib/order-processing.ts:21-24` 先读订单；`:133` 基于读到的 pending/cancelled 进入履约。
- `src/lib/order-processing.ts:307-347` 先 SELECT 卡，再逐张 UPDATE。
- `src/lib/order-processing.ts:355-364` 最后才更新订单为 delivered，而且 WHERE 只有 order_id，无旧状态条件。
- 支付回调和 `src/actions/order.ts:45-58` 主动查单均可触发同一函数。

**影响**
两个并发履约请求都可能看到 pending，并重复取卡、重复发货、重复发送通知。多步更新中间崩溃还会出现卡已消耗但订单未交付。

**修复建议**
- 首先执行原子 claim：`UPDATE orders ... WHERE order_id=? AND status IN ('pending','cancelled') RETURNING ...`；未 claim 到的请求直接返回 already_processed。
- 卡密使用原子 `UPDATE ... WHERE id=(SELECT ...) RETURNING`，不要 select 后再 update。
- 使用 D1 `batch()` 或可恢复状态机，保证卡、订单、积分流水的关键写入具有明确原子边界。

## P0-5 积分账本的 pending 状态可永久卡死

**证据**
- `src/lib/points/ledger-service.ts:84-87`：只要 `findByBusinessKey` 查到任何记录就直接返回，不区分 pending/completed。
- `src/lib/points/ledger-db.ts:334-351`：先插入 pending 账本，再修改余额。
- `src/lib/points/ledger-service.ts:97-105`：余额调整和 finalize 分离。

**影响**
若进程在插入 pending 之后、更新余额之前中断，后续重试会把 pending 当成成功结果返回，造成“订单看似扣过积分，但余额没扣”或“返还流水存在但积分未返还”。

**修复建议**
- `findByBusinessKey` 仅把 completed 视为最终幂等结果。
- pending 需要租约/恢复机制；超时 pending 可重试或补偿。
- claim + balance delta + finalize 尽可能放入 D1 batch/单条条件 SQL；至少为状态转换加条件和影响行数校验。

---

# P1：重大问题

## P1-1 管理员身份仅按 OAuth username 判定

- `src/lib/admin-auth.ts:8-11` 和 `src/actions/admin.ts:27-32` 只比较 `ADMIN_USERS` 与 `session.user.username`。
- username 是显示/可变标识，不应作为长期管理员主键。

**建议**：改用 provider + 不可变 provider account ID / `sub`，或独立角色表；后台 layout、Server Actions、下载路由统一调用同一个稳定的 `checkAdminIdentity()`。

## P1-2 所有出站请求均无显式超时

- `src/lib/epay.ts:29-31` 支付查单。
- `src/lib/email.ts:222,362,399` Resend 邮件。
- 卡密 API、通知等 fetch 同样未使用 AbortSignal。

**影响**：第三方慢请求可占满 Worker 生命周期，支付轮询叠加时会放大并发和回调超时。

**建议**：统一 `fetchWithTimeout`（如 5–10 秒）、有限重试、结构化错误；支付回调内非关键外部请求移出主事务。

## P1-3 运行时热路径承担数据库迁移与回填

- `src/lib/db/queries.ts:206-244` 的 `ensureDatabaseInitialized()` 会在 schema 版本不匹配时执行 ALTER/CREATE INDEX/用户迁移/聚合回填。
- 首页 `getActiveProducts`、订单页、下载路由、后台 action 等大量调用。

**影响**：冷启动首请求延迟、多个实例重复迁移、线上请求承担不可预测的 DDL 成本。

**建议**：迁移移到部署阶段；运行时只做 schema version 快速读取，版本不匹配时 fail closed 并报警。

## P1-4 支持任意远程图片域名且允许 SVG

- `next.config.ts:7-14` 允许任意 `http/https` hostname，并开启 `dangerouslyAllowSVG`。

**影响**：扩大服务端图片代理 SSRF/资源消耗面。当前 Next.js 版本又命中 Image Optimization 漏洞，使组合风险更高。

**建议**：列出实际业务域名白名单；非必要关闭 SVG；升级 Next.js 后再验证。

## P1-5 测试覆盖严重不足，lint 质量门禁已失效

- `src` 仅找到 `src/lib/runtime/async-once.test.ts`，4 个测试全部通过，但与订单、支付、积分、授权无关。
- `eslint.config.mjs` 使用 FlatCompat 包装 Next 16 已提供的 flat config，运行 ESLint 9 时抛出 circular JSON，无法执行 lint。

**建议**：
1. 改为直接导入 `eslint-config-next/core-web-vitals` 与 `eslint-config-next/typescript` 的 flat config。
2. 至少补支付回调幂等、并发履约、积分 pending 恢复、订单权限、手动/自动发货邮件五组集成测试。

## P1-6 表单可访问名称系统性不足

脚本扫描了 85 个 `Input`/`Textarea`：仅 37 个有 `id` 或 aria 关联，**42 个为 placeholder-only**。典型位置：
- `components/home-content.tsx:185-192`
- `components/orders-content.tsx:83-91`
- `components/admin/orders-content.tsx:323-333`
- `components/profile-content.tsx:664-676`
- `components/search-content.tsx:81-90`

**影响**：placeholder 消失后无字段名；屏幕阅读器无法可靠识别输入目的（WCAG 1.3.1/4.1.2）。

**建议**：搜索框可用本地化 `aria-label`；业务表单采用可见 `Label htmlFor` + `id`；错误文案通过 `aria-describedby` 关联。

---

# P2：中等问题与体验改进

## P2-1 首页全量加载所有商品并下发客户端

- `src/lib/db/queries.ts:986-1022` 查询全部在售商品且包含描述、图片等大字段，无 LIMIT。
- `src/app/page.tsx:53-76` 全量取回后再计算数量。
- `src/components/home-content.tsx` 是 client component，在浏览器中搜索/排序/分页。

**建议**：搜索、排序、分类与分页下推 D1；列表只取必要字段和当前页。

## P2-2 商品评价无分页

- `src/lib/db/queries.ts:1965-1978` 取出某商品全部评价与回复。

**建议**：游标分页；详情首屏只加载最近 N 条，更多内容按需加载。

## P2-3 交付文件全量缓冲，且无 R2 时存 D1 Blob

- `src/lib/delivery-files.ts:121-160` 上传先 `arrayBuffer()` 全量入内存；无 R2 时存 D1 BLOB。
- `src/lib/delivery-files.ts:174-185` R2 下载再次 `arrayBuffer()` 全量入内存。

**建议**：生产强制 R2；下载使用 R2 body 流式响应；补孤儿 R2 对象清理（R2 put 成功而 D1 insert 失败的补偿）。

## P2-4 favicon 代理存在管理员可控 SSRF 原语

- `src/app/favicon/route.ts:68-102` 对设置中的 logo URL 执行服务端 fetch，未限制协议后的目标 IP/域名，也不限制响应大小/内容类型。

**建议**：HTTPS 域名白名单、DNS/IP 私网检查、大小/Content-Type 限制、超时。

## P2-5 `/paying` 无会话/订单绑定

- `src/app/paying/route.ts:19-28` 接收任意 formData 并转发到支付网关。

虽然签名和回调金额校验降低了直接盗货风险，但它仍是公开的网关请求反射器。

**建议**：只接受服务端生成的一次性 token，或校验 out_trade_no/money/sign 与订单一致。

## P2-6 UI/UX：键盘、ARIA 和本地化仍有明显缺口

- `components/profile-content.tsx:509-545` 自定义 tab 缺 `tablist/tab/tabpanel` 与 `aria-selected`。
- `components/profile-content.tsx:823-835,856-864` 可点击 div 不可键盘操作。
- `components/admin/order-actions.tsx:83-90` 等多个图标按钮只有 `title`，无 `aria-label`。
- `components/copy-button.tsx:47-58,63-76` icon-only 复制按钮无可访问名称，触摸目标 32px 或更小。
- `components/ui/table.tsx:68-76` 表头未默认 `scope="col"`。
- `src/lib/i18n/context.tsx:44-60` 切换 locale 不同步 `document.documentElement.lang`。
- 静态键检查确认缺失：`common.confirmDelete`、`common.deleteConfirmDesc`、`common.deleteSuccess`、`points.myPoints`、`admin.orders.batchDelete`、`admin.orders.cancelOrder`。

**建议**：建立基础组件层修复，而不是逐页面打补丁：Input/SearchField、IconButton、Tabs、TableHead 统一可访问规范；补齐 locale 并在开发环境警告缺失键。

## P2-7 Footer 可执行管理员输入的 HTML

- `components/footer-content.tsx:66-69` 使用 `dangerouslySetInnerHTML`。
- `actions/admin.ts:754-762` 仅 trim + 长度限制，没有 sanitize。

虽然写入者要求管理员权限，仍会放大管理员账号泄露或错误粘贴 HTML 的影响。

**建议**：默认纯文本；如确需链接，使用严格标签/属性白名单 sanitizer。

---

# 积极发现

1. **支付金额有双重校验**：回调和履约均复核订单金额，能防止低金额伪支付。
2. **主要 Server Actions 权限边界总体清晰**：管理操作普遍调用 `checkAdmin()`，订单退款/取消等多数有 owner 校验。
3. **手动发货附件有扩展名、MIME、数量与大小限制**；附件键使用 `crypto.randomUUID()`，无明显路径穿越。
4. **邮件模板正确转义商品名、订单号、交付说明**，避免把这些字段直接注入 HTML。
5. **后台长列表已有分页与统一滚动容器**；订单管理列表近期改造的信息密度和列宽更合理。
6. **危险操作已基本统一为可控 Dialog**，不是原生 `window.confirm/prompt`；移动后台也已有 Sheet 抽屉导航。
7. **TypeScript 静态检查通过**；现有 4 个运行时工具单元测试全部通过。

---

# 推荐修复路线

## 第一批：当天完成（阻断级）
1. 删除 Cookie 授权，重构订单 owner/capability token。
2. 升级 Next.js / Auth.js 依赖并完成回归。
3. 支付回调错误返回策略与成功状态覆盖。
4. 引入订单履约原子 claim，防并发重复发卡。
5. 修复积分 pending 状态机与幂等恢复。

## 第二批：下一次发布前
1. 修复 lint flat config，建立 CI：typecheck + lint + unit/integration。
2. 关键外部 fetch 统一超时、重试和可观测性。
3. 将 schema migration 从请求热路径迁出。
4. 收窄图片域名和 SVG 策略。
5. 补订单/支付/积分/权限集成测试。

## 第三批：性能与体验
1. 首页和评价服务端分页。
2. R2 流式下载，移除生产 D1 Blob 回退。
3. 基础表单、IconButton、Tabs、TableHead 统一 A11y。
4. 修复缺失 i18n 键与 `<html lang>` 同步。
5. Footer HTML 白名单化。

---

# 验证记录

- `node node_modules/typescript/lib/tsc.js --noEmit`：通过（0 错误）。
- `node --test src/lib/runtime/async-once.test.ts`：4/4 通过；同时出现 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。
- ESLint：未能运行；配置在 ESLint 9 下报 `Converting circular structure to JSON`，属于项目质量门禁问题。
- `npm audit --omit=dev`：14 项（3 Critical / 6 High / 4 Moderate / 1 Low）。
- Git 工作树：审查开始与结束均无源码改动。

> 本报告是审查结果，不包含修复提交。建议先处理 P0，再进行一次专项回归与二次审查。
