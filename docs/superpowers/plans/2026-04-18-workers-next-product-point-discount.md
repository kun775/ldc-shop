# `_workers_next` 商品签到积分抵扣 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `_workers_next` 增加商品级签到积分抵扣配置，并把下单默认路径恢复为 `credit.linux.do` 授权扣款，只按商品配置的百分比使用签到积分抵扣。

**Architecture:** 采用“纯函数规则先落地、后台配置再接入、前台展示与服务端结算共用同一套计算函数”的方案。商品表新增 `point_discount_enabled` 和 `point_discount_percent` 两个字段；管理端只负责采集配置，买页与下单 action 都通过共享的 `product-point-discount` 规则函数计算展示与最终金额，避免前后端各算一套。

**Tech Stack:** Next.js 16 App Router、TypeScript、Drizzle ORM、Cloudflare D1、Vitest、Testing Library、Next Server Actions。

---

> **执行约束**
>
> - 当前仓库 `AGENTS.md` 规定：`git commit` 需要用户明确确认。本计划保留提交步骤，但实际执行前必须再次征得用户确认。
> - 当前工作区已经有 `_workers_next/package.json`、`_workers_next/package-lock.json` 和 `docs/` 的未提交改动。执行时只整理本功能相关 diff，不回滚或覆盖已有修改。

## File Structure

### New Files

- Create: `_workers_next/vitest.config.ts`
- Create: `_workers_next/src/test/setup.ts`
- Create: `_workers_next/src/lib/points/product-point-discount.ts`
- Create: `_workers_next/src/lib/points/product-point-discount.test.ts`
- Create: `_workers_next/src/components/buy-button.test.tsx`

### Modified Files

- Modify: `_workers_next/package.json`
- Modify: `_workers_next/package-lock.json`
- Modify: `_workers_next/src/lib/db/schema.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/actions/admin.ts`
- Modify: `_workers_next/src/actions/data.ts`
- Modify: `_workers_next/src/actions/checkout.ts`
- Modify: `_workers_next/src/app/buy/[id]/page.tsx`
- Modify: `_workers_next/src/components/admin/product-form.tsx`
- Modify: `_workers_next/src/components/buy-button.tsx`
- Modify: `_workers_next/src/components/buy-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

### Responsibility Map

- `_workers_next/src/lib/points/product-point-discount.ts`
  负责商品积分抵扣的唯一规则源：配置归一化、展示计算、服务端最终金额计算。

- `_workers_next/src/actions/admin.ts`
  负责解析商品表单中的积分抵扣配置，并在保存商品时写入 D1。

- `_workers_next/src/lib/db/queries.ts`
  负责补齐新列、初始化 D1 表结构，并把新字段暴露给 `getProduct`、`getProductVariants`、`getProductForAdmin`。

- `_workers_next/src/components/admin/product-form.tsx`
  负责后台商品编辑页的“开启签到积分抵扣金额 / 抵扣百分比”交互。

- `_workers_next/src/components/buy-content.tsx`
  负责把商品的抵扣配置透传给购买弹窗，包含单规格和多规格场景。

- `_workers_next/src/components/buy-button.tsx`
  负责购买弹窗里的默认未勾选、积分抵扣显隐、支付总价展示。

- `_workers_next/src/actions/checkout.ts`
  负责服务端最终校验：即使前端传 `usePoints=true`，也只能按商品配置比例抵扣，其他金额继续走 `credit.linux.do`。

---

### Task 1: 建立测试基建并落地共享积分抵扣规则函数

**Files:**
- Modify: `_workers_next/package.json`
- Modify: `_workers_next/package-lock.json`
- Create: `_workers_next/vitest.config.ts`
- Create: `_workers_next/src/test/setup.ts`
- Create: `_workers_next/src/lib/points/product-point-discount.ts`
- Create: `_workers_next/src/lib/points/product-point-discount.test.ts`

- [ ] **Step 1: 先写失败测试，锁定配置归一化与金额计算规则**

```ts
// _workers_next/src/lib/points/product-point-discount.test.ts
import { describe, expect, it } from "vitest";
import {
  calculatePointDiscountPreview,
  normalizeProductPointDiscountConfig,
} from "./product-point-discount";

describe("normalizeProductPointDiscountConfig", () => {
  it("forces percent to 0 when point discount is disabled", () => {
    expect(
      normalizeProductPointDiscountConfig({
        pointDiscountEnabled: false,
        pointDiscountPercent: "35",
      })
    ).toEqual({
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    });
  });

  it("rejects non-integer percent when point discount is enabled", () => {
    expect(() =>
      normalizeProductPointDiscountConfig({
        pointDiscountEnabled: true,
        pointDiscountPercent: "10.5",
      })
    ).toThrow("INVALID_POINT_DISCOUNT_PERCENT");
  });

  it("rejects out-of-range percent when point discount is enabled", () => {
    expect(() =>
      normalizeProductPointDiscountConfig({
        pointDiscountEnabled: true,
        pointDiscountPercent: "101",
      })
    ).toThrow("POINT_DISCOUNT_PERCENT_OUT_OF_RANGE");
  });
});

describe("calculatePointDiscountPreview", () => {
  it("caps point usage to the configured percent", () => {
    expect(
      calculatePointDiscountPreview({
        orderAmount: 100,
        availablePoints: 999,
        usePoints: true,
        pointDiscountEnabled: true,
        pointDiscountPercent: 10,
      })
    ).toMatchObject({
      shouldShowPointOption: true,
      maxDiscountPoints: 10,
      pointsToUse: 10,
      finalAmount: 90,
    });
  });

  it("keeps original amount when percent rounds down below one whole point", () => {
    expect(
      calculatePointDiscountPreview({
        orderAmount: 9.9,
        availablePoints: 50,
        usePoints: true,
        pointDiscountEnabled: true,
        pointDiscountPercent: 10,
      })
    ).toMatchObject({
      shouldShowPointOption: false,
      maxDiscountPoints: 0,
      pointsToUse: 0,
      finalAmount: 9.9,
    });
  });

  it("allows a zero-price order only when the config is 100 percent and points are sufficient", () => {
    expect(
      calculatePointDiscountPreview({
        orderAmount: 25,
        availablePoints: 25,
        usePoints: true,
        pointDiscountEnabled: true,
        pointDiscountPercent: 100,
      })
    ).toMatchObject({
      maxDiscountPoints: 25,
      pointsToUse: 25,
      finalAmount: 0,
    });
  });
});
```

- [ ] **Step 2: 补最小可运行的 Vitest 基建**

```json
// _workers_next/package.json
{
  "scripts": {
    "dev": "next dev --webpack",
    "build": "next build --webpack",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "opennextjs-cloudflare build && wrangler deploy"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "jsdom": "^25.0.1",
    "vitest": "^2.1.4"
  }
}
```

```ts
// _workers_next/vitest.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

```ts
// _workers_next/src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

Run:

```bash
npm --prefix _workers_next install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Expected:

- `package.json` 和 `package-lock.json` 被更新
- 依赖安装成功，无 `npm ERR!`

- [ ] **Step 3: 运行测试，确认当前处于 RED 状态**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts
```

Expected:

- 失败
- 报错集中在 `product-point-discount.ts` 尚不存在或导出缺失

- [ ] **Step 4: 实现共享规则函数，只写通过测试所需的最小代码**

```ts
// _workers_next/src/lib/points/product-point-discount.ts
export interface ProductPointDiscountConfig {
  pointDiscountEnabled: boolean;
  pointDiscountPercent: number;
}

export interface PointDiscountPreview extends ProductPointDiscountConfig {
  shouldShowPointOption: boolean;
  maxDiscountPoints: number;
  pointsToUse: number;
  finalAmount: number;
}

function parseIntegerPercent(raw: number | string | null | undefined) {
  if (raw === null || raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error("INVALID_POINT_DISCOUNT_PERCENT");
  }
  return value;
}

export function normalizeProductPointDiscountConfig(input: {
  pointDiscountEnabled: boolean;
  pointDiscountPercent: number | string | null | undefined;
}): ProductPointDiscountConfig {
  if (!input.pointDiscountEnabled) {
    return {
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    };
  }

  const percent = parseIntegerPercent(input.pointDiscountPercent);
  if (percent < 1 || percent > 100) {
    throw new Error("POINT_DISCOUNT_PERCENT_OUT_OF_RANGE");
  }

  return {
    pointDiscountEnabled: true,
    pointDiscountPercent: percent,
  };
}

export function calculatePointDiscountPreview(input: {
  orderAmount: number;
  availablePoints: number;
  usePoints: boolean;
  pointDiscountEnabled: boolean;
  pointDiscountPercent: number;
}): PointDiscountPreview {
  const config = normalizeProductPointDiscountConfig({
    pointDiscountEnabled: input.pointDiscountEnabled,
    pointDiscountPercent: input.pointDiscountPercent,
  });

  const safeAmount = Number.isFinite(input.orderAmount) && input.orderAmount > 0
    ? input.orderAmount
    : 0;
  const safePoints = Number.isFinite(input.availablePoints) && input.availablePoints > 0
    ? Math.floor(input.availablePoints)
    : 0;
  const maxDiscountPoints = config.pointDiscountEnabled
    ? Math.max(0, Math.floor((safeAmount * config.pointDiscountPercent) / 100))
    : 0;
  const shouldShowPointOption = config.pointDiscountEnabled && safePoints > 0 && maxDiscountPoints > 0;
  const pointsToUse = shouldShowPointOption && input.usePoints
    ? Math.min(safePoints, maxDiscountPoints)
    : 0;
  const finalAmount = Math.max(0, safeAmount - pointsToUse);

  return {
    ...config,
    shouldShowPointOption,
    maxDiscountPoints,
    pointsToUse,
    finalAmount,
  };
}
```

- [ ] **Step 5: 重新运行单测，确认规则函数进入 GREEN**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts
```

Expected:

- `PASS src/lib/points/product-point-discount.test.ts`

- [ ] **Step 6: 如用户明确确认提交，再记录本任务 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/package.json _workers_next/package-lock.json _workers_next/vitest.config.ts _workers_next/src/test/setup.ts _workers_next/src/lib/points/product-point-discount.ts _workers_next/src/lib/points/product-point-discount.test.ts
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 新增商品积分抵扣规则函数"
```

---

### Task 2: 打通商品表结构、后台保存和编辑页配置

**Files:**
- Modify: `_workers_next/src/lib/points/product-point-discount.ts`
- Modify: `_workers_next/src/lib/db/schema.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/actions/admin.ts`
- Modify: `_workers_next/src/actions/data.ts`
- Modify: `_workers_next/src/components/admin/product-form.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

- [ ] **Step 1: 先扩失败测试，锁定后台保存时的配置归一化规则**

```ts
// Append to _workers_next/src/lib/points/product-point-discount.test.ts
it("treats a blank percent as required when the toggle is enabled", () => {
  expect(() =>
    normalizeProductPointDiscountConfig({
      pointDiscountEnabled: true,
      pointDiscountPercent: "",
    })
  ).toThrow("POINT_DISCOUNT_PERCENT_REQUIRED");
});

it("trims whitespace from a whole-number percent when enabled", () => {
  expect(
    normalizeProductPointDiscountConfig({
      pointDiscountEnabled: true,
      pointDiscountPercent: " 35 ",
    })
  ).toEqual({
    pointDiscountEnabled: true,
    pointDiscountPercent: 35,
  });
});
```

- [ ] **Step 2: 运行单测，确认新增断言先失败**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts
```

Expected:

- 失败
- `normalizeProductPointDiscountConfig` 还没有把空字符串识别成必填错误

- [ ] **Step 3: 修改 schema、查询和商品保存逻辑，把新字段真正落到 D1**

```ts
// _workers_next/src/lib/points/product-point-discount.ts
function parseIntegerPercent(raw: number | string | null | undefined) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.trim() === "") {
    throw new Error("POINT_DISCOUNT_PERCENT_REQUIRED");
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error("INVALID_POINT_DISCOUNT_PERCENT");
  }
  return value;
}
```

```ts
// _workers_next/src/lib/db/schema.ts
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: text("price").notNull(),
  compareAtPrice: text("compare_at_price"),
  category: text("category"),
  image: text("image"),
  productImages: text("product_images"),
  isHot: integer("is_hot", { mode: "boolean" }).default(false),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  isShared: integer("is_shared", { mode: "boolean" }).default(false),
  sortOrder: integer("sort_order").default(0),
  purchaseLimit: integer("purchase_limit"),
  purchaseWarning: text("purchase_warning"),
  visibilityLevel: integer("visibility_level").default(-1),
  pointDiscountEnabled: integer("point_discount_enabled", { mode: "boolean" }).default(false),
  pointDiscountPercent: integer("point_discount_percent").default(0),
  stockCount: integer("stock_count").default(0),
  lockedCount: integer("locked_count").default(0),
  soldCount: integer("sold_count").default(0),
  // ...
});
```

```ts
// _workers_next/src/lib/db/queries.ts
const CURRENT_SCHEMA_VERSION = 21;

async function ensureProductsColumns() {
  await ensureColumnsOnce("products", async () => {
    await safeAddColumn("products", "compare_at_price", "TEXT");
    await safeAddColumn("products", "is_hot", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "purchase_warning", "TEXT");
    await safeAddColumn("products", "is_shared", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "visibility_level", "INTEGER DEFAULT -1");
    await safeAddColumn("products", "point_discount_enabled", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "point_discount_percent", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "stock_count", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "locked_count", "INTEGER DEFAULT 0");
    await safeAddColumn("products", "sold_count", "INTEGER DEFAULT 0");
    // ...
  });
}

export async function getProductForAdmin(id: string) {
  return await withProductColumnFallback(async () => {
    const result = await db.select({
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
      purchaseLimit: products.purchaseLimit,
      purchaseWarning: products.purchaseWarning,
      pointDiscountEnabled: products.pointDiscountEnabled,
      pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
      visibilityLevel: products.visibilityLevel,
      variantGroupId: products.variantGroupId,
      variantLabel: products.variantLabel,
      purchaseQuestions: products.purchaseQuestions,
    }).from(products).where(eq(products.id, id));

    return result[0] || null;
  });
}
```

```sql
-- inside the first-run CREATE TABLE products block in _workers_next/src/lib/db/queries.ts
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price TEXT NOT NULL,
  compare_at_price TEXT,
  category TEXT,
  image TEXT,
  product_images TEXT,
  is_hot INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_shared INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  purchase_limit INTEGER,
  purchase_warning TEXT,
  visibility_level INTEGER DEFAULT -1,
  point_discount_enabled INTEGER DEFAULT 0,
  point_discount_percent INTEGER DEFAULT 0,
  stock_count INTEGER DEFAULT 0,
  locked_count INTEGER DEFAULT 0,
  sold_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  variant_group_id TEXT,
  variant_label TEXT
);
```

```ts
// _workers_next/src/actions/admin.ts
import {
  normalizeProductPointDiscountConfig,
} from "@/lib/points/product-point-discount";

export async function saveProduct(formData: FormData) {
  await checkAdmin();

  const pointDiscountEnabled = formData.get("pointDiscountEnabled") === "on";
  const pointDiscountPercentRaw = (formData.get("pointDiscountPercent") as string | null)?.trim() ?? "";
  const pointDiscountConfig = normalizeProductPointDiscountConfig({
    pointDiscountEnabled,
    pointDiscountPercent: pointDiscountPercentRaw,
  });

  // ...
  await db.insert(products).values({
    id,
    name,
    description,
    price,
    // ...
    pointDiscountEnabled: pointDiscountConfig.pointDiscountEnabled,
    pointDiscountPercent: pointDiscountConfig.pointDiscountPercent,
  }).onConflictDoUpdate({
    target: products.id,
    set: {
      name,
      description,
      price,
      // ...
      pointDiscountEnabled: pointDiscountConfig.pointDiscountEnabled,
      pointDiscountPercent: pointDiscountConfig.pointDiscountPercent,
    }
  });
}
```

```ts
// _workers_next/src/actions/data.ts
const columnMap: Record<string, string> = {
  // Products
  compareAtPrice: "compare_at_price",
  isHot: "is_hot",
  isActive: "is_active",
  isShared: "is_shared",
  sortOrder: "sort_order",
  purchaseLimit: "purchase_limit",
  purchaseWarning: "purchase_warning",
  visibilityLevel: "visibility_level",
  pointDiscountEnabled: "point_discount_enabled",
  pointDiscountPercent: "point_discount_percent",
  stockCount: "stock_count",
  // ...
};
```

- [ ] **Step 4: 修改后台商品表单，新增开关、输入框和回显**

```tsx
// inside _workers_next/src/components/admin/product-form.tsx
const [pointDiscountEnabled, setPointDiscountEnabled] = useState(
  Boolean(product?.pointDiscountEnabled)
);

useEffect(() => {
  setPointDiscountEnabled(Boolean(product?.pointDiscountEnabled));
}, [product?.id]);

<div className="space-y-3 rounded-md border bg-muted/30 p-3">
  <div className="flex items-center gap-2">
    <Checkbox
      id="pointDiscountEnabled"
      name="pointDiscountEnabled"
      checked={pointDiscountEnabled}
      onCheckedChange={(checked) => setPointDiscountEnabled(Boolean(checked))}
      className="h-4 w-4 accent-primary"
    />
    <div className="flex flex-col">
      <Label htmlFor="pointDiscountEnabled" className="cursor-pointer font-medium">
        {t("admin.productForm.pointDiscountEnabledLabel")}
      </Label>
      <span className="text-xs text-muted-foreground">
        {t("admin.productForm.pointDiscountEnabledHint")}
      </span>
    </div>
  </div>

  <div className="grid gap-2">
    <Label htmlFor="pointDiscountPercent">
      {t("admin.productForm.pointDiscountPercentLabel")}
    </Label>
    <Input
      id="pointDiscountPercent"
      name="pointDiscountPercent"
      type="number"
      min={1}
      max={100}
      step="1"
      defaultValue={currentProduct?.pointDiscountPercent || ""}
      placeholder={t("admin.productForm.pointDiscountPercentPlaceholder")}
      disabled={!pointDiscountEnabled}
      onWheel={(e) => e.currentTarget.blur()}
    />
    <p className="text-xs text-muted-foreground">
      {t("admin.productForm.pointDiscountPercentHint")}
    </p>
  </div>
</div>
```

```json
// _workers_next/src/locales/zh.json
"pointDiscountEnabledLabel": "开启签到积分抵扣金额",
"pointDiscountEnabledHint": "关闭后该商品下单将直接走 credit.linux.do 支付，不显示签到积分抵扣。",
"pointDiscountPercentLabel": "最多抵扣订单金额百分比",
"pointDiscountPercentPlaceholder": "例如 10",
"pointDiscountPercentHint": "填写 10 表示最多抵扣订单金额的 10%，仅支持 1 到 100 的整数。"
```

```json
// _workers_next/src/locales/en.json
"pointDiscountEnabledLabel": "Enable check-in points discount",
"pointDiscountEnabledHint": "When disabled, checkout goes straight to credit.linux.do and no points discount option is shown.",
"pointDiscountPercentLabel": "Maximum order discount percentage",
"pointDiscountPercentPlaceholder": "e.g. 10",
"pointDiscountPercentHint": "Entering 10 means points can cover up to 10% of the order total. Only whole numbers from 1 to 100 are allowed."
```

- [ ] **Step 5: 跑单测与一次构建，确认后台配置链路不破**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts
npm --prefix _workers_next run build
```

Expected:

- `product-point-discount.test.ts` 通过
- `next build --webpack` 通过，无新增 TypeScript 错误

- [ ] **Step 6: 如用户明确确认提交，再记录本任务 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/lib/db/schema.ts _workers_next/src/lib/db/queries.ts _workers_next/src/actions/admin.ts _workers_next/src/actions/data.ts _workers_next/src/components/admin/product-form.tsx _workers_next/src/locales/zh.json _workers_next/src/locales/en.json
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 增加商品积分抵扣配置"
```

---

### Task 3: 打通买页数据透传与购买弹窗默认未勾选行为

**Files:**
- Create: `_workers_next/src/components/buy-button.test.tsx`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/app/buy/[id]/page.tsx`
- Modify: `_workers_next/src/components/buy-content.tsx`
- Modify: `_workers_next/src/components/buy-button.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

- [ ] **Step 1: 先写失败测试，锁定“默认不勾选”和“比例展示”的弹窗行为**

```tsx
// _workers_next/src/components/buy-button.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BuyButton } from "./buy-button";

vi.mock("@/actions/points", () => ({
  getUserPoints: vi.fn().mockResolvedValue(50),
}));

vi.mock("@/actions/checkout", () => ({
  createOrder: vi.fn(),
}));

describe("BuyButton", () => {
  it("does not show a points checkbox when the product config disables point discount", async () => {
    render(
      <BuyButton
        productId="prod_1"
        price="100"
        productName="Test Product"
        quantity={1}
        pointDiscountEnabled={false}
        pointDiscountPercent={0}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Use Points")).not.toBeInTheDocument();
    });
    expect(screen.getByText("100.00")).toBeInTheDocument();
  });

  it("shows the checkbox but keeps it unchecked by default when the product allows a 10 percent discount", async () => {
    render(
      <BuyButton
        productId="prod_1"
        price="100"
        productName="Test Product"
        quantity={1}
        pointDiscountEnabled={true}
        pointDiscountPercent={10}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));

    const checkbox = await screen.findByLabelText("Use Points");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("100.00")).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(screen.getByText("90.00")).toBeInTheDocument();
    expect(screen.getByText(/Up to 10 points can be used/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行组件测试，确认当前处于 RED 状态**

Run:

```bash
npm --prefix _workers_next run test -- src/components/buy-button.test.tsx
```

Expected:

- 失败
- `BuyButton` 还没有 `pointDiscountEnabled` / `pointDiscountPercent` props

- [ ] **Step 3: 修改查询、买页和弹窗，把商品配置真正带到用户界面**

```ts
// _workers_next/src/lib/db/queries.ts
export async function getProduct(id: string, options?: { isLoggedIn?: boolean; trustLevel?: number | null }) {
  return await withProductColumnFallback(async () => {
    const result = await db.select({
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
      sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
      purchaseLimit: products.purchaseLimit,
      purchaseWarning: products.purchaseWarning,
      pointDiscountEnabled: products.pointDiscountEnabled,
      pointDiscountPercent: sql<number>`COALESCE(${products.pointDiscountPercent}, 0)`,
      visibilityLevel: products.visibilityLevel,
      rating: sql<number>`COALESCE(${products.rating}, 0)`,
      reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`,
      variantGroupId: products.variantGroupId,
      variantLabel: products.variantLabel,
      purchaseQuestions: products.purchaseQuestions,
    }).from(products).where(and(eq(products.id, id), visibilityCondition(options?.isLoggedIn, options?.trustLevel)));

    const product = result[0];
    return !product || product.isActive === false ? null : product;
  });
}
```

```ts
// Add to ProductVariantRow and getProductVariants select in _workers_next/src/lib/db/queries.ts
pointDiscountEnabled: boolean | null;
pointDiscountPercent: number;
```

```tsx
// _workers_next/src/app/buy/[id]/page.tsx
return (
  <BuyContent
    product={product}
    stockCount={liveAvailable}
    lockedStockCount={liveLocked}
    isLoggedIn={!!session?.user}
    reviews={[]}
    averageRating={Number(product.rating || 0)}
    reviewCount={Number(product.reviewCount || 0)}
    canReview={false}
    reviewOrderId={undefined}
    emailConfigured={false}
    variants={variantsWithStock.length > 1 ? variantsWithStock : undefined}
  />
);
```

```tsx
// _workers_next/src/components/buy-content.tsx
interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string;
  compareAtPrice?: string | null;
  image: string | null;
  productImages?: string | null;
  category: string | null;
  purchaseLimit?: number | null;
  purchaseWarning?: string | null;
  purchaseQuestions?: string | null;
  pointDiscountEnabled?: boolean | null;
  pointDiscountPercent?: number | null;
  isHot?: boolean | null;
  sold?: number;
}

if (variants.length > 1 && selectedVariantId) {
  const v = variants.find((x) => x.id === selectedVariantId);
  if (v) {
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      image: v.image,
      productImages: v.productImages,
      category: product.category,
      purchaseLimit: v.purchaseLimit,
      purchaseWarning: v.purchaseWarning ?? null,
      purchaseQuestions: v.purchaseQuestions ?? null,
      pointDiscountEnabled: v.pointDiscountEnabled ?? false,
      pointDiscountPercent: v.pointDiscountPercent ?? 0,
      isHot: v.isHot ?? false,
    } satisfies Product;
  }
}

<BuyButton
  productId={displayProduct.id}
  price={displayProduct.price}
  productName={displayProduct.name}
  quantity={quantity}
  autoOpen={warningConfirmed && !!displayProduct.purchaseWarning}
  emailConfigured={emailConfiguredState}
  answers={hasQuestions ? questionAnswers : undefined}
  pointDiscountEnabled={Boolean(displayProduct.pointDiscountEnabled)}
  pointDiscountPercent={Number(displayProduct.pointDiscountPercent || 0)}
  className="h-11 flex-1 rounded-full bg-primary px-5 font-medium text-primary-foreground shadow-[0_16px_34px_-20px_rgba(15,23,42,0.55)] transition-all hover:bg-primary/90 hover:shadow-[0_18px_40px_-22px_rgba(15,23,42,0.6)]"
/>
```

```tsx
// _workers_next/src/components/buy-button.tsx
import { calculatePointDiscountPreview } from "@/lib/points/product-point-discount";

interface BuyButtonProps {
  productId: string;
  price: string | number;
  productName: string;
  disabled?: boolean;
  quantity?: number;
  autoOpen?: boolean;
  emailConfigured?: boolean;
  answers?: string[];
  pointDiscountEnabled?: boolean;
  pointDiscountPercent?: number;
  className?: string;
}

const preview = calculatePointDiscountPreview({
  orderAmount: Number(price) * quantity,
  availablePoints: points,
  usePoints,
  pointDiscountEnabled: Boolean(pointDiscountEnabled),
  pointDiscountPercent: Number(pointDiscountPercent || 0),
});

// inside openDialog()
setUsePoints(false);

// inside the dialog body
{preview.shouldShowPointOption && (
  <div className="space-y-2 rounded-md border p-3">
    <div className="flex items-center space-x-2">
      <input
        type="checkbox"
        id="use-points"
        checked={usePoints}
        onChange={(e) => setUsePoints(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
      />
      <Label htmlFor="use-points" className="cursor-pointer">
        {t("buy.modal.usePoints")}
      </Label>
    </div>
    <p className="text-sm text-muted-foreground">
      {t("buy.modal.pointDiscountSummary", {
        maxPoints: preview.maxDiscountPoints,
        percent: preview.pointDiscountPercent,
        available: points,
      })}
    </p>
  </div>
)}

<div className="flex justify-between items-center border-t pt-4 font-bold text-lg">
  <span>{t("buy.modal.total")}</span>
  <span>{preview.finalAmount.toFixed(2)}</span>
</div>
```

```json
// _workers_next/src/locales/zh.json
"pointDiscountSummary": "最多可用 {{maxPoints}} 积分，最高抵扣订单金额的 {{percent}}%（当前可用 {{available}} 积分）"
```

```json
// _workers_next/src/locales/en.json
"pointDiscountSummary": "Up to {{maxPoints}} points can be used, covering at most {{percent}}% of the order total ({{available}} points available)"
```

- [ ] **Step 4: 重跑组件测试，确认买页行为进入 GREEN**

Run:

```bash
npm --prefix _workers_next run test -- src/components/buy-button.test.tsx
```

Expected:

- `PASS src/components/buy-button.test.tsx`
- 断言覆盖：
  - 商品关闭积分抵扣时不显示复选框
  - 开启后默认未勾选
  - 勾选后总价按比例变化

- [ ] **Step 5: 手动冒烟验证买页**

Run:

```bash
npm --prefix _workers_next run dev
```

Manual checklist:

- 在 `/admin/product/edit/<id>` 打开任意商品，开启积分抵扣并保存 `10`
- 登录一个有积分的用户，访问 `/buy/<id>`
- 购买弹窗默认不勾选积分
- 商品关闭积分抵扣后，弹窗不再显示积分选项
- 同规格组商品切换后，显示的是各自商品自己的抵扣配置

- [ ] **Step 6: 如用户明确确认提交，再记录本任务 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/lib/db/queries.ts _workers_next/src/app/buy/[id]/page.tsx _workers_next/src/components/buy-content.tsx _workers_next/src/components/buy-button.tsx _workers_next/src/components/buy-button.test.tsx _workers_next/src/locales/zh.json _workers_next/src/locales/en.json
git -C E:/local_project/git/ldc-shop commit -m "feat(workers_next): 调整买页积分抵扣展示逻辑"
```

---

### Task 4: 收口服务端下单校验，让默认支付路径回到 credit.linux.do

**Files:**
- Modify: `_workers_next/src/actions/checkout.ts`
- Modify: `_workers_next/src/lib/points/product-point-discount.ts`
- Modify: `_workers_next/src/lib/points/product-point-discount.test.ts`

- [ ] **Step 1: 先补失败测试，锁定服务端必须遵守的结算边界**

```ts
// Update the existing import in _workers_next/src/lib/points/product-point-discount.test.ts
import {
  calculatePointDiscountPreview,
  normalizeProductPointDiscountConfig,
  resolveCheckoutPointUsage,
} from "./product-point-discount";

it("uses zero points when the product config is disabled even if the client asks to use points", () => {
  expect(
    resolveCheckoutPointUsage({
      orderAmount: 88,
      availablePoints: 100,
      usePoints: true,
      pointDiscountEnabled: false,
      pointDiscountPercent: 0,
    })
  ).toMatchObject({
    shouldShowPointOption: false,
    pointsToUse: 0,
    finalAmount: 88,
  });
});

it("keeps the remaining amount for credit.linux.do when points are insufficient", () => {
  expect(
    resolveCheckoutPointUsage({
      orderAmount: 120,
      availablePoints: 5,
      usePoints: true,
      pointDiscountEnabled: true,
      pointDiscountPercent: 100,
    })
  ).toMatchObject({
    pointsToUse: 5,
    finalAmount: 115,
  });
});
```

- [ ] **Step 2: 运行规则测试，确认新增结算断言先失败**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts
```

Expected:

- 失败
- `resolveCheckoutPointUsage` 还不存在

- [ ] **Step 3: 修改 checkout.ts，服务端统一使用共享规则函数重算金额**

```ts
// _workers_next/src/lib/points/product-point-discount.ts
export function resolveCheckoutPointUsage(input: {
  orderAmount: number;
  availablePoints: number;
  usePoints: boolean;
  pointDiscountEnabled: boolean;
  pointDiscountPercent: number;
}) {
  return calculatePointDiscountPreview(input);
}
```

```ts
// _workers_next/src/actions/checkout.ts
import { resolveCheckoutPointUsage } from "@/lib/points/product-point-discount";

export async function createOrder(
  productId: string,
  quantity: number = 1,
  email?: string,
  usePoints: boolean = false,
  answers?: string[]
) {
  const session = await auth();
  const user = session?.user;
  // ...

  const product = await db.query.products.findFirst({
    where: eq(products.id, productId),
    columns: {
      id: true,
      name: true,
      price: true,
      purchaseLimit: true,
      isShared: true,
      purchaseQuestions: true,
      pointDiscountEnabled: true,
      pointDiscountPercent: true,
    },
  });

  let availablePoints = 0;
  if (user?.id) {
    const userRec = await db.query.loginUsers.findFirst({
      where: eq(loginUsers.userId, user.id),
      columns: { points: true },
    });
    availablePoints = userRec?.points || 0;
  }

  const pricing = resolveCheckoutPointUsage({
    orderAmount: Number(product.price) * quantity,
    availablePoints,
    usePoints,
    pointDiscountEnabled: Boolean(product.pointDiscountEnabled),
    pointDiscountPercent: Number(product.pointDiscountPercent || 0),
  });

  const pointsToUse = pricing.pointsToUse;
  const finalAmount = pricing.finalAmount;
  const isZeroPrice = finalAmount <= 0;

  // keep the rest of the reservation / order creation flow unchanged
  // ...
  if (!isZeroPrice) {
    return {
      success: true,
      url: process.env.PAY_URL || "https://credit.linux.do/epay/pay/submit.php",
      params: payParams,
    };
  }
}
```

- [ ] **Step 4: 跑规则测试和整站构建，确认服务端逻辑已收口**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/product-point-discount.test.ts src/components/buy-button.test.tsx
npm --prefix _workers_next run build
```

Expected:

- 所有新增测试通过
- `next build --webpack` 通过
- 无新增 TypeScript 报错

- [ ] **Step 5: 做最终手动验证矩阵**

Manual checklist:

- 商品关闭积分抵扣：
  - 弹窗不显示积分选项
  - 下单直接生成 `credit.linux.do` 支付参数
- 商品开启 `10%`：
  - 订单金额 `100`，积分 `999`
  - 最多只用 `10` 积分
  - 待支付金额为 `90`
- 商品开启 `100%`，积分足够：
  - 生成零元积分订单
  - `tradeNo` 为 `POINTS_REDEMPTION`
- 商品开启 `100%`，积分不足：
  - `points_used` 为实际积分余额
  - 剩余金额继续走 `credit.linux.do`

- [ ] **Step 6: 如用户明确确认提交，再记录本任务 checkpoint**

```bash
git -C E:/local_project/git/ldc-shop add _workers_next/src/actions/checkout.ts _workers_next/src/lib/points/product-point-discount.test.ts
git -C E:/local_project/git/ldc-shop commit -m "fix(workers_next): 按商品比例限制积分抵扣金额"
```

---

## Self-Review

### 1. Spec Coverage

- 商品级开关与百分比字段：Task 2
- D1 历史表补列与初始化建表：Task 2
- 后台商品编辑页开关与输入框：Task 2
- 买页默认不勾选、条件显隐、提示文案：Task 3
- 服务端统一按比例计算与默认走 `credit.linux.do`：Task 4
- `100%` 配置下的零元订单保留：Task 1 + Task 4

### 2. Placeholder Scan

- 未发现占位词或“后补”式描述
- 每个任务都给了明确文件、代码片段、命令和预期结果

### 3. Type Consistency

- 统一使用 `pointDiscountEnabled` / `pointDiscountPercent`
- 统一使用 `normalizeProductPointDiscountConfig`
- 统一使用 `calculatePointDiscountPreview`
- 前台与服务端共用同一套计算函数，避免命名漂移
