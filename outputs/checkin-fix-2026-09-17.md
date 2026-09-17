# 签到失败修复 + 数据库错误信息脱敏报告

> 日期：2026-09-17
> 工程：`_workers_next`
> 状态：**线上已修复并验证**；代码改动尚未提交

---

## 1. 用户报告的问题

1. 签到失败。
2. 报错把数据库结构暴露到了前台：

```
checkin.Check-in failed: Failed query: insert into "user_point_ledger"
("id", "user_id", "event_type", "delta", "balance_after", "business_key",
 "source_type", "source_id", "reason", "operator_user_id", "operator_username",
 "metadata", "status", "claim_id", "claimed_at", "created_at")
values (null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict do nothing returning "id"
params: 10785,checkin_reward,10,,checkin_reward:10785:1789603200000,...
```

---

## 2. 根因

### 2.1 直接原因：线上表结构与代码不一致

查询生产 D1（`ldc-shop-next`）得到 `user_point_ledger` 的真实列：

```
id,user_id,event_type,delta,balance_after,business_key,source_type,source_id,
reason,operator_user_id,operator_username,metadata,status,created_at
```

**缺少 `claim_id` 与 `claimed_at`**，而代码按 schema v2 结构插入这两列 → `no such column: claim_id`。

### 2.2 深层原因：缺列永远补不上

`ensureUserPointLedgerSchema()` 的第一行就是：

```ts
if (await hasCurrentPointLedgerSchema()) return   // 版本达标 → 直接返回
```

而线上 `settings.point_ledger_schema_version` 早已是 **2**（上一次事故处置时手工置位）。
于是建列 DDL 被**永久跳过**。

更隐蔽的是 `hasCurrentPointLedgerSchema()` 内部会调用 `markPointLedgerSchemaReady()` 产生副作用，
而签到路径的执行顺序是：

```
ensurePointLedgerUserRecord()
  → ensurePointLedgerLoginUsersSchema()
    → hasCurrentPointLedgerSchema()      ← 在这里就把 ready 置为 true
      → markPointLedgerSchemaReady()
applyUserAutomaticPointEvent()
  → ensureUserPointLedgerSchema()        ← 因 ready 已为 true 而直接 return
```

自愈逻辑在真正执行前就被短路了。

**影响面不止签到**：`order_deduction`（下单积分抵扣）、`refund_return`（退款返积分）、
`admin_adjust`（后台调整积分）走的都是同一条 Insert，同样会失败。

### 2.3 泄漏原因

Server Action 的**返回值不会被 Next.js 脱敏**（只有 `throw` 才会）。而旧代码是：

```ts
} catch (error: any) {
    return { success: false, error: `Check-in failed: ${error?.message}` }
}
```

客户端又做了 `t(\`checkin.${res.error}\`)`，`t()` 找不到键时原样返回 key，
于是整段 SQL 就显示在 toast 上。

---

## 3. 修复内容

### 3.1 线上数据修复（立即生效，无需部署）

```sql
ALTER TABLE user_point_ledger ADD COLUMN claim_id TEXT;
ALTER TABLE user_point_ledger ADD COLUMN claimed_at INTEGER;
```

线上代码本来就在写这两列，所以补列后签到**当场恢复**。

### 3.2 代码修复（防复发）

**a) 去掉版本号短路，改为结构自愈** — `src/lib/points/ledger-db.ts`

- `hasCurrentPointLedgerSchema()` → 无副作用的 `isPointLedgerSchemaCurrent()`，不再顺手置 ready。
- `ensureUserPointLedgerSchema()` 每 isolate **无条件**执行幂等 DDL：
  `CREATE TABLE IF NOT EXISTS`、`safeAddColumn`（吞掉 duplicate column）、
  `CREATE INDEX IF NOT EXISTS`、`CREATE TRIGGER IF NOT EXISTS`；
  版本号仅在未达标时才写入，避免每 isolate 一次无谓写操作。
- 额外补上 `balance_after` / `status` 的 `safeAddColumn`，覆盖更早的历史结构。

**b) 新增统一脱敏工具** — `src/lib/errors/safe-error.ts`

| 导出 | 作用 |
|---|---|
| `isInternalErrorMessage(message)` | 识别 SQL 原文、驱动错误、内部错误码、超长文本 |
| `sanitizeClientErrorMessage(message, fallback)` | 内部错误 → 兜底安全文案 |
| `resolveClientErrorKey(error, mapping, fallbackKey)` | 只放行白名单业务错误码映射的 i18n key |
| `createErrorId()` / `logServerError(scope, error)` | 生成短 ID 并把完整错误写服务端日志 |

**c) 签到改为返回稳定 key** — `src/actions/points.ts`

返回值只可能是：
`checkin.loginRequired` / `checkin.disabled` / `checkin.alreadyCheckedIn` /
`checkin.inProgress` / `checkin.balanceNegative` / `checkin.failed`，并附带 `errorId`。

`src/components/checkin-button.tsx` 相应改为消费 key（并兼容旧的英文文案）。

**d) 其它同类返回点一并收口**

`actions/order.ts`、`actions/data.ts`（2 处）、`actions/admin-orders.ts`（verifyRefund）、
`actions/refund-requests.ts`、`actions/update-check.ts` 全部改走 `sanitizeClientErrorMessage`。

**e) 多语言**

补齐 `checkin.loginRequired` / `checkin.disabled` / `checkin.inProgress` / `checkin.balanceNegative`
的中英文文案。

---

## 4. 验证

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `eslint src --quiet` | 0 错误 |
| `node --test "src/lib/**/*.test.ts"` | **35/35 通过**（新增 7 项脱敏测试，第一条直接用线上泄漏原文断言） |
| 线上 `user_point_ledger` 列 | 已含 `claim_id`、`claimed_at` |
| 线上触发器 | `user_point_ledger_apply_balance` 存在 |
| 线上版本标记 | `point_ledger_schema_version = 2` |

### 顺带核查（排除同类隐患）

线上表结构与代码预期逐表比对：

| 表 | 列数 | 结论 |
|---|---|---|
| `orders` | 23（含 `fulfillment_claim_id`/`fulfillment_claimed_at`） | 一致 |
| `cards` | 9 | 一致 |
| `login_users` | 10 | 一致 |
| `user_point_ledger` | 16（修复后） | 已修好 |

`coupons` / `coupon_*` 表尚不存在属正常——优惠券功能已提交但未部署，
部署时会因 `schema_version` 为 24 而自动执行 v25 建表。

**结论：账本表是唯一的结构不一致处。**

---

## 5. 改动文件

**新增**
- `src/lib/errors/safe-error.ts`
- `src/lib/errors/safe-error.test.ts`

**修改**
- `src/lib/points/ledger-db.ts`（自愈 + 去除副作用）
- `src/actions/points.ts`（安全错误返回）
- `src/components/checkin-button.tsx`（消费 i18n key）
- `src/actions/order.ts`、`src/actions/data.ts`、`src/actions/admin-orders.ts`、
  `src/actions/refund-requests.ts`、`src/actions/update-check.ts`（脱敏）
- `src/locales/zh.json`、`src/locales/en.json`（4 个新键）

**线上数据操作（一次）**
- `user_point_ledger` 补 `claim_id`、`claimed_at` 两列

---

## 6. 遗留与建议

1. **本轮代码改动尚未提交**。线上签到已通过补列恢复，但自愈逻辑与脱敏需要部署后才生效。
2. 同类「版本号领先于真实结构」的写法在 `src/lib/db/queries.ts` 仍然存在
   （`hasCurrentSchemaVersion()` 达标即跳过所有增量迁移）。
   目前 `schema_version = 24 < 25`，优惠券部署时会正常执行迁移，
   但**下次再手工置位就可能重现本次故障**，建议后续一并改造为幂等自愈。
3. `applyBalanceDelta()` 在 `ledger-db.ts` 中是死代码——积分增减依赖数据库触发器。
   若触发器缺失，`finalizeAutomaticEvent` 会把账本置为 `completed` 但**积分不会增加**（静默少发）。
   建议补一条启动自检或在核销后校验余额。
