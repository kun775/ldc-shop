# 优惠券功能实现报告

> 工程：`_workers_next`（Cloudflare Workers 正式版本）
> 依据计划：`outputs/coupon-development-plan-2026-09-16.md`
> 落地日期：2026-09-17
> schema：v24 → **v25**
> 状态：代码完成并通过完整本地验证；**未提交、未部署、远程 D1 未迁移**

---

## 1. 已完成内容

### 1.1 数据库（schema v25）

新增四张表，并在 `orders` 上增加定价快照列：

| 对象 | 作用 |
|---|---|
| `coupons` | 优惠券规则主表，唯一索引 `coupons_code_uq ON coupons(upper(code))` |
| `coupon_products` | 指定商品范围，复合主键 `(coupon_id, product_id)` |
| `coupon_usages` | 预占/核销/释放/返还明细 + 规则与金额快照 |
| `coupon_user_counters` | 每人限次的并发计数，复合主键 `(coupon_id, user_id)` |

`orders` 新增：`subtotal_amount_cents`、`coupon_discount_amount_cents`、`points_discount_amount_cents`、`pricing_snapshot`。

迁移实现要点：

- `CURRENT_SCHEMA_VERSION` 提升至 25；新增 `ensureCouponTables()`。
- **同时接入「增量迁移」和「首次安装 bootstrap」两条分支**，空库和已有库都能建表。
- 优惠券 DDL 全部逐条 `db.run(sql...)` 执行，不使用多语句 prepared statement（规避本项目历史上踩过的 trigger/DDL 执行坑）。
- 全部 DDL 成功后才写入 `schema_version=25`；沿用「已有库迁移失败不得跌入首次初始化」的保护。
- 只新增、不改写、不强制回填历史订单。

### 1.2 领域层（`src/lib/coupons/`）

| 文件 | 职责 |
|---|---|
| `types.ts` | 枚举、DTO、定价与快照类型 |
| `errors.ts` | `CouponError` + 16 个稳定错误码 → i18n key 映射 |
| `code.ts` | 优惠码标准化/校验/随机生成 |
| `money.ts` | LDC ↔ 整数分，字符串截断舍入 |
| `rules.ts` | 纯函数：状态、有效期、范围、门槛、总次数、每人次数、折扣计算 |
| `pricing.ts` | 商品小计 → 券 → 积分 → 应付 的统一计算 + 定价快照 |
| `checkout-quote.ts` | 下单与预览共用的定价入口 |
| `repository.ts` | 后台列表/详情/使用记录/写库 |
| `reservation.ts` | 预占/核销/释放/返还状态机 |
| `admin-validation.ts` | 后台表单边界校验 |
| `flag.ts` | `coupons_enabled` 功能开关 |
| `rules.test.ts` | 15 项单元测试 |

### 1.3 支持的优惠形态

- 百分比折扣（`rate_bps`，如 9000 = 九折）+ 可选最高优惠封顶
- 固定立减
- 满额立减（门槛仅按该券适用商品金额判断）
- 所有商品 / 指定商品
- 总使用次数（1 次 = 一次性券 / N 次 / 不限）
- 每人使用次数（1 次 / N 次 / 不限，需登录）
- 与其他券叠加 / 与积分叠加（两个独立开关）
- 有效期、草稿/启用/停用、退款返券策略
- 每单最多 3 张券

### 1.4 金额与并发

金额顺序固定为 **商品小计 → 优惠券优惠 → 券后金额 → 积分抵扣 → 最终应付**，全程整数分计算。

多券排序固定：固定额与满减券优先，百分比券后置，同类型保持输入顺序；每张券在前一张折扣后的剩余金额上计算，结果可复现。

并发一致性：

- 整券次数：单条条件 `UPDATE coupons SET reserved_count = reserved_count + 1 WHERE ... AND (reserved_count + consumed_count) < total_use_limit RETURNING id`
- 每人次数：`coupon_user_counters` 条件 `UPDATE ... RETURNING`
- 失败即补偿：先回滚已占用计数，再释放本订单全部预占
- 核销/释放/返还：先读明细，再逐条做条件状态迁移并 `RETURNING` 判定，只有真正迁移成功才调整计数 → 重复支付回调、重复取消、重复退款天然幂等

### 1.5 链路接入点

| 场景 | 接入位置 |
|---|---|
| 下单预占 + 快照写入 | `src/actions/checkout.ts` |
| 零元订单立即核销 | `src/actions/checkout.ts`（零元分支） |
| 创建失败补偿释放 | `src/actions/checkout.ts` catch |
| 支付成功核销 | `src/lib/order-processing.ts` 三处 finalize helper |
| 后台标记已付款核销 | `src/actions/admin-orders.ts:markOrderPaid` |
| 手动取消释放 | `src/actions/admin-orders.ts:cancelOrder` |
| 删除订单释放 | `src/actions/admin-orders.ts:deleteOneOrder` |
| 5 分钟超时释放 | `src/lib/db/queries.ts:cancelExpiredOrders` |
| 退款按策略返还 | `src/actions/refund.ts:markOrderRefunded` |

### 1.6 后台管理

- `/admin/coupons` 列表：服务端分页、关键词/状态/类型/范围筛选、复制、启用停用、删除、前台开关切换
- `/admin/coupons/new` 创建，`/admin/coupons/[id]/edit` 编辑
- `/admin/coupons/[id]` 详情：核销/预占/使用人/累计优惠统计 + 使用记录分页（状态、使用人、关联订单可跳转、时间线、备注）
- 已产生使用记录的优惠券锁定优惠码与经济规则，只能「复制为新券」，保护待支付订单
- 侧栏「店铺运营」新增「优惠券管理」入口
- 新增 34 个中英文 i18n 键（错误码 + 结算弹窗文案）

### 1.7 用户端

购买弹窗新增优惠码输入、已应用券标签可移除、金额四段拆分（商品小计 / 券优惠 / 积分抵扣 / 应付）。
券与积分冲突时自动关闭积分并提示；客户端计算仅用于展示，下单金额始终由服务端重算。

---

## 2. 验证证据

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `eslint src --quiet` | 0 错误（新增文件仅 `no-explicit-any` 警告，与全仓现状一致） |
| `node --test "src/lib/**/*.test.ts"` | **28/28 通过**（13 存量 + 15 新增优惠券测试） |
| Next.js 16.3.5 webpack 生产构建 | 完整通过：编译 → 类型检查 → 36/36 静态页 → Collecting build traces（跑了两轮） |
| 新路由注册 | 构建输出的路由表含 `/admin/coupons`、`/admin/coupons/new`、`/admin/coupons/[id]`、`/admin/coupons/[id]/edit`；产物确认 `.next/server/app/admin/coupons/{page.js, new/, [id]/}` 均存在 |

单元测试覆盖：金额舍入、优惠码标准化、三类折扣、门槛边界、有效期边界、总次数/每人次数、指定商品范围、
券后积分顺序、无券回归、不产生负金额、积分冲突、不可叠加拒绝、多券顺序确定性、超出 3 张、快照完整性。

---

## 3. 如何使用

### 3.1 启用开关

功能开关 `coupons_enabled` **默认关闭**，这是刻意的软回滚控制点。

1. 部署后进入后台 `/admin/coupons`
2. 点击右上角「启用前台优惠券」
3. 前台结算弹窗才会出现优惠码输入框

开关关闭时：后台仍可创建和管理优惠券；`createOrder` 收到优惠码会直接拒绝，前台不展示入口。

### 3.2 建议上线顺序

1. 备份 D1（或创建时间点备份）
2. 完整构建 `_workers_next`（禁止直接部署历史 `.open-next`）
3. 确认远程 D1 完成 schema v25（四张表 + 订单四列 + 索引）
4. 部署代码，**保持开关关闭**
5. 验证首页、后台、普通下单、积分下单、支付回调无回归
6. 后台创建内部测试券，跑通：预览 → 下单 → 支付 → 核销
7. 再验证取消释放、5 分钟超时释放、退款返还
8. 打开前台开关

### 3.3 回滚

首选软回滚：关闭 `coupons_enabled`。已创建订单继续按订单快照金额完成支付与履约。
**不要**在紧急回滚中 DROP 表或删除使用记录 —— 优惠券使用记录属于财务审计数据。
不要下调 `schema_version`，避免下一个 isolate 重跑迁移。

---

## 4. 已知限制与注意事项

1. **未部署、未迁移远程 D1**。本地验证全部通过，但 schema v25 尚未在远程执行。
2. `orders.amount` 的格式由 `"10"` 变为 `"10.00"`。已确认 `assertValidPaidAmount` 用 `parseFloat` + 0.01 容差比较、`getRetryPaymentParams` 与退款代理都用 `Number(order.amount).toFixed(2)`，兼容。
3. 老订单的快照字段为空，订单详情会自动回退到「实付 + 积分」两段展示，不伪造优惠券明细。
4. 后台优惠券页面的界面文案为中文硬编码（与现有 `refunds-content.tsx` 等后台页面一致）；仅错误码与结算弹窗走 i18n。
5. 多券叠加已实现并通过顺序确定性测试，但按计划应先验收单券闭环。
6. 客户端在无券时仍用本地积分预览，有券时完全以服务端返回为准。

---

## 5. 待用户处理

- **尚未提交**。本轮改动为 14 个文件修改 + 4 个新增目录/文件组（见下）。
- **尚未部署**，远程 D1 仍是 schema v24。
- 临时隔离构建目录与临时构建配置均已清理还原。

## 6. 改动文件清单

**修改：**

- `src/lib/db/schema.ts`（新增四表 + 订单快照列）
- `src/lib/db/queries.ts`（schema v25、`ensureCouponTables()`、超时释放优惠券）
- `src/actions/checkout.ts`（优惠券定价、预占、快照、补偿释放、零元核销）
- `src/lib/order-processing.ts`（支付核销）
- `src/actions/admin-orders.ts`（标记已付款核销、取消与删除释放）
- `src/actions/refund.ts`（按策略返还）
- `src/components/buy-button.tsx`（优惠码输入与金额明细）
- `src/components/admin/sidebar.tsx`（侧栏入口）
- `src/components/admin/order-detail-content.tsx`、`src/app/admin/orders/[id]/page.tsx`（订单金额拆分展示）
- `src/lib/order-payment-breakdown.ts`（支持快照金额拆分）
- `src/locales/zh.json`、`src/locales/en.json`（34 个新键）
- `tsconfig.json`（`allowImportingTsExtensions`）
- `_workers_next/.gitignore`

**新增：**

- `src/lib/coupons/`（types / errors / code / money / rules / pricing / checkout-quote / repository / reservation / admin-validation / flag / rules.test.ts）
- `src/actions/coupons.ts`
- `src/app/admin/coupons/`（page / new / [id] / [id]/edit）
- `src/components/admin/coupons/`（coupon-list-content / coupon-form / coupon-product-picker）
