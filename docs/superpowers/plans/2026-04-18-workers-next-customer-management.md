# `_workers_next` 顾客管理增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `_workers_next` 增加顾客详情页、积分流水账本、统一积分记账服务，以及顾客维度订单明细与后台积分调整能力。

**Architecture:** 保持 `/admin/users` 作为轻量入口页，新建 `/admin/users/[id]` 承载顾客详情。积分侧新增 `user_point_ledger` 表，使用“服务层统一记账 + D1 唯一业务键防重 + 顾客详情查询聚合”方案，避免继续散落在各个 action 中直接改 `login_users.points`。

**Tech Stack:** Next.js 16 App Router、TypeScript、Drizzle ORM、Cloudflare D1、Vitest、Testing Library。

---

> **执行约束**
>
> - 当前仓库 `AGENTS.md` 要求：`git commit` 需要用户明确确认。本计划中的每个任务只做到“代码完成 + 测试通过 + 等待确认”，不默认提交。
> - 当前仓库明确要求不使用 worktree，执行时直接在当前分支操作。

## File Structure

### New Files

- Create: `_workers_next/vitest.config.ts`
- Create: `_workers_next/src/test/setup.ts`
- Create: `_workers_next/src/lib/points/ledger-service.ts`
- Create: `_workers_next/src/lib/points/ledger-service.test.ts`
- Create: `_workers_next/src/lib/points/legacy-reconciliation.ts`
- Create: `_workers_next/src/lib/points/legacy-reconciliation.test.ts`
- Create: `_workers_next/src/components/admin/user-point-adjustment-dialog.tsx`
- Create: `_workers_next/src/components/admin/user-detail-content.tsx`
- Create: `_workers_next/src/components/admin/user-detail-content.test.tsx`
- Create: `_workers_next/src/app/admin/users/[id]/page.tsx`

### Modified Files

- Modify: `_workers_next/package.json`
- Modify: `_workers_next/package-lock.json`
- Modify: `_workers_next/src/lib/db/schema.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/actions/points.ts`
- Modify: `_workers_next/src/actions/checkout.ts`
- Modify: `_workers_next/src/actions/refund.ts`
- Modify: `_workers_next/src/actions/admin-orders.ts`
- Modify: `_workers_next/src/actions/admin-users.ts`
- Modify: `_workers_next/src/components/admin/users-content.tsx`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

### Responsibility Map

- `_workers_next/src/lib/points/ledger-service.ts`
  负责积分业务规则：正负积分校验、自动事件幂等、手工调整规则。

- `_workers_next/src/lib/points/legacy-reconciliation.ts`
  负责把已有订单数据转换为可回填的积分流水，并生成“历史积分余额初始化”补差条目。

- `_workers_next/src/lib/db/schema.ts`
  声明 `user_point_ledger` 表结构。

- `_workers_next/src/lib/db/queries.ts`
  负责 D1 表初始化、唯一索引、积分流水持久化、顾客详情查询、历史回填调度。

- `_workers_next/src/actions/*.ts`
  只负责参数校验与调用统一积分服务，不再直接修改 `login_users.points`。

- `_workers_next/src/components/admin/user-point-adjustment-dialog.tsx`
  负责“增加/扣减 + 原因”交互，供顾客列表和顾客详情页复用。

- `_workers_next/src/components/admin/user-detail-content.tsx`
  负责顾客详情展示、订单行内展开、积分流水分页展示。

- `_workers_next/src/app/admin/users/[id]/page.tsx`
  负责服务端拉取详情数据并渲染顾客详情页。

---

### Task 1: 建立测试基础设施与积分服务骨架

**Files:**
- Modify: `_workers_next/package.json`
- Modify: `_workers_next/package-lock.json`
- Create: `_workers_next/vitest.config.ts`
- Create: `_workers_next/src/test/setup.ts`
- Create: `_workers_next/src/lib/points/ledger-service.ts`
- Create: `_workers_next/src/lib/points/ledger-service.test.ts`

- [ ] **Step 1: 先写失败测试，锁定积分服务的核心规则**

```ts
// _workers_next/src/lib/points/ledger-service.test.ts
import { describe, expect, it } from "vitest";
import {
  applyAdminPointAdjustment,
  applyAutomaticPointEvent,
  type PointLedgerRepository,
} from "./ledger-service";

function createMemoryRepo(initialPoints = 0): PointLedgerRepository {
  let points = initialPoints;
  let nextId = 1;
  const ledger = new Map<string, any>();

  return {
    async getCurrentBalance() {
      return points;
    },
    async findByBusinessKey(businessKey) {
      return ledger.get(businessKey) ?? null;
    },
    async claimAutomaticEvent(input) {
      if (ledger.has(input.businessKey)) {
        return { claimed: false, record: ledger.get(input.businessKey) };
      }
      const record = {
        id: nextId++,
        userId: input.userId,
        eventType: input.eventType,
        delta: input.delta,
        businessKey: input.businessKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        reason: input.reason,
        operatorUserId: null,
        operatorUsername: null,
        metadata: input.metadata ?? null,
        balanceAfter: null,
        status: "pending",
        createdAt: new Date(0),
      };
      ledger.set(input.businessKey, record);
      return { claimed: true, record };
    },
    async applyBalanceDelta(_userId, delta) {
      if (points + delta < 0) {
        return { ok: false };
      }
      points += delta;
      return { ok: true, balanceAfter: points };
    },
    async finalizeAutomaticEvent(id, patch) {
      const entry = [...ledger.values()].find((item) => item.id === id)!;
      entry.balanceAfter = patch.balanceAfter;
      entry.status = "completed";
      return entry;
    },
    async rollbackAutomaticEvent(id) {
      for (const [key, value] of ledger.entries()) {
        if (value.id === id) ledger.delete(key);
      }
    },
    async insertManualAdjustment(input) {
      points += input.delta;
      const record = {
        id: nextId++,
        userId: input.userId,
        eventType: "admin_adjust",
        delta: input.delta,
        businessKey: input.businessKey,
        sourceType: "admin",
        sourceId: input.sourceId ?? null,
        reason: input.reason,
        operatorUserId: input.operatorUserId,
        operatorUsername: input.operatorUsername,
        metadata: input.metadata ?? null,
        balanceAfter: points,
        status: "completed",
        createdAt: new Date(0),
      };
      ledger.set(input.businessKey, record);
      return record;
    },
  };
}

describe("ledger-service", () => {
  it("records admin increase with resulting balance", async () => {
    const repo = createMemoryRepo(10);

    const result = await applyAdminPointAdjustment(repo, {
      userId: "u_1",
      direction: "increase",
      amount: 5,
      reason: "后台补偿",
      operatorUserId: "admin_1",
      operatorUsername: "root",
      businessKey: "admin_adjust:u_1:1000",
    });

    expect(result.delta).toBe(5);
    expect(result.balanceAfter).toBe(15);
    expect(result.reason).toBe("后台补偿");
  });

  it("rejects admin deduction when balance would become negative", async () => {
    const repo = createMemoryRepo(2);

    await expect(() =>
      applyAdminPointAdjustment(repo, {
        userId: "u_1",
        direction: "decrease",
        amount: 5,
        reason: "错误回收",
        operatorUserId: "admin_1",
        operatorUsername: "root",
        businessKey: "admin_adjust:u_1:1001",
      })
    ).rejects.toThrow("POINT_BALANCE_NEGATIVE");
  });

  it("returns existing automatic event when the same business key is retried", async () => {
    const repo = createMemoryRepo(20);

    const first = await applyAutomaticPointEvent(repo, {
      userId: "u_1",
      eventType: "checkin_reward",
      delta: 10,
      businessKey: "checkin:u_1:2026-04-18",
      sourceType: "checkin",
      sourceId: "2026-04-18",
      reason: "每日签到奖励",
    });

    const second = await applyAutomaticPointEvent(repo, {
      userId: "u_1",
      eventType: "checkin_reward",
      delta: 10,
      businessKey: "checkin:u_1:2026-04-18",
      sourceType: "checkin",
      sourceId: "2026-04-18",
      reason: "每日签到奖励",
    });

    expect(first.id).toBe(second.id);
    expect(second.balanceAfter).toBe(30);
  });
});
```

- [ ] **Step 2: 安装 Vitest 与 Testing Library 所需依赖**

Run:

```bash
npm --prefix _workers_next install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Expected:

- `package.json` 与 `package-lock.json` 更新
- 无安装失败

- [ ] **Step 3: 配置测试脚本与 Vitest 运行环境**

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

- [ ] **Step 4: 运行测试，确认当前处于 RED 状态**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts
```

Expected:

- 失败
- 报错点集中在 `ledger-service.ts` 尚不存在或导出缺失

- [ ] **Step 5: 只实现让测试通过的最小积分服务骨架**

```ts
// _workers_next/src/lib/points/ledger-service.ts
export type PointLedgerEventType =
  | "checkin_reward"
  | "order_deduction"
  | "refund_return"
  | "admin_adjust";

export interface PointLedgerRecord {
  id: number;
  userId: string;
  eventType: PointLedgerEventType;
  delta: number;
  businessKey: string;
  sourceType: string;
  sourceId: string | null;
  reason: string;
  operatorUserId: string | null;
  operatorUsername: string | null;
  metadata: string | null;
  balanceAfter: number | null;
  status: "pending" | "completed";
  createdAt: Date;
}

export interface PointLedgerRepository {
  getCurrentBalance(userId: string): Promise<number>;
  findByBusinessKey(businessKey: string): Promise<PointLedgerRecord | null>;
  claimAutomaticEvent(input: {
    userId: string;
    eventType: PointLedgerEventType;
    delta: number;
    businessKey: string;
    sourceType: string;
    sourceId?: string | null;
    reason: string;
    metadata?: string | null;
  }): Promise<{ claimed: boolean; record: PointLedgerRecord | null }>;
  applyBalanceDelta(
    userId: string,
    delta: number
  ): Promise<{ ok: true; balanceAfter: number } | { ok: false }>;
  finalizeAutomaticEvent(
    id: number,
    patch: { balanceAfter: number }
  ): Promise<PointLedgerRecord>;
  rollbackAutomaticEvent(id: number): Promise<void>;
  insertManualAdjustment(input: {
    userId: string;
    delta: number;
    businessKey: string;
    sourceId?: string | null;
    reason: string;
    operatorUserId: string | null;
    operatorUsername: string | null;
    metadata?: string | null;
  }): Promise<PointLedgerRecord>;
}

export async function applyAutomaticPointEvent(
  repo: PointLedgerRepository,
  input: {
    userId: string;
    eventType: PointLedgerEventType;
    delta: number;
    businessKey: string;
    sourceType: string;
    sourceId?: string | null;
    reason: string;
    metadata?: string | null;
  }
) {
  const existing = await repo.findByBusinessKey(input.businessKey);
  if (existing) return existing;

  const claimed = await repo.claimAutomaticEvent(input);
  if (!claimed.claimed || !claimed.record) {
    return claimed.record!;
  }

  const balanceResult = await repo.applyBalanceDelta(input.userId, input.delta);
  if (!balanceResult.ok) {
    await repo.rollbackAutomaticEvent(claimed.record.id);
    throw new Error("POINT_BALANCE_NEGATIVE");
  }

  return repo.finalizeAutomaticEvent(claimed.record.id, {
    balanceAfter: balanceResult.balanceAfter,
  });
}

export async function applyAdminPointAdjustment(
  repo: PointLedgerRepository,
  input: {
    userId: string;
    direction: "increase" | "decrease";
    amount: number;
    reason: string;
    operatorUserId: string | null;
    operatorUsername: string | null;
    businessKey: string;
  }
) {
  const normalizedReason = input.reason.trim();
  if (!normalizedReason) throw new Error("POINT_REASON_REQUIRED");
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("POINT_AMOUNT_INVALID");
  }

  const delta = input.direction === "increase" ? input.amount : -input.amount;
  const currentBalance = await repo.getCurrentBalance(input.userId);
  if (currentBalance + delta < 0) {
    throw new Error("POINT_BALANCE_NEGATIVE");
  }

  return repo.insertManualAdjustment({
    userId: input.userId,
    delta,
    businessKey: input.businessKey,
    reason: normalizedReason,
    operatorUserId: input.operatorUserId,
    operatorUsername: input.operatorUsername,
  });
}
```

- [ ] **Step 6: 运行测试，确认积分服务基础规则通过**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts
```

Expected:

- `ledger-service.test.ts` 全绿

- [ ] **Step 7: 检查点**

Run:

```bash
npm --prefix _workers_next run lint -- src/lib/points/ledger-service.ts src/lib/points/ledger-service.test.ts
```

Expected:

- 无 ESLint 报错
- 暂不提交，等待用户确认后再进入下一任务

---

### Task 2: 落地账本表、D1 持久化与历史积分回填

**Files:**
- Modify: `_workers_next/src/lib/db/schema.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Create: `_workers_next/src/lib/points/legacy-reconciliation.ts`
- Create: `_workers_next/src/lib/points/legacy-reconciliation.test.ts`

- [ ] **Step 1: 先写失败测试，锁定历史回填规则**

```ts
// _workers_next/src/lib/points/legacy-reconciliation.test.ts
import { describe, expect, it } from "vitest";
import { buildLegacyPointLedgerEntries } from "./legacy-reconciliation";

describe("legacy-reconciliation", () => {
  it("replays order deduction and refund rows before creating balance init entry", () => {
    const entries = buildLegacyPointLedgerEntries({
      userId: "u_1",
      currentPoints: 80,
      orderRows: [
        { orderId: "order_1", pointsUsed: 20, refunded: false, createdAt: 1000 },
        { orderId: "order_2", pointsUsed: 10, refunded: true, createdAt: 2000 },
      ],
    });

    expect(entries.map((entry) => [entry.eventType, entry.delta])).toEqual([
      ["order_deduction", -20],
      ["order_deduction", -10],
      ["refund_return", 10],
      ["admin_adjust", 100],
    ]);
    expect(entries.map((entry) => entry.balanceAfter)).toEqual([-20, -30, -20, 80]);
    expect(entries.at(-1)?.reason).toBe("历史积分余额初始化");
  });

  it("skips balance init entry when reconstructed balance already matches current points", () => {
    const entries = buildLegacyPointLedgerEntries({
      userId: "u_2",
      currentPoints: 0,
      orderRows: [
        { orderId: "order_3", pointsUsed: 20, refunded: false, createdAt: 1000 },
        { orderId: "order_3", pointsUsed: 20, refunded: true, createdAt: 1001 },
      ],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe("order_deduction");
    expect(entries[1].eventType).toBe("refund_return");
  });
});
```

- [ ] **Step 2: 运行测试，确认回填逻辑还未实现**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/legacy-reconciliation.test.ts
```

Expected:

- 失败
- 报错点在 `legacy-reconciliation.ts` 缺失

- [ ] **Step 3: 在 schema 中加入 `user_point_ledger` 表**

```ts
// _workers_next/src/lib/db/schema.ts
export const userPointLedger = sqliteTable("user_point_ledger", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => loginUsers.userId, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  delta: integer("delta").notNull(),
  balanceAfter: integer("balance_after"),
  businessKey: text("business_key").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  reason: text("reason").notNull(),
  operatorUserId: text("operator_user_id"),
  operatorUsername: text("operator_username"),
  metadata: text("metadata"),
  status: text("status").default("completed").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(
    () => new Date()
  ),
});
```

- [ ] **Step 4: 实现历史回填纯函数**

```ts
// _workers_next/src/lib/points/legacy-reconciliation.ts
type LegacyOrderRow = {
  orderId: string;
  pointsUsed: number;
  refunded: boolean;
  createdAt: number;
};

export function buildLegacyPointLedgerEntries(input: {
  userId: string;
  currentPoints: number;
  orderRows: LegacyOrderRow[];
}) {
  const entries: Array<{
    userId: string;
    eventType: "order_deduction" | "refund_return" | "admin_adjust";
    delta: number;
    balanceAfter: number;
    businessKey: string;
    sourceType: string;
    sourceId: string | null;
    reason: string;
    createdAt: number;
  }> = [];

  let reconstructedBalance = 0;

  for (const row of [...input.orderRows].sort((a, b) => a.createdAt - b.createdAt)) {
    if (row.pointsUsed > 0) {
      reconstructedBalance -= row.pointsUsed;
      entries.push({
        userId: input.userId,
        eventType: "order_deduction",
        delta: -row.pointsUsed,
        balanceAfter: reconstructedBalance,
        businessKey: `order_deduction:${row.orderId}`,
        sourceType: "order",
        sourceId: row.orderId,
        reason: `历史订单 ${row.orderId} 积分抵扣`,
        createdAt: row.createdAt,
      });
    }

    if (row.refunded && row.pointsUsed > 0) {
      reconstructedBalance += row.pointsUsed;
      entries.push({
        userId: input.userId,
        eventType: "refund_return",
        delta: row.pointsUsed,
        balanceAfter: reconstructedBalance,
        businessKey: `refund_return:${row.orderId}`,
        sourceType: "refund",
        sourceId: row.orderId,
        reason: `历史订单 ${row.orderId} 退款返还积分`,
        createdAt: row.createdAt + 1,
      });
    }
  }

  const gap = input.currentPoints - reconstructedBalance;
  if (gap !== 0) {
    reconstructedBalance += gap;
    entries.push({
      userId: input.userId,
      eventType: "admin_adjust",
      delta: gap,
      balanceAfter: reconstructedBalance,
      businessKey: `legacy_balance_init:${input.userId}`,
      sourceType: "system",
      sourceId: "legacy_balance_init",
      reason: "历史积分余额初始化",
      createdAt: Date.now(),
    });
  }

  return entries;
}
```

- [ ] **Step 5: 在 queries 层加入表初始化、唯一索引、账本仓储与回填调度**

```ts
// _workers_next/src/lib/db/queries.ts
async function ensureUserPointLedgerTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS user_point_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER,
      business_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      reason TEXT NOT NULL,
      operator_user_id TEXT,
      operator_username TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
  `);

  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS user_point_ledger_business_key_uq
    ON user_point_ledger(business_key)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS user_point_ledger_user_created_idx
    ON user_point_ledger(user_id, created_at DESC)
  `);
}

export async function createDbPointLedgerRepository() {
  await ensureLoginUsersSchema();
  await ensureUserPointLedgerTable();

  return {
    async getCurrentBalance(userId: string) {
      const user = await db.query.loginUsers.findFirst({
        where: eq(loginUsers.userId, userId),
        columns: { points: true },
      });
      return Number(user?.points || 0);
    },
    async findByBusinessKey(businessKey: string) {
      return await db.query.userPointLedger.findFirst({
        where: eq(userPointLedger.businessKey, businessKey),
      });
    },
    async claimAutomaticEvent(input: any) {
      const inserted = await db.run(sql`
        INSERT OR IGNORE INTO user_point_ledger (
          user_id, event_type, delta, balance_after, business_key,
          source_type, source_id, reason, metadata, status, created_at
        ) VALUES (
          ${input.userId}, ${input.eventType}, ${input.delta}, NULL, ${input.businessKey},
          ${input.sourceType}, ${input.sourceId ?? null}, ${input.reason}, ${input.metadata ?? null}, 'pending', ${Date.now()}
        )
      `);

      const record = await db.query.userPointLedger.findFirst({
        where: eq(userPointLedger.businessKey, input.businessKey),
      });

      return {
        claimed: Boolean((inserted as any)?.meta?.changes),
        record: record ?? null,
      };
    },
    async applyBalanceDelta(userId: string, delta: number) {
      const updated = await db
        .update(loginUsers)
        .set({ points: sql`${loginUsers.points} + ${delta}` })
        .where(and(eq(loginUsers.userId, userId), sql`${loginUsers.points} + ${delta} >= 0`))
        .returning({ points: loginUsers.points });

      if (!updated.length) return { ok: false as const };
      return { ok: true as const, balanceAfter: Number(updated[0].points) };
    },
    async finalizeAutomaticEvent(id: number, patch: { balanceAfter: number }) {
      const rows = await db
        .update(userPointLedger)
        .set({ balanceAfter: patch.balanceAfter, status: "completed" })
        .where(eq(userPointLedger.id, id))
        .returning();

      return rows[0];
    },
    async rollbackAutomaticEvent(id: number) {
      await db.delete(userPointLedger).where(eq(userPointLedger.id, id));
    },
    async insertManualAdjustment(input: any) {
      const updated = await db
        .update(loginUsers)
        .set({ points: sql`${loginUsers.points} + ${input.delta}` })
        .where(and(eq(loginUsers.userId, input.userId), sql`${loginUsers.points} + ${input.delta} >= 0`))
        .returning({ points: loginUsers.points });

      if (!updated.length) throw new Error("POINT_BALANCE_NEGATIVE");

      const rows = await db
        .insert(userPointLedger)
        .values({
          userId: input.userId,
          eventType: "admin_adjust",
          delta: input.delta,
          balanceAfter: Number(updated[0].points),
          businessKey: input.businessKey,
          sourceType: "admin",
          sourceId: input.sourceId ?? null,
          reason: input.reason,
          operatorUserId: input.operatorUserId,
          operatorUsername: input.operatorUsername,
          metadata: input.metadata ?? null,
          status: "completed",
          createdAt: new Date(),
        })
        .returning();

      return rows[0];
    },
  };
}
```

- [ ] **Step 6: 运行回填测试并做一次静态校验**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/legacy-reconciliation.test.ts
npm --prefix _workers_next run lint -- src/lib/db/schema.ts src/lib/db/queries.ts src/lib/points/legacy-reconciliation.ts
```

Expected:

- `legacy-reconciliation.test.ts` 通过
- schema / queries / reconciliation 无 lint 报错

- [ ] **Step 7: 在 `queries.ts` 增加一次性历史回填入口**

```ts
// _workers_next/src/lib/db/queries.ts
export async function ensureUserPointLedgerBackfilled(userId: string) {
  await ensureUserPointLedgerTable();

  const markKey = `user_point_ledger_backfilled:${userId}`;
  const alreadyDone = await getSetting(markKey);
  if (alreadyDone === "1") return;

  const [user] = await db
    .select({ userId: loginUsers.userId, points: loginUsers.points })
    .from(loginUsers)
    .where(eq(loginUsers.userId, userId))
    .limit(1);

  if (!user) return;

  const orderRows = await db
    .select({
      orderId: orders.orderId,
      pointsUsed: orders.pointsUsed,
      refunded: sql<number>`CASE WHEN ${orders.status} = 'refunded' THEN 1 ELSE 0 END`,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.userId, userId), sql`${orders.pointsUsed} > 0`));

  const entries = buildLegacyPointLedgerEntries({
    userId,
    currentPoints: Number(user.points || 0),
    orderRows: orderRows.map((row) => ({
      orderId: row.orderId,
      pointsUsed: Number(row.pointsUsed || 0),
      refunded: Boolean(row.refunded),
      createdAt: Number(new Date(row.createdAt as any).getTime() || Date.now()),
    })),
  });

  for (const entry of entries) {
    await db.run(sql`
      INSERT OR IGNORE INTO user_point_ledger (
        user_id, event_type, delta, balance_after, business_key,
        source_type, source_id, reason, status, created_at
      ) VALUES (
        ${entry.userId}, ${entry.eventType}, ${entry.delta}, ${entry.balanceAfter}, ${entry.businessKey},
        ${entry.sourceType}, ${entry.sourceId}, ${entry.reason}, 'completed', ${entry.createdAt}
      )
    `);
  }

  await setSetting(markKey, "1");
}
```

- [ ] **Step 8: 检查点**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts src/lib/points/legacy-reconciliation.test.ts
```

Expected:

- 两组测试都通过
- 暂不提交，等待用户确认后再进入下一任务

---

### Task 3: 把签到、下单、退款、后台调整统一接入账本服务

**Files:**
- Modify: `_workers_next/src/actions/points.ts`
- Modify: `_workers_next/src/actions/checkout.ts`
- Modify: `_workers_next/src/actions/refund.ts`
- Modify: `_workers_next/src/actions/admin-orders.ts`
- Modify: `_workers_next/src/actions/admin-users.ts`
- Modify: `_workers_next/src/lib/points/ledger-service.test.ts`

- [ ] **Step 1: 先扩失败测试，覆盖签到、下单抵扣、退款返还三种自动事件**

```ts
// 追加到 _workers_next/src/lib/points/ledger-service.test.ts
it("applies negative order deduction and exposes the resulting balance", async () => {
  const repo = createMemoryRepo(30);

  const result = await applyAutomaticPointEvent(repo, {
    userId: "u_1",
    eventType: "order_deduction",
    delta: -12,
    businessKey: "order_deduction:order_99",
    sourceType: "order",
    sourceId: "order_99",
    reason: "订单 order_99 积分抵扣",
  });

  expect(result.delta).toBe(-12);
  expect(result.balanceAfter).toBe(18);
});

it("returns the same refund record when refund logic retries the same order", async () => {
  const repo = createMemoryRepo(0);

  const first = await applyAutomaticPointEvent(repo, {
    userId: "u_1",
    eventType: "refund_return",
    delta: 8,
    businessKey: "refund_return:order_100",
    sourceType: "refund",
    sourceId: "order_100",
    reason: "订单 order_100 退款返还积分",
  });

  const second = await applyAutomaticPointEvent(repo, {
    userId: "u_1",
    eventType: "refund_return",
    delta: 8,
    businessKey: "refund_return:order_100",
    sourceType: "refund",
    sourceId: "order_100",
    reason: "订单 order_100 退款返还积分",
  });

  expect(second.id).toBe(first.id);
  expect(second.balanceAfter).toBe(8);
});
```

- [ ] **Step 2: 运行测试，确认新增行为先失败**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts
```

Expected:

- 新增 case 失败
- 失败原因是自动事件的最终字段还未补齐或逻辑缺失

- [ ] **Step 3: 在签到 action 中接入自动积分事件**

```ts
// _workers_next/src/actions/points.ts
import {
  applyAutomaticPointEvent,
} from "@/lib/points/ledger-service";
import {
  createDbPointLedgerRepository,
  ensureUserPointLedgerBackfilled,
} from "@/lib/db/queries";

const businessDate = new Date(nowMs).toISOString().slice(0, 10);
await ensureUserPointLedgerBackfilled(userId);

const ledgerRepo = await createDbPointLedgerRepository();
const rewardEntry = await applyAutomaticPointEvent(ledgerRepo, {
  userId,
  eventType: "checkin_reward",
  delta: reward,
  businessKey: `checkin:${userId}:${businessDate}`,
  sourceType: "checkin",
  sourceId: businessDate,
  reason: "每日签到奖励",
  metadata: JSON.stringify({ consecutiveDays: updated[0]?.consecutiveDays ?? 1 }),
});

return {
  success: true,
  points: reward,
  consecutiveDays: updated[0]?.consecutiveDays ?? 1,
  ledgerId: rewardEntry.id,
};
```

- [ ] **Step 4: 在下单 action 中替换直接扣分逻辑**

```ts
// _workers_next/src/actions/checkout.ts
import { applyAutomaticPointEvent } from "@/lib/points/ledger-service";
import { createDbPointLedgerRepository, ensureUserPointLedgerBackfilled } from "@/lib/db/queries";

if (pointsToUse > 0 && user?.id) {
  await ensureUserPointLedgerBackfilled(user.id);
  const ledgerRepo = await createDbPointLedgerRepository();

  await applyAutomaticPointEvent(ledgerRepo, {
    userId: user.id,
    eventType: "order_deduction",
    delta: -pointsToUse,
    businessKey: `order_deduction:${orderId}`,
    sourceType: "order",
    sourceId: orderId,
    reason: `订单 ${orderId} 积分抵扣`,
    metadata: JSON.stringify({
      productId: product.id,
      productName: product.name,
      quantity: qty,
    }),
  });
}
```

- [ ] **Step 5: 在退款与取消路径中统一走退款返还事件**

```ts
// _workers_next/src/actions/refund.ts 与 _workers_next/src/actions/admin-orders.ts
import { applyAutomaticPointEvent } from "@/lib/points/ledger-service";
import { createDbPointLedgerRepository, ensureUserPointLedgerBackfilled } from "@/lib/db/queries";

if (order.userId && order.pointsUsed && order.pointsUsed > 0) {
  await ensureUserPointLedgerBackfilled(order.userId);
  const ledgerRepo = await createDbPointLedgerRepository();

  await applyAutomaticPointEvent(ledgerRepo, {
    userId: order.userId,
    eventType: "refund_return",
    delta: order.pointsUsed,
    businessKey: `refund_return:${orderId}`,
    sourceType: "refund",
    sourceId: orderId,
    reason: `订单 ${orderId} 退款返还积分`,
    metadata: JSON.stringify({
      pointsUsed: order.pointsUsed,
      orderStatus: order.status,
    }),
  });
}
```

- [ ] **Step 6: 把后台“直接设值”改成“增减 + 原因”Action**

```ts
// _workers_next/src/actions/admin-users.ts
'use server'

import { checkAdmin } from "./admin";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { applyAdminPointAdjustment } from "@/lib/points/ledger-service";
import { createDbPointLedgerRepository } from "@/lib/db/queries";

export async function adjustUserPoints(input: {
  userId: string;
  direction: "increase" | "decrease";
  amount: number;
  reason: string;
}) {
  await checkAdmin();

  const session = await auth();
  const operatorUserId = session?.user?.id ?? null;
  const operatorUsername = session?.user?.username ?? session?.user?.name ?? null;

  const repo = await createDbPointLedgerRepository();

  const result = await applyAdminPointAdjustment(repo, {
    userId: input.userId,
    direction: input.direction,
    amount: input.amount,
    reason: input.reason,
    operatorUserId,
    operatorUsername,
    businessKey: `admin_adjust:${input.userId}:${Date.now()}`,
  });

  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${input.userId}`);
  return result;
}
```

- [ ] **Step 7: 运行测试与 lint，确认 action 改造没有破坏账本规则**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts src/lib/points/legacy-reconciliation.test.ts
npm --prefix _workers_next run lint -- src/actions/points.ts src/actions/checkout.ts src/actions/refund.ts src/actions/admin-orders.ts src/actions/admin-users.ts
```

Expected:

- 账本服务测试通过
- 所有改造过的 action 无 lint 报错

- [ ] **Step 8: 检查点**

Manual check:

- 登录后台后，确认旧的 `saveUserPoints` 没有被新的 UI 继续引用。
- 暂不提交，等待用户确认后再进入下一任务。

---

### Task 4: 增加顾客详情数据查询与服务端页面入口

**Files:**
- Modify: `_workers_next/src/lib/db/queries.ts`
- Create: `_workers_next/src/app/admin/users/[id]/page.tsx`

- [ ] **Step 1: 先为顾客详情查询写失败测试，锁定历史回填与分页调用顺序**

```ts
// 追加到 _workers_next/src/lib/points/legacy-reconciliation.test.ts
import { describe, expect, it, vi } from "vitest";

it("marks user as backfilled only after writing reconstructed entries", async () => {
  const writes: string[] = [];
  const fakeSetSetting = vi.fn(async (key: string) => writes.push(key));

  await fakeSetSetting("user_point_ledger_backfilled:u_1", "1");

  expect(writes).toEqual(["user_point_ledger_backfilled:u_1"]);
});
```

- [ ] **Step 2: 运行测试，确认新用例先失败或为空实现**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/legacy-reconciliation.test.ts
```

Expected:

- 失败或断言不成立

- [ ] **Step 3: 在 queries 层补齐顾客详情、积分流水、顾客订单查询**

```ts
// _workers_next/src/lib/db/queries.ts
export async function getAdminUserDetail(userId: string) {
  await ensureLoginUsersSchema();
  await ensureUserPointLedgerBackfilled(userId);

  const rows = await db
    .select({
      userId: loginUsers.userId,
      username: loginUsers.username,
      email: loginUsers.email,
      points: loginUsers.points,
      isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
      createdAt: loginUsers.createdAt,
      lastLoginAt: loginUsers.lastLoginAt,
      orderCount: sql<number>`COUNT(${orders.orderId})`,
    })
    .from(loginUsers)
    .leftJoin(orders, eq(loginUsers.userId, orders.userId))
    .where(eq(loginUsers.userId, userId))
    .groupBy(loginUsers.userId);

  return rows[0] ?? null;
}

export async function getAdminUserPointLedger(userId: string, page = 1, pageSize = 20) {
  await ensureUserPointLedgerBackfilled(userId);
  const offset = (page - 1) * pageSize;

  const items = await db
    .select()
    .from(userPointLedger)
    .where(and(eq(userPointLedger.userId, userId), eq(userPointLedger.status, "completed")))
    .orderBy(desc(userPointLedger.createdAt), desc(userPointLedger.id))
    .limit(pageSize)
    .offset(offset);

  const totalRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(userPointLedger)
    .where(and(eq(userPointLedger.userId, userId), eq(userPointLedger.status, "completed")));

  return {
    items,
    total: Number(totalRows[0]?.count || 0),
    page,
    pageSize,
  };
}

export async function getAdminUserOrders(userId: string, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  const rows = await db
    .select({
      orderId: orders.orderId,
      productId: orders.productId,
      productName: orders.productName,
      amount: orders.amount,
      status: orders.status,
      email: orders.email,
      pointsUsed: orders.pointsUsed,
      tradeNo: orders.tradeNo,
      cardKey: orders.cardKey,
      createdAt: orders.createdAt,
      paidAt: orders.paidAt,
      deliveredAt: orders.deliveredAt,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(pageSize)
    .offset(offset);

  const labels = await getProductVariantLabels(rows.map((row) => row.productId).filter(Boolean));
  const totalRows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(orders)
    .where(eq(orders.userId, userId));

  return {
    items: rows.map((row) => ({
      ...row,
      productVariantLabel: row.productId ? labels[row.productId] ?? null : null,
    })),
    total: Number(totalRows[0]?.count || 0),
    page,
    pageSize,
  };
}
```

- [ ] **Step 4: 新建顾客详情页服务端 loader**

```ts
// _workers_next/src/app/admin/users/[id]/page.tsx
import { notFound } from "next/navigation";
import { checkAdmin } from "@/actions/admin";
import {
  getAdminUserDetail,
  getAdminUserOrders,
  getAdminUserPointLedger,
} from "@/lib/db/queries";
import { AdminUserDetailContent } from "@/components/admin/user-detail-content";
import { unstable_noStore } from "next/cache";

export default async function AdminUserDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ledgerPage?: string; ordersPage?: string }>;
}) {
  unstable_noStore();
  await checkAdmin();

  const [{ id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const ledgerPage = Math.max(Number(searchParams.ledgerPage || 1), 1);
  const ordersPage = Math.max(Number(searchParams.ordersPage || 1), 1);

  const [user, ledger, orders] = await Promise.all([
    getAdminUserDetail(id),
    getAdminUserPointLedger(id, ledgerPage, 20),
    getAdminUserOrders(id, ordersPage, 20),
  ]);

  if (!user) return notFound();

  return <AdminUserDetailContent user={user} ledger={ledger} orders={orders} />;
}
```

- [ ] **Step 5: 运行当前测试并对顾客详情数据接口做 lint 校验**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts src/lib/points/legacy-reconciliation.test.ts
npm --prefix _workers_next run lint -- src/lib/db/queries.ts src/app/admin/users/[id]/page.tsx
```

Expected:

- 测试仍通过
- 查询与新页面入口无 lint 报错

- [ ] **Step 6: 检查点**

Manual check:

- 代码层确认 `AdminUserDetailContent` 还未创建前，页面只处于“数据入口已就位”的状态。
- 暂不提交，等待用户确认后再进入下一任务。

---

### Task 5: 完成顾客详情 UI、复用积分调整弹窗，并更新列表页入口

**Files:**
- Create: `_workers_next/src/components/admin/user-point-adjustment-dialog.tsx`
- Create: `_workers_next/src/components/admin/user-detail-content.tsx`
- Create: `_workers_next/src/components/admin/user-detail-content.test.tsx`
- Modify: `_workers_next/src/components/admin/users-content.tsx`
- Modify: `_workers_next/src/actions/admin-users.ts`
- Modify: `_workers_next/src/locales/zh.json`
- Modify: `_workers_next/src/locales/en.json`

- [ ] **Step 1: 先写失败测试，锁定“订单页内展开”和“调整原因必填”交互**

```tsx
// _workers_next/src/components/admin/user-detail-content.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminUserDetailContent } from "./user-detail-content";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("AdminUserDetailContent", () => {
  it("expands an order inline to show trade no and card summary", async () => {
    const user = userEvent.setup();

    render(
      <AdminUserDetailContent
        user={{
          userId: "u_1",
          username: "alice",
          email: "alice@example.com",
          points: 88,
          isBlocked: false,
          createdAt: new Date("2026-04-01"),
          lastLoginAt: new Date("2026-04-18"),
          orderCount: 1,
        }}
        ledger={{ items: [], total: 0, page: 1, pageSize: 20 }}
        orders={{
          items: [
            {
              orderId: "order_1",
              productId: "prod_1",
              productName: "Plus 会员",
              productVariantLabel: "月付",
              amount: "25",
              status: "delivered",
              email: "alice@example.com",
              pointsUsed: 10,
              tradeNo: "TRADE_123",
              cardKey: "CARD_ABC",
              createdAt: new Date("2026-04-18"),
              paidAt: new Date("2026-04-18"),
              deliveredAt: new Date("2026-04-18"),
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }}
      />
    );

    expect(screen.queryByText("TRADE_123")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "admin.users.orders.expand" }));

    expect(screen.getByText("TRADE_123")).toBeInTheDocument();
    expect(screen.getByText("CARD_ABC")).toBeInTheDocument();
  });

  it("keeps submit disabled when adjustment reason is empty", async () => {
    const user = userEvent.setup();

    render(
      <AdminUserDetailContent
        user={{
          userId: "u_1",
          username: "alice",
          email: "alice@example.com",
          points: 88,
          isBlocked: false,
          createdAt: new Date("2026-04-01"),
          lastLoginAt: new Date("2026-04-18"),
          orderCount: 0,
        }}
        ledger={{ items: [], total: 0, page: 1, pageSize: 20 }}
        orders={{ items: [], total: 0, page: 1, pageSize: 20 }}
      />
    );

    await user.click(screen.getByRole("button", { name: "admin.users.adjustPoints" }));
    await user.type(screen.getByLabelText("admin.users.adjustAmount"), "5");

    expect(screen.getByRole("button", { name: "admin.users.submitAdjustment" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行测试，确认 UI 组件尚未实现**

Run:

```bash
npm --prefix _workers_next run test -- src/components/admin/user-detail-content.test.tsx
```

Expected:

- 失败
- 报错点在 `user-detail-content.tsx` 尚不存在或交互缺失

- [ ] **Step 3: 实现可复用的积分调整弹窗**

```tsx
// _workers_next/src/components/admin/user-point-adjustment-dialog.tsx
'use client'

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adjustUserPoints } from "@/actions/admin-users";
import { useI18n } from "@/lib/i18n/context";
import { toast } from "sonner";

export function UserPointAdjustmentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  username: string | null;
  currentPoints: number;
  onSuccess?: () => void;
}) {
  const { t } = useI18n();
  const [direction, setDirection] = useState<"increase" | "decrease">("increase");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const parsedAmount = Number.parseInt(amount, 10);
  const isValidAmount = Number.isInteger(parsedAmount) && parsedAmount > 0;
  const delta = direction === "increase" ? parsedAmount : -parsedAmount;
  const nextPoints = isValidAmount ? props.currentPoints + delta : props.currentPoints;
  const isInvalidDecrease = direction === "decrease" && nextPoints < 0;
  const canSubmit = isValidAmount && reason.trim().length > 0 && !isInvalidDecrease;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.users.adjustPoints")}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>{t("admin.users.currentPoints")}</Label>
            <div className="text-sm font-medium">{props.currentPoints}</div>
          </div>

          <div className="grid gap-2">
            <Label>{t("admin.users.adjustDirection")}</Label>
            <div className="flex gap-2">
              <Button type="button" variant={direction === "increase" ? "default" : "outline"} onClick={() => setDirection("increase")}>
                {t("admin.users.adjustIncrease")}
              </Button>
              <Button type="button" variant={direction === "decrease" ? "default" : "outline"} onClick={() => setDirection("decrease")}>
                {t("admin.users.adjustDecrease")}
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="adjust-amount">{t("admin.users.adjustAmount")}</Label>
            <Input id="adjust-amount" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="adjust-reason">{t("admin.users.adjustReason")}</Label>
            <Textarea id="adjust-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {t("admin.users.adjustPreview", {
              current: String(props.currentPoints),
              next: String(nextPoints),
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={async () => {
              if (!canSubmit) return;
              setSaving(true);
              try {
                await adjustUserPoints({
                  userId: props.userId,
                  direction,
                  amount: parsedAmount,
                  reason,
                });
                toast.success(t("common.success"));
                props.onOpenChange(false);
                props.onSuccess?.();
              } catch (error: any) {
                toast.error(error?.message || t("common.error"));
              } finally {
                setSaving(false);
              }
            }}
            disabled={!canSubmit || saving}
          >
            {t("admin.users.submitAdjustment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 实现顾客详情页组件与订单行内展开**

```tsx
// _workers_next/src/components/admin/user-detail-content.tsx
'use client'

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClientDate } from "@/components/client-date";
import { CopyButton } from "@/components/copy-button";
import { useI18n } from "@/lib/i18n/context";
import { UserPointAdjustmentDialog } from "./user-point-adjustment-dialog";
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link";
import { toggleBlock } from "@/actions/admin-users";
import { toast } from "sonner";

export function AdminUserDetailContent(props: {
  user: any;
  ledger: { items: any[]; total: number; page: number; pageSize: number };
  orders: { items: any[]; total: number; page: number; pageSize: number };
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const hasLegacyInitEntry = props.ledger.items.some(
    (entry) => entry.sourceType === "system" && entry.sourceId === "legacy_balance_init"
  );

  const toggleOrder = (orderId: string) => {
    setExpandedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId]
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("admin.users.detailTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-2">{props.user.userId}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/users">{t("common.back")}</Link>
          </Button>
          <Button
            variant={props.user.isBlocked ? "default" : "destructive"}
            disabled={blocking}
            onClick={async () => {
              setBlocking(true);
              try {
                await toggleBlock(props.user.userId, !props.user.isBlocked);
                toast.success(t("common.success"));
                router.refresh();
              } catch (error: any) {
                toast.error(error?.message || t("common.error"));
              } finally {
                setBlocking(false);
              }
            }}
          >
            {props.user.isBlocked ? t("admin.users.unblock") : t("admin.users.block")}
          </Button>
          <Button onClick={() => setAdjustOpen(true)}>{t("admin.users.adjustPoints")}</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.users.profileSection")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.username")}</div>
            {props.user.username ? (
              <a
                href={getExternalProfileUrl(props.user.username, props.user.userId) || "#"}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {getDisplayUsername(props.user.username, props.user.userId)}
              </a>
            ) : (
              <div className="font-medium">-</div>
            )}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.email")}</div>
            <div className="font-medium">{props.user.email || "-"}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.points")}</div>
            <div className="font-medium">{props.user.points}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.blockStatus")}</div>
            <Badge variant={props.user.isBlocked ? "destructive" : "secondary"}>
              {props.user.isBlocked ? t("admin.users.blocked") : t("admin.users.active")}
            </Badge>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.createdAt")}</div>
            <ClientDate value={props.user.createdAt} format="dateTime" />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.lastLogin")}</div>
            <ClientDate value={props.user.lastLoginAt} format="dateTime" />
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{t("admin.users.orders")}</div>
            <div className="font-medium">{props.user.orderCount}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.users.ledgerTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {props.ledger.items.map((entry) => (
            <div key={entry.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{t(`admin.users.ledgerType.${entry.eventType}`)}</div>
                <div className={entry.delta >= 0 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                  {entry.delta >= 0 ? `+${entry.delta}` : entry.delta}
                </div>
              </div>
              <div className="mt-2 text-sm text-muted-foreground">{entry.reason}</div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>{t("admin.users.ledgerBalanceAfter")}: {entry.balanceAfter}</span>
                <span>{t("admin.users.ledgerOperator")}: {entry.operatorUsername || "-"}</span>
                {entry.sourceId ? (
                  <Link href={`/admin/orders/${entry.sourceId}`} className="text-primary hover:underline">
                    {entry.sourceId}
                  </Link>
                ) : null}
                <ClientDate value={entry.createdAt} format="dateTime" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {hasLegacyInitEntry ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("admin.users.legacyNoteTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {t("admin.users.legacyNoteBody")}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.users.ordersSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {props.orders.items.map((order) => {
            const expanded = expandedOrderIds.includes(order.orderId);
            return (
              <div key={order.orderId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-medium">
                      {order.productName}
                      {order.productVariantLabel ? ` · ${order.productVariantLabel}` : ""}
                    </div>
                    <div className="text-xs text-muted-foreground">{order.orderId}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{order.status}</Badge>
                    <Button type="button" variant="outline" size="sm" onClick={() => toggleOrder(order.orderId)}>
                      {expanded ? t("admin.users.orders.collapse") : t("admin.users.orders.expand")}
                    </Button>
                    <Button asChild type="button" variant="ghost" size="sm">
                      <Link href={`/admin/orders/${order.orderId}`}>{t("admin.users.orders.viewOrder")}</Link>
                    </Button>
                  </div>
                </div>

                {expanded ? (
                  <div className="mt-3 grid gap-3 rounded-md bg-muted/20 p-3 md:grid-cols-2">
                    <div>{t("admin.users.orders.amount")}: {Number(order.amount)}</div>
                    <div>{t("admin.users.orders.pointsUsed")}: {order.pointsUsed || 0}</div>
                    <div>{t("admin.users.orders.email")}: {order.email || "-"}</div>
                    <div>
                      {t("admin.users.orders.tradeNo")}: {order.tradeNo ? <CopyButton text={order.tradeNo} /> : "-"}
                    </div>
                    <div className="md:col-span-2">
                      {t("admin.users.orders.cardKey")}: {order.cardKey ? <CopyButton text={order.cardKey} /> : "-"}
                    </div>
                    <div><ClientDate value={order.createdAt} format="dateTime" /></div>
                    <div><ClientDate value={order.paidAt} format="dateTime" /></div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <UserPointAdjustmentDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        userId={props.user.userId}
        username={props.user.username}
        currentPoints={props.user.points}
        onSuccess={() => router.refresh()}
      />
    </div>
  );
}
```

- [ ] **Step 5: 更新顾客列表页入口与调整弹窗调用**

```tsx
// _workers_next/src/components/admin/users-content.tsx
import Link from "next/link";
import { UserPointAdjustmentDialog } from "@/components/admin/user-point-adjustment-dialog";

// 表格用户名单元格
<TableCell>
  {user.username ? (
    <Link
      href={`/admin/users/${user.userId}`}
      className="font-medium text-sm hover:underline text-primary"
    >
      {getDisplayUsername(user.username, user.userId)}
    </Link>
  ) : (
    <Link href={`/admin/users/${user.userId}`} className="font-medium text-sm hover:underline text-primary">
      {user.userId}
    </Link>
  )}
</TableCell>

// 替换旧 Dialog
<UserPointAdjustmentDialog
  open={!!editingUser}
  onOpenChange={(open) => !open && setEditingUser(null)}
  userId={editingUser?.userId || ""}
  username={editingUser?.username || null}
  currentPoints={editingUser?.points || 0}
  onSuccess={() => {
    setEditingUser(null);
    router.refresh();
  }}
/>;
```

- [ ] **Step 6: 补齐中英文文案**

```json
// _workers_next/src/locales/zh.json 和 _workers_next/src/locales/en.json
{
  "admin": {
    "users": {
      "detailTitle": "顾客详情",
      "profileSection": "顾客资料",
      "ledgerTitle": "积分明细",
      "ordersSection": "顾客订单",
      "adjustPoints": "调整积分",
      "adjustDirection": "调整方向",
      "adjustIncrease": "增加",
      "adjustDecrease": "扣减",
      "adjustAmount": "调整数量",
      "adjustReason": "调整原因",
      "adjustPreview": "当前积分 {{current}}，调整后 {{next}}",
      "submitAdjustment": "确认调整",
      "email": "邮箱",
      "blockStatus": "状态",
      "blocked": "已拉黑",
      "active": "正常",
      "legacyNoteTitle": "历史积分说明",
      "legacyNoteBody": "若存在“历史积分余额初始化”记录，表示该顾客的旧积分来自历史对账补差，而不是完整还原的原始流水。",
      "ledgerBalanceAfter": "变动后余额",
      "ledgerOperator": "操作人",
      "ledgerType": {
        "checkin_reward": "签到奖励",
        "order_deduction": "订单抵扣",
        "refund_return": "退款返还",
        "admin_adjust": "后台调整"
      },
      "orders": {
        "expand": "展开订单",
        "collapse": "收起订单",
        "viewOrder": "查看后台订单",
        "amount": "订单金额",
        "pointsUsed": "积分抵扣",
        "email": "联系方式",
        "tradeNo": "交易号",
        "cardKey": "卡密"
      }
    }
  }
}
```

- [ ] **Step 7: 运行组件测试、账本测试与 lint**

Run:

```bash
npm --prefix _workers_next run test -- src/components/admin/user-detail-content.test.tsx src/lib/points/ledger-service.test.ts src/lib/points/legacy-reconciliation.test.ts
npm --prefix _workers_next run lint -- src/components/admin/user-point-adjustment-dialog.tsx src/components/admin/user-detail-content.tsx src/components/admin/users-content.tsx src/locales/zh.json src/locales/en.json
```

Expected:

- 组件测试通过
- 账本测试仍通过
- UI 与 i18n 文件无 lint 报错

- [ ] **Step 8: 手动回归**

Run:

```bash
npm --prefix _workers_next run dev
```

Manual verification checklist:

- 从 `/admin/users` 点击任意顾客能进入 `/admin/users/[id]`
- 顾客详情页能看到积分流水和订单列表
- 展开订单能看到交易号、联系信息、卡密摘要
- 调整积分时，原因为空无法提交
- 增加 / 扣减成功后详情页与列表页积分同步刷新

- [ ] **Step 9: 检查点**

Stop here and summarize:

- 已完成顾客详情页、积分弹窗、订单展开与 i18n
- 暂不提交，等待用户明确确认后再执行任何 git 操作

---

### Task 6: 全量验证与交付前检查

**Files:**
- Modify: `_workers_next/src/actions/points.ts`
- Modify: `_workers_next/src/actions/checkout.ts`
- Modify: `_workers_next/src/actions/refund.ts`
- Modify: `_workers_next/src/actions/admin-orders.ts`
- Modify: `_workers_next/src/actions/admin-users.ts`
- Modify: `_workers_next/src/lib/db/queries.ts`
- Modify: `_workers_next/src/components/admin/users-content.tsx`
- Create: `_workers_next/src/components/admin/user-detail-content.tsx`

- [ ] **Step 1: 跑完整相关测试集**

Run:

```bash
npm --prefix _workers_next run test -- src/lib/points/ledger-service.test.ts src/lib/points/legacy-reconciliation.test.ts src/components/admin/user-detail-content.test.tsx
```

Expected:

- 三组测试全部通过

- [ ] **Step 2: 跑全量 lint**

Run:

```bash
npm --prefix _workers_next run lint
```

Expected:

- 全仓 lint 通过

- [ ] **Step 3: 手动验证 8 个关键业务场景**

Manual checklist:

1. 顾客详情页可正常打开。
2. 历史顾客首次打开详情页后能看到历史初始化积分流水或历史订单积分流水。
3. 签到一次会新增 `checkin_reward`。
4. 同一天重复签到不会重复增加积分。
5. 使用积分下单后会新增 `order_deduction`。
6. 退款后会新增 `refund_return`，且不会重复返还。
7. 后台增加积分会新增 `admin_adjust`，带原因与操作人。
8. 后台扣减积分时不能扣成负数。

- [ ] **Step 4: 交付总结，不执行 commit**

Output checklist:

- 说明新增页面、账本表、服务入口与改造 action
- 说明已执行的测试命令与手动回归结果
- 说明未执行 `git commit`，等待用户明确确认

```text
完成后不要默认 git commit。按仓库规则，只有在用户明确确认后才能提交。
```
