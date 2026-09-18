# dex 单点登录接入 — 实施报告

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-18 |
| 范围 | `_workers_next/`（Cloudflare Workers 正式版本） |
| 方案依据 | `outputs/dex-sso-integration-plan-2026-09-18.md` |
| 状态 | **已上线**（版本 2.1.0，提交 `2f1c7ce`） |
| Git | 已推送 main，Cloudflare 约 110s 完成构建，线上核验通过 |

---

## 一、决策确认

陛下已确认的四项前置决策，实施严格按此执行：

| 编号 | 决策 | 对实施的影响 |
| --- | --- | --- |
| Q1 | **仅后台管理员**使用 dex | 走路线 0；登录页入口标注"仅供管理员"，不做公开推广 |
| Q2 | **路线 0**（不含账号合并） | 不新增任何数据表/列，无 DDL，零数据迁移风险 |
| Q3 | **保留** linuxdo / github 登录 | 三个入口并存，dex 置顶且为主按钮 |
| Q4 | dex 为**本地账号、自用、不会修改** | 不实施邮箱自动合并（路线 B）；不申请 `groups` scope（本地 connector 不产出组） |

---

## 二、改动清单

共 8 个文件：7 处修改 + 1 个新增。

### 2.1 `src/lib/auth.ts`（核心，+138 −1）

| 改动 | 说明 |
| --- | --- |
| 新增 `dex` provider | `type: "oidc"` + `issuer`，仅在 `DEX_CLIENT_ID` 与 `DEX_CLIENT_SECRET` **同时存在**时注册，缺失时 `console.warn` 并跳过（与既有 GitHub 模式一致） |
| `normalizeDexUserId()` | 规范为 `dex:<sub>`，幂等处理已有前缀 |
| `normalizeDexUsername()` | 规范为 `dex_<handle>`，依次回退 `preferred_username` → `name` → `email` 本地部分 → `sub` 前 12 位 |
| `sanitizeDexHandle()` | 小写化并剔除非法字符，防止用户名注入异常字符 |
| `profile()` | 映射 dex claims；`sub` 缺失时**抛错而非降级**（静默降级会导致 user_id 退化并与 Linux DO 数字 id 撞车） |
| `jwt` 回调新增 dex 分支 | 二次兜底规范化，来源优先级 `profile.sub` → `account.providerAccountId` → 现有 `resolvedId` |
| `pages.error` | 由未配置改为 `"/login"`，统一错误落点 |

**未申请 `offline_access`**：本站不调用 dex 的下游 API，不需要 refresh token。

### 2.2 `src/app/login/page.tsx`（改写，服务端外壳）

由纯客户端组件改为**服务端组件 + Suspense**：

- 新增 `export const dynamic = "force-dynamic"` —— provider 可用性来自 Worker Secret，必须在运行时读取。若被静态预渲染固化，构建期不可见的 secret 会让入口永久消失。
- `isDexEnabled()` / `isGithubEnabled()` 与 `auth.ts` 的注册条件保持**同一套判定逻辑**。

### 2.3 `src/app/login/login-form.tsx`（新增，客户端表单）

- 三个按钮：DEX（主按钮，`ShieldCheck` 图标）/ GitHub（outline）/ Linux DO（深色）。
- DEX 按钮下方一行提示：「DEX 登录仅供后台管理员使用。共用设备上请勿保持 DEX 登录状态。」——后半句对应"dex 无单点登出"的硬约束。
- 新增错误提示区：把 Auth.js 错误码映射为 8 类可操作文案。
- **顺带修复既有缺陷**：GitHub 按钮由"无条件显示"改为"配置了凭据才显示"。此前若未配置 `GITHUB_ID`，用户点击会直接报错。

### 2.4 `src/lib/user-profile-link.ts`（+25）

- 新增 `isDexUsername()` / `isDexUser()` 与两个前缀常量。
- `getDisplayUsername()` 新增 dex 分支：统一小写并补 `dex_` 前缀，与 `gh_` 处理方式对齐。
- **`getExternalProfileUrl()` 新增 dex 分支并返回 `null`** —— 这是方案中标记的关键耦合点：该函数原先把所有非 GitHub 用户外链到 `https://linux.do/u/<name>`，dex 用户会被错误链接。

### 2.5 `src/lib/user-profile-link.test.ts`（+16，3 个新用例）

| 用例 | 保护目标 |
| --- | --- |
| DEX users never link out to LinuxDo | 外链回归保护 |
| DEX identity is recognised from the user id alone | 仅凭 `dex:` 前缀也能识别（用户名可能被改） |
| DEX user ids that are purely numeric are not mistaken for LinuxDo users | 验证 `dex:12345` 不走 linux.do，而裸 `12345` 仍走 —— 命名空间隔离的核心断言 |

### 2.6 `src/locales/zh.json` / `en.json`（各 +17）

新增顶层 `login` 段：`title` / `withDex` / `dexHint` / `withGitHub` / `withLinuxDo` + `error` 下 8 个 key。两个文件 key 完全一致（已校验）。

### 2.7 `README.md`（+36 −2）

- 两处环境变量表补充 `DEX_ISSUER` / `DEX_CLIENT_ID` / `DEX_CLIENT_SECRET` / `DEX_ENABLED`。
- 补充此前文档缺失的 `ADMIN_USER_IDS`。
- 回调地址表新增 DEX 行。
- 新增「DEX 单点登录（仅后台管理员）」小节，含 `config.yaml` 示例与 5 条配置要点。

---

## 三、验证结果

全部在本机实测，非推断。

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0 error** |
| 单元测试 | `node --test "src/lib/**/*.test.ts"` | **229 pass / 0 fail**（原 226 + 新增 3） |
| ESLint | `node node_modules/eslint/bin/eslint.js src` | **0 error** / 359 warning（均为既有 `any` 风格警告） |
| 生产构建 | `NEXT_DIST_DIR=.next-verify node node_modules/next/dist/bin/next build --webpack` | **成功**；`/login` 正确标记为 `ƒ (Dynamic)` |

构建后已清理 `tsconfig.json` 中被自动追加的 `.next-verify/**` include 项（已用 `git diff` 确认清理干净）。

### 3.1 端到端冒烟验证

以临时凭据启动本地 dev server，实测四项：

| # | 验证 | 结果 |
| --- | --- | --- |
| 1 | `GET /api/auth/providers` | 返回 `dex: { type: "oidc", signinUrl: .../signin/dex, callbackUrl: .../callback/dex }` |
| 2 | `POST /api/auth/signin/dex` | 302 到 `https://auth.zkun.de/dex/auth?response_type=code&client_id=...&redirect_uri=...%2Fapi%2Fauth%2Fcallback%2Fdex&scope=openid+profile+email&code_challenge=...&code_challenge_method=S256` |
| 3 | `GET /login`（zh / en） | DEX 按钮与提示文案均正确渲染；GitHub 按钮在未配置凭据时**正确隐藏**；Linux DO 按钮不受影响 |
| 4 | `GET /api/auth/callback/dex?code=fake&state=fake` | 302 到 `/login?error=Configuration`，页面渲染中文友好提示「认证服务配置异常…」 |

**第 2 项是本方案最大的技术风险点的直接消除**：它证明 `oauth4webapi`（Auth.js 的 OIDC 底层）能真实拉取 dex 的 discovery 文档并正确构造带 PKCE S256 的授权请求 —— 即方案中的「路径 1」可行，无需回退到手工 OAuth provider。

### 3.2 线上核验（提交后实测）

推送 main 后约 110 秒完成构建，随后对线上做全链路只读诊断，结果如下。

| # | 核验项 | 结果 |
| --- | --- | --- |
| 1 | 新代码是否上线 | `GET /login`（`Accept-Language: en`）出现 `Sign in with Linux DO` —— 改动前该页面为硬编码中文，任何语言都显示中文，该文案是新代码的独有特征 |
| 2 | provider 注册 | `GET /api/auth/providers` 返回三个：`linuxdo`(oauth) / `github`(oauth) / **`dex`(oidc)** |
| 3 | 授权 URL | `POST /api/auth/signin/dex` → 302 到 `https://auth.zkun.de/dex/auth?response_type=code&client_id=ldc-shop&redirect_uri=https%3A%2F%2Fshop.ikun.day%2Fapi%2Fauth%2Fcallback%2Fdex&scope=openid+profile+email&code_challenge=...&code_challenge_method=S256` |
| 4 | **dex 侧是否接受该回调地址** | 直接请求上述 authorize URL → **HTTP 200**，重定向至 `https://auth.zkun.de/dex/auth/local/login?back=&state=...`（dex 本地密码登录页，含 `<form>`，`lang="zh-CN"`）。**dex 未报 redirect_uri 错误，证明回调地址已在 dex 侧正确登记** |

**结论：线上链路已可用。** `client_id=ldc-shop`、`redirect_uri` 与站点域名精确匹配、PKCE S256 已启用、scope 不含 `offline_access`。dex 的 connector 确认为本地密码（与"本地账号、自用"的描述一致）。

### 3.3 仍未覆盖的部分

| 项 | 说明 |
| --- | --- |
| 输入密码后的完整闭环 | 需人工在浏览器完成一次真实登录；诊断脚本只走到 dex 登录页为止 |
| `login_users` 落库形态 | 依赖上一项；预期为 `user_id=dex:<sub>`、`username=dex_<句柄>` |
| 管理员权限生效 | 依赖 `ADMIN_USER_IDS` 配置（见第 4 节步骤 3） |

---

## 四、配置状态

### 步骤 1：dex 侧注册 static client — [已完成]

**实测确认**：线上 authorize URL 的 `client_id` 为 `ldc-shop`，`redirect_uri` 为 `https://shop.ikun.day/api/auth/callback/dex`，dex 直接返回 200 并跳转本地登录页，未报回调地址错误 —— 说明回调地址已在 dex 侧正确登记。

以下为配置内容，供后续变更参考。在 dex 服务的 `config.yaml` 中：

```yaml
staticClients:
  - id: ldc-shop
    name: 'LDC Shop'
    secret: '<生成的密钥或 bcrypt hash>'
    redirectURIs:
      - 'https://shop.ikun.day/api/auth/callback/dex'
```

- `redirectURIs` 必须**精确匹配**（协议、域名、路径、大小写），dex 不支持通配符。
- 若还要通过 `*.workers.dev` 访问，需一并登记该域名的回调地址。
- 建议同时确认 `skipApprovalScreen: true`，否则每次登录都会显示一次授权同意页。

### 步骤 2：配置 Cloudflare Worker 环境变量 — [已完成]

**实测确认**：线上 `/api/auth/providers` 已返回 `dex`（type=oidc），且能生成带 PKCE S256 的授权 URL，说明凭据已生效。

| 变量 | 类型 | 值 |
| --- | --- | --- |
| `DEX_CLIENT_ID` | Text | 步骤 1 中的 `id` |
| `DEX_CLIENT_SECRET` | **Secret** | 步骤 1 中的 `secret` |
| `DEX_ISSUER` | Text | 可省略（默认 `https://auth.zkun.de/dex`） |
| `DEX_ENABLED` | Text | 可省略；设为 `false` 可临时隐藏入口 |

> `DEX_CLIENT_SECRET` **必须**用 Secret 类型，且不可写入 `wrangler.json`（该文件入库，且已开启 `keep_vars: true`）。

### 步骤 3：授予管理员权限 — [待执行]

> **这是当前唯一未完成的一步。** 在写入 `ADMIN_USER_IDS` 之前，DEX 登录成功后只是一个普通账号，无法进入 `/admin`。

1. 部署后访问 `/login`，点击「使用 DEX 登录」完成一次登录。
2. 进入 **后台 → 用户管理**，找到形如 `dex_用户名` 的记录，复制其用户 ID（形如 `dex:xxxxxxxx`）。
3. 将其写入 `ADMIN_USER_IDS`（逗号分隔，可追加在既有 ID 后）。

**建议使用 `ADMIN_USER_IDS` 而非 `ADMIN_USERS`**：前者匹配不可变的用户 ID，后者依赖用户名，而用户名可在 dex 侧被修改。

> 注意：`ADMIN_USER_IDS` 一旦非空，`ADMIN_USERS` 将**完全失效**（这是既有逻辑）。若当前线上仅配置了 `ADMIN_USERS`，切换前需把所有现有管理员的用户 ID 一并补齐，否则会把其他管理员锁在后台外。

---

## 五、已知限制

1. **不支持单点登出。** dex 的 discovery 文档中不存在 `end_session_endpoint`（实测确认）。在本站登出只清除本站会话，dex 侧登录态保留，再次点击登录会直接进入。已通过登录页文案提示"共用设备上请勿保持 DEX 登录状态"。
2. **管理员权限回收存在会话延迟。** JWT 会话默认有效期较长，从 `ADMIN_USER_IDS` 移除某人后，其已签发的 token 在过期前仍可通过判定。这是**既有设计问题**，非本次引入，但 dex 管理员同样受影响。如需修复，建议单独排期（改为实时查库或缩短会话）。
3. **`ADMIN_USERS` 首项影响品牌名。** 页头品牌名取 `getAdminUsernames()[0]`，如在 `ADMIN_USERS` 首位加入 `dex_xxx` 会改变店铺显示名。属既有行为，配置时留意顺序即可。
4. **不申请 `groups` scope。** 符合"本地账号"的实际能力（本地 password connector 不产出组声明），管理员权限走显式 ID 白名单。

---

## 六、回滚方式

**零数据风险。** 本次未涉及任何 DDL，`login_users` 表结构未变，已产生的 `dex:*` 用户记录在回滚后仅是无法登录的孤立数据，不影响既有用户。

三种回滚粒度，按需选择：

| 粒度 | 操作 | 生效范围 |
| --- | --- | --- |
| 软回滚 | 设 `DEX_ENABLED=false` | 隐藏入口，代码与数据均保留 |
| 硬回滚 | 删除 `DEX_CLIENT_ID` / `DEX_CLIENT_SECRET` | provider 不再注册，`/api/auth/providers` 不再返回 dex |
| 完全回滚 | `git revert` 本次提交 | 恢复至改动前状态 |

---

## 七、后续可选增强

| 项 | 价值 | 前置条件 |
| --- | --- | --- |
| 管理员权限判定实时化 | 消除第 5.2 条的回收延迟 | 无 |
| 新增 dex 账号绑定表（路线 C） | 仅当将来 dex 扩展到普通用户时才需要 | 需要改变 Q1 决策 |
| 单点登出 | 需要 dex 侧先提供 `end_session_endpoint` | 依赖 dex 升级 |
| 组映射管理员（`DEX_ADMIN_GROUPS`） | 仅当 dex 接入能产出 groups 的 connector | 需先实测 claims |
