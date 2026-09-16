# Workers Next Admin Product Edit Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `_workers_next` 中实现桌面端后台固定左侧侧边栏，并将商品新建/编辑页重构为“左内容编辑、右配置与操作”的双栏布局，同时保持现有保存逻辑和移动端抽屉导航不变。

**Architecture:** 先调整后台外壳，把桌面端滚动上下文稳定到右侧主内容区；再把 `product-form.tsx` 从单列长表单改成双栏壳子；最后把大块 JSX 拆成 4 个职责清晰的子组件，由 `product-form.tsx` 继续持有状态和提交逻辑。

**Tech Stack:** Next.js App Router、React 19 Client Components、TypeScript、Tailwind CSS、现有 `@/components/ui/*` 基础组件、既有 `saveProduct()` server action。

---

## File Structure

### Existing Files To Modify

- `_workers_next/src/app/admin/layout.tsx`
  - 调整桌面端后台骨架，让侧边栏固定，右侧 `main` 独立滚动。
- `_workers_next/src/components/admin/sidebar.tsx`
  - 保留移动端抽屉菜单，重写桌面端侧边栏容器样式与滚动行为。
- `_workers_next/src/components/admin/product-form.tsx`
  - 保留状态与提交总控，改成页面头部 + 双栏容器，并接入拆分后的 4 个子组件。

### New Files To Create

- `_workers_next/src/components/admin/product-content-section.tsx`
  - 左栏基础信息、价格与购买须知编辑区。
- `_workers_next/src/components/admin/product-media-section.tsx`
  - 左栏主图与图库编辑区。
- `_workers_next/src/components/admin/product-questions-section.tsx`
  - 左栏购买提问编辑区。
- `_workers_next/src/components/admin/product-settings-sidebar.tsx`
  - 右栏配置区与保存操作卡。

### Verification Constraints

- 当前仓库没有现成的 React 组件测试基建，这次是布局重构，不新增测试框架。
- 代码级验证以 `npx tsc --noEmit --pretty false` 为主。
- 页面验收以桌面端与移动端人工检查为主。

---

### Task 1: 固定后台桌面端侧边栏并稳定滚动上下文

**Files:**
- Modify: `_workers_next/src/app/admin/layout.tsx`
- Modify: `_workers_next/src/components/admin/sidebar.tsx`

- [ ] **Step 1: 改后台布局骨架，让桌面端右侧主内容区独立滚动**

在 `_workers_next/src/app/admin/layout.tsx` 中，把当前“侧边栏 + main”普通流式布局改成“固定侧边栏 + 带桌面偏移的主内容区”。

```tsx
return (
  <div className="min-h-screen bg-background">
    <UpdateNotification currentVersion={APP_VERSION} />
    <RegistryPrompt shouldPrompt={shouldPrompt} registryEnabled={registryEnabled} />
    <AdminSidebar username={user.username} />
    <main className="min-h-screen px-4 py-6 md:ml-64 md:h-screen md:overflow-y-auto md:px-8 md:py-10">
      {children}
    </main>
  </div>
)
```

- [ ] **Step 2: 改桌面端侧边栏为固定栏，移动端继续保留抽屉**

在 `_workers_next/src/components/admin/sidebar.tsx` 中保留现有移动端 `Sheet` 逻辑，只改桌面端 `aside` 样式：

```tsx
<aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-64 md:flex-col md:border-r md:bg-muted/40">
  <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
    <SidebarContent username={username} t={t} />
  </div>
</aside>
```

- [ ] **Step 3: 跑类型检查确认后台壳子改动没有引入 TS 问题**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证桌面端和移动端后台导航**

手动检查：

- 桌面端进入 `/admin/products`，向下滚动时左侧菜单保持固定
- 切到 `/admin/settings`、`/admin/orders`，右侧内容区仍可独立滚动
- 移动端宽度下仍然显示顶部菜单按钮和抽屉导航

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/app/admin/layout.tsx _workers_next/src/components/admin/sidebar.tsx
git commit -m "feat(workers-next): 固定后台桌面侧边栏"
```

---

### Task 2: 新建商品内容编辑区组件

**Files:**
- Create: `_workers_next/src/components/admin/product-content-section.tsx`
- Modify: `_workers_next/src/components/admin/product-form.tsx`

- [ ] **Step 1: 新建左栏内容编辑区组件，承接基础信息和价格区**

在 `_workers_next/src/components/admin/product-content-section.tsx` 中创建一个纯展示型客户端组件，只接收 `product`、`visibility-independent` 字段值和对应 setter/flags，不自己持有提交状态。

```tsx
type ProductContentSectionProps = {
  currentProduct: any
  showWarning: boolean
  setShowWarning: (value: boolean) => void
  productIdReadonly: boolean
  categoriesHint?: string
  t: (key: string) => string
}

export function ProductContentSection({
  currentProduct,
  showWarning,
  setShowWarning,
  productIdReadonly,
  t,
}: ProductContentSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("admin.productForm.basicSectionTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* slug / name / description / price / compareAtPrice / purchaseLimit / purchaseWarning */}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: 在总表单里用新组件替代对应旧 JSX**

在 `_workers_next/src/components/admin/product-form.tsx` 中把以下字段块迁入 `ProductContentSection`：

- `slug`
- `name`
- `price`
- `compareAtPrice`
- `purchaseLimit`
- `description`
- `purchaseWarning`

接入方式示例：

```tsx
<ProductContentSection
  currentProduct={currentProduct}
  showWarning={showWarning}
  setShowWarning={setShowWarning}
  productIdReadonly={!!currentProduct}
  t={t}
/>
```

- [ ] **Step 3: 跑类型检查确认 props 和事件没有断**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证基础字段仍然参与提交**

手动检查：

- 新建商品时可编辑 `slug`
- 编辑商品时 `slug` 仍然只读
- 输入名称、价格、描述、购买须知后点击保存，`FormData` 字段名保持原样

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/components/admin/product-content-section.tsx _workers_next/src/components/admin/product-form.tsx
git commit -m "refactor(workers-next): 拆分商品内容编辑区"
```

---

### Task 3: 新建商品图片与图库组件

**Files:**
- Create: `_workers_next/src/components/admin/product-media-section.tsx`
- Modify: `_workers_next/src/components/admin/product-form.tsx`

- [ ] **Step 1: 新建图片与图库组件，完整承接现有主图和图库 UI**

在 `_workers_next/src/components/admin/product-media-section.tsx` 中承接以下状态驱动界面：

- 主图输入与主图上传
- 主图预览
- 图库输入与图库上传
- 图库卡片预览、设为封面、删除

```tsx
type ProductMediaSectionProps = {
  currentProduct: any
  loading: boolean
  productImageValue: string
  setProductImageValue: (value: string) => void
  productGalleryValues: string[]
  galleryImageInputValue: string
  setGalleryImageInputValue: (value: string) => void
  processingProductImageFile: boolean
  processingProductGalleryFiles: boolean
  hasRoomForMoreGalleryImages: boolean
  productImageFileInputRef: React.RefObject<HTMLInputElement | null>
  productGalleryFileInputRef: React.RefObject<HTMLInputElement | null>
  handleAddGalleryImage: () => void
  handlePromoteGalleryImage: (index: number) => void
  handleRemoveGalleryImage: (index: number) => void
  handleSelectProductImageFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
  handleSelectProductGalleryFiles: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
  t: (key: string, params?: Record<string, any>) => string
}
```

- [ ] **Step 2: 在总表单中用图片组件替代旧图片/图库 JSX**

在 `_workers_next/src/components/admin/product-form.tsx` 中删除旧的主图与图库 JSX，改为：

```tsx
<ProductMediaSection
  currentProduct={currentProduct}
  loading={loading}
  productImageValue={productImageValue}
  setProductImageValue={setProductImageValue}
  productGalleryValues={productGalleryValues}
  galleryImageInputValue={galleryImageInputValue}
  setGalleryImageInputValue={setGalleryImageInputValue}
  processingProductImageFile={processingProductImageFile}
  processingProductGalleryFiles={processingProductGalleryFiles}
  hasRoomForMoreGalleryImages={hasRoomForMoreGalleryImages}
  productImageFileInputRef={productImageFileInputRef}
  productGalleryFileInputRef={productGalleryFileInputRef}
  handleAddGalleryImage={handleAddGalleryImage}
  handlePromoteGalleryImage={handlePromoteGalleryImage}
  handleRemoveGalleryImage={handleRemoveGalleryImage}
  handleSelectProductImageFile={handleSelectProductImageFile}
  handleSelectProductGalleryFiles={handleSelectProductGalleryFiles}
  t={t}
/>
```

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证图片行为没有回归**

手动检查：

- 主图上传后仍能显示预览
- 图库上传后仍能追加图片
- “设为封面”会交换主图和图库图
- 删除图库图仍然生效

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/components/admin/product-media-section.tsx _workers_next/src/components/admin/product-form.tsx
git commit -m "refactor(workers-next): 拆分商品图片编辑区"
```

---

### Task 4: 新建购买提问组件

**Files:**
- Create: `_workers_next/src/components/admin/product-questions-section.tsx`
- Modify: `_workers_next/src/components/admin/product-form.tsx`

- [ ] **Step 1: 新建购买提问组件，承接开关与动态列表**

在 `_workers_next/src/components/admin/product-questions-section.tsx` 中承接：

- `showQuestions`
- `purchaseQuestions`
- 新增问题
- 删除问题
- 修改问题和答案

```tsx
type ProductQuestionsSectionProps = {
  showQuestions: boolean
  setShowQuestions: (value: boolean) => void
  purchaseQuestions: Array<{ q: string; a: string }>
  setPurchaseQuestions: (value: Array<{ q: string; a: string }>) => void
  t: (key: string) => string
}
```

组件内部保留隐藏字段：

```tsx
<input type="hidden" name="purchaseQuestions" value={JSON.stringify(purchaseQuestions)} />
```

- [ ] **Step 2: 在总表单中替换购买提问旧 JSX**

在 `_workers_next/src/components/admin/product-form.tsx` 中接入：

```tsx
<ProductQuestionsSection
  showQuestions={showQuestions}
  setShowQuestions={setShowQuestions}
  purchaseQuestions={purchaseQuestions}
  setPurchaseQuestions={setPurchaseQuestions}
  t={t}
/>
```

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证提问列表行为**

手动检查：

- 勾选后可以新增问题
- 修改问答内容后隐藏字段仍包含最新 JSON
- 删除项后保存不报错

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/components/admin/product-questions-section.tsx _workers_next/src/components/admin/product-form.tsx
git commit -m "refactor(workers-next): 拆分商品提问编辑区"
```

---

### Task 5: 新建右栏配置与操作组件

**Files:**
- Create: `_workers_next/src/components/admin/product-settings-sidebar.tsx`
- Modify: `_workers_next/src/components/admin/product-form.tsx`

- [ ] **Step 1: 新建右栏配置组件，集中发布设置、属性、积分和变体**

在 `_workers_next/src/components/admin/product-settings-sidebar.tsx` 中承接：

- 分类
- 可见等级
- `isShared`
- `isHot`
- 积分抵扣开关与比例
- `variantGroupId`
- `variantLabel`
- 顶部保存/取消操作卡

```tsx
type ProductSettingsSidebarProps = {
  currentProduct: any
  categories: Array<{ name: string }>
  loading: boolean
  pointDiscountEnabled: boolean
  setPointDiscountEnabled: (value: boolean) => void
  visibilityLevel: string
  setVisibilityLevel: (value: string) => void
  onCancel: () => void
  t: (key: string) => string
}
```

右栏顶层容器使用：

```tsx
<div className="space-y-4 lg:sticky lg:top-6">
  {/* 操作卡 + 发布设置卡 + 属性卡 + 积分与变体卡 */}
</div>
```

- [ ] **Step 2: 将底部保存按钮迁移到右栏顶部操作卡**

在 `_workers_next/src/components/admin/product-form.tsx` 中删除底部动作区：

```tsx
<div className="pt-4 flex justify-end gap-2">...</div>
```

改为把取消和保存操作交给右栏组件：

```tsx
<ProductSettingsSidebar
  currentProduct={currentProduct}
  categories={categories}
  loading={loading}
  pointDiscountEnabled={pointDiscountEnabled}
  setPointDiscountEnabled={setPointDiscountEnabled}
  visibilityLevel={visibilityLevel}
  setVisibilityLevel={setVisibilityLevel}
  onCancel={() => router.back()}
  t={t}
/>
```

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证右栏配置和保存操作**

手动检查：

- 右栏能修改分类、可见性、共享、热门、积分抵扣和变体字段
- 桌面端下右栏滚动到页面中段后仍可看到保存按钮
- 点击取消仍然执行 `router.back()`

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/components/admin/product-settings-sidebar.tsx _workers_next/src/components/admin/product-form.tsx
git commit -m "feat(workers-next): 新增商品右栏配置区"
```

---

### Task 6: 集成商品编辑页双栏壳子和页面头部

**Files:**
- Modify: `_workers_next/src/components/admin/product-form.tsx`

- [ ] **Step 1: 给商品表单增加页面级标题区和双栏栅格**

在 `_workers_next/src/components/admin/product-form.tsx` 中把当前单卡片结构：

```tsx
<Card className="max-w-2xl mx-auto">...</Card>
```

改成页面头部 + 双栏栅格：

```tsx
return (
  <div className="mx-auto max-w-7xl space-y-6">
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        {product ? t("admin.productForm.editTitle") : t("admin.productForm.addTitle")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t("admin.productForm.layoutHint")}
      </p>
    </div>

    <div className="relative">
      {loading && /* 保留现有遮罩 */}
      <form key={formSeed} onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_360px]" aria-busy={loading}>
        <fieldset disabled={loading} className="contents">
          <div className="space-y-6">
            <ProductContentSection ... />
            <ProductMediaSection ... />
            <ProductQuestionsSection ... />
          </div>
          <ProductSettingsSidebar ... />
        </fieldset>
      </form>
    </div>
  </div>
)
```

- [ ] **Step 2: 调整 loading 遮罩覆盖新布局容器**

保留现有遮罩逻辑，但让遮罩挂在双栏外层，而不是旧单卡片 `CardContent` 内部，确保保存时整张编辑页面都被锁定：

```tsx
{loading && (
  <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/70 backdrop-blur-sm">
    ...
  </div>
)}
```

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 4: 手工验证双栏布局和响应式折叠**

手动检查：

- 桌面端是左内容右配置
- 平板/移动端自动折叠成单列
- 保存中遮罩覆盖整个编辑区域

- [ ] **Step 5: 提交这一阶段**

```bash
git add _workers_next/src/components/admin/product-form.tsx
git commit -m "feat(workers-next): 重构商品编辑页双栏布局"
```

---

### Task 7: 端到端回归验证与收尾

**Files:**
- Verify only: `_workers_next/src/app/admin/layout.tsx`
- Verify only: `_workers_next/src/components/admin/sidebar.tsx`
- Verify only: `_workers_next/src/components/admin/product-form.tsx`
- Verify only: `_workers_next/src/components/admin/product-content-section.tsx`
- Verify only: `_workers_next/src/components/admin/product-media-section.tsx`
- Verify only: `_workers_next/src/components/admin/product-questions-section.tsx`
- Verify only: `_workers_next/src/components/admin/product-settings-sidebar.tsx`

- [ ] **Step 1: 跑最终类型检查**

Run: `npx tsc --noEmit --pretty false`  
Expected: 无输出，退出码 `0`

- [ ] **Step 2: 跑最终构建验证**

Run: `npm run build`  
Expected: Next.js 构建完成并退出码 `0`

- [ ] **Step 3: 做桌面端人工验收**

手动检查以下路径：

- `/admin/products`
- `/admin/settings`
- `/admin/product/new`
- `/admin/product/edit/[existing-id]`

验收点：

- 左侧后台菜单固定
- 右侧主内容独立滚动
- 商品编辑页右栏保存卡吸顶
- 新建/编辑商品保存流程保持原有行为

- [ ] **Step 4: 做移动端人工验收**

在窄视口下检查：

- 后台顶部菜单按钮仍可打开抽屉
- 商品编辑页变为单列
- 没有横向溢出

- [ ] **Step 5: 整理并提交最终结果**

```bash
git add _workers_next/src/app/admin/layout.tsx _workers_next/src/components/admin/sidebar.tsx _workers_next/src/components/admin/product-form.tsx _workers_next/src/components/admin/product-content-section.tsx _workers_next/src/components/admin/product-media-section.tsx _workers_next/src/components/admin/product-questions-section.tsx _workers_next/src/components/admin/product-settings-sidebar.tsx
git commit -m "feat(workers-next): 重构后台商品编辑布局"
```

---

## Self-Review

### Spec Coverage Check

- 固定桌面端后台侧边栏：Task 1
- 商品编辑页双栏布局：Task 6
- 左栏内容编辑区：Task 2、Task 3、Task 4
- 右栏配置与操作区：Task 5
- 不改保存逻辑、保留移动端抽屉：Task 1、Task 5、Task 6、Task 7 验收约束已覆盖

### Placeholder Scan

- 计划中未使用 `TODO`、`TBD`、`类似 Task N` 之类占位写法
- 每个任务都给出明确文件路径、代码片段和验证命令

### Type Consistency Check

- `product-form.tsx` 继续作为状态总控
- 4 个子组件都只接 props，不接 server action
- `loading`、`pointDiscountEnabled`、`visibilityLevel` 等关键状态命名与现有代码保持一致

---

Plan complete and saved to `docs/superpowers/plans/2026-04-21-workers-next-admin-product-edit-layout.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
