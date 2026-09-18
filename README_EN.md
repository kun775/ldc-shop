# LDC Shop (Next.js + Workers)

[中文说明](./README.md)

---

A serverless virtual goods shop built with **Next.js 16**, **Cloudflare Workers** (OpenNext), **D1 Database**, and **Shadcn UI**.

> [!IMPORTANT]
> **⚠️ Vercel edition is no longer maintained. Use the Cloudflare Workers or Docker edition.**
> 
> The Workers edition is the actively maintained version with all latest features. The Docker edition may lag behind.

> 🚀 **Recommended: Cloudflare Workers or Docker self-hosted**
> 
> | Comparison | Cloudflare Workers | Docker self-hosted | Vercel |
> |------------|-------------------|---------------------|--------|
> | Maintenance | **✅ Active** | ✅ Synced | ⚠️ Stopped |
> | Free requests | **100K/day** | Unlimited | Limited |
> | Database | **D1 free 5GB** | SQLite unlimited | Postgres quota |
> | Cold start | **Near zero** | None | Yes |
> | Requirements | No server | VPS needed | No server |
> | Global edge | ✅ Worldwide | Single node | Partial |
> 
> 👉 **[Full features & Workers deployment guide → `_workers_next/README.md`](./_workers_next/README.md)**
> 
> 👉 **[Docker deployment guide → `_docker/README.md`](./_docker/README.md)**

## 📢 Login status (2026-03-04)

`Linux DO Connect` OAuth login is working again; authorization and login complete normally.

**GitHub login** remains available as a fallback (see `_workers_next/README.md` for GitHub OAuth setup). This notice will be updated if anything changes.

## 🆕 Recent updates (2026-09-18)

- **Admin audit center**: Records important login, check-in, order, refund, point, coupon, and manual-fulfillment operations. Platform errors support error-ID lookup, filters, pagination, sanitized details, resolution notes, and reopening.
- **Database upgrade management**: Schema upgrades are now explicitly run by an administrator, with structure checks, idempotent execution, failure records, and retries. Ordinary page requests and log writes no longer execute DDL automatically.
- **More resilient admin interactions**: Added a delayed page-level loading overlay and fixed unreleased overlays, duplicate submissions, and unrecoverable error states in coupon editing, point adjustments, and manual fulfillment.
- **Customer and refund workflows**: Customer IDs link to the matching Linux DO or GitHub profile, while usernames and nicknames open the internal customer page. Refund requests can open the related order details in a review dialog.
- **Manual-delivery attachments**: Delivery notes and files are supported. Files use Cloudflare R2 through the `FILES` binding by default, with a D1 fallback when R2 is not configured and a limit of 10 attachments per order.

## ✨ Feature overview

The current **Workers edition** includes (full list in [_workers_next/README.md](./_workers_next/README.md)):

- **Stack**: Next.js 16 (App Router), Tailwind CSS, TypeScript; edge runtime **Cloudflare Workers + D1**.
- **Linux DO**: OIDC login, EasyPay; optional GitHub login.
- **Storefront**: Search and categories, dedicated search page, wishlist and voting, announcements, Markdown descriptions, purchase warnings, **product visibility by trust level**, hot and discount, ratings and reviews, stock/sold, shared card keys, purchase limits, quantity selection, custom store name, **product variants (multi-spec)**.
- **Orders**: Payment callback verification, automatic card-key delivery, manual delivery notes and attachments, multi-key display, default recipient email, stock reservation, timeout cancellation, order center (with variant labels), pending-order reminders, refund requests and automatic refunds, payment QR.
- **Admin**: Sales statistics, low-stock alerts, product/category/card-key/order management, order cleanup, refund review with order details, reviews, customers, point adjustments, messages, export/import, database upgrades, operation audits and platform-error handling, announcements, navigation, store themes, check-in settings, and update checks.
- **Reliability & storage**: Page-level loading and recoverable error states, duplicate-submit protection for important writes, Cloudflare R2 support for manual-delivery attachments, and a D1 fallback for small files.
- **Points**: Daily check-in (configurable on/off and reward), point deduction, full payment with points.
- **I18n & theme**: English/Chinese, light/dark/system.
- **Notifications**: Resend delivery email, Telegram and **Bark** for new orders/refunds/user messages, in-app inbox and desktop notifications, contact admin, LDC nav (with store count).

## 🚀 Deployment

> For detailed steps and env vars, see **[_workers_next/README.md](./_workers_next/README.md)**.

### ⭐ Recommended: Cloudflare Workers

High free tier, fast global access, no cold start.

👉 **[Full deployment guide → _workers_next/README.md](./_workers_next/README.md)**

### Alternative: Docker self-hosted

For VPS or your own server; local SQLite, no third-party DB.

👉 **[Docker guide → _docker/README.md](./_docker/README.md)**

### Alternative: Vercel (no longer maintained)

The Vercel edition is no longer maintained; use Workers or Docker for new deployments. This repository is independently maintained and no longer syncs from upstream.

## 💡 Custom domain

For the best experience (instant payment status updates), we recommend binding a custom domain (e.g. `store.yourdomain.com`). Shared domains may be blocked by payment gateways or firewalls.

## ⚙️ Configuration & local development

Environment variables, OIDC/EPay setup, and local dev steps for the Workers edition are in **[_workers_next/README.md](./_workers_next/README.md)**.

## 📄 License

MIT
