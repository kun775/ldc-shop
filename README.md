# LDC Shop (Next.js + Workers)

[English](./README_EN.md)

---

基于 **Next.js 16**、**Cloudflare Workers**（OpenNext）、**D1 Database** 和 **Shadcn UI** 构建的无服务器虚拟商品商店。

> [!IMPORTANT]
> 本仓库仅维护 Cloudflare Workers 版本，正式工程位于 [`_workers_next`](./_workers_next)。
> 原 Docker、Vercel 和其他部署版本已于 2026 年 9 月 22 日移除，不再提供更新和技术支持。

## 📢 登录状态公告（2026-03-04）

`Linux DO Connect` OAuth 登录已恢复正常，当前可正常完成授权并登录。

项目保留 **GitHub 登录** 作为备用方式（配置见 `_workers_next/README.md` 中的 GitHub OAuth 说明）。如有变化将在本公告更新。

## 🆕 近期更新（2026-09-22）

- **订单超时清理**：定时任务改为每分钟执行，未支付订单满 5 分钟后通常会在下一次分钟任务中取消。
- **手动发货稳定性**：修复首次提交时的异常遮罩与文件类型判断问题。
- **时间显示**：订单、顾客、消息、优惠券和公告等时间统一精确到秒。
- **后台审计中心**：记录登录、签到、下单、退款、积分调整、优惠券和手动发货等关键操作；平台运行错误支持按错误 ID 查询、筛选、分页、查看脱敏详情、填写处理说明和重新打开。
- **数据库升级管理**：数据库结构升级改为管理员在后台手动执行，支持结构自检、幂等升级、失败记录与重试；普通页面访问和日志写入不再自动执行 DDL。
- **后台交互稳定性**：新增延迟显示的页面级 Loading 遮罩，修复优惠券编辑、积分调整和手动发货中的异常遮罩、重复提交及错误状态无法恢复问题。
- **顾客与退款管理**：顾客 ID 可跳转对应的 Linux DO/GitHub 主页，用户名和昵称统一进入站内顾客详情；退款申请可直接弹出关联订单详情辅助审核。
- **手动发货附件**：支持发货说明和附件交付，默认通过 `FILES` 绑定保存到 Cloudflare R2；未配置 R2 时可降级到 D1，单订单最多 10 个附件。

## ✨ 特性概览

当前正式版本的主要特性如下（完整列表见 [_workers_next/README.md](./_workers_next/README.md)）：

- **技术栈**: Next.js 16 (App Router)、Tailwind CSS、TypeScript；边缘部署为 **Cloudflare Workers + D1**。
- **Linux DO 集成**: OIDC 登录、EasyPay 支付；可选 GitHub 登录。
- **商城**: 搜索与分类、独立搜索页、心愿单与投票、公告栏、Markdown 描述、购买前提醒、**商品可见级别**（按信任等级）、热门与折扣、评分评论、库存/已售、共享卡密、限购、数量选择、自定义商店名称、**商品规格（多规格）** 等。
- **订单**: 支付回调验签、自动发货卡密、手动发货说明与附件、多卡密分发、默认收件邮箱、库存锁定、超时取消、订单中心（含规格标签）、待支付提醒、退款申请与自动退款、收款码。
- **管理后台**: 销售统计、库存预警、商品管理（含可见范围与规格）、分类管理、卡密管理、订单管理、订单清理、退款审核与订单详情、评价管理、顾客管理、积分调整、消息管理、数据导出/导入、数据库升级、操作审计与平台错误处理、公告、导航、店铺主题、签到设置和更新检查。
- **稳定性与存储**: 页面级 Loading 与可恢复错误状态、关键写操作防重复提交；手动发货附件支持 Cloudflare R2，并提供 D1 小文件降级存储。
- **积分**: 每日签到（可配置开关与奖励）、积分抵扣、积分全额支付。
- **多语言与主题**: 中英切换、浅色/深色/跟随系统。
- **通知**: Resend 发货邮件、Telegram 与 **Bark** 新订单/退款/用户消息推送、站内收件箱与桌面通知、联系管理员、LDC 导航（含商店数目）。

## 🚀 Cloudflare Workers 部署

使用 Cloudflare Workers Builds 连接本仓库时，配置如下：

| 配置项 | 值 |
|---|---|
| Path | `_workers_next` |
| Build command | `npm install && npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |

部署前需要创建并绑定：

- D1 数据库，默认名称为 `ldc-shop-next`，绑定名为 `DB`。
- R2 Bucket，默认名称为 `ldc-shop-files`，绑定名为 `FILES`。
- OAuth、支付、管理员和站点地址等环境变量。

详细步骤和完整环境变量列表见 [Workers 部署指南](./_workers_next/README.md)。

## 💡 建议：绑定自定义域名

为获得最佳体验（即时支付状态更新），建议绑定自定义域名（如 `store.yourdomain.com`）。共享域名可能被支付平台或防火墙拦截，影响回调。

## ⚙️ 配置与本地开发

```bash
cd _workers_next
npm install
npm run dev
```

常用验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

环境变量、OIDC/EPay 配置及完整说明见 [_workers_next/README.md](./_workers_next/README.md)。

## 📁 项目结构

```text
_workers_next/
├── src/                 # Next.js 应用、Server Actions 和业务逻辑
├── public/              # 静态资源
├── docs/                # 当前 Worker 版本的专项设计文档
├── wrangler.json        # Worker、D1、R2 和 Cron 配置
├── open-next.config.ts  # OpenNext Cloudflare 配置
└── package.json         # 开发、测试、构建和部署命令
```

## 📄 许可证
MIT
