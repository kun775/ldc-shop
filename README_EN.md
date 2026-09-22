# LDC Shop (Next.js + Workers)

[中文说明](./README.md)

---

A serverless virtual goods shop built with **Next.js 16**, **Cloudflare Workers** (OpenNext), **D1 Database**, and **Shadcn UI**.

> [!IMPORTANT]
> This repository maintains only the Cloudflare Workers edition. The production application is in [`_workers_next`](./_workers_next).
> The former Docker, Vercel, and other deployment editions were removed on September 22, 2026 and are no longer maintained or supported.

## 📢 Login status (2026-03-04)

`Linux DO Connect` OAuth login is working again; authorization and login complete normally.

**GitHub login** remains available as a fallback (see `_workers_next/README.md` for GitHub OAuth setup). This notice will be updated if anything changes.

## 🆕 Recent updates (2026-09-22)

- **Order expiration cleanup**: The scheduled task now runs every minute, so unpaid orders are normally cancelled by the next minute-level run after reaching five minutes.
- **Manual fulfillment stability**: Fixed the first-submit overlay and file-type detection issues.
- **Timestamp display**: Order, customer, message, coupon, and announcement timestamps now include seconds.
- **Admin audit center**: Records important login, check-in, order, refund, point, coupon, and manual-fulfillment operations. Platform errors support error-ID lookup, filters, pagination, sanitized details, resolution notes, and reopening.
- **Database upgrade management**: Schema upgrades are now explicitly run by an administrator, with structure checks, idempotent execution, failure records, and retries. Ordinary page requests and log writes no longer execute DDL automatically.
- **More resilient admin interactions**: Added a delayed page-level loading overlay and fixed unreleased overlays, duplicate submissions, and unrecoverable error states in coupon editing, point adjustments, and manual fulfillment.
- **Customer and refund workflows**: Customer IDs link to the matching Linux DO or GitHub profile, while usernames and nicknames open the internal customer page. Refund requests can open the related order details in a review dialog.
- **Manual-delivery attachments**: Delivery notes and files are supported. Files use Cloudflare R2 through the `FILES` binding by default, with a D1 fallback when R2 is not configured and a limit of 10 attachments per order.

## ✨ Feature overview

The production edition includes (full list in [_workers_next/README_EN.md](./_workers_next/README_EN.md)):

- **Stack**: Next.js 16 (App Router), Tailwind CSS, TypeScript; edge runtime **Cloudflare Workers + D1**.
- **Linux DO**: OIDC login, EasyPay; optional GitHub login.
- **Storefront**: Search and categories, dedicated search page, wishlist and voting, announcements, Markdown descriptions, purchase warnings, **product visibility by trust level**, hot and discount, ratings and reviews, stock/sold, shared card keys, purchase limits, quantity selection, custom store name, **product variants (multi-spec)**.
- **Orders**: Payment callback verification, automatic card-key delivery, manual delivery notes and attachments, multi-key display, default recipient email, stock reservation, timeout cancellation, order center (with variant labels), pending-order reminders, refund requests and automatic refunds, payment QR.
- **Admin**: Sales statistics, low-stock alerts, product/category/card-key/order management, order cleanup, refund review with order details, reviews, customers, point adjustments, messages, export/import, database upgrades, operation audits and platform-error handling, announcements, navigation, store themes, check-in settings, and update checks.
- **Reliability & storage**: Page-level loading and recoverable error states, duplicate-submit protection for important writes, Cloudflare R2 support for manual-delivery attachments, and a D1 fallback for small files.
- **Points**: Daily check-in (configurable on/off and reward), point deduction, full payment with points.
- **I18n & theme**: English/Chinese, light/dark/system.
- **Notifications**: Resend delivery email, Telegram and **Bark** for new orders/refunds/user messages, in-app inbox and desktop notifications, contact admin, LDC nav (with store count).

## 🚀 Cloudflare Workers deployment

When connecting this repository through Cloudflare Workers Builds, use:

| Setting | Value |
|---|---|
| Path | `_workers_next` |
| Build command | `npm install && npx opennextjs-cloudflare build` |
| Deploy command | `npx wrangler deploy` |

Create and bind the following resources before deployment:

- A D1 database named `ldc-shop-next` by default, bound as `DB`.
- An R2 bucket named `ldc-shop-files` by default, bound as `FILES`.
- Environment variables for OAuth, payments, administrators, and the public application URL.

See the [Workers deployment guide](./_workers_next/README_EN.md) for detailed instructions and the complete environment variable list.

## 💡 Custom domain

For the best experience (instant payment status updates), we recommend binding a custom domain (e.g. `store.yourdomain.com`). Shared domains may be blocked by payment gateways or firewalls.

## ⚙️ Configuration & local development

```bash
cd _workers_next
npm install
npm run dev
```

Common verification commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See [_workers_next/README_EN.md](./_workers_next/README_EN.md) for environment variables, OIDC/EPay setup, and the complete guide.

## 📁 Project structure

```text
_workers_next/
├── src/                 # Next.js application, Server Actions, and business logic
├── public/              # Static assets
├── docs/                # Design documents for the current Workers edition
├── wrangler.json        # Worker, D1, R2, and Cron configuration
├── open-next.config.ts  # OpenNext Cloudflare configuration
└── package.json         # Development, test, build, and deployment commands
```

## 📄 License

MIT
