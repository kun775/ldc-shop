# dex 单点登录（OIDC）接入方案

| 项目 | 内容 |
| --- | --- |
| 目标站点 | ldc-shop — https://shop.ikun.day |
| 运行形态 | Cloudflare Workers + D1（OpenNext），代码位于 `_workers_next/` |
| 身份提供方 | dex — https://auth.zkun.de/dex |
| 文档版本 | v1 草案（评审稿，未开始编码） |
| 日期 | 2026-09-18 |
| 适用读者 | 决策者（需就第 12 节拍板）+ 实施工程师 |

---

## 0. 结论摘要

**接入在技术上可行，改动面可控；真正的难点不在协议，而在账号归属与登出语义。**

1. **协议侧无阻塞。** dex 是标准 OIDC 实现：仅授权码模式（`code`）、PKCE `S256`、`RS256` 签名、`client_secret_basic/post` 客户端认证。本站认证栈是 Auth.js v5（`next-auth@5.0.0-beta.32`），其 OIDC 分支底层是 `oauth4webapi@3.8.8`（基于 `fetch` + WebCrypto，非 Node 原生模块），对 Workers 运行时友好。核心改动集中在 `_workers_next/src/lib/auth.ts` 一个文件。
2. **必须建立独立用户命名空间。** 建议 `user_id = dex:<sub>`、`username = dex_<preferred_username>`。这与现有 linuxdo（裸数字 id）、github（`github:` 前缀 + `gh_` 用户名）两套命名空间并行不冲突。
3. **dex 不支持单点登出（硬约束）。** 实测 discovery 文档**不含 `end_session_endpoint`**。用户在本站登出后，dex 侧身份会话仍然保留，再次点击登录会静默直接进入。共享设备场景下这是真实的安全暴露面，需要产品面接受或推动 dex 升级。
4. **最大风险是历史账号不可见。** 老用户改用 dex 登录会得到一个全新的空账号（历史订单、积分、卡密均不可见）。是否需要账号合并必须先拍板 —— 本文给出三条路线与推荐（见 4.2）。
5. **有一个低成本的替代路径值得先考虑。** 如果本次目标是"后台管理员统一走 SSO"，而不是"全体用户换登录方式"，则完全可以绕开账号合并问题（见 4.2 路线 0）。

**建议的执行顺序**：先确认目标受众（第 12 节 Q1）→ 确认账号策略（Q2）→ 再进入编码。若受众为"仅管理员"，整体工作量约为"全体用户"方案的三分之一。

---

## 1. dex 服务实测结果

以下数据于 2026-09-18 通过 `GET https://auth.zkun.de/dex/.well-known/openid-configuration` 与 `GET https://auth.zkun.de/dex/keys` 实际抓取，非文档推测。

### 1.1 Discovery 关键字段

| 字段 | 实测值 | 对本站的含义 |
| --- | --- | --- |
| `issuer` | `https://auth.zkun.de/dex` | 校验时必须**精确匹配**，无尾斜杠 |
| `authorization_endpoint` | `https://auth.zkun.de/dex/auth` | 授权码流程入口 |
| `token_endpoint` | `https://auth.zkun.de/dex/token` | 换取 token |
| `jwks_uri` | `https://auth.zkun.de/dex/keys` | id_token 验签公钥来源 |
| `userinfo_endpoint` | `https://auth.zkun.de/dex/userinfo` | 用户声明来源 |
| `device_authorization_endpoint` | `https://auth.zkun.de/dex/device/code` | 设备码流程，本站不使用 |
| `introspection_endpoint` | `https://auth.zkun.de/dex/token/introspect` | 令牌内省，本站不使用 |
| `response_types_supported` | `["code"]` | 仅授权码模式，与 Auth.js 兼容 |
| `grant_types_supported` | `authorization_code`, `password`, `refresh_token`, `device_code`, `token-exchange` | **不使用 `password`（ROPC）** |
| `id_token_signing_alg_values_supported` | `["RS256"]` | 非对称签名，可离线验签 |
| `code_challenge_methods_supported` | `["S256", "plain"]` | 必须选 `S256` |
| `scopes_supported` | `openid`, `email`, `groups`, `profile`, `offline_access` | 需要 `openid`；`groups` 可选 |
| `token_endpoint_auth_methods_supported` | `client_secret_basic`, `client_secret_post` | **无 `none`** → 必须为机密客户端 |
| `claims_supported` | `iss`, `sub`, `aud`, `iat`, `exp`, `email`, `email_verified`, `locale`, `name`, `preferred_username`, `at_hash` | 不含 `groups`，见下方说明 |
| `end_session_endpoint` | **缺失** | 不支持 RP-Initiated Logout |
| `subject_types_supported` | `["public"]` | `sub` 直接可用，无需成对标识符 |

### 1.2 JWKS 实测

`GET https://auth.zkun.de/dex/keys` 返回 200、521 字节，仅一把 RSA 公钥：

```
kid: cfc441bed0db3f128baaedb44193fbeafa5ce631
kty: RSA | use: sig | alg: RS256 | e: AQAB
```

**含义**：只有一把签名密钥，无密钥轮换历史。密钥轮换时 `kid` 会变化，Auth.js 通过 `jwks_uri` 动态获取，无需我方干预（前提是不要自行缓存 JWKS 到静态文件）。

### 1.3 由实测推导的五条硬性结论

1. **必须使用机密客户端（confidential client）。** `token_endpoint_auth_methods_supported` 不含 `none`，说明 dex 部署不接受公共客户端（无法做纯 PKCE 无密钥的 SPA 流程）。因此 `client_secret` 是必需的，且必须只存在于 Cloudflare Worker Secret 中，绝不能进入前端 bundle。
2. **单点登出不可实现。** 缺 `end_session_endpoint`，OIDC 的 RP-Initiated Logout 协议无法执行。这是 dex 自身的设计（当前主线版本未提供该端点），不是我方配置问题。
3. **`claims_supported` 不含 `groups` 不能作为判断依据。** dex 该字段是服务端硬编码的静态列表，不反映 connector 的实际能力。**是否有 `groups` 必须在运行时实测**（方法见附录 A.3）。这一点直接影响"用组映射管理员"的可行性，不可凭文档下结论。
4. **`offline_access` 不建议申请。** 本站不调用 dex 的任何下游 API，不需要 refresh token；申请它只会扩大令牌泄漏面。
5. **`/dex/` 根路径返回 404 属正常现象**，dex 不提供门户首页，该地址仅供协议端点使用。

---

## 2. 本站现状基线

### 2.1 认证栈

| 项 | 现状 |
| --- | --- |
| 框架 | Auth.js v5（`next-auth@5.0.0-beta.32`，依赖 `@auth/core@0.41.3`） |
| 会话策略 | **JWT**（未配置 adapter，Auth.js 默认走 JWT） |
| 会话载体 | `session.user.{ id, username, trustLevel, avatar_url }` |
| 入口 | `src/lib/auth.ts`（导出 `handlers / signIn / signOut / auth`） |
| 路由 | `src/app/api/auth/[...nextauth]/route.ts`（仅转发 handlers） |
| 登录页 | `src/app/login/page.tsx`（纯客户端组件，两个按钮：GitHub / Linux DO） |
| 鉴权方式 | **无 `middleware.ts`**，全部在 layout / page / server action 中逐个 `await auth()`（全站 47 处） |
| 会话密钥 | `AUTH_SECRET`（回退 `NEXTAUTH_SECRET` → `OAUTH_CLIENT_SECRET`） |
| Host 信任 | `trustHost: true` |

### 2.2 现有 Provider

| Provider | 类型 | 端点来源 | 启用条件 |
| --- | --- | --- | --- |
| `linuxdo` | 自定义 `type: "oauth"` | 硬编码（`connect.linux.do`） | 恒启用 |
| `github` | 内置 `GitHub()` | 内置 | 仅当 `GITHUB_ID` + `GITHUB_SECRET` 均存在 |

> 注意：`src/lib/auth.ts` 第 11–60 行的 `linuxdo` 是**手写 OAuth provider**（显式声明 authorization/token/userinfo，并带一个 `conform` 补丁处理非标准 content-type）。这条路径在本项目已被生产验证 —— 本文把它作为 OIDC 接入失败时的**兜底方案**（见 4.3）。

### 2.3 用户主键命名规范（关键约束）

现有两套命名空间，均硬编码在 `src/lib/auth.ts`：

| Provider | `login_users.user_id` | `login_users.username` |
| --- | --- | --- |
| linuxdo | Linux DO 数字 id 原样，如 `12345` | 原样，如 `alice` |
| github | `github:<login 或稳定 id>`，如 `github:octocat` | `gh_<login>`，如 `gh_octocat` |

相关工具函数（`src/lib/user-profile-link.ts`）：

- `isGitHubUsername()` / `isGitHubUser()`：按 `gh_` 前缀或 `github:` 前缀识别
- `getDisplayUsername()`：github 用户名统一小写并补 `gh_` 前缀；**其他一律原样返回**
- `getExternalProfileUrl()`：github → `https://github.com/<login>`；**其余一律 → `https://linux.do/u/<name>`**
- `getAdminUserProfileUrl()`：站内链接 `/admin/users/<userId>`，与 provider 无关

`getDisplayUsername()` 被后台订单、退款、评价、优惠券、用户列表等 10 处消费；`getExternalProfileUrl()` 仅在 `src/components/admin/users-content.tsx` 使用。

### 2.4 用户记录写入路径

`login_users` 没有"注册"动作，全部是**登录后懒创建**：

| 路径 | 位置 | 特点 |
| --- | --- | --- |
| 主路径 | `src/components/site-header.tsx:29` → `recordLoginUser()`（`src/lib/db/queries.ts:3168`）→ `persistLoginUser()` | 每次渲染站点头部时调用，含 5 分钟心跳节流；仅在字段有变化时 UPDATE |
| 积分路径 | `src/lib/points/ledger-db.ts:403` `ensurePointLedgerUserRecord()` | 签到/积分事件时的兜底 insert，`onConflictDoNothing` |

**推论**：只要用户访问任意带站头的页面，`login_users` 记录就会自动建立。**接入 dex 在数据层不需要新增任何 DDL**（前提是不做账号绑定表）。

### 2.5 管理员判定

`src/lib/admin-auth.ts` 全文只有 4 个函数，逻辑为：

```
isAdminIdentity(user):
  若 ADMIN_USER_IDS 非空 → 命中列表（精确匹配 user.id）才算管理员
  否则                  → 回退按 ADMIN_USERS 用户名匹配（大小写不敏感）
```

后台保护在 `src/app/admin/layout.tsx:17`：`if (!isAdminIdentity(user) || !user?.username) redirect("/")`。

**注意现有设计缺陷（与本次接入同源，建议一并修）**：JWT 会话默认有效期 30 天，管理员在白名单中被移除后，其已签发的 token 仍可通过判定，最长 30 天无法即时回收。

### 2.6 审计

`auth.login` 事件已在 `signIn` 事件回调中记录，`metadata.provider` 字段会带上 provider id。新增 dex 后**自动生效**，无需改造，只需确认后台审计筛选能正确显示 `dex`。

---

## 3. 目标与非目标

### 3.1 本期目标

1. 用户可使用 dex 账号登录本站，身份落入 `login_users`，获得独立且稳定的 `user_id`。
2. 管理员可通过 dex 身份获得后台权限（与现有 `ADMIN_USER_IDS` 机制一致）。
3. 不破坏现有 linuxdo / github 登录的任何行为（含既有用户的 `user_id` 不变）。
4. 登录失败时给出可诊断的友好提示（而非 Auth.js 默认错误页）。
5. 全链路可审计。

### 3.2 本期非目标

| 非目标 | 原因 |
| --- | --- |
| 单点登出（SLO） | dex 不提供 `end_session_endpoint`，协议上不可行 |
| 邮箱自动合并账号 | 存在账号劫持风险，见 4.2 |
| 请求 `refresh_token` / `offline_access` | 本站不调用 dex API，无必要 |
| `password`（ROPC）授权 | 安全性差，仅 dex 兼容保留，不使用 |
| SCIM / 用户生命周期自动同步 | 超出本期范围 |
| 后台"以某用户身份登录"（模拟登录） | 审计与合规风险 |

---

## 4. 关键设计决策

本节是方案的实质内容。每项决策列出候选、对比与推荐。

### 4.1 D1 — 用户命名空间

**决策：新增 `dex:` / `dex_` 命名空间，不改动既有两套。**

| 字段 | 取值 | 理由 |
| --- | --- | --- |
| `user_id` | `dex:<sub>` | dex 的 `sub` 由 `(connectorID, userID)` 派生，跨登录稳定；加前缀避免与 linuxdo 的纯数字 id 碰撞 |
| `username` | `dex_<preferred_username>` | 与 github 的 `gh_` 风格对齐，便于人眼识别来源 |
| `username` 缺失时 | 依次回退 `name` → `email` 的 `@` 前部分 → `sub` 前 8 位 | dex 的 `preferred_username` 取决于 connector，可能为空 |

**为什么不复用裸 `sub`**：linuxdo 用户的 `user_id` 是纯数字（如 `12345`），dex 的 `sub` 在部分 connector 下同样可能是纯数字串，一旦碰撞会直接把两个不同的人合并到同一账号 —— 后果是订单/积分串号。加前缀是零成本的兜底。

**`username` 为什么要加前缀**：`src/lib/user-profile-link.ts` 的 `getDisplayUsername()` 对非 `gh_` 用户名原样透传，后台列表靠这个前缀区分身份来源；同时避免与 linuxdo 用户名重名造成管理员 `ADMIN_USERS` 配置歧义。

### 4.2 D2 — 账号归属策略（**需决策者拍板**）

这是本方案唯一无法由工程手段单独解决的问题。老用户在本站已有身份和数据，dex 是第三套身份源，两者之间没有天然映射。

#### 路线 0：dex 仅用于管理员 SSO（**推荐先评估**）

普通用户继续用 linuxdo / github，dex 按钮只在后台登录入口或对管理员可见。

- **优点**：零账号合并问题（管理员只有几个人，可直接在 dex 侧开户并在 `ADMIN_USER_IDS` 登记）；工作量最小；风险最低；不触碰任何存量用户。
- **缺点**：不满足"全体用户统一身份"的长期目标。
- **适用**：本次诉求实为"后台统一登录"时。

#### 路线 A：独立账号，不合并（**推荐作为全体用户方案的第一步**）

dex 登录直接创建 `dex:<sub>` 新账号，与既有账号互不相干。

- **优点**：实现简单、无安全风险、可独立上线与回滚。
- **缺点**：同一自然人可能出现重复账号，老用户看不到历史订单与积分 —— **必须在登录页/个人中心明确提示**，否则会变成客诉。
- **适用**：dex 面向的是新用户群，或可接受过渡期双账号。

#### 路线 B：按邮箱自动合并（**不建议实施**）

首次 dex 登录时，用 `email` 在 `login_users` 中查找既有账号并合并。

- **致命问题**：dex 侧邮箱是否可自助修改、`email_verified` 是否真实，取决于 dex 的 connector 配置。若邮箱可自改或未验证，攻击者只需把 dex 邮箱改成一个已知老用户的邮箱，即可**直接接管该账号的全部订单与积分**。
- 附带问题：linuxdo 侧的 email 同样未必可信；`login_users.email` 无唯一索引，可能一对多。
- **结论**：除非能在 dex 侧证明邮箱不可自改且强制验证，否则不实施。

#### 路线 C：显式绑定（**推荐作为终态**）

用户先以既有账号登录，在个人中心主动发起"绑定 dex 身份"，完成一次 dex 授权后建立映射。

- **优点**：安全（用户主动、双方已认证）、可审计、可解绑。
- **代价**：需新增映射表与绑定 UI。

建议的数据模型（仅在走路线 C 时才需要）：

```sql
CREATE TABLE IF NOT EXISTS user_identities (
    provider            TEXT NOT NULL,   -- 'dex' | 'linuxdo' | 'github'
    provider_account_id TEXT NOT NULL,   -- dex 的 sub 原值（无前缀）
    user_id             TEXT NOT NULL,   -- 指向 login_users.user_id
    email               TEXT,
    linked_at           INTEGER,
    PRIMARY KEY (provider, provider_account_id)
)
```

**推荐组合**：路线 0 或 A 先上线（视 Q1 而定），路线 C 作为后续增强。路线 B 不实施。

### 4.3 D3 — Provider 实现路径

#### 路径 1（推荐）：Auth.js 通用 OIDC provider

`@auth/core@0.41.3` **已不含内置 Dex provider**（实测：`providers/` 目录下无 `dex.js`，v4 时代的 `Dex()` 已移除），但保留了通用的 `type: "oidc"` 分支，可直接手写 provider 对象：

```ts
providers.push({
    id: "dex",
    name: "DEX SSO",
    type: "oidc",
    issuer: process.env.DEX_ISSUER,          // https://auth.zkun.de/dex
    clientId: process.env.DEX_CLIENT_ID,
    clientSecret: process.env.DEX_CLIENT_SECRET,
    authorization: { params: { scope: "openid profile email" } },
})
```

Auth.js 会自动完成：discovery 拉取、state / nonce / PKCE 生成与校验、id_token 的 RS256 验签（经 `jwks_uri`）、`iss` 与 `aud` 校验、userinfo 调用。

- **优点**：约 15 行代码；安全细节由框架保证，无自研密码学。
- **唯一未验证点**：`oauth4webapi@3.8.8` 在本项目 OpenNext + Workers 产物中的实际运行表现。**证据倾向于可行**（该库基于 `fetch` 与 WebCrypto，无 Node 原生依赖），但本项目尚未实测过 `type: "oidc"` 分支 —— 现有两个 provider 一个是内置 `GitHub()`（同为 OIDC/oauth4webapi 路径，但走内置端点定义），另一个是手写 provider。**验证成本约 30 分钟**，见 8.1。

#### 路径 2（兜底）：手写 OAuth provider

完全仿照 `src/lib/auth.ts` 中的 `linuxdo` 写法，显式声明四个端点：

```ts
{
    id: "dex",
    name: "DEX SSO",
    type: "oauth",
    authorization: { url: "https://auth.zkun.de/dex/auth", params: { scope: "openid profile email" } },
    token: "https://auth.zkun.de/dex/token",
    userinfo: "https://auth.zkun.de/dex/userinfo",
    issuer: "https://auth.zkun.de/dex",
    clientId: process.env.DEX_CLIENT_ID,
    clientSecret: process.env.DEX_CLIENT_SECRET,
    profile(profile) { /* 映射 */ },
}
```

- **优点**：走已被生产验证的代码路径，确定性最高。
- **代价**：id_token **签名不会被校验**（框架仅信任 TLS + userinfo 返回）；需要自行确认 `sub` 的来源与稳定性。
- **切换成本极低**：两条路径改动都在同一处，切换约 10 分钟。

**推荐**：先按路径 1 实现，若 8.1 的验证不通过再切路径 2，两者对上层（jwt/session 回调、命名空间、UI）完全等价。

### 4.4 D4 — 管理员权限映射

| 选项 | 做法 | 评价 |
| --- | --- | --- |
| **ID 白名单（推荐）** | `ADMIN_USER_IDS` 追加 `dex:<sub>` | 与现有设计一致；不可变、可精确回收、无额外代码 |
| 用户名白名单 | `ADMIN_USERS` 追加 `dex_<name>` | 仅在未配置 `ADMIN_USER_IDS` 时生效；用户名可被 dex 侧修改，弱 |
| dex 组映射（可选增强） | 请求 `groups` scope，配置 `DEX_ADMIN_GROUPS`，在 jwt 回调中写入 `token.groups` | 集中管理、可批量授权；但组改名会连带改权限，且 JWT 缓存导致变更最长延迟一个会话周期 |

**推荐**：以 ID 白名单为准。组映射作为可选项保留接口（在 `admin-auth.ts` 增加 `isAdminByIdentityOrGroups()`），但**默认关闭**，且必须等附录 A.3 实测确认 dex 会返回 `groups` 后再评估。

⚠️ 前置条件：需要先完成一次 dex 登录、从 `login_users` 中读出实际的 `user_id`（形如 `dex:ChExampleSub`），才能填入 `ADMIN_USER_IDS`。这一步无法预先猜测。

### 4.5 D5 — 登出语义（硬约束）

由于 dex 无 `end_session_endpoint`：

- 本站 `signOut()` 只清除本站的 Auth.js 会话 Cookie。
- dex 侧的 SSO 会话（dex 域名下的 Cookie）**仍然有效**。
- 用户再次点击"使用 DEX 登录"时，dex 会识别到已有会话，**无交互直接跳回**并重新登录本站。

**风险等级**：共享设备（网吧、办公室共用机、演示机）上，"登出"给用户的安全感与实际不符。

**缓解措施（建议全部采纳）**：

1. 登出按钮旁增加一行说明文案（i18n key 新增），提示"如需完全退出，请同时关闭 DEX 登录会话"。
2. 为 dex 用户配置更短的会话有效期（`session.maxAge` 按 provider 区分较难实现，可整体下调，需评估对 linuxdo 用户的影响）。
3. 在个人中心提供指向 dex 的链接，引导用户自行结束 dex 会话。

**不建议**：伪造一个 `/dex/logout` 跳转 —— 该端点不存在，会造成 404 并误导用户。

### 4.6 D6 — 与现有登录方式的并存策略

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| 并存（默认） | 登录页三个按钮：DEX / Linux DO / GitHub | 渐进推广期 |
| 置顶推荐 | DEX 按钮排第一并高亮，其余降为次要样式 | 引导迁移期 |
| 仅 DEX | 隐藏其余按钮 | 全面切换后 |

**推荐**：并存 + DEX 置顶。通过 `DEX_ENABLED` 控制显隐，为将来"仅 DEX"留开关。

> 提示：本项目已有网站品牌与用户来源绑定（`getExternalProfileUrl` 默认把非 GitHub 用户指向 linux.do；页头品牌名取 `getAdminUsernames()[0]`）。切换登录入口前建议先确认品牌展示逻辑不受影响。

---

## 5. 数据模型变更

| 阶段 | 变更 | 说明 |
| --- | --- | --- |
| 路线 0 / A（推荐首期） | **无** | 复用 `login_users`；`user_id` 为 TEXT 主键，`dex:<sub>` 天然兼容 |
| 路线 C（绑定，后续） | 新增 `user_identities` 表 + 一个数据库升级项 | 需在 `src/lib/db/database-upgrades.ts` 新增**独立升级项** |
| 可选增强 | 新增 `login_users.auth_provider` 列（记录来源）、`login_users`.`email_verified` 列 | 便于后台筛选与风控 |

**若新增任何列/表，必须遵守本项目既有铁律**（见 `_workers_next/docs/` 与项目约定）：

- 新增独立升级项，ID 唯一递增不可复用，**不得**把所有 DDL 堆进一个全量升级函数。
- `ensure*` 每 isolate 无条件执行幂等 DDL（`CREATE TABLE/INDEX IF NOT EXISTS` + `safeAddColumn`），版本号只用于"是否写入标记"。
- 禁止"版本号达标就跳过 DDL"。
- 结构探测字段必须对应真实 schema 并补测试。

---

## 6. 环境变量与密钥

### 6.1 新增变量

| 变量 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `DEX_ISSUER` | Text | 是 | `https://auth.zkun.de/dex`（无尾斜杠） |
| `DEX_CLIENT_ID` | Text | 是 | dex 侧 `staticClients[].id` |
| `DEX_CLIENT_SECRET` | **Secret** | 是 | 必须用 Worker Secret，禁止写入 `wrangler.json` |
| `DEX_ENABLED` | Text | 否 | `'true'` 显示登录按钮；缺省视为按 secret 是否齐全自动判断 |
| `DEX_ADMIN_GROUPS` | Text | 否 | 逗号分隔的组名白名单，默认空（即关闭组映射） |

### 6.2 需要修改的既有变量

| 变量 | 变更 |
| --- | --- |
| `ADMIN_USER_IDS` | 追加 `dex:<sub>`（**必须先完成一次 dex 登录拿到实际 `sub`**） |

### 6.3 密钥安全要求

1. `DEX_CLIENT_SECRET` 只以 Cloudflare Worker Secret 形式存在。**注意 `wrangler.json` 已开启 `keep_vars: true`**，切勿把密钥写进该文件的 `vars`。
2. 本仓库无 `.gitattributes` 且 `core.autocrlf=true`，`.env*` 已在 `.gitignore` 中 —— 本地验证若用 `.env.local`，确认不会被提交。
3. 密钥生成建议 ≥ 32 字节随机（`openssl rand -base64 32`）。
4. **区分 Text 与 Secret 的既有教训**：`NEXT_PUBLIC_APP_URL` 因构建期需要必须为 Text。`DEX_*` 均为服务端运行时读取（与现有 `GITHUB_ID` 同模式），Secret 类型可用；但为便于线上排障，`DEX_ISSUER` / `DEX_CLIENT_ID` 建议用 Text。

---

## 7. dex 侧配置（需在 dex 服务器执行）

### 7.1 注册 static client

在 dex 的 `config.yaml` 中新增：

```yaml
staticClients:
  - id: ldc-shop
    name: 'LDC Shop'
    secret: '<生成的密钥，或 bcrypt hash>'
    redirectURIs:
      - 'https://shop.ikun.day/api/auth/callback/dex'
      - 'http://localhost:3000/api/auth/callback/dex'
```

说明：

- `secret` 支持明文或 bcrypt hash（以 `$2` 开头时按 bcrypt 校验）。建议使用 hash。
- **`redirectURIs` 必须精确匹配**，dex 不做通配。多一个斜杠、大小写不同都会导致授权失败。
- 如果后台还要通过 `*.workers.dev` 预览域名访问，需要把该域名的回调地址一并登记，否则预览环境无法登录。

### 7.2 建议同时确认的开关

| 配置项 | 建议 | 理由 |
| --- | --- | --- |
| `skipApprovalScreen` | `true` | 否则每次登录都会展示一次授权同意页 |
| connector 列表 | 按需精简 | connector 数量决定用户在 dex 侧需要点击的步骤数 |
| 邮箱是否可自助修改 | **确认并记录** | 直接决定 4.2 路线 B 是否有讨论余地 |
| `email` claim 是否验证 | **确认并记录** | 同上 |

**这些是决定方案走向的信息，建议在编码前一次性确认并回填到本文档。**

---

## 8. 代码改动清单

### 8.1 阶段 1：基础接入（可上线的最小闭环）

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/lib/auth.ts` | ① 新增 `dex` provider（路径 1 写法），仅在 `DEX_CLIENT_ID` + `DEX_CLIENT_SECRET` 齐全时注册，缺失时 `console.warn` 并跳过（与现有 GitHub 模式一致）；② `jwt` 回调新增 `account.provider === "dex"` 分支，置 `resolvedId = "dex:" + sub`、`resolvedUsername = "dex_" + preferred_username`；③ 校验 `sub` 缺失时 `throw`（不可静默降级） | **高** —— 唯一必须一次做对的文件 |
| `src/app/login/page.tsx` | 新增 DEX 登录按钮（`signIn("dex", { callbackUrl })`），受 `DEX_ENABLED` 控制 | 低。当前为纯客户端组件，若要读取 `DEX_ENABLED` 需拆出 Server Component 外壳或改用 `/api/auth/providers` |
| `src/locales/zh.json` / `en.json` | 新增文案 key：按钮名、失败提示、登出说明 | 低 |
| `src/lib/user-profile-link.ts` | `getExternalProfileUrl()` 增加 dex 分支，**返回 `null` 而非默认指向 linux.do**（否则 `dex_alice` 会被误链到 `https://linux.do/u/dex_alice`） | 中，影响后台外链 |
| `src/lib/user-profile-link.test.ts` | 补充 dex 用例断言 | 低 |
| `src/app/login/page.tsx` + `src/lib/auth.ts` 的 `pages` | 配置 `pages.error = "/login"`，并在登录页展示 `?error=` 的友好提示 | 低。dex 引入的失败模式更多（discovery 不可达、secret 错误、redirect_uri 未登记），默认错误页不可接受 |

**`jwt` 回调的 dex 分支伪代码**：

```
} else if (account?.provider === "dex") {
    const sub = normalizeAuthScalar((profile as any)?.sub)
    if (!sub) throw new Error("DEX_SUB_MISSING")
    resolvedId = `dex:${sub}`

    const rawUsername = (profile as any)?.preferred_username
        ?? (profile as any)?.name
        ?? (profile as any)?.email?.split("@")[0]
    const safeUsername = normalizeAuthScrub(rawUsername)   // 小写、去非法字符
    resolvedUsername = safeUsername ? `dex_${safeUsername}` : null
    // 可选：token.groups = (profile as any)?.groups ?? []
}
```

> 注意：`profile` 里可用的字段取决于 Auth.js 的 OIDC 默认 profile 解析（id_token claims + userinfo 合并）。建议实施时**先把完整 profile 打到日志确认字段实际形态**，不要直接按文档字段名编写。

### 8.2 阶段 2：管理员接入

| 文件 | 改动 |
| --- | --- |
| Cloudflare 环境变量 | `ADMIN_USER_IDS` 追加 `dex:<sub>` |
| `src/lib/admin-auth.ts` | 如需组映射：新增 `isAdminByIdentityOrGroups()`；建议保留 ID 白名单为唯一权威 |
| `src/types/next-auth.d.ts` | 若透传 `groups`，需扩展 `Session` / `User` / `JWT` 三个接口 |
| 后台审计页 | 确认 `provider = dex` 可正常筛选（预期无需改代码） |

### 8.3 阶段 3（可选）：账号绑定（路线 C）

新增 `user_identities` 表 + 升级项 + 个人中心绑定/解绑 UI + 解绑时的数据归属处理（解绑不能删除主账号）。

### 8.4 明确不需要改动的部分

- `src/app/api/auth/[...nextauth]/route.ts` —— 泛型转发，自动包含新 provider。
- 全部 47 处 `await auth()` 调用 —— `session.user.id` 的值变化对调用方透明。
- `recordLoginUser()` / `persistLoginUser()` —— 已 provider 无关。
- 审计模块 —— `metadata.provider` 已自动携带。

---

## 9. 分阶段实施计划

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0 前置** | 决策者确认第 12 节 Q1–Q4；dex 侧建 client；确认 connector / 邮箱策略 | 拿到 `client_id` / `client_secret` / `redirect_uri` 登记完成 |
| **P1 本地验证** | 路径 1 可行性验证（本地 `next dev` 走通 dex 登录） | 本地登录成功且 `login_users` 出现 `dex:*` 行 |
| **P2 实现** | 8.1 全部改动 + 类型检查 + 单测 | `typecheck` / `lint` / `test` 全绿 |
| **P3 生产验证** | 推 main 自动部署（Cloudflare Git 集成），线上点一次 dex 登录 | 线上登录成功；既有 provider 不受影响 |
| **P4 管理员** | 取 `sub` → 配置 `ADMIN_USER_IDS` → 验证后台可进 | 管理员能进 `/admin`，非管理员被重定向 |
| **P5（可选）** | 账号绑定 | 视 Q2 结论 |

### 9.1 上线方式与验证要点

- **本项目推 main 即自动部署**（Cloudflare 侧 Git 集成），不要手工 `wrangler deploy`（本地 `.open-next/` 是旧产物）。
- 部署后按既有方法核验：抓首页 HTML 中的 `/_next/static/chunks/<hash>.js`，比对 HTTP 200 与本地 `md5sum`。
- 生产构建验证命令（须直调，`npx` 在沙箱内会被拦）：
  ```
  NEXT_DIST_DIR=.next-verify node node_modules/next/dist/bin/next build --webpack
  ```
  构建后**记得删除 `tsconfig.json` 中被自动追加的 include 项**。

---

## 10. 验收标准

**功能**

- [ ] 未登录用户可在登录页看到 DEX 按钮，点击后跳转 `https://auth.zkun.de/dex/auth?...`，参数含 `client_id` / `redirect_uri` / `state` / `code_challenge` / `code_challenge_method=S256`。
- [ ] 授权后回调 `/api/auth/callback/dex` 成功，用户进入已登录状态。
- [ ] `login_users` 出现 `user_id = dex:<sub>` 的行，`username` 为 `dex_*`。
- [ ] 同一 dex 账号重复登录，`user_id` 保持稳定不变。
- [ ] `ADMIN_USER_IDS` 配置该 `user_id` 后可进入 `/admin`；未配置时访问 `/admin` 被重定向到 `/`。
- [ ] 后台审计事件列表可看到 `provider = dex` 的 `auth.login` 记录。

**兼容性**

- [ ] linuxdo 用户登录后 `user_id` 与登录前完全一致（无迁移、无副作用）。
- [ ] github 用户同上。
- [ ] `DEX_ENABLED=false` 或密钥缺失时，登录页不显示 DEX 按钮，其余登录方式正常。
- [ ] 后台订单/退款/评价列表的用户名展示对 dex 用户正确（显示 `dex_*`，外链不错误指向 linux.do）。

**工程**

- [ ] `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 通过。
- [ ] `node --test "src/lib/**/*.test.ts"` 通过。
- [ ] `tsconfig.json` 无残留的 `<distDir>/types/**/*.ts` include 项。

**失败路径**

- [ ] `redirect_uri` 未登记时，用户看到友好错误提示而非原始堆栈。
- [ ] dex 服务不可达时，其余登录方式不受影响。

---

## 11. 安全评估

| # | 风险 | 级别 | 缓解 |
| --- | --- | --- | --- |
| 1 | `client_secret` 泄漏 | 高 | 仅存 Worker Secret；不入库、不入前端；`wrangler.json` 保持无密钥 |
| 2 | 账号劫持（若实施路线 B） | **严重** | 不实施邮箱自动合并 |
| 3 | 共享设备登出错觉 | 中 | 登出提示文案 + 缩短 maxAge + 引导至 dex（见 4.5） |
| 4 | 开放重定向 | 中 | dex 侧精确登记 `redirectURIs`，禁止通配；Auth.js 已校验 state |
| 5 | `iss` / `aud` 校验缺失 | 中 | 路径 1 由框架强制校验；若走路径 2 需自行确认 |
| 6 | 管理员权限回收延迟 | 中 | 现存的 JWT 30 天缓存问题。建议本次一并改为管理员判定实时查库或缩短会话 |
| 7 | 用户名与 linuxdo 撞名 | 低 | `dex_` 前缀隔离；`ADMIN_USERS` 配置需带前缀 |
| 8 | JWKS 轮换 | 低 | 走 `jwks_uri` 动态获取，不落静态文件 |
| 9 | `email` 被用作风控依据 | 中 | 在 dex 侧确认 `email_verified` 语义前，不将 email 用于权限或合并决策 |
| 10 | 错误信息泄漏 | 低 | 遵循 `src/lib/errors/safe-error.ts` 约定：服务端日志留存完整错误，前端只给稳定 i18n key + `errorId` |

**特别提示**：`Server Action` 的返回值不会被 Next.js 脱敏，只有 `throw` 才会。若在登录路径新增任何错误返回，务必使用既有 `safe-error.ts` 工具，不要 `return { error: e.message }`。

---

## 12. 待确认事项（阻塞编码）

| # | 问题 | 影响 | 建议默认 |
| --- | --- | --- | --- |
| **Q1** | dex 登录面向**全体用户**还是**仅后台管理员**？ | 决定是否要处理账号合并 —— 最大工作量分水岭 | 若为后者，直接走路线 0，工作量约为前者 1/3 |
| **Q2** | 老用户的账号归属走哪条路线？（0 / A / C） | 决定数据模型与 UI 改动 | 路线 A 起步 |
| **Q3** | 是否保留 linuxdo / github 登录？ | 决定登录页与品牌展示改动 | 保留，DEX 置顶 |
| **Q4** | dex 侧的 connector 类型是什么？邮箱是否可自助修改、是否强制验证？ | 决定路线 B 是否可讨论、`groups` 是否可用 | 待回填 |
| **Q5** | 是否接受"无法单点登出"？（dex 未提供 `end_session_endpoint`） | 影响产品文案与用户预期 | 接受 + 加提示文案 |
| **Q6** | 预览域名（`*.workers.dev`）是否需要支持 dex 登录？ | 决定 dex 侧 redirectURIs 登记范围 | 需要则一并登记 |
| **Q7** | 是否需要借本次改动一并修复"管理员权限回收延迟"（第 11 节 #6）？ | 独立但同源 | 建议一并修 |

---

## 附录 A：实测命令与原始数据

### A.1 抓取 discovery

```bash
curl -s https://auth.zkun.de/dex/.well-known/openid-configuration
```

### A.2 抓取 JWKS

```bash
curl -s https://auth.zkun.de/dex/keys
```

返回 `kid=cfc441bed0db3f128baaedb44193fbeafa5ce631`，单一 RS256 公钥。

### A.3 验证 dex 是否返回 `groups`（**编码前建议执行**）

由于 discovery 的 `claims_supported` 不反映实际 connector 能力，必须用真实令牌验证。推荐做法：完成本地 dex 登录后，在 `jwt` 回调中临时打印完整 `profile` 对象，检查是否含 `groups` 数组及其内容形态。

临时诊断日志请务必在上线前移除，或改为受环境变量控制的开关（参考现有 `[auth-temp]` 日志的处理方式）。

### A.4 沙箱环境注意事项

- 本项目沙箱内 `curl -o /tmp/x` 会静默丢文件，临时下载请落到工作区内路径。
- `npx` 会被安全策略拦截（拉起 `wsl.exe`），须用 `node node_modules/...` 直调。

---

## 附录 B：dex `config.yaml` 参考片段

仅供 dex 服务器侧操作参考，**本站代码库不包含此文件**。

```yaml
issuer: https://auth.zkun.de/dex

# 每次登录不显示授权同意页
skipApprovalScreen: true

staticClients:
  - id: ldc-shop
    name: 'LDC Shop'
    secret: '<bcrypt hash 或明文>'
    redirectURIs:
      - 'https://shop.ikun.day/api/auth/callback/dex'
      - 'http://localhost:3000/api/auth/callback/dex'
```

修改后 dex 需重启生效（或按部署方式滚动更新）。

---

## 附录 C：术语与参考

| 术语 | 说明 |
| --- | --- |
| OIDC | OpenID Connect，构建在 OAuth 2.0 之上的身份层协议 |
| IdP | Identity Provider，身份提供方，本文指 dex |
| RP | Relying Party，依赖方，本文指 ldc-shop |
| `sub` | Subject，dex 中由 `(connectorID, userID)` 派生的稳定用户标识 |
| PKCE | Proof Key for Code Exchange，防授权码拦截；dex 支持 `S256` |
| ROPC | Resource Owner Password Credentials，密码直传模式；dex 支持但**不推荐使用** |

**相关文件速查**

| 用途 | 路径 |
| --- | --- |
| 认证核心 | `_workers_next/src/lib/auth.ts` |
| 管理员判定 | `_workers_next/src/lib/admin-auth.ts` |
| 登录页 | `_workers_next/src/app/login/page.tsx` |
| 用户表结构 | `_workers_next/src/lib/db/login-users-schema.ts` |
| 用户落库 | `_workers_next/src/lib/db/queries.ts`（`recordLoginUser`） |
| 用户名工具 | `_workers_next/src/lib/user-profile-link.ts` |
| 会话类型 | `_workers_next/src/types/next-auth.d.ts` |
| 错误脱敏 | `_workers_next/src/lib/errors/safe-error.ts` |
| 数据库升级项 | `_workers_next/src/lib/db/database-upgrades.ts` |
| 部署配置 | `_workers_next/wrangler.json` |

---

*本文档为评审稿。第 12 节问题确认后，将据此更新为实施版并补充精确的 diff 级改动清单。*
