# `_workers_next` 商品积分抵扣展示补充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `_workers_next` 的首页、搜索页和商品详情页补上商品级签到积分抵扣展示，让用户在进入购买弹窗前就能看到 `积分抵扣10%` 这一类提示。

**Architecture:** 这次只做展示层补齐，不改数据库结构、不改后台配置、不改下单结算。实现上复用现有 `product-point-discount` 规则文件产出一个轻量展示 helper，首页和搜索页只补查询字段透传，详情页直接读取现有 `displayProduct` 的商品配置；变体组列表继续沿用 `groupProductsAsVariants` 的代表商品配置，避免引入新的聚合语义。

**Tech Stack:** Next.js 16 App Router、TypeScript、Drizzle ORM、Cloudflare D1、JSON i18n 词条。

---

> **执行约束**
>
> - 当前仓库 `AGENTS.md` 规定：`git commit` 属危险操作。计划里会保留提交步骤，但执行前必须再次得到用户明确确认。
> - 当前仓库还没有前端自动化测试基建；本计划采用“精确代码改动 + `npm run build` + 手动冒烟验证”的最小闭环，不在本轮顺手引入 Vitest，避免为了一个展示增强扩大改动面。
> - 当前工作区存在与本任务无关的未提交改动。执行时只整理本功能相关 diff，不回滚、不覆盖其他文件。

## File Structure

### New Files

- None

### Modified Files

- Modify: `_workers_next/src/lib/points/product-point-discount.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/app/page.tsx`
- Modify: `_workers_next/src/app/search/page.tsx`
- Modify: `_workers_next/src/components/home-content.tsx`
- Modify: `_workers_next/src/components/search-content.tsx`
- Modify: `_workers_next/src/components/buy-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

### Responsibility Map

- `_workers_next/src/lib/points/product-point-discount.ts`
  负责统一“商品是否应该显示积分抵扣 badge”的判断，避免首页、搜索页、详情页各写一套 `Boolean(...) && Number(...) > 0`。

- `_workers_next/src/lib/db/queries.ts`
  负责给 `getActiveProducts` 和 `searchActiveProducts` 补齐 `pointDiscountEnabled`、`pointDiscountPercent` 字段；不改 `groupProductsAsVariants` 聚合策略。

- `_workers_next/src/app/page.tsx`
  负责把首页聚合商品里的积分抵扣字段透传给 `HomeContent`。

- `_workers_next/src/app/search/page.tsx`
  负责把搜索结果里的积分抵扣字段透传给 `SearchContent`。

- `_workers_next/src/components/home-content.tsx`
  负责在首页商品卡片价格区、原价删除线和折扣 badge 同一行补充积分抵扣 badge。

- `_workers_next/src/components/search-content.tsx`
  负责在搜索结果价格区域补充积分抵扣 badge，并保持现有卡片结构不变。

- `_workers_next/src/components/buy-content.tsx`
  负责在商品详情页价格区补充积分抵扣 badge，复用当前 `displayProduct` 的商品配置。

- `_workers_next/src/locales/zh.json`
  负责新增中文 badge 文案。

- `_workers_next/src/locales/en.json`
  负责新增英文 badge 文案。

---

### Task 1: 打通首页与搜索页的积分抵扣字段透传

**Files:**
- Modify: `_workers_next/src/lib/points/product-point-discount.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/app/page.tsx`
- Modify: `_workers_next/src/app/search/page.tsx`

- [ ] **Step 1: 在共享规则文件里补一个展示 helper，只做展示判断，不碰结算逻辑**

```ts
// _workers_next/src/lib/points/product-point-discount.ts
export interface ProductPointDiscountBadge {
  percent: number
}

// getProductPointDiscountBadge 提取商品展示层的积分抵扣徽标配置
//
// 参数:
//   - input.pointDiscountEnabled: 商品是否开启积分抵扣
//   - input.pointDiscountPercent: 商品配置的抵扣百分比
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-04-19
//   - 更新时间: 2026-04-19
//   - 更新内容: 新增前台展示层使用的积分抵扣徽标判断逻辑。
export function getProductPointDiscountBadge(input: {
  pointDiscountEnabled: boolean | null | undefined
  pointDiscountPercent: number | string | null | undefined
}): ProductPointDiscountBadge | null {
  const config = sanitizeRuntimeProductPointDiscountConfig({
    pointDiscountEnabled: Boolean(input.pointDiscountEnabled),
    pointDiscountPercent: input.pointDiscountPercent,
  })

  if (!config.pointDiscountEnabled || config.pointDiscountPercent <= 0) {
    return null
  }

  return {
    percent: config.pointDiscountPercent,
  }
}
```

- [ ] **Step 2: 给首页与搜索查询补齐字段，保持变体组继续沿用代表商品配置**

```ts
// _workers_next/src/lib/db/queries.ts
export async function getActiveProducts(options?: { isLoggedIn?: boolean; trustLevel?: number | null }) {
  await ensureDatabaseInitialized();

  const rows = await withProductColumnFallback(async () => {
    return await db.select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      compareAtPrice: products.compareAtPrice,
      image: products.image,
      productImages: products.productImages,
      category: products.category,
      isHot: products.isHot,
      isShared: products.isShared,
      purchaseLimit: products.purchaseLimit,
      pointDiscountEnabled: products.pointDiscountEnabled,
      pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
      visibilityLevel: products.visibilityLevel,
      sortOrder: products.sortOrder,
      createdAt: products.createdAt,
      variantGroupId: products.variantGroupId,
      variantLabel: products.variantLabel,
      stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
      locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
      sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
      rating: sql<number>`COALESCE(${products.rating}, 0)`,
      reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`,
    })
      .from(products)
      .where(and(eq(products.isActive, true), visibilityCondition(options?.isLoggedIn, options?.trustLevel)))
      .orderBy(asc(products.sortOrder), desc(products.createdAt));
  });

  return groupProductsAsVariants(rows);
}
```

```ts
// _workers_next/src/lib/db/queries.ts
export async function searchActiveProducts(params: {
  q?: string
  category?: string
  sort?: string
  page?: number
  pageSize?: number
  isLoggedIn?: boolean
  trustLevel?: number | null
}) {
  // ...
  const [rows] = await withProductColumnFallback(async () => {
    const rowsPromise = db.select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      compareAtPrice: products.compareAtPrice,
      image: products.image,
      category: products.category,
      isHot: products.isHot,
      isShared: products.isShared,
      purchaseLimit: products.purchaseLimit,
      pointDiscountEnabled: products.pointDiscountEnabled,
      pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
      sortOrder: products.sortOrder,
      createdAt: products.createdAt,
      variantGroupId: products.variantGroupId,
      variantLabel: products.variantLabel,
      stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
      locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
      sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
      rating: sql<number>`COALESCE(${products.rating}, 0)`,
      reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`,
    })
      .from(products)
      .where(whereExpr)
      .orderBy(...orderByParts)

    return [await rowsPromise] as const
  })

  const grouped = groupProductsAsVariants(rows)
  // ...
}
```

- [ ] **Step 3: 首页和搜索页的服务端映射把字段继续往下传，不在这里做额外转换规则**

```ts
// _workers_next/src/app/page.tsx
  const productsWithRatings = products.map((p: any) => {
    const isGroup = p.allVariantIds && p.allVariantIds.length > 1;
    // stockTotal, soldCount, rating 逻辑保持原样

    return {
      ...p,
      pointDiscountEnabled: Boolean(p.pointDiscountEnabled),
      pointDiscountPercent: Number(p.pointDiscountPercent || 0),
      stockCount: stockTotal,
      soldCount: isGroup ? (p.totalSold || 0) : (p.sold || 0),
      isHot: isGroup ? (p.groupHot || false) : p.isHot,
      descriptionPlain: stripMarkdown(p.description || ''),
      rating: isGroup ? Number(p.avgRating || 0) : Number(p.rating || 0),
      reviewCount: isGroup ? Number(p.totalReviewCount || 0) : Number(p.reviewCount || 0)
    };
  });
```

```ts
// _workers_next/src/app/search/page.tsx
      products={result.items.map((p: any) => {
        const isGroup = p.allVariantIds && p.allVariantIds.length > 1
        let stockCount: number
        // 现有库存计算逻辑保持原样

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          pointDiscountEnabled: Boolean(p.pointDiscountEnabled),
          pointDiscountPercent: Number(p.pointDiscountPercent || 0),
          image: p.image,
          category: p.category,
          isHot: isGroup ? (p.groupHot || false) : (p.isHot ?? false),
          stockCount,
          soldCount: isGroup ? (p.totalSold || 0) : (p.sold || 0)
        }
      })}
```

- [ ] **Step 4: 跑一次构建，确认字段透传没有打断现有页面**

Run:

```bash
npm --prefix _workers_next run build
```

Expected:

- `next build --webpack` 通过
- 没有新增 `pointDiscountEnabled` / `pointDiscountPercent` 缺失的 TypeScript 报错

- [ ] **Step 5: 如用户明确确认提交，再记录数据透传 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/lib/points/product-point-discount.ts _workers_next/src/lib/db/queries.ts _workers_next/src/app/page.tsx _workers_next/src/app/search/page.tsx
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 补齐积分抵扣展示字段透传"
```

---

### Task 2: 在首页和搜索页价格区渲染积分抵扣 badge

**Files:**
- Modify: `_workers_next/src/components/home-content.tsx`
- Modify: `_workers_next/src/components/search-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

- [ ] **Step 1: 新增共用文案，文案只做 badge，不扩成长句说明**

```json
// _workers_next/src/locales/zh.json
{
  "common": {
    "pointDiscountBadge": "积分抵扣{{percent}}%"
  }
}
```

```json
// _workers_next/src/locales/en.json
{
  "common": {
    "pointDiscountBadge": "Points {{percent}}% Off"
  }
}
```

- [ ] **Step 2: 首页商品卡片补齐字段类型，并把 badge 放到原价/折扣同一行**

```tsx
// _workers_next/src/components/home-content.tsx
import { getProductPointDiscountBadge } from "@/lib/points/product-point-discount"

interface Product {
  id: string
  name: string
  description: string | null
  descriptionPlain?: string | null
  price: string
  compareAtPrice?: string | null
  pointDiscountEnabled?: boolean | null
  pointDiscountPercent?: number | null
  image: string | null
  category: string | null
  stockCount: number
  soldCount: number
  isHot?: boolean | null
  rating?: number
  reviewCount?: number
  variantCount?: number
  priceMin?: number
  priceMax?: number
}
```

```tsx
// inside the homepage card price row in _workers_next/src/components/home-content.tsx
const pointDiscountBadge = getProductPointDiscountBadge({
  pointDiscountEnabled: product.pointDiscountEnabled,
  pointDiscountPercent: product.pointDiscountPercent,
})

{product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
  <>
    <span className="text-sm tabular-nums text-muted-foreground/50 line-through">
      {Number(product.compareAtPrice)}
    </span>
    <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-400">
      -{Math.round((1 - Number(product.price) / Number(product.compareAtPrice)) * 100)}%
    </span>
  </>
)}
{pointDiscountBadge && (
  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
    {t("common.pointDiscountBadge", { percent: pointDiscountBadge.percent })}
  </span>
)}
```

- [ ] **Step 3: 搜索结果页补齐字段类型，并在价格区紧跟价格/划线价后面渲染 badge**

```tsx
// _workers_next/src/components/search-content.tsx
import { getProductPointDiscountBadge } from "@/lib/points/product-point-discount"

type Product = {
  id: string
  name: string
  description: string | null
  price: string
  compareAtPrice: string | null
  pointDiscountEnabled?: boolean | null
  pointDiscountPercent?: number | null
  image: string | null
  category: string | null
  isHot: boolean
  stockCount: number
  soldCount: number
}
```

```tsx
// inside the search result card price row in _workers_next/src/components/search-content.tsx
const pointDiscountBadge = getProductPointDiscountBadge({
  pointDiscountEnabled: product.pointDiscountEnabled,
  pointDiscountPercent: product.pointDiscountPercent,
})

<div className="flex items-end gap-2">
  <span className="text-2xl font-bold font-mono tracking-tight">{Number(product.price)}</span>
  {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
    <span className="text-xs text-muted-foreground line-through">{Number(product.compareAtPrice)}</span>
  )}
  {pointDiscountBadge && (
    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
      {t("common.pointDiscountBadge", { percent: pointDiscountBadge.percent })}
    </span>
  )}
</div>
```

- [ ] **Step 4: 重新构建，并做首页/搜索页手动冒烟**

Run:

```bash
npm --prefix _workers_next run build
npm --prefix _workers_next run dev
```

Manual checklist:

- 首页中未开启积分抵扣的商品不显示 badge
- 首页中开启 `10%` 的商品，在 `-25%` 那一行看到 `积分抵扣10%`
- 搜索页中开启 `10%` 的商品，在价格区域看到 `积分抵扣10%`
- 搜索页中没有原价折扣的商品，仍然可以单独显示积分抵扣 badge
- 变体组卡片沿用代表商品配置，不新增额外聚合逻辑

- [ ] **Step 5: 如用户明确确认提交，再记录首页/搜索页 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/components/home-content.tsx _workers_next/src/components/search-content.tsx _workers_next/src/locales/zh.json _workers_next/src/locales/en.json
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 增加商品列表积分抵扣标识"
```

---

### Task 3: 在商品详情页价格区补齐积分抵扣 badge 并完成最终验证

**Files:**
- Modify: `_workers_next/src/components/buy-content.tsx`

- [ ] **Step 1: 在详情页价格区复用同一个 helper，和折扣 badge 并列显示**

```tsx
// _workers_next/src/components/buy-content.tsx
import { getProductPointDiscountBadge } from "@/lib/points/product-point-discount"

const pointDiscountBadge = getProductPointDiscountBadge({
  pointDiscountEnabled: displayProduct.pointDiscountEnabled,
  pointDiscountPercent: displayProduct.pointDiscountPercent,
})
```

```tsx
// inside the price row in _workers_next/src/components/buy-content.tsx
<div className="flex flex-wrap items-baseline gap-2">
  <span className="text-3xl font-semibold tracking-tight text-primary tabular-nums">
    {priceValue}
  </span>
  <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
    {t('common.credits')}
  </span>
  {compareAtPriceValue && compareAtPriceValue > priceValue && (
    <>
      <span className="text-sm tabular-nums text-muted-foreground/50 line-through">
        {compareAtPriceValue}
      </span>
      <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-400">
        -{Math.round((1 - priceValue / compareAtPriceValue) * 100)}%
      </span>
    </>
  )}
  {pointDiscountBadge && (
    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
      {t("common.pointDiscountBadge", { percent: pointDiscountBadge.percent })}
    </span>
  )}
</div>
```

- [ ] **Step 2: 跑最终构建验证，确保详情页没有引入新的类型或编译问题**

Run:

```bash
npm --prefix _workers_next run build
```

Expected:

- `next build --webpack` 通过
- 没有新增 i18n key 缺失或组件属性缺失报错

- [ ] **Step 3: 做完整手动验证矩阵，覆盖三处页面与两类商品场景**

Run:

```bash
npm --prefix _workers_next run dev
```

Manual checklist:

- 商品关闭积分抵扣：
  - 首页不显示 badge
  - 搜索页不显示 badge
  - 商品详情页不显示 badge

- 商品开启 `10%`：
  - 首页价格区显示 `积分抵扣10%`
  - 搜索页价格区显示 `积分抵扣10%`
  - 商品详情页价格区显示 `积分抵扣10%`

- 商品同时存在原价折扣和积分抵扣：
  - 首页同时显示折扣 badge 和积分抵扣 badge
  - 商品详情页同时显示折扣 badge 和积分抵扣 badge

- 没有原价折扣、只有积分抵扣：
  - 搜索页单独显示积分抵扣 badge
  - 商品详情页单独显示积分抵扣 badge

- [ ] **Step 4: 如用户明确确认提交，再记录最终交付 commit**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/components/buy-content.tsx
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 增加商品详情积分抵扣标识"
```

---

## Self-Review

### 1. Spec Coverage

- 首页商品卡片 badge：Task 2
- 搜索结果页 badge：Task 2
- 商品详情页 badge：Task 3
- 展示条件 `pointDiscountEnabled = true` 且 `pointDiscountPercent > 0`：Task 1
- 中英文文案：Task 2
- 不改积分结算逻辑、购买弹窗结构、后台配置：Architecture + File Structure 已约束

### 2. Placeholder Scan

- 未使用 `TODO`、`TBD`、`后续补` 这类占位词
- 每个任务都写明了修改文件、代码片段、命令和预期验证结果

### 3. Type Consistency

- 全程统一使用 `pointDiscountEnabled` / `pointDiscountPercent`
- 三个页面统一复用 `getProductPointDiscountBadge`
- 列表页变体组展示统一沿用 `groupProductsAsVariants` 的代表商品配置，没有额外引入 `groupPointDiscount*` 新字段
