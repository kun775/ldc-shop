# LDC Shop 接入通用卡密服务：可行性评估与落地方案

**评估日期：**2026-09-29  
**修订日期：**2026-09-29（**第二版**，依据新版 `docs/API.md`（2026-09-29，619 行）、`api/openapi.yaml`（2025 行）与服务实现逐条复核。中心侧此前识别的 8 项上线前缺陷已在服务提交 `9092c22` 修复，文档在 `9b0ab37`、`2485cb7` 对齐；本版删除已失效的阻断项，并新增 5 项由新语义产生的落地约束，见 §0。第一版修订依据为 `outputs/license-key-service-integration-plan-review-2026-09-29.md`。）  
**范围：**`E:/git/kun775/ldc-shop/_workers_next/`（商城正式代码）与 `E:/git/vita/license-key-service/`（通用卡密服务，复核基线 `master@2485cb7`）；以服务 `docs/API.md`、`api/openapi.yaml` 和当前实现交叉核对。  
**结论：可接入。**“中心生成及分配、商城持有可售库存、售出前回写中心”的库存型方案不变；**中心侧阻断项已消除**，剩余阻断条件集中在商城侧实现、超窗（Ack 窗口）处理与联调验证。仍不建议直接替换现有拉卡 URL，也不建议首期改为支付后实时分配。本报告是静态代码评估，未改动两个项目业务代码，未接入生产实例、签发密钥或完成端到端测试。

## 0. 修订摘要（第二版相对第一版的变化）

### 0.1 原判断已被服务修复，本版相应撤销或改写

| # | 第一版结论 | 复核结果（当前代码/文档） | 本版处置 |
|---|---|---|---|
| ① | 实际错误 `request_id` 在 `error.request_id`，文档写顶层 | 已修复：`internal/infra/http/response/response.go:15-20,104-118` 把 `request_id` 提升到错误信封顶层；API.md §3.2（:94）明确「位于信封**顶层**，调用方应始终从顶层读取」 | 撤销差异；接入方一律从顶层读，仅在响应头可用时做交叉记录 |
| ② | OpenAPI 多处状态枚举漏 `sold`，Sell 复用 Ack 响应体致 `sold` 不在枚举内 | 已修复：状态枚举补齐为 `[allocated, acknowledged, sold, cancelled, expired]`（`api/openapi.yaml:1134,1627,1703`），Sell 改用独立 `SellAllocationResponse`（:1760-1776） | 撤销差异；纳入契约测试用例 |
| ③ | Key Scope 枚举只列 8 项，实现接受 10 项 | 已修复：枚举含 `cards:sell`、`cards:revoke`（:1498-1510），与 `internal/application/admin_provisioning.go:449-453` 一致 | 撤销差异；按 10 项签发 |
| ④ | Allocation 列表 `external_ref` 位置不一致（实现顶层、契约在 `cards.items` 下） | 已修复：`AllocationListItem.external_ref` 在列表项顶层（:1712），实现同样输出在顶层（`internal/adapters/http/allocation_handler.go:250-259`） | 撤销差异；对账直接取 `item.external_ref` |
| ⑤ | Sell 被路由组 `RequireScope("cards:allocate")` 覆盖，只签 `cards:sell` 会 403 | 已修复：`/sell` 单独 `RequireScope("cards:sell")`（`allocation_handler.go:35`），查询类接口改用 `cards:read`（:37-38） | **改写采购清单**：销售 Key 必须同时具备 `cards:allocate`、`cards:sell`、`cards:read` |
| ⑥ | `admin_writer.go` 批量清理无历史引用保护（第一版阻断项） | 已修复：`internal/adapters/persistence/admin_writer.go:73-99` 增加 `card_allocations.card_ids`、`card_reservations`、`card_redemptions`、`redemption_credentials` 及 `usage_held/usage_committed` 保护 | 降为上线前复核项；须以数据库集成测试复现「取消后同键重放」 |
| ⑦ | 30 分钟 Ack 窗口「无实际效力」，Ack 不判过期 | **语义反转**：已修复并新增 `expired` 终态（迁移 `migrations/000004_allocations_expired.up.sql`）。超窗 Ack 返回 `409 allocation_expired` 并内联回收（`allocation_service.go:285-287,324-330,564-582`）；后台 worker 周期回收（`cmd/card-worker/main.go:84-90`，默认间隔 5s，`config.go:103`） | **改写**：窗口现在强制有效，必须把「超窗即失去卡密」纳入补货与交付设计 |
| ⑧ | 服务无条件信任转发头计算限流/审计 IP | 已修复：新增 `TRUSTED_PROXIES` 与 `internal/security/realip`，仅 TCP 对端落在可信网段时才采信转发头，配置非法启动即失败（`config.go:39-42,111-114,119-128`；`.env.example:36-41`） | 改写为部署前置条件：确认服务侧 `TRUSTED_PROXIES` 与实际反代拓扑一致 |

### 0.2 本版新增发现（均为实测，直接影响落地方案）

| # | 事实 | 对商城的影响 |
|---|---|---|
| N1 | `card_allocations` 存在 `UNIQUE(tenant_id, client_id, external_ref)`（`migrations/000001_init_schema.up.sql:156`），该唯一性**不因 `cancelled`/`expired` 而释放**；空值入库写 `NULL`（`allocation_store.go:57` `nullIfEmpty`），故省略 `external_ref` 时不占用唯一值 | 第一版「固定 `external_ref=ldc-shop:restock:<task_id>`」仅在一次性成功时成立。**任何取消或超窗后重新补货必须使用新的 `task_id` 与新 `external_ref`，否则 `409 allocation_conflict`** |
| N2 | 幂等重放「原样返回首次响应，不追随 Allocation 后续状态」（API.md:158），且 `rebuildAllocation` 不校验当前状态（`allocation_service.go:649-692`） | Allocation 已 `expired` 后同键重放仍返回 `status=allocated` 与重建的明文卡密，而该批卡可能已回到池中被其他受领方取走。**重放结果不得直接进入可售库存**，必须先按 `GET /api/v1/allocations/{id}` 核对真实状态 |
| N3 | 列表项不含 `expires_at`（`allocation_handler.go:250-259`、`api/openapi.yaml:1693-1722`）；只有 `GET /allocations/{id}`（`CreateAllocationResponse` 必含 `expires_at`）返回该字段 | 「即将超窗」的对账与告警必须逐条查详情，不能只靠列表驱动补货/Ack 调度 |
| N4 | Revoke 在实现与 OpenAPI 中同时接受 `acknowledged` 与 `sold`（`internal/application/card_revocation.go:40,76`、`internal/adapters/persistence/store.go:140-145`、`openapi.yaml:848`），但 API.md §6.2（:325）正文写「Allocation 状态为 `acknowledged`」 | 退款作废**已交付（`sold`）**卡在实现上可行，第一版的退款策略可保留；文档文字比实现窄，须请服务方对齐，联调以实现/OpenAPI 为准 |
| N5 | 作废要求「卡属于当前 Client」，SQL 以 `a.client_id = $2` 归属校验（`store.go:143-145`）；而 `docs/AUTHORIZATION.md:67` 建议 `cards:revoke` 签给「销售方退款处理 Client」 | 若该「退款处理 Client」是**另一个** Client，Revoke 必然失败。**作废 Key 必须签发在原销售 Client（`ldc-shop`）上**，以独立 Key + 独立 Scope 与分配 Key 隔离，而不是另建 Client |

## 1. 为什么能接，但不能直连现有 GET 拉卡入口

| 环节 | 商城现状 | 通用服务能力（当前实现） | 判断 |
|---|---|---|---|
| 卡源 | `GET` 单次取一张，解析任意 `key/code`，插入本地 `cards`；商品配置在 D1 `settings` | `POST /api/v1/allocations`，必须提供 Bearer Key 与幂等键；返回 `allocation_id`、`program_key`、完整卡集与 `expires_at` | 必须开发独立适配器，原 URL 不能直接替换；响应含 `program_key`，可校验与请求一致 |
| 分配确认 | 无远端确认/台账 | `POST /allocations/{id}/ack`，必须提交完整 `received_card_ids`；**必须在 `expires_at`（默认 30 分钟）内完成**，超窗返回 `409 allocation_expired` 且卡密回池 | 本地持久化后 Ack，但存在硬性时限；超窗必须放弃原分配并作废本地副本（N1） |
| 成交核销资格 | 付款后从本地卡发货；零元自动订单立即发货 | `POST /allocations/{id}/sell`：需**独立的 `cards:sell` Scope**，只允许 Ack 后、且提交原分配完整卡集；仅 `sold` 卡可 Reserve 核销 | **售出成功必须先于向客户展示/邮件交付**；销售 Key 必须同时带 `cards:allocate` |
| 取消及退款 | 待支付订单释放本地预留；已交付退款不重新出售卡 | Cancel 仅限未 Ack 且未展示；已 Ack 不可回到中心可售；已 Ack/已售卡可按规则 Revoke（**不回库存**，N4） | 不可将订单取消映射为 Cancel；退款策略须分状态；Revoke 已覆盖 `sold` |
| 可售库存 | 本地 `cards` 决定下单与展示 | 管理统计 `unallocated_cards` 不是可售承诺；分配时整批原子判断 | 优先维持商城本地库存，定时补货并核对 |

依据：商城 `src/lib/card-api.ts:102-167`（旧 GET）、`src/actions/checkout.ts:223-268`（库存检查）、`src/actions/checkout.ts:306-481`（本地预留）、`src/actions/checkout.ts:509-569`（零元直发）、`src/lib/order-processing.ts:382-525`（付款履约）；服务 `docs/API.md:5-17,120-272,274-329`、`internal/application/allocation_service.go:75-231,247-332,348-417,433-497`。

**关键闭环：**`unallocated → allocated → acknowledged → sold →（核销方）inspect / reserve / commit`，旁路终态 `cancelled` / `expired`。商城只负责销售环节；核销方是**另一个业务集成**，需单独配置 Client/Key、核实 Program 的 `grant` 契约。商城不应替核销方发放权益，也不能把 `acknowledged` 当成已可核销。

## 2. 推荐架构及决策

```
卡密服务（PostgreSQL）: Program/批次/卡密 → Allocation/Ack（30 分钟窗口）→ Sell → Revoke（按退款策略）
                            │ Bearer + HTTPS，服务端调用
                            ↓
商城 Worker（D1）: 商品↔Program 映射 → 补货适配器 → 本地 cards + 远端映射/操作账本
                      ├─ 下单：现有本地预留与库存判断
                      ├─ 支付/零元：远端 Sell 成功 → 本地原子交付 → 展示/邮件
                      ├─ 取消：只释放未交付本地预留，不 Cancel 已 Ack 的库存
                      └─ 退款/对账：按已售、已展示、核销状态决策；失败持续重试
```

选择库存型，是因为商城在下单前即按本地卡逐张预留，并且付费和零元订单有两条不同的交付路径；支付后实时从中心分配将要求重做库存判断、预留、零元直发和支付超时补偿。首期限定 **自动发货、非共享卡、一个商品绑定一个固定 Program**。手动发货、共享卡、同商品混合供应商、跨 Program 混发不进入首期。保留旧通用 GET 供应商为独立模式，互斥启用，逐商品灰度；旧库存可继续售卖但不调用中心 Sell。

**两个需要业务口径的决策：**

1. **已交付退款后是否作废卡。** 建议默认已交付且符合退款政策时以独立 `cards:revoke` Key 作废，并在政策及页面上明确：中心不退回库存；若客户已实际使用权益，退款和作废须先核对核销台账与权益补偿，不能假定 Revoke 可撤销已 Commit 的历史权益。实现上 `sold` 卡可直接作废（N4），文档文字待服务方对齐。未交付但已远端 Sell 的卡也不再出售，按作废或人工审查处理。
2. **超窗（Ack 窗口）策略。** 补货必须在 30 分钟内完成「Allocate → 本地入库 → Ack」全链路；任何一环阻塞超过窗口，该批卡密即回到中心可分配池，本地副本必须作废并换新 `task_id` 重建（N1）。首期建议**小批量、串行、优先 Ack**：单批数量控制在远小于窗口内可处理量，避免一次申请大量卡密却来不及确认。

**唯一需要决策的业务口径是第 1 条；第 2 条是服务语义决定的硬约束，不构成可选项。**

## 3. 具体实施步骤

### 阶段 A｜服务端契约及准入（双仓库）

1. 在卡密服务的管理员端建立 Tenant、Program、批次、销售 Client；**销售 Key 的 Scope 为 `cards:allocate`、`cards:sell`、`cards:read`**，并限定 `allowed_program_ids` 到该 Program（`docs/API.md:587-596`）。漏 `cards:sell` 会让 Sell 返回 `403`，卡永久停在 `acknowledged`。需作废时，在**同一销售 Client** 上另签一把仅含 `cards:revoke` 的 Key（N5；不要新建 Client，否则 Revoke 因归属校验失败）。核销方使用另外的 Client/Key。管理员操作走该服务 OIDC（`lks_admin_session`），不要把管理员 Session/Cookie 放入商城。
2. **（部署前置条件）** 确认服务侧 `TRUSTED_PROXIES` 与真实反代拓扑一致：默认仅信任回环（`127.0.0.1/32,::1/128`），若服务前有网关/容器网络需按实际网段填写，配置非法时服务启动即失败（`config.go:111-114`；`.env.example:36-41`）。商城侧只记录服务返回的 `X-Request-Id` 与错误体，不代服务计算客户端 IP。
3. 验证商城 Worker 到服务 HTTPS 端点的可达性与鉴权；凭据只放 Worker Secret，Base URL 用受控环境配置/固定域名白名单，不由商品管理员输入任意目标。明确限流、单次批量上限（`quantity ≤ 100` 且受 Program 的 `max_batch_allocation_size` 进一步约束）、密钥轮换、部署和故障通报责任。
4. **契约差异已清零（第一版 5 项 + 2 项阻断项均已在 `9092c22` 修复，见 §0.1）**，本阶段只需做契约回归：
   - 用 OpenAPI 生成/校验客户端时，确认状态枚举含 `sold`、`expired`，Sell 使用独立的 `SellAllocationResponse`（`api/openapi.yaml:1760-1776`）；
   - 错误码枚举含 `allocation_expired` 与 `allocation_conflict`（`api/openapi.yaml:1981-2004`），错误信封 `request_id` 在顶层（:2016-2025）；
   - **对账「取消/超窗后同键重放」不再报内部错误**：这是第一版阻断项的回归验证，须以数据库集成测试覆盖（服务已有 `internal/adapters/persistence/admin_integration_test.go` 同类用例，接入前要求出具结果）。
   - 遗留文案项（不阻断、需服务方对齐）：API.md §6.2（:325）称 Revoke 仅接受 `acknowledged`，实现与 OpenAPI 同时接受 `sold`（N4）。
5. 业务请求体为 `additionalProperties: false`，多传字段返回 `400 invalid_request`（`docs/API.md:538`）；适配器只发送契约字段。

### 阶段 B｜商城数据与凭据（`_workers_next/`）

1. 新增商品级供应模式 `local / legacy_get / license_service` 与 `program_key`（尽量固定在服务端管理的商品映射中）；既有商品默认保持原模式。不要复用 `cards_api_token_*`：当前 Token 在 D1 `settings` 明文保存并进入管理端组件与数据导出。中心 API Key 存 Worker Secret，避免传给浏览器、导出、审计元数据。
2. 新增专用 D1 远端映射/操作账本，例如 `card_service_allocations(allocation_id PK, product_id, program_key, external_ref UNIQUE, quantity, state, request_key, expires_at, last_error_code, timestamps)`、`card_service_cards(remote_card_id UNIQUE, local_card_id UNIQUE, allocation_id, order_id, state, sold_at, revoked_at, timestamps)` 和 `card_service_operations(operation_key PK, operation, resource_id, state, next_retry_at, attempts, request_id, timestamps)`。字段示意非最终 DDL；加入 FK/唯一索引前先评估现有卡清理和订单物理删除。
   - **本地必须单独保存 `expires_at`**：服务侧列表接口不返回该字段（N3），超窗调度只能依靠本地记录。
   - 每张远端卡保留不可复用身份与审计映射，不能用 `card_key` 文本去重（商城现允许重复卡）。远端状态独立于商城 `cards.is_used`；商品/订单 ID 作为外部业务引用。
3. 建 **独立**数据库升级项（当前注册表 `0028`～`0037`、schema version 37）；同步 Drizzle schema、结构探针、升级执行器和新旧库初始化/基线，并核验实际 DDL，不能用 `ensure*` 顺手标记 ready，也不能只提升 schema_version 跳过建表。代码入口：`src/lib/db/schema.ts`、`src/lib/db/database-upgrade-registry.ts`、`src/lib/db/queries.ts:254-287,593-661,664-967`。
4. 首期为了复用本地预留与订单展示，卡密仍会进入本地明文 `cards.card_key`/`orders.card_key` 和既有邮件，须显式接受这一安全边界，并控制管理端导出、日志、通知和备份。若要求端到端仅中心保存明文或商城不落明文，必须另立更大范围的交付/展示重构项目，不能宣称本方案已满足。

### 阶段 C｜补货适配器与持久化确认

1. 新建 `src/lib/license-service/` 下结构化 HTTP 客户端、契约校验和幂等键生成器；从环境取固定 HTTPS URL 与 Key；设超时、响应大小上限与错误分类，不记录请求/响应完整体、卡密及 Authorization。只解析 `ok/data` 中的完整 `cards[]`，校验数量、卡 ID 与 key 非空；**可校验响应 `program_key` 与请求一致**（服务在分配与单查响应中均返回该字段，`allocation.go:79-93`），但仍须以发起请求时的受控商品映射为准，不能仅凭响应文本核验 Program 归属。`X-Request-Id` 只追踪，不能代替幂等键；错误追踪 ID 从**顶层** `request_id` 读取（§0.1 ①）。
2. 对每笔补货任务创建**持久稳定**的 `restock_task_id`，固定 `external_ref=ldc-shop:restock:<task_id>`；固定幂等键 `restock:<task_id>:allocate`。**`external_ref` 在同一 Tenant+Client 下终身唯一，`cancelled`/`expired` 的分配仍占用该值（N1）**：任务一旦取消或超窗，必须换新 `task_id` 与新 `external_ref`，不能复用；若确实希望可重放，可省略 `external_ref`（入库为 `NULL`，服务允许重复），代价是只能凭幂等键对账。
   - 幂等键与请求体强绑定：Ack/Sell/Cancel 的请求哈希包含 `allocation_id` 与规范化后的请求体（`allocation_service.go:499-512`），**重试时不得增删字段**（例如首次带 `external_ref`、重试省略），否则返回 `409 idempotency_conflict`。
   - 一个 Allocation 可含 1～100 张且受 Program 更小的配置约束，库存目标按上限分段；**不要默认一单多卡打包成一个 Allocation**，因为 Sell 要求整批卡同时售出。推荐首期每张卡独立 Allocation，虽有调用开销，却能适配不同订单和数量；确需批量补货时必须明确「整批绑定同一订单售出」或扩展服务为按卡 Sell。
3. Allocation 响应成功后，在一次 D1 原子写中插入本地卡、远端 card_id/alloc_id 映射及待 Ack 操作（同时记录服务返回的 `expires_at`）；唯一索引防止网络重试造成重复入库。随后立即以固定 `restock:<task_id>:ack` 调用 Ack，提交**完整** `received_card_ids` 与原 `external_ref`；只有 Ack 成功后才允许本地卡参与可售库存。可采用映射状态筛选库存，或先持久化在不可售暂存表、Ack 后转入 `cards`；**不能先插入可售 `cards` 再裸调用 Ack**，否则并发下单可先买走未确认卡。
4. Ack 失败按同一请求重试，不再新建 Allocation；但**窗口是硬约束（§0.1 ⑦）**：
   - 返回 `409 allocation_expired` 表示窗口已过且卡密已回池，**不得再重试 Ack**，必须把本地副本标记作废/隔离并换新任务重新补货（N1）；
   - 其他可重试错误（`429`/`503`/网络超时）按原键退避重试，但总预算必须显著小于 30 分钟；建议对单任务设超时告警，超过阈值即主动作废本地副本并放弃该分配；
   - 回收由服务后台任务执行（默认轮询 5s，`config.go:103`），并且超窗后的 Ack 会**内联触发同一次回收**（`allocation_service.go:324-330`），因此不存在「再抢一次 Ack 就能拿回卡密」的窗口。
   - **N2 风险**：Allocation 过期后同键重放 Allocate 仍会返回 `status=allocated` 与重建的明文卡密，而卡密可能已被重新分配。**任何重放结果在入可售库存前，必须先用 `GET /api/v1/allocations/{id}` 或 `GET /allocations?external_ref=` 核对真实状态为 `allocated`**；对账口径以查询接口为准，不以重放响应为准。
5. 切换商品前，单独制定补货阈值、目标库存和调度；管理端「拉一张」、启用时补一张、售后补一张是辅助触发，不是可靠补货系统。用受认证的定时任务扫描低水位、`allocated` 未 Ack、`expires_at` 临近、待售出/待作废及未知结果操作。`GET /allocations?external_ref=...` 和 `GET /allocations/{id}` 可对账但**不返回完整卡密**；明文恢复应在服务幂等保留期内以同 Key 重放 Allocate（当前幂等记录保留 30 天，`allocation_service.go:220`）。窗口外不盲目新建任务，转人工核查。

### 阶段 D｜付款、零元订单及“售出先于展示”

1. 保留本地订单预留逻辑，但保证远端卡**未 Ack 时不进入预留/库存 SQL**。支付通知、订单页轮询只能共用 `processOrderFulfillment`（`src/app/api/notify/route.ts:73-110`、`src/actions/order.ts:19-75`），不要另写发货路径。
2. 在履约声明内，根据订单 `cardIds` 找到远端映射；对每张远端卡用固定、与原 Allocation 对应的 `sell:<allocation_id>:<order_id>` 幂等键调用 Sell，body 携带该 Allocation 全部 `card_ids` 与原 `external_ref`。只有**该订单所有远端卡 Sell 均确认成功**，才在 D1 原子批次中标记本地卡已使用、订单 `delivered`、映射售出和交付快照；之后才发通知/邮件。混合本地与远端库存原则上禁止；若允许混合，需要定义交付全有或全无与已 Sell 不可回滚补偿。多张卡 Sell 无跨 Allocation 原子性，部分成功时保持不展示、保留原预留并由对账重试；不要再领新卡。
3. 状态机约束（据 `allocation.CanSell`/错误映射，`allocation.go:52-54`、`internal/adapters/http/errors.go:56-61`）：Sell 仅接受 `acknowledged`；`allocated`、`cancelled`、`expired`、`sold`（非重放）分别返回 `409 allocation_conflict`（`sold` 走幂等重放路径返回原结果），`allocation_expired` 不再单独用于 Sell。因此**履约只能消费已 Ack 的卡**；发现 `allocated` 状态即说明前序 Ack 未完成，须回到阶段 C 处理，不能直接 Sell。
4. 若 Sell 响应丢失，按原键重试/查 Allocation 状态；远端已 `sold` 而本地仍未交付时继续原订单，不再向另一订单分配。若本地原子交付失败，同理保持待交付操作继续补偿。避免「先本地 delivered、再调用 Sell」：客户会先拿到不可核销的卡。处理现有 `processing` 10 分钟租约过期重领、回调重试及已收款但卡不足时的 `paid` 待履约分支；不能让待 Sell 的订单被误认为未支付并取消。
5. **零元自动订单单独改造**：当前 `checkout.ts:509-569` 直接消耗卡、插入 `delivered`，不会经过支付回调。改为先生成持久订单/履约意图并保持不可见，复用同一 Sell→交付函数；所有补偿依据原订单号，不能创建第二单或重复扣积分/券。`orders.card_key` 只能在最终交付态对授权用户开放；现有订单页授权校验保留。

### 阶段 E｜售后、运营及上线

1. 用户/管理员取消 `pending` 时仅释放本地预留，**已 Ack 的中心库存继续归商城管理，不调用 Cancel**；确因本地入库失败且尚未 Ack、未展示时，才按完整卡集调用中心 Cancel。管理员删未售卡要禁止直接删中心映射：Ack 后没有归还可售接口，只能停售/隔离并人工处理。已售卡和远端映射不可随订单物理删除而丢失；检查 `src/actions/admin.ts:382-409`、`src/actions/admin-orders.ts:279-428`、`src/lib/db/queries.ts:3654-3666` 的删除/过期清理。
2. 退款在支付平台成功和本地退款结算后创建独立幂等作废操作；`src/actions/refund.ts:20-135` 清空订单卡密前须保留远端 card_id、Allocation、原订单与作废状态。作废对象为 `acknowledged` 或 `sold` 的卡，作废**不回库存**且会吊销该卡的短期凭证；若该卡仍有 `held` 的 Reservation，**服务不会自动释放**，须由核销方 Release 或等待过期回收（`docs/API.md:322-327`）。远端作废超时不要把它说成已经完成；保持待重试并提示管理员。`src/actions/refund-requests.ts:173-269` 的批准、网关退款与结算为分步操作，应有补偿台账。若未展示但已 Sell，也**不能**再 Cancel 或回到库存；按同一策略作废/隔离。
3. 商品管理端增加 Program 映射、目标库存、连接状态、待 Ack / Sell / Revoke 数和对账失败清单；另需展示**临近 Ack 超窗的分配**（本地记录 `expires_at`，N3）。普通管理员不展示密钥。现有 `markOrderPaid` 只改状态、不自动发货，`markOrderDelivered` 对自动卡要求已有 `cardKey`（`src/actions/admin-orders.ts:53-149`）；远端商品须提供明确的「重试履约」入口，而不是通过手工改状态绕过 Sell。
4. 采用「独立升级项 → 服务端契约回归/密钥与 `TRUSTED_PROXIES` 确认 → 后台补货少量库存 → 单商品灰度 → 超窗与退款演练 → 扩量」的顺序；发布后监控 `已 Ack 未 Sell`、`远端 sold 而本地未 delivered`、`本地 delivered 但远端非 sold`（后者必须为 0）、`expired 但本地仍有可售副本`（必须为 0）、待作废、未知结果与补货耗尽；回滚只关闭**新补货及新销售**，不得删除未完成操作账本、远端库存映射或对已收款订单直接断流。

## 4. 失败情景与验收门槛

| 情景 | 期望结果 |
|---|---|
| Allocate 成功但网络超时 | 同任务原幂等键重放，入库只一份；不换 `external_ref`；重放结果须先核对真实状态再使用（N2） |
| D1 插入失败 / Ack 超时 | 未 Ack 卡不可售；在窗口内继续原 Allocation 重试；**超窗拿到 `allocation_expired` 后作废本地副本、换新 `task_id` 重建（N1）** |
| 一笔订单多卡，仅部分 Sell 成功 | 不交付任何明文；保留原订单及卡归属，原键重试剩余 Sell，不挪给其他订单 |
| 回调并发/声明过期/订单页轮询 | 每卡一次远端 Sell，一笔订单只交付一次，不重复发邮件或权益 |
| 付费或零元订单交付 | 展示时对应远端 Allocation 已 `sold`；零元积分券只扣一次 |
| 未付款取消、已交付退款 | 取消不退回已 Ack 中心库存；按退款规则 Revoke（`acknowledged`/`sold` 均可），不将卡重新上架；`held` 的 Reservation 需另行 Release |
| Sell 时 Allocation 已 `expired`/`cancelled` | 返回 `409 allocation_conflict`；不得交付，转人工/补偿流程，不得新建 Allocation 掩盖 |
| 服务 429/503/断网 | 同键有限重试 + 退避；不能售出时禁止先交付；产生可见异常与可恢复操作 |
| API Key 失效/Program 禁用/库存不足 | 停止自动补货，按稳定错误码（`unauthorized`/`program_not_allowed`/`card_unavailable`）提示运维；不泄露密钥、卡密及内部错误 |
| 错误响应解析 | `request_id` 取**顶层**；`error` 只读 `code/message/retryable`；重试判定依 `retryable` 与 §9 重试规则（`docs/API.md:600-610`） |

**上线阻断条件（第二版，8 条）：**

1. 已交付订单对应服务端非 `sold`；
2. 任何 Ack 前卡能被下单；
3. 没有可运行的定时对账与待操作重试；
4. 未实现「Ack 超窗」分支：本地副本未作废、或复用原 `external_ref` 重建任务（`expired` 后本地仍有可售副本亦视为未通过）；
5. 密钥进入浏览器/导出或任意商品 URL 可请求内网；
6. 零元订单绕过 Sell；
7. 缺少重复回调、超时与**超窗**故障注入测试；
8. 服务侧 `TRUSTED_PROXIES` 与实际反代拓扑未经确认，或 Redis/Worker 未运行（无周期性回收与对账）。

前置验证：先用隔离测试 Tenant/Program/数据库及真实 HTTP 契约测试，并复核服务侧「取消/超窗后同键重放」的数据库集成测试结果（第一版阻断项 ⑥ 的回归证据）；再小流量灰度。本次评估不代表线上联调已通过。

## 5. 实施范围与代码定位汇总

- **服务仓库（基线 `master@2485cb7`）：**
  - 文档与契约：`docs/API.md:5-17`（基本约定）、`:37-59`（幂等键规则）、`:75-94`（响应模型，`request_id` 顶层）、`:96-118`（错误码）、`:120-272`（分配 API，含 `expires_at` 与 `allocation_expired`）、`:274-329`（卡状态与作废）、`:518-598`（管理端与开通顺序）、`:600-619`（重试与兼容性）；`api/openapi.yaml:733-771`（Sell）、`:1498-1510`（Scope 枚举）、`:1573-1645`（分配请求/响应）、`:1693-1722`（列表项，`external_ref` 顶层）、`:1743-1776`（Ack/Sell 响应）、`:1981-2025`（错误体与信封）。
  - 实现：`internal/application/allocation_service.go:75-231`（Allocate，幂等快照与 30 天保留）、`:247-332`（Ack 与超窗内联回收）、`:348-417`（Sell）、`:433-497`（Cancel）、`:528-609`（回收实现与后台入口）、`:649-692`（重放重建）；`internal/domain/allocation/allocation.go:42-93`（状态判定与响应模型）；`internal/adapters/http/allocation_handler.go:31-42`（路由级 Scope）、`:213-259`（列表）；`internal/adapters/http/errors.go:56-61`（分配错误码映射）；`internal/application/card_revocation.go:40-115` 与 `internal/adapters/persistence/store.go:126-147`（作废的状态与归属校验）；`internal/adapters/persistence/admin_writer.go:73-99`（批量清理引用保护）、`:109-200`（单条删除守卫）；`cmd/card-worker/main.go:84-90`（分配超期回收）；`internal/config/config.go:39-42,103,111-128`（`TRUSTED_PROXIES` 与轮询间隔）；`internal/security/realip/realip.go`；`migrations/000004_allocations_expired.up.sql`；`migrations/000001_init_schema.up.sql:156`（`external_ref` 唯一约束）。
- **商城仓库：**`src/lib/card-api.ts:102-167`（旧 GET，保留而不硬改）；`src/lib/db/schema.ts:4-80`、`src/lib/db/database-upgrade-registry.ts:4-65`、`src/lib/db/queries.ts:254-287,593-661,664-967`（升级：结构探针与升级执行器）、`src/lib/db/queries.ts:1280-1361`（数据：商品评分汇总重算，非升级）；`src/actions/checkout.ts:223-268`（库存检查）、`src/actions/checkout.ts:306-481`（本地预留）、`src/actions/checkout.ts:509-569`（零元直发）；`src/lib/order-processing.ts:382-525`（付款履约）；`src/actions/order.ts:19-75`（订单页轮询）、`src/actions/order.ts:77-185`（取消）；`src/actions/refund.ts:20-135`、`src/actions/refund-requests.ts:173-269`（退款）；`src/actions/admin.ts:382-409`、`src/actions/admin-orders.ts:53-149,279-428`（后台操作）。
- **明确不在首期：**核销方 grant 业务解释与权益发放（服务 `docs/API.md:381-450` 为独立对接）；共享卡；重构既有历史明文卡密；跨两个数据库的原子事务。上述事项必须另行建账与补偿，不能凭接口幂等推导出跨服务强一致。
