# ldc-shop 优惠券功能详细开发计划

> 适用工程：`_workers_next`（Cloudflare Workers 正式版本）  
> 技术栈：Next.js 16.3.5 App Router、React 19、Server Actions、Cloudflare Workers、D1、Drizzle ORM、Auth.js v5  
> 基线：`schema_version = 24`  
> 计划状态：待实施，本文件不包含代码改动  
> 目标：后台完整管理优惠券；结算支持优惠券、积分和支付；所有次数变更可追踪、幂等且不超发

---

## 1. 范围与默认产品决策

### 1.1 最终功能范围

1. 优惠类型：
   - 百分比折扣：如 90%，即九折；支持“最高优惠金额”。
   - 固定立减：如立减 10 LDC。
   - 满额立减：如满 100 LDC 减 20 LDC。
2. 使用范围：
   - 所有在售商品。
   - 指定一个或多个商品。
3. 次数限制：
   - 整张券总使用次数：1 次、N 次或不限。
   - 单用户使用次数：1 次、N 次或不限。
4. 叠加能力：
   - 是否允许与其他优惠券叠加。
   - 是否允许与积分抵扣叠加。
   - 最终支持每单最多 3 张优惠券。
5. 生命周期：草稿、待生效、使用中、已用完、已过期、已停用。
6. 后台：创建、编辑、复制、启停、列表筛选、使用记录、使用人和关联订单。
7. 用户端：输入优惠码、预览校验、金额拆分、移除和叠加提示。
8. 订单后续：下单预占、支付核销、取消/超时释放、退款返还。

### 1.2 分阶段边界

为控制下单主链路风险，开发顺序采用“两步交付”而不是一次性上线全部复杂度：

- **MVP 闭环：每单 1 张优惠券**，但数据库从第一天就使用 `coupon_usages` 多行关联模型，不把架构锁死为单券。
- **增强阶段：开放最多 3 张券叠加**，复用相同表结构和状态机，只增加组合校验、确定性排序与前端多券交互。

MVP 验收通过前，不开放多券叠加。最终功能仍覆盖完整需求。

### 1.3 已确定规则

1. 金额顺序固定为：

   `商品小计 → 优惠券优惠 → 券后金额 → 积分抵扣 → 最终应付`

2. 指定商品券的门槛，只按该券适用商品的金额判断。
3. 最终应付金额最低为 `0.00 LDC`，优惠总额不得超过商品小计。
4. 需要单用户限次的券只允许登录用户使用；不使用邮箱、IP 或 Cookie 作为用户身份。
5. 订单创建时服务端必须重新校验，客户端预览不作为价格依据。
6. 已产生预占或核销记录后，优惠码、优惠类型、优惠值、门槛和适用范围不可直接修改；后台提供“复制为新券”。
7. 全额退款且订单未履约时默认返还优惠券次数；部分退款不返券；后台可对单张券配置退款策略。

### 1.4 待实现时固化的细节

- 金额全部通过“分”或 Decimal 字符串运算，不允许直接用浮点数作为核心优惠计算依据。
- 百分比使用基点 `rate_bps`：`9000 = 90% 支付价`，避免“折扣率”和“优惠百分比”语义混淆。
- 优惠码标准化：`trim + uppercase`；允许字符 `[A-Z0-9_-]`；长度 4–32；大小写不敏感唯一。

---

## 2. 架构决策

| 决策项 | 结论 |
|---|---|
| 工程边界 | 只修改 `_workers_next`；根目录旧版和 `_docker` 不纳入本次实施。 |
| 项目组织 | Feature-first，新建 `src/lib/coupons/`，规则、存储和状态机不塞入页面或 Server Action。 |
| 集成方式 | 继续使用 Next.js Server Actions；不新增 REST/GraphQL 服务。 |
| 认证 | 沿用 Auth.js session；后台操作统一 `checkAdmin()`；每用户限次使用不可篡改 `userId`。 |
| 实时性 | 不需要 WebSocket/SSE；后台列表按导航刷新，结算预览按用户操作请求。 |
| 输入验证 | 优惠券表单和优惠码输入统一使用显式校验器；错误返回稳定错误码，不向用户展示数据库异常。 |
| 错误处理 | 新建类型化 `CouponError`，含 `code`、安全用户提示键和可选上下文。 |
| 金额模型 | 新优惠字段使用整数分；旧 `orders.amount` TEXT 保留为最终实付金额，保证支付兼容。 |
| 并发模型 | 单条条件 SQL 抢占 + `RETURNING` + 唯一索引 + 状态迁移幂等；D1 `batch` 只用于减少中间失败窗口，不把普通多语句当作可回滚事务。 |
| 功能开关 | 新增 `coupons_enabled` 设置，部署时默认关闭；迁移和验证通过后再开启前台入口。 |

---

## 3. 数据模型与 schema v25

### 3.1 `coupons` 主表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `cpn_<uuid>`，不可变 |
| `code` | TEXT NOT NULL | 保存标准化后的优惠码 |
| `name` | TEXT NOT NULL | 后台内部名称 |
| `description` | TEXT | 后台备注或用户说明 |
| `discount_type` | TEXT NOT NULL | `percent` / `fixed` / `threshold_fixed` |
| `rate_bps` | INTEGER | 百分比券支付比例，1–10000 |
| `discount_amount_cents` | INTEGER | 固定优惠金额，必须 > 0 |
| `min_spend_cents` | INTEGER DEFAULT 0 | 满减门槛或最低消费 |
| `max_discount_cents` | INTEGER | 百分比券最高优惠，可空 |
| `scope` | TEXT NOT NULL | `all` / `selected` |
| `total_use_limit` | INTEGER | NULL = 不限；1 = 一次性券 |
| `per_user_limit` | INTEGER | NULL = 不限 |
| `reserved_count` | INTEGER DEFAULT 0 | 当前有效预占数量 |
| `consumed_count` | INTEGER DEFAULT 0 | 已核销数量 |
| `stackable_with_coupons` | INTEGER DEFAULT 0 | 是否允许券间叠加 |
| `stackable_with_points` | INTEGER DEFAULT 1 | 是否允许与积分叠加 |
| `refund_policy` | TEXT DEFAULT `unfulfilled_full_refund` | `never` / `unfulfilled_full_refund` / `always` |
| `status` | TEXT NOT NULL | `draft` / `active` / `disabled` |
| `starts_at` | INTEGER | 毫秒时间戳，可空 |
| `ends_at` | INTEGER | 毫秒时间戳，可空 |
| `created_by` | TEXT | 管理员 userId |
| `created_at` | INTEGER | 毫秒时间戳 |
| `updated_at` | INTEGER | 毫秒时间戳 |

约束和索引：

- `UNIQUE INDEX coupons_code_uq ON coupons(upper(code))`
- `INDEX coupons_status_window_idx ON coupons(status, starts_at, ends_at)`
- `CHECK(total_use_limit IS NULL OR total_use_limit > 0)`
- `CHECK(per_user_limit IS NULL OR per_user_limit > 0)`
- `CHECK(reserved_count >= 0 AND consumed_count >= 0)`

“待生效、已用完、已过期”是根据 `status + 时间 + 计数` 派生的展示状态，不额外写入，避免状态漂移。

### 3.2 `coupon_products` 适用商品表

| 字段 | 类型 | 说明 |
|---|---|---|
| `coupon_id` | TEXT NOT NULL | 关联 `coupons.id` |
| `product_id` | TEXT NOT NULL | 关联商品 ID |
| `created_at` | INTEGER | 毫秒时间戳 |

约束和索引：

- 复合主键或唯一索引：`(coupon_id, product_id)`
- `INDEX coupon_products_product_idx ON coupon_products(product_id, coupon_id)`
- 优惠券删除时级联删除关联；商品被删除时应清理关联，或后台把券标记为配置不完整。

### 3.3 `coupon_usages` 使用与预占记录

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `cpu_<uuid>` |
| `coupon_id` | TEXT NOT NULL | 优惠券 ID |
| `order_id` | TEXT NOT NULL | 订单 ID |
| `user_id` | TEXT | 登录用户 ID；公共券可空 |
| `username` | TEXT | 下单快照 |
| `status` | TEXT NOT NULL | `reserved` / `consumed` / `released` / `reversed` |
| `sequence` | INTEGER DEFAULT 0 | 多券计算次序 |
| `reservation_id` | TEXT NOT NULL | 本次预占令牌 |
| `reservation_expires_at` | INTEGER | 预占失效时间 |
| `coupon_code_snapshot` | TEXT NOT NULL | 优惠码快照 |
| `rule_snapshot` | TEXT NOT NULL | 类型、值、门槛、范围、叠加规则 JSON 快照 |
| `eligible_amount_cents` | INTEGER NOT NULL | 本券适用金额 |
| `discount_amount_cents` | INTEGER NOT NULL | 实际优惠金额 |
| `reserved_at` | INTEGER | 预占时间 |
| `consumed_at` | INTEGER | 核销时间 |
| `released_at` | INTEGER | 释放时间 |
| `reversed_at` | INTEGER | 退款返还时间 |
| `reason` | TEXT | 释放或返还原因 |

约束和索引：

- MVP：`UNIQUE INDEX coupon_usages_order_coupon_uq ON coupon_usages(order_id, coupon_id)`
- `INDEX coupon_usages_coupon_status_idx ON coupon_usages(coupon_id, status, reserved_at)`
- `INDEX coupon_usages_user_idx ON coupon_usages(coupon_id, user_id, status)`
- `INDEX coupon_usages_order_idx ON coupon_usages(order_id, sequence)`
- `UNIQUE INDEX coupon_usages_reservation_uq ON coupon_usages(reservation_id)`

不能用 `UNIQUE(coupon_id, user_id)` 实现每人一次，因为它会阻止失败订单释放后重试。单用户限次由原子计数/占用语句校验当前有效状态数量。

### 3.4 `coupon_user_counters` 用户并发计数表

| 字段 | 类型 | 说明 |
|---|---|---|
| `coupon_id` | TEXT NOT NULL | 优惠券 ID |
| `user_id` | TEXT NOT NULL | 不可篡改登录用户 ID |
| `reserved_count` | INTEGER DEFAULT 0 | 当前有效预占数 |
| `consumed_count` | INTEGER DEFAULT 0 | 当前已核销数 |
| `updated_at` | INTEGER | 毫秒时间戳 |

约束和索引：

- 复合主键：`(coupon_id, user_id)`
- `CHECK(reserved_count >= 0 AND consumed_count >= 0)`
- 只在优惠券设置了 `per_user_limit` 时参与占用；匿名用户直接拒绝此类券。
- 这是并发控制用的聚合计数，审计仍以 `coupon_usages` 明细为准。

### 3.5 `orders` 新增快照字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `subtotal_amount_cents` | INTEGER | 商品小计 |
| `coupon_discount_amount_cents` | INTEGER DEFAULT 0 | 券优惠合计 |
| `points_discount_amount_cents` | INTEGER DEFAULT 0 | 积分对应优惠金额 |
| `pricing_snapshot` | TEXT | 完整定价快照 JSON |

继续保留：

- `amount`：支付网关最终应付金额 TEXT。
- `points_used`：实际扣除积分数。

订单详情不依赖优惠券主表实时规则，必须只展示快照。

### 3.6 迁移接入文件

修改：

- `src/lib/db/schema.ts`
- `src/lib/db/queries.ts`

具体动作：

1. `CURRENT_SCHEMA_VERSION` 从 24 升到 25。
2. 新增 `ensureCouponTables()`，幂等创建四张表及索引。
3. `ensureOrdersColumns()` 新增四个订单快照列。
4. 增量迁移分支和首次安装 bootstrap 分支都必须创建新表/列。
5. 只有全部 DDL 成功后才能写 `schema_version=25`。
6. 迁移失败继续沿用当前“现有库不能跌入首次初始化”的保护；优惠券功能开关关闭时原业务可继续读写。
7. 不删除、不重命名、不强制回填旧订单字段。

---

## 4. 优惠券领域模块

新增目录：`src/lib/coupons/`

### 4.1 建议文件

| 文件 | 职责 |
|---|---|
| `types.ts` | 枚举、DTO、定价输入输出、使用状态类型 |
| `errors.ts` | `CouponError` 及稳定错误码 |
| `code.ts` | 优惠码标准化、格式校验、随机码生成 |
| `money.ts` | LDC 与分转换、整数舍入、格式化 |
| `rules.ts` | 纯函数规则校验和单券折扣计算 |
| `pricing.ts` | 单券和多券组合计算、积分叠加判定、定价快照 |
| `repository.ts` | D1/Drizzle 查询、列表、详情、保存 |
| `reservation.ts` | 预占、核销、释放、退款返还状态机 |
| `admin-validation.ts` | 后台创建/编辑输入校验 |
| `rules.test.ts` | 折扣与边界单元测试 |
| `pricing.test.ts` | 多券排序和金额不变量测试 |
| `reservation.test.ts` | 状态迁移与幂等测试 |

### 4.2 类型化错误码

至少包含：

- `COUPON_NOT_FOUND`
- `COUPON_NOT_ACTIVE`
- `COUPON_NOT_STARTED`
- `COUPON_EXPIRED`
- `COUPON_EXHAUSTED`
- `COUPON_LOGIN_REQUIRED`
- `COUPON_USER_LIMIT_REACHED`
- `COUPON_PRODUCT_NOT_ELIGIBLE`
- `COUPON_MIN_SPEND_NOT_MET`
- `COUPON_NOT_STACKABLE`
- `COUPON_POINTS_CONFLICT`
- `COUPON_RESERVATION_CONFLICT`
- `COUPON_SCHEMA_UNAVAILABLE`

Server Action 只返回这些稳定错误码对应的 i18n key；原始 SQL 错误仅写服务端日志。

### 4.3 纯规则引擎

`evaluateCouponRule(input)` 必须是无数据库依赖的纯函数，输入包括：

- 当前时间
- 商品 ID、数量和小计分
- 用户 ID
- 优惠券规则快照
- 当前总预占/已核销数量
- 当前用户有效预占/已核销数量

输出包括：

- 是否可用
- `eligibleAmountCents`
- `discountAmountCents`
- 是否可与积分叠加
- 失败错误码
- 规则快照

百分比券计算：

- `payable = roundHalfUp(eligible * rate_bps / 10000)`
- `discount = eligible - payable`
- 再应用 `max_discount_cents`

固定券与满减券：

- `discount = min(configuredDiscount, eligible)`
- 满减先校验 `eligible >= minSpend`

### 4.4 多券确定性规则

增强阶段开放多券时：

1. 所有券都必须 `stackable_with_coupons = true`；只要一张不允许，整组拒绝，而不是静默忽略。
2. 去重标准化后的优惠码。
3. 最多 3 张。
4. 排序固定为：
   - 满减/固定额券先应用；
   - 百分比券后应用；
   - 同类型按后台选择顺序；
   - 最终写入 `coupon_usages.sequence`。
5. 每张券在前一张折扣后的剩余金额上计算，规则和结果写入快照，因此重算结果稳定。
6. 任何一张券在创建订单时失效，则整单失败并提示重新确认价格。

---

## 5. D1 并发、预占与幂等设计

### 5.1 核心原则

- D1 `batch()` 能减少网络往返并提供批量提交能力，但设计不能依赖任意业务代码之间的传统长事务。
- 次数控制必须在单条条件 SQL 中完成，不能先 `SELECT count` 再无条件 `UPDATE`。
- 所有状态变化都必须带前置状态条件并使用 `RETURNING` 判断是否真正成功。

### 5.2 预占顺序

在 `createOrder()` 中生成 `orderId` 后执行：

1. 服务端重新加载商品、优惠券和用户使用状态。
2. 纯规则引擎计算定价。
3. 对每张券按确定顺序执行原子占用：
   - 条件必须同时满足状态、有效期、总次数和用户次数。
   - 原子增加 `reserved_count`。
   - 写入 `coupon_usages(status='reserved')`。
4. 创建订单并写金额快照。
5. 预占库存、扣积分。
6. 任一步失败，按预占令牌幂等调用 `releaseCouponReservations(orderId, 'order_create_failed')`。

由于现有下单函数还包含库存和积分的补偿式回滚，实施时应把优惠券释放并入同一个 `catch`，不能依赖定时任务作为唯一补偿。

### 5.3 原子 SQL 要求

总次数条件应等价于：

```sql
UPDATE coupons
SET reserved_count = reserved_count + 1,
    updated_at = ?
WHERE id = ?
  AND status = 'active'
  AND (starts_at IS NULL OR starts_at <= ?)
  AND (ends_at IS NULL OR ends_at >= ?)
  AND (
    total_use_limit IS NULL
    OR reserved_count + consumed_count < total_use_limit
  )
RETURNING id;
```

单用户次数不能仅靠内存 count。建议新增一张紧凑计数表 `coupon_user_counters`，或使用“按用户的单条条件插入/更新”完成原子限次。推荐在实施时增加：

`coupon_user_counters(coupon_id, user_id, reserved_count, consumed_count, PRIMARY KEY(coupon_id,user_id))`

预占时先确保计数行存在，再通过条件 `UPDATE ... WHERE reserved_count + consumed_count < per_user_limit RETURNING` 抢占。这样比并发 `COUNT(coupon_usages)` 更可靠。该表是并发计数，不替代审计明细 `coupon_usages`。

### 5.4 状态迁移

| 事件 | usage 状态 | 主表计数变化 | 用户计数变化 |
|---|---|---|---|
| 创建订单 | `reserved` | reserved +1 | reserved +1 |
| 支付成功 | `reserved → consumed` | reserved -1，consumed +1 | 同步迁移 |
| 创建失败/取消/超时 | `reserved → released` | reserved -1 | reserved -1 |
| 符合返券退款 | `consumed → reversed` | consumed -1 | consumed -1 |
| 不返券退款 | 保持 `consumed` | 不变 | 不变 |

幂等要求：

- 核销只更新 `status='reserved'` 的记录。
- 释放只更新 `status='reserved'` 的记录。
- 返还只更新 `status='consumed'` 的记录。
- 重复回调、重复取消、重复退款均返回成功但计数不得再次变化。

### 5.5 支付核销时机

必须先成功核销优惠券，再把订单最终推进到 `paid/delivered`，或把两者通过同一状态 Claim 串联：

1. `processOrderFulfillment()` 已取得订单 `fulfillmentClaimId`。
2. 调用 `consumeCouponReservations(orderId, claimId)`。
3. 完成手动发货订单 `paid` 或自动发货订单 `delivered`。
4. 如履约失败并恢复订单 Claim，需要保证优惠券核销可重试，不可重复扣次数。

实现时在订单 `processing` Claim 范围内串行执行，复用现有重复支付回调防护。

---

## 6. 后端与下单链路改动

### 6.1 Server Actions

新增 `src/actions/coupons.ts`：

用户侧：

- `previewCoupon(input)`：校验单券并返回报价，不占用次数。
- `previewCouponStack(input)`：增强阶段启用，不占用次数。

后台侧：

- `createCoupon(formData)`
- `updateCoupon(id, formData)`
- `setCouponStatus(id, status)`
- `duplicateCoupon(id)`
- `getCouponUsagePage(input)`

所有后台 mutation 第一行调用 `checkAdmin()`；创建/编辑边界做完整输入校验；禁止客户端传入计数字段。

### 6.2 `src/actions/checkout.ts`

改动清单：

1. `createOrder()` 增加 `couponCodes?: string[]` 参数；MVP UI 传 0 或 1 个。
2. `orderAmount` 立即转换为 `subtotalAmountCents`。
3. 在 `resolveCheckoutPointUsage()` 前调用优惠券定价。
4. 把积分计算输入从原商品小计改为券后金额。
5. 如果任一券不允许与积分叠加，则 `usePoints=true` 时返回明确冲突错误；不静默取消用户选择。
6. `finalAmount` 从整数分转换为支付网关要求的两位字符串。
7. `createOrderRecord()` 写入订单金额快照，并写 `coupon_usages` 预占。
8. 三个订单插入分支必须全部覆盖：
   - 零金额 + 手动发货；
   - 零金额 + 自动发货；
   - 普通待支付订单。
9. 零金额订单不经过支付回调，因此订单创建成功后必须立即把优惠券从 `reserved` 核销为 `consumed`。
10. `catch` 补偿顺序：删除订单/释放库存/返还积分/释放优惠券；每一步独立幂等并记录失败。
11. `payParams.money` 必须严格来自订单持久化后的 `amount`，避免内存报价与订单不一致。
12. `getRetryPaymentParams()` 不重新计算优惠券，继续使用订单快照金额。

### 6.3 `src/lib/order-processing.ts`

改动清单：

1. `processOrderFulfillment()` 在获取订单 Claim 后读取该订单的 `reserved` 优惠券记录。
2. 在最终 `paid/delivered` 前调用幂等核销。
3. `already_processed` 分支不得再次核销。
4. 履约异常时不得释放已确认付款订单的优惠券；应保留可重试状态。
5. 手动发货、共享商品、自动发卡、支付型商品四条分支全部覆盖。
6. 管理员 `markOrderPaid()` 不能绕过优惠券核销，应调用统一服务，而不是只改订单状态。

### 6.4 取消、超时与退款

修改：

- `src/actions/admin-orders.ts`
- `src/lib/db/queries.ts:cancelExpiredOrders()`
- `src/actions/refund.ts`
- `src/app/api/internal/cron/cleanup/route.ts`

要求：

1. 手动取消订单成功后释放 `reserved` 优惠券。
2. 5 分钟超时取消后释放预占；清理结果增加 `releasedCouponUsageCount` 便于观测。
3. `deleteOneOrder()` 不能直接删除使用记录；订单物理删除前保留审计信息，或明确禁止删除有核销记录的订单。
4. `markOrderRefunded()` 根据 `refund_policy`、订单履约状态和退款类型决定是否返券。
5. 返券必须幂等；退款接口重复调用不能重复减 `consumed_count`。
6. 订单退款后仍保留定价快照和优惠券使用记录。

---

## 7. 后台管理功能

### 7.1 页面和组件

新增：

- `src/app/admin/coupons/page.tsx`
- `src/app/admin/coupons/new/page.tsx`
- `src/app/admin/coupons/[id]/page.tsx`
- `src/app/admin/coupons/[id]/edit/page.tsx`
- `src/components/admin/coupons/coupon-list-content.tsx`
- `src/components/admin/coupons/coupon-form.tsx`
- `src/components/admin/coupons/coupon-detail-content.tsx`
- `src/components/admin/coupons/coupon-product-picker.tsx`
- `src/components/admin/coupons/coupon-usage-table.tsx`

修改：

- `src/components/admin/sidebar.tsx`
- `src/locales/zh.json`
- `src/locales/en.json`

优惠券入口放在“店铺运营”区域，位于商品管理与订单管理之间。

### 7.2 列表页

采用项目既有 `AdminListPage + AdminListScroll`，默认 20 条/页，底部固定分页栏。

筛选：

- 关键词：优惠码、内部名称。
- 状态：全部、草稿、待生效、使用中、已用完、已过期、已停用。
- 类型：百分比、固定立减、满减。
- 范围：全部商品、指定商品。

列表字段：

- 优惠码和名称。
- 规则摘要。
- 适用范围。
- 有效期。
- `已核销 / 总次数`、当前预占。
- 使用人数。
- 券间/积分叠加状态。
- 派生状态。
- 创建时间与操作。

操作：查看、编辑、复制、启用/停用。已使用优惠券不提供删除；未使用草稿可删除，但必须二次确认。

### 7.3 创建/编辑表单

分区：

1. 基础信息：名称、优惠码、说明。
2. 优惠规则：类型、折扣率/立减额、门槛、最高优惠。
3. 使用范围：全部商品或指定商品多选。
4. 次数限制：总次数、每人次数。
5. 叠加规则：其他券、积分。
6. 退款策略。
7. 生效时间与结束时间。
8. 状态与发布确认。

动态校验：

- 不同类型只显示相关金额字段。
- `selected` 至少选择一个商品。
- 结束时间必须晚于开始时间。
- 固定优惠不得为 0；折扣基点范围必须有效。
- 每人限制不能大于有限的总次数。
- 首次保存默认草稿；点击启用前显示规则摘要确认。

### 7.4 详情与使用记录

摘要：

- 核销次数、预占次数、使用人数。
- 累计优惠金额。
- 关联订单总金额和最终实付。
- 规则、有效期、适用商品和叠加规则。

使用记录列：

- 状态。
- 用户名、用户 ID。
- 订单号，可跳转 `/admin/orders/[id]`。
- 商品。
- 小计、优惠券优惠、积分抵扣、实付。
- 预占、核销、释放或返还时间。
- 原因。

详情查询必须服务端分页，不能一次加载所有使用记录。

---

## 8. 用户结算体验

### 8.1 修改文件

- `src/components/buy-button.tsx`
- `src/actions/checkout.ts`
- `src/actions/coupons.ts`
- `src/locales/zh.json`
- `src/locales/en.json`

### 8.2 交互流程

1. 购买弹窗打开后不自动请求优惠券。
2. 用户输入优惠码，点击“使用”。
3. 调用 `previewCoupon()`：请求携带商品 ID、数量、标准化后的优惠码和是否选择积分。
4. 返回报价后显示已应用券卡片、优惠金额、有效说明和移除按钮。
5. MVP 只允许一张；增强阶段允许继续输入，最多 3 张。
6. 改变数量、积分开关或商品变体时，重新校验已应用优惠券。
7. 点击支付时，把优惠码数组传给 `createOrder()`；服务端重新计算。
8. 若下单时规则已变化，停留在弹窗并提示“优惠状态已变化，请重新确认价格”。

### 8.3 金额明细

按顺序展示：

- 商品小计。
- 每张优惠券及优惠额。
- 优惠券优惠合计。
- 积分抵扣及积分数。
- 最终应付。

不能只显示总价，否则用户和管理员无法核对叠加结果。

### 8.4 防枚举与滥用

- 预览失败统一返回业务级提示，不返回剩余总量、创建者、内部名称等后台信息。
- 服务端记录失败类型和请求上下文，但不记录完整敏感会话信息。
- 如后续发现爆破，增加按会话/IP 的短周期限流；第一版先限制输入长度和请求按钮并发，客户端做 300–500ms 防抖但不替代服务端保护。

---

## 9. 分阶段开发任务与依赖

### Phase 0：基线保护与功能开关

- [ ] 记录当前远端 main、线上 schema v24 和 D1 表结构。
- [ ] 新增 `coupons_enabled=false` 配置读取，默认关闭。
- [ ] 建立优惠券错误码和领域类型骨架。
- [ ] 确认现有 10 项测试、typecheck、lint 基线通过。

完成标准：未启用功能时，线上行为与当前版本完全一致。

### Phase 1：schema v25 与只读仓储

- [ ] 在 `schema.ts` 定义 `coupons`、`coupon_products`、`coupon_usages`、`coupon_user_counters`。
- [ ] orders 增加定价快照列。
- [ ] `queries.ts` 增加幂等建表/加列/索引逻辑。
- [ ] 首次安装 bootstrap 同步更新。
- [ ] `CURRENT_SCHEMA_VERSION=25`，仅迁移全部成功后标记。
- [ ] 实现后台只读列表与详情 Repository 查询。

完成标准：空库可初始化；v24 可升级；重复执行迁移无异常；原首页与后台订单页正常。

### Phase 2：规则引擎与金额模型

- [ ] 完成 code、money、errors、rules、pricing 模块。
- [ ] 实现三种优惠类型、范围、有效期、总次数和每人次数校验。
- [ ] 实现单券报价和定价快照。
- [ ] 把积分抵扣输入改为券后金额的测试模型，但暂不接入下单。
- [ ] 增加规则和金额单元测试。

完成标准：规则层不访问 DB；所有金额测试使用整数分；边界与舍入明确。

### Phase 3：后台 CRUD

- [ ] 新增优惠券 Server Actions 和管理员鉴权。
- [ ] 完成列表、新建、详情、编辑、复制、启停。
- [ ] 完成商品选择器和服务端分页使用记录表。
- [ ] 锁定已使用券的经济规则。
- [ ] 增加中英文文案和表单可访问性。

完成标准：管理员能完整配置券；非管理员不能调用 mutation；未开启前台功能也可提前创建草稿券。

### Phase 4：MVP 单券预览与下单预占

- [ ] `buy-button.tsx` 增加单券输入和报价明细。
- [ ] `createOrder()` 接受单个优惠码并服务端重算。
- [ ] 原子预占总次数和每人次数。
- [ ] 创建订单及 `coupon_usages` 快照。
- [ ] 创建失败补偿释放。
- [ ] 零金额订单立即核销。
- [ ] 更新订单列表和详情金额拆分。

完成标准：普通、积分、零金额、自动发货和手动发货下单都能正确处理一张券。

### Phase 5：支付、取消、超时和退款闭环

- [ ] 支付履约 Claim 中核销优惠券。
- [ ] 重复支付回调幂等。
- [ ] 管理员标记已支付走统一核销路径。
- [ ] 手动取消、5 分钟超时和创建失败释放预占。
- [ ] 退款按策略返券。
- [ ] 清理接口输出优惠券处理统计。
- [ ] 删除订单策略改为保留优惠券审计链。

完成标准：任何订单终态都有对应优惠券终态；计数与 usage 聚合一致。

### Phase 6：多券叠加增强

- [ ] Server Action 接受最多 3 个标准化优惠码。
- [ ] 实现所有券均允许叠加的组合校验。
- [ ] 实现确定性计算顺序和 `sequence` 快照。
- [ ] 用户端支持多券标签、移除和组合重算。
- [ ] 全部券原子预占；任一失败时回滚已抢占券。
- [ ] 增加多券 + 积分组合矩阵测试。

完成标准：相同输入始终得到相同金额；并发失败不留下孤儿预占。

### Phase 7：发布与观察

- [ ] 本地执行 `npm run check`。
- [ ] 执行完整 OpenNext Cloudflare build，不使用旧 `.open-next` 产物。
- [ ] 在远程 D1 先完成 schema v25 并核验表/列/索引。
- [ ] 部署代码，保持 `coupons_enabled=false`。
- [ ] 后台创建内部测试券，使用测试账号跑通支付/取消/退款。
- [ ] 开启功能开关。
- [ ] 观察迁移错误、预占冲突、核销失败和清理统计。

完成标准：线上功能开关开启后，原订单、积分、发卡和退款链路无回归。

---

## 10. 测试矩阵

### 10.1 单元测试

#### 金额

- 百分比：0.01、整数、小数、最高优惠封顶。
- 固定立减大于、等于和小于小计。
- 满减在门槛前 1 分、刚好达到和超过门槛。
- 多券后金额不为负。
- 统一 round-half-up 舍入。

#### 规则

- 草稿、启用、停用。
- 开始时间前、边界时刻、结束时间边界和过期后。
- 所有商品、指定商品命中和未命中。
- 总次数、每人次数刚好达到上限。
- 匿名用户使用每人限次券。
- 与积分/其他券冲突。

#### 状态机

- `reserved → consumed`
- `reserved → released`
- `consumed → reversed`
- 非法迁移被拒绝。
- 每个动作重复执行只生效一次。

### 10.2 集成测试

| 场景 | 预期 |
|---|---|
| 普通金额 + 单券 | 订单 amount 等于服务端报价 |
| 单券 + 积分 | 先券后积分，快照完整 |
| 不可与积分叠加券 + 勾选积分 | 下单被明确拒绝 |
| 券后 0 LDC + 自动发货 | 立即交付并核销券 |
| 券后 0 LDC + 手动发货 | 状态 paid，等待后台发货，券已核销 |
| 支付回调重复两次 | 只核销一次 |
| 支付回调金额不符 | 不核销、不履约 |
| 待支付超时 | 订单取消、积分返还、库存和券释放 |
| 管理员取消 | 同上，重复操作幂等 |
| 全额未履约退款 | 根据策略返券 |
| 已交付退款 | 默认不返券，保留记录 |
| 共享商品 | 不因特殊库存逻辑漏核销或返还 |
| 手动发货商品 | 支付和交付状态不重复核销 |

### 10.3 并发测试

- 总次数 1：并发 20 次创建订单，只允许 1 个有效预占。
- 总次数 10：并发 50 次，`reserved + consumed <= 10`。
- 每人限 1：同用户并发 10 次，只允许 1 个有效预占。
- 不同用户并发：不互相错误阻塞。
- 支付回调与超时清理竞争：最终只能是 consumed 或 released，不能两者都计数。
- 支付回调与管理员标记已支付竞争：只核销一次。
- 多券阶段：第二张抢占失败后第一张必须释放。

### 10.4 权限与安全

- 非管理员无法创建、编辑、启停、查看完整使用人列表。
- 普通用户不能伪造 `userId` 绕过每人限次。
- 订单最终价格不接受客户端金额字段。
- 修改/删除商品后，指定商品券不会错误扩展为全商品券。
- 优惠码错误响应不泄漏后台字段和剩余次数。
- 搜索、名称、描述和码值经过长度与字符校验，页面输出不产生 XSS。

### 10.5 UI 与可访问性

- 桌面和移动端优惠券列表、表单、结算弹窗无横向溢出。
- 表单字段有 Label、错误提示与焦点定位。
- 仅键盘可完成输入、使用、移除和提交。
- 加载中禁止重复提交。
- 折扣金额、积分和最终价格文本可被屏幕阅读器理解。
- 中文和英文无缺失 key。

### 10.6 回归测试

- 无优惠券下单金额与当前线上完全一致。
- 积分抵扣、库存预占、自动发卡、手动发货均正常。
- 订单重试支付使用原订单 amount，不重算优惠券。
- 老订单快照字段为空时，列表和详情不报错。
- schema 迁移失败时，前台优惠券关闭，原商品和订单读路径不被拖垮。

---

## 11. 监控、审计与一致性检查

### 11.1 结构化日志事件

- `coupon.preview.failed`
- `coupon.reserve.succeeded`
- `coupon.reserve.conflict`
- `coupon.consume.succeeded`
- `coupon.release.succeeded`
- `coupon.reverse.succeeded`
- `coupon.state_transition.failed`
- `coupon.reconciliation.mismatch`

日志字段包含 `couponId`、`orderId`、`userId`（可空）、错误码和 request/claim ID；不要打印敏感会话或完整表单。

### 11.2 后台一致性检查

增加只读诊断查询：

- `coupons.reserved_count` 对比 `coupon_usages status=reserved`。
- `coupons.consumed_count` 对比 `status=consumed`。
- 用户计数表对比 usage 聚合。
- 找出已过期但仍 reserved 的记录。
- 找出 paid/delivered 订单仍 reserved 的记录。
- 找出 cancelled/refunded 订单状态不符合退款策略的记录。

第一版可通过受保护的后台诊断操作手工执行；稳定后再考虑接入定时对账。

---

## 12. 上线与回滚方案

### 12.1 上线顺序

1. 数据库备份或创建 D1 时间点备份。
2. 完整构建 `_workers_next`，禁止直接部署历史 `.open-next`。
3. 远程执行/触发 schema v25，查询确认四张表、订单四列和全部索引存在。
4. 部署后保持 `coupons_enabled=false`。
5. 验证首页、后台、普通下单、积分下单和支付回调。
6. 后台创建内部测试券，完成：预览 → 下单 → 支付 → 核销。
7. 再验证取消释放、超时释放和退款返还。
8. 开启前台功能。
9. 核对线上 Worker 名仍为 `ldc-shop`，D1 绑定仍为 `DB` / `ldc-shop-next`。

### 12.2 回滚

首选软回滚：

1. 关闭 `coupons_enabled`。
2. 新下单不接受优惠码，已创建订单继续按快照金额完成支付和履约。
3. 保留新表和新列，不降 `schema_version`，避免下一 isolate 重跑迁移。
4. 修复后重新开启。

不应在紧急回滚中 DROP 表或清空记录；优惠券使用记录属于财务审计数据。

### 12.3 兼容性

- 旧代码读取新增可空列不受影响。
- 新代码遇到旧订单空快照时回退为：`subtotal ≈ amount + pointsUsed`，但明确标注为历史估算；不伪造优惠券明细。
- 已创建订单的支付重试始终使用订单 `amount`，不受优惠券后来停用或过期影响。

---

## 13. 关键文件变更总表

### 必改

- `src/lib/db/schema.ts`
- `src/lib/db/queries.ts`
- `src/actions/checkout.ts`
- `src/lib/order-processing.ts`
- `src/actions/admin-orders.ts`
- `src/actions/refund.ts`
- `src/components/buy-button.tsx`
- `src/components/admin/sidebar.tsx`
- `src/app/api/internal/cron/cleanup/route.ts`
- `src/app/admin/orders/page.tsx`
- `src/app/admin/orders/[id]/page.tsx`
- `src/components/admin/orders-content.tsx`
- `src/components/admin/order-detail-content.tsx`
- `src/locales/zh.json`
- `src/locales/en.json`

### 新增

- `src/lib/coupons/*`
- `src/actions/coupons.ts`
- `src/app/admin/coupons/**`
- `src/components/admin/coupons/**`

### 可能调整

- `src/lib/order-payment-breakdown.ts`：扩展为小计、券优惠、积分、实付的统一展示模型。
- `worker-entry.mjs`：如 scheduled handler 直接编排清理，则加入优惠券过期预占清理；若仍调用现有内部清理路由，则无需新增独立入口。

---

## 14. Definition of Done

只有以下条件全部满足，优惠券功能才算完成：

- [ ] schema v25 在空库、v24 升级和重复执行三种情况下均成功。
- [ ] 三类优惠和两种商品范围全部可配置。
- [ ] 总次数、每人次数在并发下不超限。
- [ ] 单券完整闭环通过后，多券最多 3 张功能通过。
- [ ] 商品小计、券优惠、积分、实付在用户端、后台和订单快照中一致。
- [ ] 支付成功、重复回调、管理员标记支付均不会重复核销。
- [ ] 创建失败、取消、超时和符合策略的退款正确释放/返券。
- [ ] 旧订单、无优惠券下单和现有积分/发货流程无回归。
- [ ] 后台可查看使用状态、使用人和关联订单，且分页、权限正确。
- [ ] 中文、英文、移动端和键盘操作通过。
- [ ] `npm run check`、生产构建和线上冒烟测试全部通过。
- [ ] 功能开关和软回滚验证完成。
