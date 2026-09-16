# `_workers_next` 后台积分抵扣与订单金额展示补充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `_workers_next` 的商品管理列表、订单管理列表和订单详情页补齐积分抵扣与订单金额构成展示，让后台能清楚看到商品支持的积分抵扣比例，以及每笔订单的 `LDC 实付 + 积分抵扣 + 订单合计`。

**Architecture:** 本次只补后台展示层和取数字段透传，不改数据库结构、不改下单扣款逻辑、不改积分记账逻辑。商品管理列表复用现有 `common.pointDiscountBadge` 文案展示商品积分抵扣比例；订单列表和详情页统一通过一个轻量金额拆分 helper 计算 `amount + pointsUsed`，确保两个页面展示口径完全一致。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Drizzle ORM、Cloudflare D1、JSON i18n。

---

> **执行约束**
>
> - 当前仓库 `AGENTS.md` 规定：`git commit` 属危险操作。计划中保留提交步骤，但执行前必须再次得到用户明确确认。
> - 当前仓库没有现成的前端单元测试基建；本轮采用“精确改动 + `npm --prefix _workers_next run build` + 后台页面手动冒烟”的最小闭环，不顺手引入新测试框架。
> - 当前工作区已经存在与本任务无关的未提交改动。执行时只按文件路径精确暂存本任务相关文件，不回滚、不覆盖其他 diff。
> - 本计划不包含数据库迁移，不需要提前新增表或改表。

## File Structure

### New Files

- Create: `_workers_next/src/lib/order-payment-breakdown.ts`

### Modified Files

- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/app/admin/products/page.tsx`
- Modify: `_workers_next/src/components/admin/products-content.tsx`
- Modify: `_workers_next/src/app/admin/orders/page.tsx`
- Modify: `_workers_next/src/components/admin/orders-content.tsx`
- Modify: `_workers_next/src/app/admin/orders/[id]/page.tsx`
- Modify: `_workers_next/src/components/admin/order-detail-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

### Responsibility Map

- `_workers_next/src/lib/db/queries.ts`
  负责给后台商品列表查询补齐 `pointDiscountEnabled`、`pointDiscountPercent`，不改其他前台查询。

- `_workers_next/src/app/admin/products/page.tsx`
  负责把商品积分抵扣配置透传给后台商品列表组件，不在页面层做展示判断。

- `_workers_next/src/components/admin/products-content.tsx`
  负责在商品价格单元格内补轻量 badge，文案形如 `积分抵扣10%`。

- `_workers_next/src/lib/order-payment-breakdown.ts`
  负责统一计算订单展示金额拆分：
  `LDC 实付 = Number(amount)`、
  `积分抵扣 = Number(pointsUsed || 0)`、
  `订单合计 = Number(amount) + Number(pointsUsed || 0)`。

- `_workers_next/src/app/admin/orders/page.tsx`
  负责给订单列表组件透传 `pointsUsed`。

- `_workers_next/src/components/admin/orders-content.tsx`
  负责把订单列表金额列改成三行展示，清楚显示 `LDC 实付 / 积分抵扣 / 订单合计`。

- `_workers_next/src/app/admin/orders/[id]/page.tsx`
  负责给订单详情组件透传 `pointsUsed`。

- `_workers_next/src/components/admin/order-detail-content.tsx`
  负责把单值金额改为“支付明细”区块，并与订单列表页共用同一金额拆分规则。

- `_workers_next/src/locales/zh.json`
  负责新增后台订单支付明细中文文案。

- `_workers_next/src/locales/en.json`
  负责新增后台订单支付明细英文文案。

---

### Task 1: 打通商品管理列表的积分抵扣比例展示

**Files:**
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/app/admin/products/page.tsx`
- Modify: `_workers_next/src/components/admin/products-content.tsx`

- [ ] **Step 1: 给后台商品查询补齐积分抵扣字段，不改其他查询函数**

```ts
// _workers_next/src/lib/db/queries.ts
export async function getProducts() {
    return await withProductColumnFallback(async () => {
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
            isActive: products.isActive,
            isShared: products.isShared,
            visibilityLevel: products.visibilityLevel,
            sortOrder: products.sortOrder,
            purchaseLimit: products.purchaseLimit,
            pointDiscountEnabled: products.pointDiscountEnabled,
            pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`
        })
            .from(products)
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    })
}
```

- [ ] **Step 2: 页面层继续透传积分字段，避免组件里再读原始数据库对象**

```ts
// _workers_next/src/app/admin/products/page.tsx
        <AdminProductsContent
            products={products.map((p: any) => {
                const stat = liveStats.get(p.id) || { unused: 0, available: 0, locked: 0 }
                const available = p.isShared
                    ? (stat.unused > 0 ? INFINITE_STOCK : 0)
                    : stat.available
                const locked = stat.locked
                const stockCount = available >= INFINITE_STOCK ? INFINITE_STOCK : (available + locked)
                return {
                    id: p.id,
                    name: p.name,
                    price: p.price,
                    compareAtPrice: p.compareAtPrice ?? null,
                    category: p.category,
                    stockCount,
                    isActive: p.isActive ?? true,
                    isHot: p.isHot ?? false,
                    sortOrder: p.sortOrder ?? 0,
                    pointDiscountEnabled: Boolean(p.pointDiscountEnabled),
                    pointDiscountPercent: Number(p.pointDiscountPercent || 0),
                    variantGroupId: p.variantGroupId ?? null,
                    variantLabel: p.variantLabel ?? null
                }
            })}
            lowStockThreshold={lowStockThreshold}
        />
```

- [ ] **Step 3: 商品列表价格单元格补轻量 badge，关闭时不显示，开启时显示比例**

```tsx
// _workers_next/src/components/admin/products-content.tsx
interface Product {
    id: string
    name: string
    price: string
    compareAtPrice: string | null
    category: string | null
    stockCount: number
    isActive: boolean
    isHot: boolean
    sortOrder: number
    pointDiscountEnabled?: boolean | null
    pointDiscountPercent?: number
    variantGroupId?: string | null
    variantLabel?: string | null
}
```

```tsx
// inside the price cell in _workers_next/src/components/admin/products-content.tsx
<TableCell>
    <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
            <span>{Number(product.price)}</span>
            {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
                <span className="text-xs text-muted-foreground line-through">
                    {Number(product.compareAtPrice)}
                </span>
            )}
        </div>
        {product.pointDiscountEnabled && Number(product.pointDiscountPercent || 0) > 0 && (
            <Badge variant="secondary" className="w-fit text-[10px]">
                {t('common.pointDiscountBadge', { percent: Number(product.pointDiscountPercent || 0) })}
            </Badge>
        )}
    </div>
</TableCell>
```

- [ ] **Step 4: 跑构建并手动检查商品管理列表两种场景**

Run:

```bash
npm --prefix _workers_next run build
```

Expected:

- `next build --webpack` 通过
- 没有新增 `pointDiscountEnabled` / `pointDiscountPercent` 缺失的 TypeScript 报错

Manual checklist:

- 访问 `/admin/products`
- 未开启积分抵扣的商品，不显示 badge
- 开启 `10%` 的商品，在价格单元格看到 `积分抵扣10%`
- 原价删除线仍保持原样，badge 不挤坏表格布局

- [ ] **Step 5: 如用户明确确认提交，再记录商品管理列表 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop status --short
git -C E:/local_project/git/ldc-shop add _workers_next/src/lib/db/queries.ts _workers_next/src/app/admin/products/page.tsx _workers_next/src/components/admin/products-content.tsx
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 补充后台商品积分抵扣展示"
```

---

### Task 2: 打通订单列表的积分抵扣与订单合计展示

**Files:**
- Create: `_workers_next/src/lib/order-payment-breakdown.ts`
- Modify: `_workers_next/src/app/admin/orders/page.tsx`
- Modify: `_workers_next/src/components/admin/orders-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

- [ ] **Step 1: 新建订单金额拆分 helper，统一列表页和详情页的金额口径**

```ts
// _workers_next/src/lib/order-payment-breakdown.ts
// getOrderPaymentBreakdown 计算订单展示层的支付构成
//
// 参数:
//   - input.amount: 订单实际 LDC 扣款金额
//   - input.pointsUsed: 订单实际使用的积分数量
//
// 元数据:
//   - 作者: Codex
//   - 创建时间: 2026-04-19
//   - 更新时间: 2026-04-19
//   - 更新内容: 新增后台订单金额拆分展示 helper。
export function getOrderPaymentBreakdown(input: {
    amount: string | number | null | undefined
    pointsUsed: string | number | null | undefined
}) {
    const ldcAmount = Number(input.amount || 0)
    const pointsAmount = Number(input.pointsUsed || 0)

    return {
        ldcAmount,
        pointsAmount,
        totalAmount: ldcAmount + pointsAmount
    }
}
```

- [ ] **Step 2: 订单列表查询结果增加 `pointsUsed`，页面层先把空值收敛成数字**

```ts
// _workers_next/src/app/admin/orders/page.tsx
        <AdminOrdersContent
            orders={rows.map((o: any) => ({
                orderId: o.orderId,
                productId: o.productId,
                userId: o.userId,
                username: (o.userId && usernameByUserId.get(o.userId)) || o.username,
                email: o.email,
                productName: o.productName,
                amount: o.amount,
                pointsUsed: Number(o.pointsUsed || 0),
                status: o.status,
                cardKey: o.cardKey,
                tradeNo: o.tradeNo,
                createdAt: o.createdAt
            }))}
            productVariantLabels={productVariantLabels}
            total={total}
            page={page}
            pageSize={pageSize}
            query={q}
            status={status}
        />
```

- [ ] **Step 3: 订单列表金额列改成三行展示，`pointsUsed = 0` 也必须显示**

```tsx
// _workers_next/src/components/admin/orders-content.tsx
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"

interface Order {
    orderId: string
    productId?: string | null
    userId: string | null
    username: string | null
    email: string | null
    productName: string
    amount: string
    pointsUsed: number
    status: string | null
    cardKey: string | null
    tradeNo: string | null
    createdAt: Date | null
}
```

```tsx
// inside the order row in _workers_next/src/components/admin/orders-content.tsx
<TableCell>
    {(() => {
        const breakdown = getOrderPaymentBreakdown({
            amount: order.amount,
            pointsUsed: order.pointsUsed
        })

        return (
            <div className="space-y-1 text-sm leading-5">
                <div className="font-medium">
                    {t('admin.orders.ldcPaid')} {breakdown.ldcAmount}
                </div>
                <div className="text-muted-foreground">
                    {t('admin.orders.pointsDeduction')} {breakdown.pointsAmount}
                </div>
                <div className="text-xs text-muted-foreground">
                    {t('admin.orders.orderTotal')} {breakdown.totalAmount}
                </div>
            </div>
        )
    })()}
</TableCell>
```

- [ ] **Step 4: 增加后台订单支付明细文案，并验证订单列表三种金额场景**

```json
// _workers_next/src/locales/zh.json
{
    "admin": {
        "orders": {
            "paymentBreakdown": "支付明细",
            "ldcPaid": "LDC 实付",
            "pointsDeduction": "积分抵扣",
            "orderTotal": "订单合计"
        }
    }
}
```

```json
// _workers_next/src/locales/en.json
{
    "admin": {
        "orders": {
            "paymentBreakdown": "Payment Breakdown",
            "ldcPaid": "LDC Paid",
            "pointsDeduction": "Points Deduction",
            "orderTotal": "Order Total"
        }
    }
}
```

Run:

```bash
npm --prefix _workers_next run build
```

Manual checklist:

- 访问 `/admin/orders`
- 纯 LDC 订单显示：
  - `LDC 实付 X`
  - `积分抵扣 0`
  - `订单合计 X`
- 部分积分抵扣订单显示：
  - `LDC 实付 90`
  - `积分抵扣 10`
  - `订单合计 100`
- 零元积分订单显示：
  - `LDC 实付 0`
  - `积分抵扣 X`
  - `订单合计 X`

- [ ] **Step 5: 如用户明确确认提交，再记录订单列表 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop status --short
git -C E:/local_project/git/ldc-shop add _workers_next/src/lib/order-payment-breakdown.ts _workers_next/src/app/admin/orders/page.tsx _workers_next/src/components/admin/orders-content.tsx _workers_next/src/locales/zh.json _workers_next/src/locales/en.json
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 补充后台订单金额拆分展示"
```

---

### Task 3: 补齐订单详情页支付明细并完成列表/详情页口径对齐

**Files:**
- Modify: `_workers_next/src/app/admin/orders/[id]/page.tsx`
- Modify: `_workers_next/src/components/admin/order-detail-content.tsx`

- [ ] **Step 1: 订单详情页查询结果透传 `pointsUsed`，不改现有订单查询方式**

```ts
// _workers_next/src/app/admin/orders/[id]/page.tsx
  return (
    <AdminOrderDetailContent
      order={{
        orderId: order.orderId,
        username: order.username,
        userId: order.userId,
        email: order.email,
        productId: order.productId,
        productName: order.productName,
        productVariantLabel,
        amount: order.amount,
        pointsUsed: Number(order.pointsUsed || 0),
        status: order.status,
        tradeNo: order.tradeNo,
        cardKey: order.cardKey,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        deliveredAt: order.deliveredAt,
      }}
    />
  )
```

- [ ] **Step 2: 把单值金额替换为“支付明细”区块，和订单列表复用同一 helper**

```tsx
// _workers_next/src/components/admin/order-detail-content.tsx
import { getOrderPaymentBreakdown } from "@/lib/order-payment-breakdown"

export function AdminOrderDetailContent({ order }: { order: any }) {
  const { t } = useI18n()
  const router = useRouter()
  const paymentBreakdown = getOrderPaymentBreakdown({
    amount: order.amount,
    pointsUsed: order.pointsUsed
  })
  // ...
}
```

```tsx
// replace the amount block in _workers_next/src/components/admin/order-detail-content.tsx
<div className="space-y-2">
  <div className="text-sm text-muted-foreground">{t('admin.orders.paymentBreakdown')}</div>
  <div className="rounded-md border bg-muted/30 p-3 space-y-2">
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{t('admin.orders.ldcPaid')}</span>
      <span className="font-medium">{paymentBreakdown.ldcAmount}</span>
    </div>
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{t('admin.orders.pointsDeduction')}</span>
      <span className="font-medium">{paymentBreakdown.pointsAmount}</span>
    </div>
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{t('admin.orders.orderTotal')}</span>
      <span className="font-semibold">{paymentBreakdown.totalAmount}</span>
    </div>
  </div>
</div>
```

- [ ] **Step 3: 跑最终构建，确认详情页没有引入新的类型或导入问题**

Run:

```bash
npm --prefix _workers_next run build
```

Expected:

- `next build --webpack` 通过
- 没有新增 `pointsUsed`、`paymentBreakdown` 或 helper 导入相关报错

- [ ] **Step 4: 做最终手动对账，确保列表页和详情页对同一订单完全一致**

Run:

```bash
npm --prefix _workers_next run dev
```

Manual checklist:

- 从 `/admin/orders` 打开一笔纯 LDC 订单详情，列表和详情的三项金额完全一致
- 从 `/admin/orders` 打开一笔部分积分抵扣订单详情，列表和详情的三项金额完全一致
- 从 `/admin/orders` 打开一笔零元积分订单详情，详情页显示：
  - `LDC 实付 0`
  - `积分抵扣 X`
  - `订单合计 X`
- 订单详情原有商品信息、用户信息、交易号、卡密、时间信息仍正常显示

- [ ] **Step 5: 如用户明确确认提交，再记录最终交付 commit**

```bash
git -C E:/local_project/git/ldc-shop status --short
git -C E:/local_project/git/ldc-shop add _workers_next/src/app/admin/orders/[id]/page.tsx _workers_next/src/components/admin/order-detail-content.tsx
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 补充后台订单支付明细"
```

---

## Self-Review

### 1. Spec Coverage

- 商品管理列表显示积分抵扣比例：Task 1
- 订单管理列表显示 `LDC 实付 / 积分抵扣 / 订单合计`：Task 2
- 订单详情页显示支付明细区块：Task 3
- `pointsUsed = 0` 仍必须显示：Task 2 + Task 3
- 纯 LDC / 部分积分抵扣 / 零元积分订单三个场景：Task 2 + Task 3
- 不改数据库结构、不改下单结算逻辑：Header + 执行约束已锁定

### 2. Placeholder Scan

- 未出现任何占位式描述，步骤都已写成可直接执行的具体动作
- 每个任务都写明了修改文件、代码片段、构建命令、手动验证场景和提交命令

### 3. Type Consistency

- 商品列表统一使用 `pointDiscountEnabled` / `pointDiscountPercent`
- 订单列表和详情页统一使用 `pointsUsed`
- 金额拆分逻辑统一复用 `getOrderPaymentBreakdown`
- 后台订单文案统一使用 `paymentBreakdown` / `ldcPaid` / `pointsDeduction` / `orderTotal`
