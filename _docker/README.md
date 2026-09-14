# LDC Shop (Docker Edition)

基于 **Next.js 16**、**SQLite** 和 **Shadcn UI** 构建的虚拟商品商店 Docker 版本。

本版本基于 `_workers_next`（Cloudflare Workers 版）改造，将数据库从 Cloudflare D1 替换为本地 SQLite（`better-sqlite3`），适用于 VPS / 自托管部署。

## 技术架构

- **核心框架**: Next.js 16 (App Router) + TypeScript
- **数据库**: SQLite（better-sqlite3），数据文件持久化到 Docker volume
- **ORM**: Drizzle ORM
- **认证**: NextAuth（Linux DO Connect + GitHub OAuth）
- **支付**: EPay
- **UI**: Tailwind CSS + Shadcn UI + Framer Motion

---

## 部署方式一：拉取预构建镜像（推荐）

无需克隆代码，直接使用已发布的 Docker 镜像。

### 一键脚本

```bash
mkdir ldc-shop && cd ldc-shop
curl -fsSL https://raw.githubusercontent.com/kun775/ldc-shop/main/_docker/pull-setup.sh -o setup.sh
chmod +x setup.sh
./setup.sh
```

脚本会交互式引导你输入所有配置项（站点 URL、OAuth、支付、GitHub 登录等），自动生成 `.env` 和 `docker-compose.yml`，拉取镜像并启动。

### 更新镜像

```bash
docker compose pull && docker compose up -d
```

---

## 部署方式二：自行构建镜像

适合需要修改源码或自定义构建的场景。

### 方法 A：一键脚本（交互式）

```bash
git clone https://github.com/kun775/ldc-shop.git
cd ldc-shop/_docker
chmod +x setup.sh
./setup.sh
```

脚本会引导你输入必要的配置项，自动生成 `.env` 和 `docker-compose.yml`，并构建启动容器。

### 方法 B：手动构建

```bash
git clone https://github.com/kun775/ldc-shop.git
cd ldc-shop/_docker
```

编辑 `.env` 文件（参考上方"拉取镜像"部分的 `.env` 模板），然后：

```bash
mkdir -p data && chmod 777 data
docker compose up -d --build
```

---

## 反向代理配置

容器监听 `3000` 端口，生产环境建议用 Nginx / Caddy 反向代理并配置 HTTPS。

**Nginx 示例：**

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

**Caddy 示例（自动 HTTPS）：**

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `APP_URL` | 是 | 站点外部访问地址，如 `https://your-domain.com` |
| `NEXT_PUBLIC_APP_URL` | 是 | 同 `APP_URL`，值保持一致 |
| `AUTH_TRUST_HOST` | 是 | 设为 `true`，信任反代传递的 Host 头 |
| `AUTH_SECRET` | 是 | 随机字符串，用于加密 session |
| `OAUTH_CLIENT_ID` | 是 | Linux DO Connect OAuth Client ID |
| `OAUTH_CLIENT_SECRET` | 是 | Linux DO Connect OAuth Client Secret |
| `MERCHANT_ID` | 是 | EPay 商户 ID |
| `MERCHANT_KEY` | 是 | EPay 商户密钥 |
| `PAY_URL` | 否 | 支付接口地址，默认 Linux DO Credit |
| `ADMIN_USERS` | 是 | 管理员用户名，多个用逗号分隔 |
| `DATABASE_PATH` | 否 | SQLite 路径，默认 `/app/data/ldc-shop.sqlite` |
| `GITHUB_ID` | 否 | GitHub OAuth Client ID |
| `GITHUB_SECRET` | 否 | GitHub OAuth Client Secret |

> Telegram 通知、Bark 推送、邮件通知等可选功能在管理后台中配置，无需设置环境变量。

---

## GitHub OAuth App 创建方法

如需启用 GitHub 登录（作为 Linux DO Connect 的备用登录方式），按以下步骤创建 OAuth App：

1. 访问 [GitHub Developer Settings](https://github.com/settings/developers)
2. 点击 **New OAuth App**
3. 填写信息：
   - **Application name**: `LDC Shop`（任意名称）
   - **Homepage URL**: `https://your-domain.com`（你的站点地址）
   - **Authorization callback URL**: `https://your-domain.com/api/auth/callback/github`
4. 点击 **Register application**
5. 记录 **Client ID**，点击 **Generate a new client secret** 获取 **Client Secret**
6. 将两个值填入 `.env` 文件的 `GITHUB_ID` 和 `GITHUB_SECRET`
7. 重启容器生效：`docker compose down && docker compose up -d`

---

## 数据持久化与备份

SQLite 数据库文件存储在 `./data/ldc-shop.sqlite`，通过 Docker volume 挂载持久化。

```bash
# 备份
cp -r ./data ./data-backup-$(date +%Y%m%d)

# 恢复
cp -r ./data-backup-20260304 ./data
docker restart ldc-shop
```

## 定时任务

容器内置 cron 定时任务（每 5 分钟执行），自动处理：
- 超时未支付订单的清理
- 过期卡密预留的释放

## 修改环境变量后生效方式

```bash
# 修改 .env 后需要重建容器（不是 docker restart）
docker compose down && docker compose up -d

# 如果修改了源码，需要重新构建
docker compose up -d --build
```
