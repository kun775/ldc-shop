# 评审：LDC Shop 接入通用卡密服务方案

**评审对象：** `outputs/license-key-service-integration-plan-2026-09-29.md`
**评审时间：** 2026-09-29
**评审方法：** 对中心 `license-key-service` 的实现、`api/openapi.yaml` 契约，以及 ldc-shop `_workers_next` 的相关代码逐条实测核对（读源码，不采信文档与注释的自我描述）。

## 结论

1. 计划对**中心侧**指出的 8 项偏差，**全部成立**；其中 3 项的实际严重程度高于计划表述，建议加码。
2. 计划对 **ldc-shop 侧**的代码引用**基本准确**（抽查 12 处，9 处精确、3 处需微调），未见方向性错误。
3. 方案方向（库存型、售出先于展示、不硬改旧 GET、`acknowledged` 不等于可核销）与中心现有能力匹配，**无方向性问题**。
4. 需修订的是**风险定级与少量引用**，不是方案本身。

---

## 一、中心侧偏差核对（计划指出 → 实测结果）

### 1. 错误响应 `request_id` 层级 —— ✅ 成立

- 实现 `internal/infra/http/response/response.go:11-22,101-123`：
  - 错误体 `{"ok":false,"error":{"code","message","request_id","retryable"}}`，`request_id` 在 **`error` 内**；
  - 成功体 `{"ok":true,"data":...,"request_id":...}`，`request_id` 在 **顶层**。
- 契约 `api/openapi.yaml:1965-1974` 的 `ErrorResponse` 为 `required: [ok, error, request_id]`，把 `request_id` 写在顶层；且 `ErrorBody`(1931-1964) 不含该字段。
- **判断正确。** 接入方错误追踪 ID 必须取 `error.request_id`。

### 2. OpenAPI 状态枚举漏 `sold` —— ✅ 成立，且比计划所述范围更大

- 漏 `sold` 的三处：`AllocationStatusQuery`(1121)、`CreateAllocationResponse.data.status`(1603)、`AllocationListItem.status`(1670)，均为 `[allocated, acknowledged, cancelled]`。
- **计划未点出的一处：** Sell 端点(729-759)复用 `AcknowledgeAllocationResponse`(1710-1724)，其 `status` 枚举仅 `[acknowledged, cancelled]` —— **连 `sold` 都不在枚举内**，Sell 成功返回的 `sold` 无法通过自身 schema 校验。
- 对照：表级枚举 `card_allocations`(232) **含** `sold`；后台过滤器 `internal/infra/http/admin_list.go:104` 也 **含** `sold`。
- **定性：纯契约文档缺陷，不是实现缺陷。**

### 3. API Key Scope 枚举漏 `cards:sell` / `cards:revoke` —— ✅ 成立，且是"文档比实现窄"

- admin 建 Key 的 schema 枚举(1490-1498)只有 8 个：`cards:allocate/read/inspect` + `redemptions:*`。
- 实现 `internal/application/admin_provisioning.go:449-453` 的 `allowedScopes` 明确接受 **10 个**，**含 `cards:sell` 与 `cards:revoke`**。
- `cards:revoke` 是真实路由级 Scope：`internal/adapters/http/card_handler.go:48` `RequireScope("cards:revoke")`。
- **后果：** 按 OpenAPI 生成客户端、或用枚举做前置校验的一方，会误判这两个 Scope 非法；反之手工调用则可通过。

### 4. Sell 路由实际要求 `cards:allocate` —— ✅ 成立，是真实"坑"

- `internal/adapters/http/allocation_handler.go:31-41`：`ar.Use(middleware.RequireScope("cards:allocate"))` 覆盖 `/api/v1/allocations` **整个路由组**，`/sell`、`/ack`、`/cancel` 全部在内。
- 与第 3 条组合：实现允许你**只签 `cards:sell`**，但这样签出的 Key 调 Sell 会被挡回 **403**。Sell 客户端必须同时具备 `cards:allocate`。
- 干扰因素：Sell 的**审计动作**记为 `cards:sell`（`allocation_service.go:383`），与路由实际要求的 Scope 名不同，极易误判。
- **计划"不要单独签发 `cards:sell` 代替它"的结论正确。**

### 5. `admin_writer.go` 批量清理无历史引用保护 —— ✅ 成立，且会破坏幂等重放（建议升级为阻断）

- `DeleteUnallocatedTestData`(73-99)：仅按"批次内存在非 `unallocated` 兄弟卡"判断，**完全不检查 `card_allocations.card_ids` 引用**。
- Cancel 会把卡打回 `unallocated`（`allocation_service.go:461`：`UpdateCardsAllocationStatus(..., "unallocated")`），因此"Cancelled Allocation 的卡"确实落入可删条件。
- **幂等重放依赖这些卡的密文：** `rebuildAllocation`(532-576) 会 `GetCardsByIDs` 并逐张 `decryptCard` 重建明文；卡被删后校验 `len(original.Cards) != len(items)` 失败，重放直接返回内部错误（`allocation idempotency snapshot does not match resource`）。
- 单条删除**有**保护：`DeleteAdminResource` case `"cards"`(149-155) 含 `NOT EXISTS (... card_allocations ...)`。计划的对照判断准确。
- **建议：把"未修复前禁用该入口"升级为上线阻断条件** —— Allocate 是商城主路径，命中概率不低。

### 6. 30 分钟 Ack 窗口无自动回收 —— ✅ 成立，且比计划所述更"空"

- `allocation_service.go:155` 仅把 `ExpiresAt = now+30min` 写入记录。
- 后台 `cmd/card-worker/main.go:71-88` 只跑 `ReapExpiredReservations`、Outbox、Reconciliation，**没有 Allocation 过期回收**。
- **且 `Ack` 流程(238-308)不校验 `record.ExpiresAt`** —— 超窗后仍可正常 Ack 成功。
- **结论：该窗口既不会自动取消、也不会拒绝 Ack，目前只是记录字段。** 计划的"需核验"应改写为"已核验：无自动回收、Ack 不判过期"。

### 7. Allocation 响应不含 `program_key` —— ✅ 成立

- `internal/domain/allocation/allocation.go:62-67`：`AllocationResponse` 只含 `allocation_id / program_id / external_ref / metadata / cards`，返回的是**内部 `program_id`（UUID）**，没有外部 `program_key`。
- 因此"不能仅凭 Allocate 响应核验 Program 归属"正确，只能靠发起请求时的受控商品映射 + Key 的 Program 白名单。

### 8. Allocation 列表 `external_ref` 位置不一致 —— ✅ 成立

- 实现 `allocation_handler.go:256-264`：`external_ref` 位于**列表项顶层**。
- 契约 `api/openapi.yaml:1662-1689` 的 `AllocationListItem`：`external_ref` 定义在 **`cards.items` 之下**(1679)，列表项顶层无该字段。
- 接入方按文档取 `item.external_ref` 会取空；实际应取顶层。

---

## 二、ldc-shop 侧代码引用核对

| 计划引用 | 实测 | 结论 |
|---|---|---|
| `src/lib/order-processing.ts:382-525`（付款履约） | `processOrderFulfillment` 起于 382 | ✅ 准确 |
| `src/app/api/notify/route.ts:73-110` | `processOrderFulfillment` 调用在 99-100，落在区间内 | ✅ 准确 |
| `src/actions/order.ts:19-75` / `:77-185` | `checkOrderStatus`(19) / `cancelPendingOrder`(77) | ✅ 准确 |
| `src/actions/admin-orders.ts:53-149` / `:279-428` | `markOrderPaid`(53)+`markOrderDelivered`(92) / `cancelOrder`(279)+`deleteOneOrder`(375) | ✅ 准确 |
| `src/actions/refund.ts:20-135` | `markOrderRefunded`(20)（`proxyRefund` 在 200） | ✅ 准确 |
| `src/actions/admin.ts:382-409` | `deleteCards`(382)（`saveCardsApiConfig` 在 424） | ✅ 准确 |
| `src/lib/db/queries.ts:3654-3666`（过期清理） | 落在 `cleanupExpiredCardsIfNeeded`(3618-3703) 内 | ✅ 准确 |
| `src/lib/db/queries.ts:254-287,593-661,664-967`（升级） | `verifyDatabaseUpgradeStructures`(254) / `runRegisteredDatabaseUpgrades`(593)+`getDatabaseUpgradeStatus`(649) / `prepareDatabaseForManualUpgrade`(666) | ✅ 准确 |
| `src/lib/db/queries.ts:1280-1361`（"数据及升级"） | 实为 `recalcProductAggregates`(1280)，属评分/评价汇总重算，与数据库升级无关 | ⚠️ 归类不准，应归"数据" |
| `src/lib/card-api.ts:77-167`（旧 GET） | 旧 GET 函数 `pullOneCardFromApi` 实际起于 **102**；77 是 `getProductCardApiConfig` | ⚠️ 起点偏早 25 行，区间仍覆盖目标函数 |
| `src/actions/checkout.ts:223-268`（标注"预留"） | 223-268 是 `getAvailableStock`（**库存检查**）；预留实为 `reserveAndCreate`(306-481) | ⚠️ 描述与位置不符，区间仍在结算流程内 |
| `src/actions/checkout.ts:509-569`（零元直发） | 509 `if (isZeroPrice)`；自动交付分支 535-569 确为 `isUsed=true` + `status:'delivered'` | ✅ 准确 |

**事实性结论抽查（均成立）：**

- `cards.cardKey` 无唯一约束，且 `ensureCardKeyDuplicatesAllowed`(`queries.ts:326`) 主动 `DROP INDEX ... cards_product_id_card_key_uq` → "商城允许重复卡"成立。
- `cards_api_token_*` 明文写入 D1 `settings`（`card-api.ts:98` `setSetting(keyOf(productId,"token"), token)`）成立。
- 升级注册表 `0028`–`0037`、`CURRENT_SCHEMA_VERSION = 37`(`queries.ts:47`)、基线 27 成立。
- `markOrderPaid`(53) 只改状态；`markOrderDelivered`(92) 对非手动履约要求已有 `order.cardKey`(126-128) 成立。

---

## 三、修订建议

1. **上线阻断条件由 7 条扩为 8 条**：新增"确认 30 分钟 Ack 窗口无自动回收、Ack 不判过期"对应的处置（接入方自行保证窗口内 Ack，或中心补回收任务），不能默认超窗即失效。
2. **第 5 条（批量清理）从"未修复前禁用入口"升级为阻断条件**，与 Allocate 主路径的耦合风险相称。
3. **契约修复清单补两条**：Sell 返回体 `status` 枚举需含 `sold`；`cards:sell` / `cards:revoke` 属"实现认、文档不认"，需在枚举中对齐。
4. **引用微调三处**：`queries.ts:1280-1361` 归类改为"数据"；`card-api.ts` 起点改 102；`checkout.ts` 中 223-268 的说明由"预留"改为"库存检查（预留见 306-481）"。
