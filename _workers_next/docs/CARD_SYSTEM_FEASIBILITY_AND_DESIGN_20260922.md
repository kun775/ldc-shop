# 通用卡密系统可行性评估与详细设计方案

更新日期：2026-09-22

## 一、执行结论

### 1.1 是否值得开发

**值得开发。** 当前已经存在三个真实且不同的卡密使用场景，已经超过“先复制代码、以后再抽象”的合理边界：

1. `ldc-shop`：卡密售卖、订单发货、库存预占、卡密 API 自动补货。
2. `german-utility-bill-service`：卡密登录、次数额度、任务预占、成功核销、失败释放。
3. `mt-worker`：兑换码批次、按用户限兑、每日/终身额度发放、使用记录。

三个项目都在重复处理以下能力：

- 卡密生成或导入；
- 批次与有效期；
- 启用、停用、耗尽等状态；
- 次数扣减与并发控制；
- 幂等、防重复兑换；
- 使用台账、查询和后台管理；
- 卡密明文保护与接口鉴权。

继续让每个项目各自实现，会持续产生状态定义不一致、并发漏洞、明文泄露、重复维护和跨项目无法查询的问题。通用卡密系统可以成为统一的**卡密生命周期与核销台账中心**。

### 1.2 原方案需要调整的关键点

原设想整体可行，但不建议让售卖端和核销端长期共享同一个高权限 `api_token`。

推荐改为：

- 同一个租户、卡密产品或项目空间下，创建多个 API 客户端；
- `ldc-shop` 使用“分配/查询”凭据；
- `german-utility-bill-service`、`mt-worker` 使用各自的“验卡/预占/核销”凭据；
- 每个凭据只具有所需的最小权限，可独立吊销和轮换；
- 卡密归属通过 `tenant + program + card` 判断，而不是通过“双方恰好使用同一个 Token”判断。

如果多个系统共享一个 Token，任何一方泄露都会同时获得发卡、验卡、核销和查询权限，无法区分调用来源，也无法只吊销受影响的一方。

### 1.3 推荐的系统边界

通用卡密系统负责：

- 卡密产品、批次、生成、导入和分配；
- 卡密状态、有效期、次数上限和剩余次数；
- 原子预占、提交、释放、过期回收；
- 分配台账、核销台账、审计和状态查询；
- API 客户端、权限、限流、密钥轮换；
- Webhook 或状态同步事件。

业务项目继续负责：

- 支付、订单、退款和发货页面；
- 用户登录、LinuxDo 身份、任务和下载权限；
- “每日额度 +10”“终身额度 +5”“允许生成一张账单”等具体业务含义；
- 本地业务数据和用户可见的处理流程。

不要把所有业务权益也搬进卡密系统。卡密系统应判断“这张卡是否可用、是否已经占用或核销”，消费项目负责“核销成功后具体做什么”。

---

## 二、现有实现评估

### 2.1 `ldc-shop`：售卖与自动补货

主要实现位置：

- `_workers_next/src/lib/card-api.ts`
- `_workers_next/src/actions/checkout.ts`
- `_workers_next/src/lib/order-processing.ts`
- `_workers_next/src/lib/db/schema.ts`

当前流程：

1. 每个商品在 `settings` 表保存 API 地址、启用状态和 Token。
2. `pullOneCardFromApi()` 使用 `GET` 请求外部地址，可携带 Bearer Token。
3. 返回结果允许多种非固定结构，然后从 `cardKey/card/key/code` 等字段猜测卡密。
4. 拉取成功后，将卡密明文插入本地 `cards` 表。
5. 启用配置、管理员手动操作、订单发货成功后，尝试补 1 张卡密。
6. 本地发货通过条件更新完成库存预占和使用标记。

已有优点：

- 本地库存预占使用条件更新，已经关注并发抢占问题；
- 商品维度可独立配置卡密来源；
- 外部 API 调用有超时；
- 本地存在商品与卡密组合唯一索引，能阻止相同卡密重复入库。

当前限制和风险：

1. **外部拉取没有幂等键。** 请求成功但响应丢失时，重试可能从上游再消耗一张新卡。
2. **协议过于宽松。** 使用 `GET` 且猜测多种返回结构，无法形成稳定、可版本化的契约。
3. **只能补 1 张。** 一单一补只能维持理论库存，连续失败后没有目标库存对账与批量追平。
4. **无法查询远端状态。** 本地只知道“是否已发货”，不知道卡密是否已被最终用户核销。
5. **Token 以普通设置值保存。** 当前配置会把 Token 明文写入 `settings`，不适合作为长期共享服务凭据。
6. **退款重新入库存在语义风险。** 当前退款逻辑可把本地卡密重新标记为未使用；若卡密已经交付并在外部核销，重新销售会产生无效卡或重复权益。
7. **卡密明文进入订单、库存和管理页面。** 需要统一脱敏、审计和导出权限。

通用卡密系统能直接解决第 1、2、4、5 项，并为第 3、6、7 项提供统一约束。

### 2.2 `german-utility-bill-service`：额度预占与任务结算

主要实现位置：

- `E:\git\vita\german-utility-bill-service\server\apps\cards\models.py`
- `E:\git\vita\german-utility-bill-service\server\apps\cards\services.py`
- `E:\git\vita\german-utility-bill-service\server\apps\cards\api.py`
- `E:\git\vita\german-utility-bill-service\server\apps\cards\codes.py`

当前流程：

1. 本地生成高熵卡密，保存哈希、前缀以及用于后台分发的明文。
2. 用户凭卡密建立服务端会话。
3. 新建任务前执行原子条件更新，增加 `quota_used`。
4. 同时建立 `CardReservation` 台账。
5. 任务成功时提交预占；失败、取消或过期时释放并退回额度。
6. 幂等键避免同一请求重复扣除额度。
7. 台账可用于重新计算计数器并发现不一致。

已有优点：

- “计数器 + 台账”模型正确，适合迁移为通用系统的核心模型；
- 原子条件更新避免先查后改导致的超用；
- 预占、提交、释放均考虑重复调用；
- 额度耗尽与身份失效被正确区分；
- 卡密输入规范化、哈希校验和限流已有较完整实现。

当前限制和风险：

1. 卡密生命周期与账单业务部署在同一个服务，无法被其他项目直接复用。
2. 卡密模型、会话、任务状态和后台高度耦合，继续扩展会让账单服务承担平台职责。
3. 新卡实际保存了 `code_plain` 供后台复制，数据库或后台权限泄露会暴露全部卡密。
4. 当前没有供外部售卖系统调用的机器接口和 API 客户端权限模型。
5. 历史仅存哈希、没有明文的卡密无法直接迁移到一个只接受明文导入的新系统。

该项目现有的原子预占、幂等和对账逻辑，应成为通用系统设计的主要参考。

### 2.3 `mt-worker`：兑换码与业务额度发放

主要实现位置：

- `E:\git\vita\mt-worker\src\routes\redeem-code-routes.ts`
- `E:\git\vita\mt-worker\src\repositories\redeem-code-repository.ts`
- `E:\git\vita\mt-worker\migrations\0011_redeem_codes.sql`
- `E:\git\vita\mt-worker\test\redeem-code-routes.test.ts`

当前流程：

1. 本地维护批次、兑换码、剩余次数、使用记录和限流桶。
2. 卡密类型分为 `daily` 和 `lifetime`，核销后增加对应用户额度。
3. 唯一索引限制同一卡密被同一用户重复使用，以及不可叠加批次的重复兑换。
4. 先写使用记录，再原子扣减剩余次数，再更新用户额度。
5. 中途失败时通过删除使用记录和恢复剩余次数进行补偿。

已有优点：

- 批次、可叠加策略、用户唯一性和使用台账较完整；
- 剩余次数采用条件更新；
- 已有用户级和 IP 级限流；
- 已覆盖主要路由和冲突分支测试。

当前限制和风险：

1. 卡密明文直接存储、列表、搜索和导出，泄露面较大。
2. 使用记录、次数扣减、业务额度增加是多步操作，当前依赖手工补偿，不是完整事务。
3. `daily/lifetime` 是 `mt-worker` 专用业务语义，不应成为通用卡密系统的固定类型。
4. 管理后台、生成逻辑、兑换逻辑和用户额度逻辑都在同一项目中重复建设。
5. 其他项目无法共享同一张卡的状态或统一审计。

迁移后，通用系统应处理卡密次数和核销唯一性，`mt-worker` 只处理 LinuxDo 用户额度。

---

## 三、可行性判断

| 维度 | 判断 | 说明 |
| --- | --- | --- |
| 业务复用价值 | 高 | 已有三个使用方，且后续仍可能增加。 |
| 技术可行性 | 高 | 三个项目已经分别验证了分配、原子扣减、预占台账和用户限兑。 |
| 迁移复杂度 | 中等 | 最大难点是历史卡迁移、分布式事务和旧接口兼容。 |
| 运维成本 | 中等 | 新服务会成为公共依赖，需要监控、备份、密钥轮换和故障预案。 |
| 安全收益 | 高 | 可统一收口明文、Token、限流、审计和权限。 |
| 一致性收益 | 高 | 统一定义“已分配、已预占、已核销、已耗尽、已停用”。 |
| 单点故障风险 | 中高 | 需要明确降级策略，不能用本地离线核销绕过中心。 |

**最终判断：建议建设，但应作为独立领域服务分阶段落地，不应一次性重写三个项目。**

---

## 四、目标架构

```text
                         ┌──────────────────────────┐
                         │   卡密管理后台 / 管理 API │
                         └─────────────┬────────────┘
                                       │
┌──────────────────┐   分配/查询       │        验卡/预占/提交/释放   ┌────────────────────────┐
│ ldc-shop         │───────────────────┼─────────────────────────────│ german utility service │
│ 支付、订单、发货 │                   │                             │ 会话、任务、下载       │
└──────────────────┘                   ▼                             └────────────────────────┘
                            ┌──────────────────────┐
                            │ 通用卡密服务 API     │
                            │ Auth / Rate Limit    │
                            │ Allocation           │
                            │ Reservation          │
                            │ Redemption Ledger    │
                            └──────────┬───────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  ▼                    ▼                    ▼
          ┌──────────────┐    ┌────────────────┐   ┌────────────────┐
          │ 关系数据库   │    │ 密钥/KMS       │   │ Outbox/Webhook │
          │ 权威状态台账 │    │ 卡密密文/密钥  │   │ 可靠事件投递   │
          └──────────────┘    └────────────────┘   └────────────────┘
                                       ▲
                                       │ 验卡/核销
                              ┌────────┴────────┐
                              │ mt-worker       │
                              │ 用户额度发放    │
                              └─────────────────┘
```

### 4.1 部署形态建议

推荐把卡密系统放在独立仓库、独立数据库和独立域名，例如：

- 仓库：`card-service`
- API：`https://cards.example.com/api/v1`
- 管理后台：`https://cards.example.com/admin`

数据库建议：

1. **长期推荐：PostgreSQL 作为权威存储。** 预占、结算、审计和幂等需要清晰的事务边界，PostgreSQL 的事务、约束和行级并发控制更直接。
2. **可选 MVP：Cloudflare Worker + D1。** 如果请求量较低、团队希望最低运维成本，可继续采用当前项目已经使用的条件更新模式，但必须用事务化批处理或其他串行化机制保证“计数更新 + 台账写入”不可部分成功。
3. 不建议把通用卡密系统直接做进 `german-utility-bill-service` 或 `mt-worker`，否则仍然是业务项目承担平台职责。

首版不需要拆成多个微服务。一个 API 服务、一个后台、一个数据库即可。

---

## 五、核心领域模型

### 5.1 概念定义

| 概念 | 含义 |
| --- | --- |
| Tenant | 租户或业务所有者，用于隔离不同组织的数据。 |
| Application | 接入项目，例如 `ldc-shop`、`bill-service`、`mt-worker`。 |
| API Client | 某个 Application 的机器身份。 |
| Program | 一类卡密产品，例如“账单生成 5 次”“MT 终身额度 +10”。 |
| Batch | Program 下的一次生成或导入批次。 |
| Card | 一张具体卡密及其有效期、次数和状态。 |
| Allocation | 卡密被分配给售卖渠道或订单系统的记录。 |
| Reservation | 一次尚未结算的额度预占。 |
| Redemption | 已提交的最终核销记录。 |
| Event | 卡密状态变化和管理操作的不可变审计记录。 |

### 5.2 状态不要只用一个 `is_used`

通用系统不应继续使用一个布尔值表达全部状态。建议拆分：

卡密管理状态：

- `active`：允许新的分配或核销；
- `disabled`：管理员停用；
- `revoked`：明确作废，不允许恢复；
- `expired`：由有效期派生，也可在查询时计算；
- `exhausted`：由额度派生，不单独手工修改。

分配状态：

- `unallocated`：尚未交给销售渠道；
- `allocated`：已分配给某渠道；
- `acknowledged`：渠道已确认成功接收；
- `cancelled`：分配在交付前被取消。

使用状态通过计数派生：

```text
remaining = usage_limit - usage_held - usage_committed
```

- `usage_held`：正在处理的预占次数；
- `usage_committed`：已最终核销次数；
- 当 `remaining <= 0` 时为 `exhausted`；
- 对一次性卡，`usage_limit = 1`。

这样可以明确区分“已经卖出但尚未兑换”“正在处理”“已最终使用”和“额度耗尽”。

### 5.3 建议数据表

#### `tenants`

- `id`
- `key`
- `name`
- `status`
- `created_at`

#### `applications`

- `id`
- `tenant_id`
- `key`
- `name`
- `status`

#### `api_clients`

- `id`
- `application_id`
- `name`
- `status`
- `allowed_scopes`
- `allowed_program_ids`
- `created_at`

#### `api_keys`

- `id`
- `client_id`
- `key_prefix`
- `secret_hash`
- `expires_at`
- `last_used_at`
- `revoked_at`
- `created_at`

服务端只保存 API Key 哈希和可展示前缀，完整 Key 只在创建时显示一次。

#### `card_programs`

- `id`
- `tenant_id`
- `key`
- `name`
- `code_prefix`
- `default_usage_limit`
- `allocation_policy`
- `redemption_policy`
- `grant_schema_version`
- `grant_payload`
- `status`

`grant_payload` 只描述业务结果，例如：

```json
{
  "type": "mt_lifetime_quota",
  "value": 10
}
```

消费项目必须对 `type` 和结构做白名单校验，不能让卡密系统传入任意字段后直接更新数据库。

#### `card_batches`

- `id`
- `program_id`
- `batch_key`
- `capacity`
- `generated_count`
- `status`
- `valid_from`
- `valid_until`
- `created_by`
- `created_at`

#### `cards`

- `id`：不可预测 UUID；
- `batch_id`
- `code_prefix`
- `code_fingerprint`
- `code_ciphertext`
- `cipher_key_version`
- `status`
- `allocation_status`
- `usage_limit`
- `usage_held`
- `usage_committed`
- `valid_from`
- `valid_until`
- `metadata`
- `created_at`
- `updated_at`

约束：

- `code_fingerprint` 全局或租户内唯一；
- `usage_held >= 0`；
- `usage_committed >= 0`；
- `usage_held + usage_committed <= usage_limit`；
- 状态和时间字段使用数据库约束限制非法值。

#### `card_allocations`

- `id`
- `card_id`
- `client_id`
- `external_ref`
- `idempotency_key`
- `request_hash`
- `status`
- `allocated_at`
- `acknowledged_at`
- `cancelled_at`

唯一约束：

- `(client_id, idempotency_key)` 唯一；
- 单次分配策略下 `card_id` 只能有一个有效 Allocation；
- `external_ref` 可映射 `ldc-shop` 商品、补货任务或订单。

#### `card_reservations`

- `id`
- `card_id`
- `client_id`
- `subject_type`
- `subject_id`
- `business_ref`
- `idempotency_key`
- `units`
- `state`：`held/committed/released/expired`
- `lease_expires_at`
- `created_at`
- `settled_at`
- `settle_reason`

唯一约束按 Program 策略组合，例如：

- `(client_id, idempotency_key)` 唯一；
- 同一卡密、同一用户最多核销一次；
- 不可叠加批次下，同一批次、同一用户最多核销一次。

#### `card_events`

- `id`
- `tenant_id`
- `card_id`
- `event_type`
- `actor_type`
- `actor_id`
- `request_id`
- `idempotency_key`
- `metadata`
- `created_at`

事件只追加、不覆盖，用于审计、对账和问题追踪。

#### `outbox_events`

- `id`
- `event_type`
- `aggregate_id`
- `payload`
- `status`
- `attempt_count`
- `next_attempt_at`
- `created_at`

业务事务与 Outbox 写入同一事务，后台任务负责可靠发送 Webhook。

---

## 六、卡密明文与密码学设计

### 6.1 卡密格式

建议新卡使用可读前缀和去歧义字符集，例如：

```text
CS-7K2M-9XPT-4WQH-8CDE-3NRA
```

要求：

- 随机部分至少约 100 bit 熵；
- 去除 `0/O/1/I/L` 等易混淆字符；
- 输入允许忽略大小写、空格和连字符；
- 前缀只用于识别 Program 或版本，不作为安全边界；
- 可选增加校验位，减少人工录入错误。

### 6.2 数据库存储

为了同时满足“按卡密快速查找”和“分配接口在重试时能返回同一张明文卡”，建议同时保存：

1. `code_fingerprint = HMAC-SHA-256(server_pepper, normalized_code)`，用于唯一索引和快速查找；
2. `code_ciphertext`，使用 AES-GCM 等认证加密保存明文；
3. `cipher_key_version`，支持密钥轮换；
4. `code_prefix`，仅用于日志和后台掩码展示。

不要使用裸 SHA-256 保存低熵或外部导入卡密。数据库泄露后，攻击者可以离线枚举。HMAC 的 Pepper 必须放在 KMS 或运行时 Secret 中，不能与数据库备份放在一起。

默认后台只显示掩码。完整卡密导出、重新显示和批量下载应具有独立权限并写审计。

---

## 七、API 鉴权与权限模型

### 7.1 Token 设计

建议 Token 形态：

```text
cs_live_<key_id>_<random_secret>
```

请求头：

```http
Authorization: Bearer cs_live_xxx_xxx
```

Token 规则：

- 至少 256 bit 随机 Secret；
- 服务端只保存哈希；
- 支持有效期、吊销、最近使用时间和创建来源；
- 允许新旧 Key 短期并存完成无停机轮换；
- 日志不得记录 `Authorization`；
- 客户端必须将 Token 放在 Secret/环境变量中，不放普通数据库设置和前端表单。

### 7.2 推荐 Scope

| Scope | 用途 |
| --- | --- |
| `cards:allocate` | 从允许的 Program 分配卡密。 |
| `cards:read` | 按远端 Card ID 查询状态。 |
| `cards:inspect` | 用卡密明文验证状态。 |
| `redemptions:reserve` | 预占使用次数。 |
| `redemptions:commit` | 提交预占。 |
| `redemptions:release` | 释放预占。 |
| `redemptions:read` | 查询核销记录。 |
| `batches:manage` | 创建批次、生成或导入卡密。 |
| `keys:manage` | 管理机器凭据。 |
| `audit:read` | 查询审计。 |

推荐凭据：

| 项目 | Scope |
| --- | --- |
| `ldc-shop` | `cards:allocate cards:read` |
| `german-utility-bill-service` | `cards:inspect redemptions:reserve redemptions:commit redemptions:release redemptions:read` |
| `mt-worker` | `cards:inspect redemptions:reserve redemptions:commit redemptions:release` |
| 管理后台 | 通过管理员身份授予批次、Key 和审计权限，不复用业务 Token。 |

可选增强：

- 固定出口 IP 白名单；
- Cloudflare Access Service Token；
- 高安全环境使用 mTLS；
- 对请求体增加时间戳和 HMAC 签名，防止代理层重放。

首版在全链路 HTTPS、强随机 Bearer Token、严格幂等和短超时下即可上线，不必一开始同时实现全部增强项。

---

## 八、API 契约建议

所有写接口要求：

- `Idempotency-Key`；
- `X-Request-Id`；
- 固定 JSON Schema；
- 同一个幂等键若请求体不同，返回 `409 idempotency_conflict`；
- 同一个幂等键和相同请求体重复调用，返回第一次的业务结果。

### 8.1 分配卡密

```http
POST /api/v1/allocations
Authorization: Bearer <ldc-shop-token>
Idempotency-Key: restock:product-123:task-20260922-001
Content-Type: application/json
```

```json
{
  "program_key": "bill-service.standard",
  "quantity": 1,
  "external_ref": "ldc-shop:product-123"
}
```

成功响应：

```json
{
  "allocation_id": "all_01K...",
  "status": "allocated",
  "cards": [
    {
      "card_id": "card_01K...",
      "code": "CS-7K2M-9XPT-4WQH-8CDE-3NRA",
      "valid_until": null,
      "usage_limit": 5
    }
  ]
}
```

本地写入成功后确认：

```http
POST /api/v1/allocations/all_01K.../ack
Idempotency-Key: restock:product-123:task-20260922-001:ack
```

若第一次响应丢失，客户端必须使用相同幂等键重试，服务端返回同一个 `allocation_id` 和同一张卡，不能再分配一张。

### 8.2 查询卡密状态

售卖端优先使用分配返回的 `card_id` 查询，不要把卡密明文放到 URL：

```http
GET /api/v1/cards/card_01K.../status
Authorization: Bearer <ldc-shop-token>
```

```json
{
  "card_id": "card_01K...",
  "status": "active",
  "allocation_status": "acknowledged",
  "usage_limit": 5,
  "usage_held": 0,
  "usage_committed": 2,
  "usage_remaining": 3,
  "valid_until": null,
  "updated_at": "2026-09-22T08:00:00Z"
}
```

需要按用户输入验卡时使用请求体：

```http
POST /api/v1/cards/inspect
Authorization: Bearer <consumer-token>
Content-Type: application/json
```

```json
{
  "program_key": "bill-service.standard",
  "code": "CS-7K2M-9XPT-4WQH-8CDE-3NRA"
}
```

不要使用 `GET /verify?code=...`，否则卡密会进入访问日志、代理日志和浏览器历史。

### 8.3 预占

```http
POST /api/v1/redemptions/reserve
Authorization: Bearer <consumer-token>
Idempotency-Key: bill-job:job-uuid
```

```json
{
  "program_key": "bill-service.standard",
  "code": "CS-7K2M-9XPT-4WQH-8CDE-3NRA",
  "subject": {
    "type": "card_session",
    "id": "session-or-user-id"
  },
  "business_ref": "job:job-uuid",
  "units": 1,
  "lease_seconds": 1800
}
```

响应：

```json
{
  "reservation_id": "res_01K...",
  "state": "held",
  "card_id": "card_01K...",
  "usage_remaining_after_hold": 2,
  "lease_expires_at": "2026-09-22T08:30:00Z",
  "grant": {
    "schema_version": 1,
    "type": "bill_generation",
    "value": 1
  }
}
```

### 8.4 提交、释放和续租

```http
POST /api/v1/redemptions/res_01K.../commit
Idempotency-Key: bill-job:job-uuid:commit
```

```http
POST /api/v1/redemptions/res_01K.../release
Idempotency-Key: bill-job:job-uuid:release
```

```json
{
  "reason": "job_failed"
}
```

长任务可续租：

```http
POST /api/v1/redemptions/res_01K.../renew
Idempotency-Key: bill-job:job-uuid:renew:2
```

提交、释放和续租都必须幂等。已提交记录再次提交返回原结果；已释放记录不能再提交，并返回明确冲突状态。

### 8.5 错误格式

```json
{
  "ok": false,
  "error": {
    "code": "card_unavailable",
    "message": "The card is unavailable.",
    "request_id": "req_01K...",
    "retryable": false
  }
}
```

稳定错误码建议：

- `invalid_request`
- `unauthorized`
- `forbidden`
- `program_not_allowed`
- `card_unavailable`
- `card_expired`
- `card_exhausted`
- `reservation_conflict`
- `reservation_expired`
- `idempotency_conflict`
- `rate_limited`
- `temporarily_unavailable`

面向非管理调用方时，不要通过不同错误文案泄露“卡密不存在”和“卡密格式正确但属于其他租户”的区别。

---

## 九、并发、一致性与幂等

### 9.1 分配事务

一次分配必须在一个数据库事务内完成：

1. 检查幂等记录；
2. 锁定或条件更新一张未分配卡；
3. 写入 Allocation；
4. 写入卡密事件；
5. 保存可重放的响应结果；
6. 提交事务。

PostgreSQL 可使用 `SELECT ... FOR UPDATE SKIP LOCKED` 或单条条件更新。D1 方案必须使用能够保证整批原子性的执行方式，不能先改卡状态再单独写台账。

### 9.2 预占事务

预占成功条件：

```text
status = active
当前时间在有效期内
usage_limit - usage_held - usage_committed >= units
Program、Tenant 与客户端权限匹配
用户限兑策略允许
```

在同一事务内：

1. 原子增加 `usage_held`；
2. 插入 `held` Reservation；
3. 写入 Event 和 Outbox；
4. 保存幂等响应。

### 9.3 提交与释放

提交：

- 只有 `held -> committed` 的调用方能够修改计数；
- `usage_held -= units`；
- `usage_committed += units`；
- 重复提交只返回已有结果。

释放：

- 只有 `held -> released/expired` 的调用方能够修改计数；
- `usage_held -= units`；
- 重复释放不重复退额度。

这与 `german-utility-bill-service` 现有的“先改变台账状态，成功改变状态的一方才调整计数”原则一致。

### 9.4 对账

必须提供周期性对账：

- 从 Reservation/Redemption 台账重算每张卡的 `usage_held` 和 `usage_committed`；
- 比较计数器与台账；
- 默认只报警，不自动修复；
- 管理员确认后可执行受审计的修复；
- 对过期 `held` Reservation 执行回收。

---

## 十、三个项目的接入方案

### 10.1 `ldc-shop`

#### 配置调整

商品配置只保存：

- 卡密服务地址；
- `program_key`；
- 是否启用；
- 目标库存 `target_stock`；
- 补货批量上限。

API Token 改为 Worker Secret 或部署环境 Secret，不再保存到普通 `settings` 表，也不在后台回显完整值。

#### 数据表调整

本地 `cards` 建议增加：

- `source`：`manual/card_service/legacy_api`；
- `remote_card_id`；
- `remote_allocation_id`；
- `remote_program_key`；
- `remote_status`；
- `remote_usage_committed`；
- `remote_checked_at`。

`remote_card_id` 建唯一索引。

#### 补货流程

1. 计算 `target_stock - current_available_stock`；
2. 按批量上限调用 Allocation API；
3. 使用补货任务 ID 作为幂等键；
4. 在本地事务中插入所有卡；
5. 插入成功后调用 Allocation Ack；
6. Ack 超时进入重试队列，不重新申请新卡；
7. 定时对账未确认 Allocation 和本地卡记录。

当前“每次成功发货后补 1 张”可保留为触发信号，但实际补货数量应按目标库存计算，而不是固定为 1。

#### 主动查询是否已使用

通过 `remote_card_id` 查询状态，或订阅：

- `card.redemption_held`
- `card.redemption_committed`
- `card.exhausted`
- `card.disabled`

需要明确：

- `ldc-shop` 的“已发货”是销售状态；
- 通用卡密系统的“已核销”是最终消费状态；
- 只有核销项目也接入通用系统，售卖端才能看到真实核销状态。

#### 退款规则

已经向客户展示过的卡密默认不得重新入库销售。退款时：

1. 查询远端核销状态；
2. 若已经预占或核销，拒绝自动回库；
3. 若从未核销，也应根据业务策略决定“作废并补发”或“重新上架”；
4. 推荐默认作废，避免客户已复制但尚未使用的卡再次卖给其他人。

### 10.2 `german-utility-bill-service`

#### 登录与会话

1. `POST /api/v1/card/session` 收到用户卡密；
2. 服务端调用卡密系统 `cards:inspect`；
3. 本地会话只保存远端 `card_id`、安全前缀和必要快照，不保存完整卡密；
4. 新建任务前必须调用远端 `reserve`；
5. 任务成功调用 `commit`；失败、取消调用 `release`；
6. 长任务按需调用 `renew`。

查看历史任务和下载已生成文件，不应因卡密额度耗尽而失效；这一行为继续遵循当前实现。

#### 网络故障策略

- 新登录、新任务预占：失败关闭，不能离线放行；
- 已创建任务的查询和下载：尽量只依赖本地任务授权，不因卡密中心短时故障中断；
- 提交或释放失败：写入本地 Outbox，持续重试；
- 卡密停用的即时性：通过短 TTL 状态缓存和 Webhook 更新，不建议每次轮询任务都同步调用中心。

#### 历史卡迁移

分两类处理：

1. 有 `code_plain` 的卡：可导入中心，保留原卡密、额度和有效期。
2. 只有 Argon2 哈希的历史卡：无法还原明文，也无法直接生成中心的 HMAC Fingerprint。

对第二类卡建议采用过渡期双轨：

- 旧卡继续由本地服务验证和扣额度；
- 新卡全部由中心生成；
- 旧卡自然过期或耗尽后关闭本地验证；
- 不要要求用户重新提交明文完成强制迁移。

### 10.3 `mt-worker`

#### Program 设计

可建立两个 Program：

- `mt.daily-quota`
- `mt.lifetime-quota`

批次的 `grant_payload` 保存类型和值，批次策略保存：

- 是否允许同一用户使用同一卡多次；
- 同一用户是否允许重复使用同批次；
- 单卡总使用次数；
- 有效期和启停状态。

#### 兑换流程

1. 用户提交兑换码；
2. `mt-worker` 做登录态、账号状态和本地限流检查；
3. 调用中心 `reserve`，`subject_id = linuxdo:<ld_user_id>`；
4. 校验返回的 `grant` 类型和值；
5. 本地以 `reservation_id` 为唯一业务键，幂等增加用户额度并写本地权益账本；
6. 调用中心 `commit`；
7. 提交超时则通过本地 Outbox 重试；
8. 本地额度写入失败则调用 `release`。

必须在本地增加唯一约束：同一个 `reservation_id` 只能应用一次额度。否则中心提交重试虽然幂等，本地仍可能重复加额度。

#### 后台迁移

第一阶段可保留当前后台只读展示，数据来自中心 API；生成、导入、启停逐步切换到中心后台。确认迁移稳定后再删除本地 `redeem_codes` 和批次写接口。

---

## 十一、可靠性与故障处理

### 11.1 中心服务不可用时

| 场景 | 策略 |
| --- | --- |
| 商城补货 | 记录失败并重试；已有本地库存仍可继续销售。 |
| 新卡验证 | 失败关闭，返回临时不可用，不能本地猜测通过。 |
| 新预占 | 失败关闭，避免超用。 |
| 提交/释放 | 本地 Outbox 重试，不能改用新的 Reservation。 |
| 状态查询 | 可返回短期缓存并标记 `stale`，不能把旧状态当最终结论。 |
| 已完成业务查询 | 尽量使用本地业务记录，不强依赖中心。 |

不得实现“中心不可用时先本地核销，恢复后再补账”的通用降级。多个项目同时离线核销会产生不可恢复的双花。

### 11.2 客户端重试

- 连接超时：使用相同幂等键重试；
- `429/503`：指数退避并增加随机抖动；
- `400/401/403/409` 非临时错误：不自动无限重试；
- 记录 `request_id`，便于跨服务排查；
- 设置合理的连接和总超时；
- 对中心服务使用断路器，避免故障期间放大请求。

### 11.3 Webhook

Webhook 只用于加速状态同步，不作为权威事务提交方式。

要求：

- HMAC 签名；
- 事件 ID 唯一；
- 消费端幂等；
- 指数退避；
- 管理后台可查看并重放失败事件；
- 最终仍可通过状态 API 对账。

---

## 十二、安全要求

1. 卡密和 Token 不得出现在 URL、普通日志、错误堆栈或分析埋点中。
2. 日志只记录卡密前缀、`card_id`、`request_id` 和错误码。
3. 卡密明文必须加密存储，数据库备份也不得包含可直接使用的明文。
4. 完整卡密显示和导出需要单独权限、二次确认和审计。
5. API Key 使用最小权限，可限制 Program、来源 IP 和有效期。
6. 售卖端、核销端、管理后台不得共享同一个 Key。
7. 所有写操作必须有幂等键和审计事件。
8. 管理员停用、批量导出、密钥创建、密钥吊销属于高风险操作。
9. 对验卡接口按客户端、IP、卡密前缀和失败次数限流。
10. 错误响应避免提供可用于枚举租户和卡密归属的信息。
11. 定期轮换加密密钥、HMAC Pepper 和 API Key；轮换过程必须可回滚。
12. 数据库备份、恢复演练和审计保留周期必须在上线前确定。

---

## 十三、管理后台范围

首版后台应包含：

- Tenant、Application、API Client 管理；
- API Key 创建、吊销、到期和最近使用时间；
- Program 和批次管理；
- 批量生成、CSV 导入、受控导出；
- 卡密状态、分配状态、使用次数和有效期；
- Allocation、Reservation、Redemption 台账；
- 按 `card_id`、前缀、批次、外部业务号查询；
- 手动停用、作废、释放异常预占；
- 对账报告；
- Webhook 投递和重放；
- 审计事件查询。

首版不建议实现：

- 面向最终用户的统一登录门户；
- 支付和订单系统；
- 任意脚本式权益规则；
- 跨项目用户主数据；
- 复杂计费和代理商结算；
- 允许业务项目直接访问中心数据库。

---

## 十四、测试与验收矩阵

### 14.1 单元与数据库测试

- 卡密生成、规范化、Fingerprint 和加解密；
- API Key 校验、Scope、Program 限制和吊销；
- 有效期边界；
- 分配、Ack、取消；
- 预占、提交、释放、续租和自动过期；
- 同一卡密最后一次额度的并发竞争；
- 同一幂等键相同请求重放；
- 同一幂等键不同请求冲突；
- 用户限兑和不可叠加批次；
- 对账发现并修复计数器漂移；
- Webhook 签名和重复事件。

### 14.2 并发验收

至少覆盖：

1. 100 个请求同时分配最后 1 张卡，只有 1 个成功。
2. 100 个请求同时核销剩余 1 次的卡，只有 1 个进入 `held`。
3. 同一预占同时收到提交和释放，最终只能有一个结算状态。
4. 重复提交、重复释放不改变第二次计数。
5. 进程在事务提交前后分别中断，不产生“计数变了但无台账”。

### 14.3 安全验收

- 日志、审计和错误响应中搜索不到完整卡密和 Token；
- 数据库只读泄露不能直接得到可使用卡密；
- `ldc-shop` Token 无法执行核销；
- `mt-worker` Token 无法分配或导出卡密；
- A 租户 Token 无法读取 B 租户卡密；
- 吊销 Token 后立即拒绝；
- 限流和异常枚举行为有审计。

### 14.4 集成验收

- 商城分配响应丢失后重试，不多消耗卡；
- 商城本地插入失败后可使用原幂等键恢复；
- 账单任务成功只扣 1 次，失败完整释放；
- 账单任务超过租期时可续租；
- `mt-worker` 本地额度更新成功、中心提交超时后，重试不会重复加额度；
- 中心不可用时，各项目按预期失败或使用本地已有数据；
- Webhook 丢失后，定时对账仍能恢复状态。

---

## 十五、分阶段实施计划

### 阶段 0：契约确认与风险收口

目标：在编码前冻结核心语义。

- 确认 Tenant、Application、Program 命名；
- 确认一次性卡、多次卡、用户限兑和不可叠加策略；
- 确认“已发货”和“已核销”的不同定义；
- 定义 OpenAPI、错误码和幂等规则；
- 确认数据库、部署位置、域名、备份和密钥管理；
- 建立威胁模型和数据保留规则。

验收产物：OpenAPI 草案、ER 图、状态机、威胁模型、迁移清单。

### 阶段 1：卡密服务 MVP

范围：

- Program、Batch、Card；
- API Client 和 Scope；
- 卡密生成、加密、Fingerprint；
- Allocation + Ack；
- Inspect；
- Reserve/Commit/Release；
- 幂等记录和审计事件；
- 最小管理后台；
- TypeScript、Python 轻量客户端；
- 单元、并发和安全测试。

暂不做复杂代理商、计费和用户门户。

### 阶段 2：先接入 `ldc-shop`

原因：售卖端只需分配和状态查询，迁移风险最低，也能最快验证中心的可用性。

- 新增远端 Card ID 和 Allocation ID；
- 新旧卡源并行；
- 新接口使用幂等补货；
- 增加目标库存和补货对账；
- Token 迁移到 Secret；
- 增加远端状态查询；
- 暂时保留旧任意 URL API 作为兼容模式，设置明确下线日期。

### 阶段 3：接入 `german-utility-bill-service`

- 新卡由中心生成；
- 新任务使用远端预占台账；
- 成功提交、失败释放；
- 增加本地 Outbox；
- 历史卡双轨验证；
- 对比本地和中心额度结果；
- 稳定后关闭本地新卡生成。

该阶段风险最高，应在灰度期间保留清晰回滚开关。

### 阶段 4：接入 `mt-worker`

- 创建 daily/lifetime Program；
- 本地增加 `reservation_id` 唯一权益账本；
- 兑换流程切换为远端预占和提交；
- 本地后台先只读中心数据；
- 迁移历史未使用卡；
- 停止本地生成新码；
- 稳定后归档本地卡密表写路径。

### 阶段 5：运维增强

- Webhook + Outbox；
- 告警、指标、追踪；
- 自动对账和预占回收；
- 密钥轮换工具；
- 备份恢复演练；
- 审计报表；
- SDK 契约测试和版本发布流程。

粗略工作量按一名熟悉现有项目的工程师估算：

| 阶段 | 估算 |
| --- | --- |
| 阶段 0 | 2～4 人日 |
| 阶段 1 | 8～15 人日 |
| 阶段 2 | 3～6 人日 |
| 阶段 3 | 5～10 人日 |
| 阶段 4 | 4～8 人日 |
| 阶段 5 | 4～8 人日 |

总计约 26～51 人日。是否采用 D1、PostgreSQL，是否需要完整管理后台和历史数据清洗，会显著影响工期。

---

## 十六、迁移与回滚原则

1. 先新增中心写入，不立即删除本地旧逻辑。
2. 每个项目都有独立开关：`local/dual/central`。
3. `dual` 阶段以中心为候选结果，本地记录对比差异，不直接双扣。
4. 任何一次业务操作只能有一个权威扣减方，禁止中心和本地同时核销。
5. 历史数据迁移必须保留源 ID、批次、额度、状态和时间。
6. 迁移脚本支持 dry-run、重复执行和差异报告。
7. 回滚时只切换新请求路由，不删除中心已产生的台账。
8. 已经由中心分配或核销的卡，不能回退到本地后重新销售或重复扣减。

---

## 十七、监控与运行指标

建议至少监控：

- API 请求量、成功率、P50/P95/P99 延迟；
- `401/403/409/429/5xx` 数量；
- 分配成功、库存不足、幂等命中；
- 预占、提交、释放、过期数量；
- 长时间 `held` 数量；
- 对账差异数量；
- Webhook 积压和失败次数；
- Token 最近使用、异常来源 IP；
- Program 剩余可分配卡量；
- 数据库连接、锁等待、慢查询、备份状态。

建议目标：

- 所有写接口具备端到端 `request_id`；
- 业务 5xx 触发告警；
- 对账差异大于 0 触发高优先级告警；
- 预占过期回收和 Outbox 投递有独立监控；
- 每次发布能够快速验证分配、预占、提交、释放完整链路。

---

## 十八、主要风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 中心服务成为单点依赖 | 多个项目不能验卡或核销 | 高可用部署、超时重试、Outbox、现有库存可继续销售。 |
| 共享 Token 泄露 | 全部能力同时失守 | 每项目独立凭据、最小 Scope、快速吊销和轮换。 |
| 分布式事务部分成功 | 中心已扣、本地权益未加或相反 | Reserve/Commit/Release、本地唯一业务键、Outbox 重试。 |
| 历史哈希卡无法迁移 | 老用户卡失效 | 双轨验证，旧卡自然退役。 |
| 卡密明文泄露 | 未使用卡被盗 | HMAC Fingerprint、加密存储、脱敏、导出审计。 |
| 状态语义混乱 | 商城把“已卖”误认为“已核销” | 明确 Allocation 与 Redemption 两条状态轴。 |
| 退款后重复销售 | 两个用户拿到同一卡 | 已交付卡默认作废，不自动重新入库。 |
| 幂等实现不完整 | 超时重试重复分配或扣次 | 幂等键唯一、请求哈希、保存首个响应。 |
| 业务权益被任意配置 | 错误修改消费项目数据 | `grant_payload` 版本化，消费端白名单校验。 |
| 迁移一次完成范围过大 | 回滚困难 | 按项目分阶段、兼容开关、先售卖后核销。 |

---

## 十九、建议的最终决策

建议批准建设独立通用卡密系统，并采用以下决策：

1. 卡密系统是卡密状态、次数和核销台账的唯一权威来源。
2. 支付、订单、任务、用户额度等业务状态继续留在各项目。
3. 售卖端和核销端使用同一 Tenant/Program，但使用不同 API Client 和 Token。
4. 首版必须包含 Allocation、Status、Reserve、Commit、Release 和幂等能力。
5. 首版就落实卡密加密、Token 最小权限、日志脱敏和审计，不能以后补。
6. `ldc-shop` 作为第一个接入方，验证分配和主动状态查询。
7. `german-utility-bill-service` 第二个接入，验证预占结算模型。
8. `mt-worker` 第三个接入，验证用户限兑和业务权益发放。
9. 历史卡采用双轨迁移，不强行迁移不可还原的哈希卡。
10. 已交付卡退款后默认作废，不重新进入可售库存。

达到以下条件后，通用系统可以进入正式实施：

- Program 与卡密状态机得到确认；
- API Scope 和每个项目的凭据边界得到确认；
- 数据库与部署方案确定；
- OpenAPI 和幂等规则冻结；
- 历史卡迁移策略得到确认；
- 中心故障时三个项目的行为得到确认；
- 备份、恢复、密钥管理和审计责任人确定。
