# 卡密接入与 Worker 资源报告核实及修复任务

- 核实日期：2026-10-03。
- 原报告：`outputs/license-service-and-worker-cpu-review-2026-10-02.md`。
- 商城基线：`dbf093dd392e7219617c6f593f4266d4497e8da0`，目录 `E:/git/kun775/ldc-shop/_workers_next`，以下记为 **L**。
- 中心基线：`ed5a629710a7f5ac30646c734c8625edddcc33ff`，目录 `E:/git/vita/license-key-service`，以下记为 **G**。
- 范围：逐项核实原报告的 19 个编号问题及全站资源判断，制定任务；没有实施业务修复、部署、迁移、清理数据或访问生产 API。
- 证据层级：代码与官方资料可以确认实现和约束；内存 SQLite + 假客户端可以复现局部行为；线上 CPU、超限比例、实际 SQL 执行计划仍待观测。原报告的正面清单不等同于完整安全性证明。

## 1. 结论与必须纠正的前提

**确认存在的首要问题是任务处理量缺少全局边界、对账重复处理，以及物化失败扩散。当前证据不足以认定原报告的两个 P0：默认 cron 必然超限、Next.js SSR 必然无法在 10 ms 内完成。**

### 1.1 资源配额不能混算

2026-10-03 从 Cloudflare 官方文档仓库读取的规则如下，来源见文末 S1–S3：

| 维度 | Free | Paid | 核实结论 |
| --- | --- | --- | --- |
| HTTP CPU | 10 ms | 默认 30 秒，可配置至 5 分钟 | 原报告此项正确 |
| 每分钟 Cron CPU | 10 ms | 30 秒 | 原报告此项正确 |
| Workers 普通子请求 | 50/调用 | 默认 10,000/调用 | 必须区分内部服务类别 |
| Workers 内部服务子请求 | 1,000/调用 | 默认 10,000，随配置 | 原报告漏掉此行 |
| D1 queries per Worker invocation | 50 | 1,000 | D1 自身另有限额，不能用 Paid 的 10,000 替代 |
| D1 单条语句绑定参数 | 100 | 100 | 批量 IN 必须考虑参数分块 |

D1 属于子请求，但不能据此将远端 HTTP、D1、其他内部服务调用全部直接相加，再断言共同扣减一个 50 次计数器。batch 的网络往返数、批内 SQL 条数、D1 配额计数也不是同一个指标；S3 确认一次调用提交多条 SQL 且整批具备事务语义，S2 还规定单条 SQL 的限制在批内照常适用。任务必须分别计数，并在隔离的 Cloudflare 测试环境验证实际限制；本次未完成平台侧配额实验。

原报告 §2.2 的 160–300+ 估计不作为验收依据。它还漏算了 `L/src/lib/license-service/product-client.ts:32` 的按 allocation/card 路由凭据查询，以及 `retry.ts:39` 的最多三次尝试。单条目固定请求数无法覆盖不同卡数、分组、错误分支与重试。

### 1.2 cron 的实际默认值是 1

`L/src/app/api/internal/cron/license-service/route.ts:33` 对缺失参数执行 Number(null)，结果为 0，再夹到 1。`L/worker-entry.mjs:13` 登记的路径没有查询参数。

本地执行原函数体得到：

| 输入 | null（未传） | 空串 | abc | 10 | 50 |
| --- | --- | --- | --- | --- | --- |
| 实际 limit | 1 | 1 | 10 | 10 | 50 |

因此“默认 limit=10，默认每轮必然处理十单”的前提错误。参数默认值本身确有缺陷，但**不能孤立地修成 10 并放大现有负载**，应随任务预算一起处理。

`retryPendingCardServiceDeliveries` 限制的是候选 Sell 待办数，再按订单去重，并非严格十个订单；一个被选中的订单又可能包含多个 allocation。`replenishCardStock({})` 完全不受这个 limit 控制，所有商品仍会被扫描。

### 1.3 原子批次内的 ID 分配不是报告所述并发窗口

`L/src/lib/license-service/restock.ts:419` 在 SQL 内计算 MAX(id)+ROW_NUMBER()，随后插卡；两步经 `database.ts:38` → `db/index.ts:70` 落在同一个 D1 batch 事务内。不存在先在 JavaScript 中读取 MAX、事务外等待、再插卡的窗口，其他普通写入不能在该写事务内部插队。

因此 L-P2-2 的“管理端正常并发加卡会在两条语句间抢走 ID”未成立，不据此改 ID 算法或增加无条件即时重试。真实约束错误、历史脏数据、存储异常仍可能发生，应由物化失败恢复任务处理。源码中同样的推测性注释也应在该任务中澄清。

### 1.4 Allocation 状态和卡状态是不同维度

`G/AGENTS.md:142`、`:162` 区分管理状态与分配状态；`G/migrations/000004_allocations_expired.up.sql:11` 的 allocation 枚举没有 revoked。单张卡作废不意味着同一 allocation 中其余卡都作废。

两端保留 allocation 的 acknowledged/sold、单卡写 revoked，本身不是状态机缺陷。应补契约和边界测试，不能直接给 allocation 加作废终态。原报告引用的 `L/src/lib/license-service/guards.ts:181` 实际查询的是 card_service_cards，并非 allocation 状态。

## 2. 逐项核实：商城侧

所有行号对应上述基线；“属实”指代码行为成立，不代表报告的 CPU 数值或线上影响已经测得。

| 原编号 | 判定 | 核实证据、修正与去向 |
| --- | --- | --- |
| L-P1-1 作废逐卡读写 | 部分属实 | revoke.ts:735,955,1128 确有逐卡写入与串行调用。但 :1041 是远端探测后再次检查管理员清理状态，不能直接复用旧映射替代。F04，保留受控顺序。 |
| L-P1-2 对账两段各用 limit | 属实，已复现 | reconcile.ts:272 将相同 options 传给两段；limit=1 时远端查询失败且本地已超窗的同一 allocation 被查两次。F01 同时解决总预算和同轮去重。 |
| L-P2-1 物化失败向上抛 | 属实，已复现 | restock.ts:650 在 Ack catch 外；replenish.ts:119 无逐商品隔离。注入失败后第二个商品未处理；还会跳过 index.ts:329,341 对本轮已成功商品的聚合重算。F03。 |
| L-P2-2 MAX(id) 并发窗口 | 原因不成立 | SQL 计算和插入处于同一原子批次，见 §1.3。不建立 ID 算法重构任务；普通物化失败归 F03。 |
| L-P2-3 HKDF 每次派生 | 属实，但收益未测 | credentials.ts:12 每次派生；product-client.ts:12 已在单个客户端实例内按商品/Program 缓存 Promise，不能把每次 HTTP 都算成一次解密。跨实例派生去重归 F06。 |
| L-P2-4 请求指纹总是计算 | 属实 | client.ts:259 在发送前计算；:315,328 也把指纹传给其他错误，不只用于 409。F07 延后诊断计算，明确非冲突错误字段变化。 |
| L-P2-5 Sell 预检 2N 次查询 | 属实 | delivery.ts:742 每个 pending group 两条查询。当前补货每次一张，一笔多卡订单可能天然跨多个 allocation，不能假定仅“集群化”才出现。F05。 |
| L-P3-1 allocation 不随作废更新 | 行为属实，不是缺陷 | 卡与 allocation 状态分工正确；删除守卫读卡映射。归 F12，不修改状态枚举。 |
| L-P3-2 面板绕过 db-port | 指控不成立，降级缺口属实 | actions/card-service.ts:176 明确调用 createD1CardServiceDatabase().query()；适配器不负责缺表降级，外层最终返回通用错误。F11 只修语义化错误和查询封装。 |
| L-P3-3 保存凭据的存在性探针 | 行为属实，暂不修 | product-connection.ts:19 属低频管理操作，目的是返回 credential_storage_not_ready。删除会损失错误语义，未证明是瓶颈，不单独优化。 |

## 3. 逐项核实：卡密中心侧

| 原编号 | 判定 | 核实证据、修正与去向 |
| --- | --- | --- |
| G-P1-1 幂等过期不生效、无清理 | 行为属实，建议有风险 | idempotency_repo.go:109 不过滤时间；运行代码未找到清理任务；Save:170 仍靠唯一键和 DO NOTHING 保留首次结果。只改 Get 会读不到旧行却又写不进新行，破坏幂等闭环。报告引用的测试是内存仓储测试，并非 PostgreSQL 过期集成测试。容量/契约问题降为 P2，D01；不能直接按 expires_at 删除。 |
| G-P2-1 每卡审计写入 | 属实，容量优化 | allocation_service.go:173,306,412,550 逐卡审计，event_store.go:113 每次单条 INSERT。具体 9+N 未测；逐卡内容必须保留，F14 批量提交以降低往返。 |
| G-P2-2 EXISTS 缺针对性索引 | 结构属实，瓶颈未证实 | store.go:112,140 用 ANY(card_ids)；现有索引以 tenant/client 开头，不能说完全无索引可用。组合索引、数组表达式或 GIN 需用执行计划证明，单加 GIN 不保证当前 ANY 受益。V02。 |
| G-P2-3 作废不回写分配状态 | 行为属实，不是缺陷 | card_revocation.go:76、store.go:140 按单卡处理，分配状态保留销售历史。F12 补契约，不改枚举。 |
| G-P2-4 Revoke 前置状态文档偏窄 | 属实 | docs/API.md:327 仅写 acknowledged，实现 card_revocation.go:76 允许 acknowledged/sold。F12，无需收窄退款能力。 |
| G-P2-5 进程内按 IP 限流 | 设计限制属实，事故未证实 | ratelimit.go:99 明确是认证前保护层，Client 限流为后续能力。多实例各自计数、共享出口互相影响是风险，未证明商城已触发。V03，不直接删 IP 层或加分布式依赖。 |
| G-P3-1 Sell ResourceID 少前缀 | 属实，当前未造成 Sell 重放失败 | idempotency_repo.go:142 漏 allocation_sell；同一 switch 也未覆盖 card_revoke。F13 按操作类型修正并核对其他写入方。 |
| G-P3-2 Ack/回收竞态错误码 | 属实，静态路径确认 | allocation_service.go:271 先读，:296 条件更新失败直接冲突；回收可在此期间推进到 expired。F15，未做 PostgreSQL 竞态复现。 |
| G-P3-3 Request ID 不校验 | 属实，调整为 P2 | middleware.go:19 接受任意非空值，event_store.go:130 原样写入，000001_init_schema.up.sql:280 限为 VARCHAR(64)。超长值可使需审计事务失败；商城默认 UUID 不触发长度问题。F10，未对真实 PostgreSQL 探测。 |

## 4. 全站资源判断的核实

| 原报告判断 | 判定与任务 |
| --- | --- |
| cron 默认必然超过 50 次 | 不成立：默认值和计数方式有误。无全局上限风险成立，F01。 |
| cleanup 候选订单无 LIMIT | 属实：L/src/lib/db/queries.ts:3894 全量查询，:3917 逐单取消和返积分；卡预留已在循环外合并释放（:3964），不是所有写操作都逐卡执行。F02。 |
| 每 PV 固定 15–20 次 D1 | 只作粗估，不采纳为事实。依登录状态、缓存、初始化、页面和配置而变，V01 计数。普通浏览首页本身不会发送订单邮件，不能直接叠加邮件预算。 |
| dummy 缓存导致全站任何路径都无缓存 | 过度概括。open-next.config.ts:9,23 的后端确为 dummy，但根布局读取 cookies/headers，页面也有 auth；换后端不自动静态化。favicon 有缓存，本地既有 prerender manifest 还列出 /_global-error、/icon.svg。V01。 |
| updateTag 没有产品数据缓存收益 | 本轮核对的首页查询没有匹配的标签缓存读取层；仅发失效通知不会创建缓存。应结合数据边界设计，不能仅替换 dummy，V01。 |
| 动态 import 的 7.4 MB 每 PV 重新加载求值 | 未成立。既有本地产物有动态 import，handler 为 7,676,405 字节，middleware 为 112,344 字节；大小不能证明每个请求重新求值，更不能推导 CPU 下界。这不是已部署版本或本次重建产物。V01 分开测冷/热请求。 |
| SSR 在 Free 下基本不可达，必须升级/重构 | 未证明，不作为 P0。10–20 ms 是官方典型负载范围，不是该站实测；V01 后再决定架构和套餐。 |
| i18n 每次 t() 至少一次动态正则 | 属实：i18n/server.ts:17,40、context.tsx:30,62,81 总传 currencyUnit。F08；不能宣称一定是最高收益项。 |
| auth() 可能已去重 | 本地 next-auth@5.0.0-beta.32 的 lib/index.js:106 每次无参调用进入 getSession；商城 auth.ts:353 直接导出，没有 React cache 包装。@auth/core/lib/actions/session.js:24 解码 JWT；无登录 Cookie 时不发生解密。F09 只对 RSC 只读会话做请求内去重。 |
| header 与 layout 重复读 settings | 属实：queries.ts:2436,2452 为独立缓存，布局读全量、header 读多个键。重复同键已有请求内去重，不能把调用数全算成 SQL。F09。 |
| 登录必读用户、页面串行读、搜索重复 CTE | 属实：queries.ts:3524 SELECT 在心跳判断前，:2845 分别执行 count/page；profile 等有串行读取。减少网络等待主要改善墙钟，未证明是 CPU 首要来源。V04。 |
| stripMarkdown、keep_names/keep_vars 为热点 | 代码形态存在，热点排序未知；不单独重构，V01/V04。 |
| assets-first、初始化实际成本 | 本地配置仅给线索，线上路由/版本未验证；V01。 |

## 5. 已确认问题的修复任务

以下复选框均表示**待实施**。P1 优先于 P2；本轮未确认 P0。每项独立验收，跨仓库任务在对应仓库实施。

### F01 · P1 · 卡密 cron 总预算、去重与公平推进

- [ ] 状态：部分实施（2026-10-03）。已做输入边界与同轮去重；未做分项请求计数、大订单分步进度、平台配额实验（仍属 V01）。
  已实现：`clampCardServiceCronLimit` 对 null、空串、非数字、负数、0 返回 1，合法值夹到 1–10（不再把 `abc` 当成 10）。对账两段共享这一个上限，第二段排除第一段已检查的 allocation。补货增加商品扫描上限、全轮补卡上限，以及 `cursor` / `afterProductId` 轮转；cron 补货使用 `maxProducts=limit`、`maxCards=limit`、`maxPerProduct=1`。
  未实现：交付、作废、对账、补货的远端请求与 D1 调用仍没有统一的剩余预算；单个大订单超过预算时没有持久化分步进度。默认调度路径不带查询参数，因此线上默认仍是每段 1 条，而不是旧代码注释里的 10。
  验证：`replenish.test.ts`、`reconcile.test.ts`、`restock.test.ts`、`cron-wiring.test.ts` 合计 59 通过；`tsc --noEmit` 通过。
- 范围：L 的 cron license-service route、reconcile.ts、replenish.ts、product-config.ts、order-processing.ts、retry.ts 及装配处；确需分入口时才改 worker-entry.mjs。
- 修改：显式处理 null/空值/非法 limit，设保守上限；交付、对账、作废、补货均有界。对账两段共享总条目数并排除已检查 allocation；补货增加商品扫描上限、全轮补卡上限及稳定游标/轮转，避免总从首商品开始。
- 约束：条目不等于请求；计入单订单多 allocation、每卡探测、重试、凭据查询和收尾聚合。耗尽时在安全边界留待下轮，预留持久化额度；不能远端已执行却丢记录。若单个大订单也超预算，需持久化分步进度，最终交付仍全有或全无。
- 验收：limit=1 时对账 checked<=1、同 allocation 每轮最多一次；缺失/空/非数/负数/极大值行为明确。100 商品、多卡订单、故障重试夹具处理量有界且跨轮不饿死尾部；不丢意图、不重复领卡/交付；cron 接线测试通过。

### F02 · P1 · 超时订单清理有界批次

- [x] 状态：已实施（2026-10-03）。未做线上积压观测。
  实现：候选选择与单笔收尾抽到 `src/lib/orders/expired-cleanup.ts`。默认每轮 20，上限 100，按创建时间与订单号排序。名额先给仍为 pending 的超时订单；有剩余才补扫「已取消但仍押着卡」的订单，避免释放失败后只扫 pending 就丢失。返积分继续用 `refund_return:<orderId>`，券释放只匹配 `reserved`，重复执行不重复入账。卡释放按 90 个订单分块。支付竞争仍靠 `status='pending'` 条件更新，只有一个推进有效。
  未实现：返积分失败后的订单如果卡已经释放，下一轮不会再被扫到；这种情况依赖 cron 当轮重试。没有把返积分、券、卡放进同一个事务。
  验证：`expired-cleanup.test.ts` 6 通过；`tsc --noEmit` 通过。生产 SQL 本身未用真实 D1 复跑。
- 范围：L/src/lib/db/queries.ts:3876、cleanup route 及 cancelExpiredOrders 定向调用方。
- 修改：按稳定时间/订单键选有限候选，限定单轮工作量；保留 product/user/order 过滤；卡释放和聚合继续批量，IN 按 100 参数约束分块。
- 约束：状态推进后的返积分、券释放、卡释放不能因停止永久遗漏。预算在完整业务单元间截断；失败要可恢复，不能指望下轮仅扫描 pending 找回已取消的半完成项。
- 验收：积压跨轮处理完整、重复清理不重复返积分；支付/取消竞争仅一个有效推进；返积分/释放步骤失败后能恢复；过滤式调用保持业务约定。

### F03 · P1 · 隔离 Ack 后的物化失败

- [x] 状态：已实施（2026-10-03，仅商城侧代码与内存 SQLite 测试；未部署、未改 ID 算法）。
  实现：`ackAndMaterializeAllocation` 捕获物化批次失败。可恢复错误（存储不可用）按操作队列指数退避保留原 allocation 与 ack key；约束类错误走 `failed`，满 12 次转 `abandoned`，暂存都不删除。落账本身失败时返回 `materialize_failure_unrecorded`，不把原待办改写成已保存。补货与对账按商品/分配隔离，一条失败不吞掉同轮已成功摘要。物化提交后读回失败仍按 `restocked` 返回。MAX(id) 注释改为「同批事务内计算，不存在先读后插的并发窗口」。
  未覆盖：调用方在物化提交后、读回前进程被杀，仍靠既有幂等重放（暂存已空则直接返回已有本地卡）；未新增持久化进度表。
  验证：`restock.test.ts` 17、`replenish.test.ts` 12、`reconcile.test.ts` 11、`discard.test.ts` 65，合计 105 通过；`tsc --noEmit` 通过。
- 范围：L/restock.ts:575、replenish.ts:96、reconcile.ts、index.ts:323（均位于 src/lib/license-service）。
- 修改：区分远端 Ack 与本地物化错误；可恢复失败保留暂存和原 allocation/ack key，写脱敏错误与退避；永久约束错误进入人工复核/有限重试。单商品/分配故障不吞此前成功摘要及聚合。
- 约束：DB 完全不可写时不得伪报已保存错误；报告基础设施失败，靠原持久化意图恢复。不新 Allocate，不把存储错误误判 expired 并删暂存。澄清 MAX 注释，不改 ID 方案。
- 验收：Ack 后注入批次失败，无半成品且暂存/待办保留；下轮原分配恢复不多领；A 成功、B 故障、C 待处理时 A 聚合保留、C 在预算内继续；永久失败不无限重试；物化成功后读取失败也按真实状态恢复。

### F04 · P2 · 安全合并作废写入

- [ ] 状态：待实施；依赖：F01 批次边界。
- 范围：L/src/lib/license-service/revoke.ts:735,955,1113 及 revoke/discard 测试。
- 修改：优先合并无客户端分支的意图/失败写入和小批次等价结果，设置批大小，保持每卡键与错误状态。
- 约束：保留远端前有效映射检查和探测后管理员清理检查；旧快照不能替代 :1041。保持隔离、归属和远端完成后本地失败的恢复能力。
- 验收：多卡缺配置的 D1 往返按块增长；部分成功/失败、响应丢失、探测中管理员清理、其他订单预留等场景正确，不作废错误归属的卡。

### F05 · P2 · 批量 Sell 预检

- [ ] 状态：待实施；依赖：F01 预算策略。
- 范围：L/src/lib/license-service/delivery.ts:728 及测试。
- 修改：批量取得 pending groups 的清理状态和 operation 状态，按参数上限分块，禁止无界 IN。
- 验收：预检查询按块增长；任一组 discarded/abandoned/超次/退避中即阻断 Sell；排序、幂等键、旧计划和人工清理交错保护不变。

### F06 · P2 · 缓存凭据派生密钥

- [x] 状态：已实施（2026-10-03）。
  实现：按解析后的 secret 缓存 HKDF 派生 Promise，最多 4 个。并发调用共享同一次派生；派生失败会移除缓存；secret 变化使用另一个键。缓存的是 CryptoKey，不是商品 API Key 明文。
  验证：`product-credentials.test.ts` 14 通过，含并发一次派生、secret 变化、失败重试。
- 范围：L/src/lib/license-service/credentials.ts:7、product-credentials.test.ts。
- 修改：按实际解析 secret（包含现有三个变量回退）使用有界 Promise 缓存；并发合并、失败移除、secret 改变失效。
- 验收：同 secret 并发只派生一次；变化/缺失/派生失败正确；随机 IV、AAD、旧密文兼容性不变；不全局缓存商品 API Key 明文，不记录 secret。

### F07 · P2 · 冲突时才计算诊断指纹

- [x] 状态：已实施（2026-10-03）。
  实现：请求发送前不再计算指纹。只有响应码是 `idempotency_conflict` 才计算；成功、网络失败和普通错误的 `bodyFingerprint` 为 null。计算抛错时仍抛原来的 HTTP 冲突。
  验证：`client.test.ts` 15 通过。
- 范围：L/src/lib/license-service/client.ts:250、errors.ts、client.test.ts。
- 修改：明确 idempotency_conflict 响应才算指纹，其他错误字段约定为 null；计算失败不能覆盖原 HTTP 错误。
- 验收：成功/网络失败/普通错误不调用 digest；同体不同键序冲突指纹一致；payload、幂等键不变；日志无请求体、卡密和凭据。

### F08 · P2 · 去除翻译的无效正则处理

- [x] 状态：已实施（2026-10-03）。
  实现：服务端与客户端共用 `interpolate.ts`。原文不含 `{{` 时直接返回，不编译正则。占位符用一次全局扫描替换，替换值中的 `$` 与新占位符不再被解释；调用方参数仍覆盖默认 `currencyUnit`。
  验证：`interpolate.test.ts` 2 通过。未做 Worker CPU 微基准。
- 范围：L/src/lib/i18n/server.ts、context.tsx，可抽取两端纯插值函数。
- 修改：无占位符直接返回，避免每参数动态编译正则；每翻译器/渲染周期预解析 currencyUnit，保持参数覆盖顺序。
- 验收：中英文、多/重复占位符、缺参数、数字 0、含 $ 的替换值、SSR/客户端一致；无占位符不创建正则；微基准不冒充 Worker CPU。

### F09 · P2 · SSR 请求内配置和会话去重

- [ ] 状态：待实施；依赖：无。
- 范围：L/src/lib/db/queries.ts:2436、布局/header/footer/i18n、auth.ts 和无参 auth 的 RSC 调用方。
- 修改：SSR 已需全量 settings 时共享请求内快照，单键读取复用；单键 API/写入流程不强制加载全部设置。只对只读 RSC 会话增加请求内缓存，不改变 handlers/signIn/signOut 或带参数 auth。
- 约束：禁止跨用户模块级 session 缓存；不退化设置保存后读取；秘密设置不能随快照进入浏览器。
- 验收：metadata/layout/header 配置去重，header/页面/mobile nav 会话计算去重；不同请求/用户不共享；无 Cookie 不解码 JWT；设置刷新生效，鉴权路由不退化。

### F10 · P2 · 中心 Request ID 规范化

- [ ] 状态：待实施；依赖：无；所属：G。
- 范围：internal/infra/http/middleware/middleware.go:19、中间件测试、API 文档。
- 修改：明确允许字符和最多 64 字符策略；非法值生成新 UUID，不继续传给响应、日志、审计；不扩大数据库字段。
- 验收：空值、UUID、64/65 边界、非法/非 ASCII；响应头、Context、错误信封、审计一致；隔离 PostgreSQL 验证超长输入不因审计长度导致事务失败。

### F11 · P3 · 人工重试的缺表错误语义

- [ ] 状态：待实施；依赖：无；所属：L。
- 范围：src/actions/card-service.ts:170、license-service 查询辅助函数。
- 修改：封装当前已通过 db-port 的 SQL；缺表明确提示存储未就绪，不继续履约；保留 checkAdmin 和脱敏。
- 验收：缺表、非法订单、死信、可重试四类行为明确；缺表不绕过阻断触发 Sell。

### F12 · P2 · 两端 Revoke 与状态维度契约

- [ ] 状态：待实施；依赖：无；所属：两端文档及定向测试。
- 范围：G/docs/API.md:310 与接口注释；L 接入文档、revoke/guards 测试。
- 修改：明确 acknowledged/sold 均可作废；单卡作废不撤销销售/分配历史；解释 allocation 内部分作废及查询返回，GET allocation 不替代单卡查询。
- 验收：已售卡可退款作废、非所属 Client 拒绝；部分作废不影响其余卡；本地守卫按卡终态和待办判断。不新增状态/迁移。

### F13 · P3 · 幂等 ResourceID 前缀完整映射

- [ ] 状态：待实施；依赖：无；所属：G。
- 范围：internal/adapters/persistence/idempotency_repo.go:140 与 ID 转换测试。
- 修改：补 allocation_sell → all，核对 card_revoke → card 等现有 Save 操作，未知操作不猜前缀。
- 验收：已知类型正确、nil 保留；首次/同体重放/异体冲突不变；覆盖 PostgreSQL 仓储转换，不能只测内存仓储。

### F14 · P3 · 批量提交逐卡审计

- [ ] 状态：待实施；依赖：隔离 PostgreSQL 的 SQL 往返基线；所属：G。
- 范围：allocation_service.go 四条审计循环、ports、event_store.go 及测试。
- 修改：一次/分块提交 N 条审计，仍每卡独立 target/request ID/diff，与业务同事务。
- 验收：quantity=1/100、多 allocation 回收的审计行数不变、往返减少；任一审计失败，业务/事件/幂等全回滚，不损失逐卡追踪。

### F15 · P3 · Ack/回收竞争的错误码

- [ ] 状态：待实施；依赖：可丢弃 PostgreSQL 并发环境；所属：G。
- 范围：internal/application/allocation_service.go:296、相关仓储及测试。
- 修改：条件转换失败后核对真实状态，已 expired 返回 allocation_expired；其他状态保持契约和条件更新，禁止无条件推进。
- 验收：同步屏障覆盖 Ack 读后回收、Ack 获胜、双 Ack；无已回收卡复活、重复审计或额外分配，409 分类与文档一致。

## 6. 先设计或测量的任务

这些条目不视为已确认性能事故，不直接授权架构改造、增加依赖或删除数据。

### D01 · P2 · 幂等记录保留与归档契约

- [ ] 状态：待设计；所属：G，需核对各消费者；依赖：保留窗口及旧键语义的业务决定。
- 已确认缺口：expires_at 未参与生命周期治理，记录持续增长，有效窗口未清楚定义。
- 产出：决定 expires_at 是最早归档时间还是语义到期；优先保留旧键不能产生第二次业务操作的语义，评估轻量键/hash/资源台账及响应重建，再决定响应体归档。提供容量监控、限量归档、恢复及回滚方案。
- 验收：长期同体/异体、无 external_ref Allocate、回收后再分配、Sell/Revoke、其他写接口、并发归档都有定义；不得只改 Get 后继续 DO NOTHING，也不得简单删除使旧键再生副作用。
- 语义未决定前仅完善现状文档/容量测量，不改 Get/Save 契约；结构变化和生产清理另行授权。

### V01 · P1 · Worker CPU 与分项请求预算

- [ ] 状态：待观测；所属：L；依赖：部署版本的脱敏数据或获准的隔离环境。
- 记录：首页/购买/订单/后台/两个 cron 的冷与热、匿名与登录、空与积压、多卡、重试；分开 CPU、墙钟、外部 HTTP、D1 调用/SQL 条数、批大小、错误及版本。
- 覆盖：assets 路由、初始化、默认配置、多商品；平台终止未必能进入 catch 或返回业务 JSON，不能说所有超限都返回 route.ts 的 500。
- 验收：p50/p95/p99、超限率、热点、配额实验口径，说明失败截断；数据支持后才选择轻量 cron、分入口、公开内容缓存/静态化或 Paid。缓存不混身份/订单/卡密；R2 后端不自动消除动态渲染需求。

### V02 · P2 · 卡归属 EXISTS 索引收益

- [ ] 状态：待基准；所属：G；依赖：可丢弃 PostgreSQL。
- 按真实分布构造 tenant/client/program/分配量，比较 store.go:112,140 的 EXPLAIN (ANALYZE, BUFFERS)，含大小数据及命中/未命中。
- 验收：证明瓶颈后选择组合索引、表达式或关系表；保持隔离条件。新增索引交付向前/回滚迁移及锁影响，不默认 GIN 优化 = ANY；无收益则关闭。

### V03 · P2 · 共享出口与多实例限流需求

- [ ] 状态：待容量/部署确认；所属：G。
- 用固定 rate/burst、多 Client 共 IP、多 API 实例验证吞吐/429，结合商城三次重试和 Retry-After。
- 验收：足够则明确进程/IP 范围后关闭；需业务配额则保留认证前 IP 层，认证后按可信 tenant/client 设计，明确多实例一致性/故障策略；不使用未经认证头分桶。

### V04 · P3 · 页面数据库与格式处理热点

- [ ] 状态：待剖析；所属：L；依赖：F09 后基线或能区分其成本的测量。
- 比较页面串行依赖、搜索双 CTE、心跳 SELECT、stripMarkdown 相对成本。
- 验收：产出有实际收益的局部任务和前后指标；并行不越鉴权/依赖；心跳不丢建档/资料同步；搜索保持分组、权限、总数及越界分页。未证明热点的项不进入实现。

## 7. 实施顺序与共同边界

1. 先 F03，同时准备 F01/F02 设计与 V01；恢复故障隔离后再扩大处理数量。
2. F01/F02 后回归交付、退款、取消和库存聚合；F04/F05 随预算收敛。
3. F06–F09 独立验收，不能替代 Worker CPU 实测。
4. 中心先 F10/F12；F11/F13/F15 按业务安排，F14 按容量需求；D01/V02/V03 先决策/测量再衍生数据生命周期、迁移和分布式方案。

共同约束：Sell 在本地交付前；退款本地结算及隔离先于远端作废；原幂等键和冻结请求体不变；管理员丢弃、死信、退避、归属守卫不被优化绕过。测试用内存/假客户端或明确可丢弃库。生产测量、发布、迁移、删数据、升级套餐另按授权执行。

## 8. 实际验证与限制

已执行：

- 交叉检查两仓库相关实现、适配层、状态约束与测试；商城开始时仅原报告未跟踪，中心干净。
- L 的 restock.test.ts、reconcile.test.ts、replenish.test.ts：**34/34 通过**。内存 SQLite/假客户端无真实服务访问；仅既有模块类型和 SQLite 实验性提示。
- 执行原 clampLimit 函数体：缺失/空为 1，非法文本反而为 10。
- Ack 成功后注入下一次 write 失败：扫描抛错，Allocate/Ack 各一次，可售 0、暂存 1，第二商品未执行。
- 超窗且 GET 暂不可用、单次尝试、limit=1：checked=2、deferred=2，同 allocation GET 两次。
- 读取 Cloudflare 官方 GitHub 文档。Grok 缺配置、网页直连失败，改官方仓库后取得资料；未改检索配置。

未执行：

- 无线上 CPU/配额观测、压测、真实 Sell/Revoke，不证明线上已超限。
- 未重建/部署 OpenNext；既有本地产物不代表线上版本。
- 未运行中心 PostgreSQL 集成测试、并发竞争或索引基准；Go 侧为静态核实，内存仓储结果不冒充数据库实测。
- 本次仅交付任务文档，所有修复复选框仍未完成。

## 9. 官方资料

以下在 2026-10-03 读取 Cloudflare 自有文档仓库 production 分支，实施前如平台变更应复核：

- S1 Workers limits：https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/limits.mdx
- S2 D1 limits：https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/d1/platform/limits.mdx
- S3 D1 batch：https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/d1/worker-api/d1-database.mdx
