# _workers_next 商品表单保存 Loading 遮罩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `_workers_next` 的商品新建/编辑共用表单增加卡片级保存 loading 遮罩，并在保存期间锁定整个表单区域。

**Architecture:** 保持改动收敛在 `_workers_next/src/components/admin/product-form.tsx`，不修改 `saveProduct()` 的后端业务逻辑和页面级路由。提交入口从当前的表单 `action` 绑定切换为显式客户端 `onSubmit`，以便在点击后第一时间稳定设置本地 `loading` 状态，再通过卡片局部遮罩和 `fieldset` 锁定交互区域。

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Server Actions, Tailwind CSS, lucide-react

---

## File Structure

- Modify: `_workers_next/src/components/admin/product-form.tsx`
  - 引入 `Loader2` 和表单提交事件类型。
  - 把当前 `handleSubmit(formData: FormData)` 改成显式客户端提交处理。
  - 在表单内容区增加局部 loading 遮罩。
  - 用 `fieldset disabled={loading}` 和按钮显式禁用一起锁定交互。
- Review only: `_workers_next/src/actions/admin.ts`
  - 确认继续复用现有 `saveProduct(formData)`，不修改保存业务逻辑。
- No changes expected: `_workers_next/src/locales/zh.json`
  - 复用已有 `admin.productForm.saving`，不新增文案。
- No changes expected: `_workers_next/src/locales/en.json`
  - 同上。

## Verification Strategy

- 当前仓库没有独立的前端组件测试脚本，也没有现成的 `test` 命令。
- 本次不为了一个交互反馈需求引入新的测试框架。
- 验证采用三层：
  - 手动复现旧问题，确认基线
  - `npx tsc --noEmit --pretty false`
  - `npm run build`
  - 本地浏览器回归 `/admin/product/new` 和 `/admin/product/edit/[id]`

### Task 1: 收紧商品表单的提交入口和保存状态

**Files:**
- Modify: `_workers_next/src/components/admin/product-form.tsx:1-15`
- Modify: `_workers_next/src/components/admin/product-form.tsx:23-135`
- Review: `_workers_next/src/actions/admin.ts:27-208`

- [ ] **Step 1: 先手动复现当前问题，确认基线行为**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run dev
```

Manual check:
- 用管理员会话打开 `http://localhost:3000/admin/product/new`
- 随便填写一个最小商品表单
- 点击“保存商品”
- 记录当前表现：
  - 没有局部遮罩
  - 只有按钮文本变化或变化不明显
  - 用户体感上像“页面没反应”

Expected: 成功复现“保存反馈太弱”的现状，作为后续回归对照。

- [ ] **Step 2: 引入显式客户端提交处理，让 `loading` 状态在点击后立即稳定生效**

Update the imports and submit handler in `_workers_next/src/components/admin/product-form.tsx`:

```tsx
'use client'

import { getProductForAdminAction, saveProduct } from "@/actions/admin"
import { prepareUploadedImage } from "@/lib/client-image"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Loader2 } from "lucide-react"
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
```

```tsx
async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitLock.current) return

    submitLock.current = true
    setLoading(true)

    const formData = new FormData(event.currentTarget)

    try {
        await saveProduct(formData)
        toast.success(t('common.success'))
        router.push('/admin/products')
    } catch (e: any) {
        console.error('Save product error:', e)
        toast.error(e?.message || t('common.error'))
    } finally {
        setLoading(false)
        submitLock.current = false
    }
}
```

- [ ] **Step 3: 把表单从 `action={handleSubmit}` 改为显式 `onSubmit={handleSubmit}`，确保客户端提交路径生效**

Update the form root in `_workers_next/src/components/admin/product-form.tsx`:

```tsx
<form key={formSeed} onSubmit={handleSubmit} className="space-y-5">
    {currentProduct && <input type="hidden" name="id" value={currentProduct.id} />}
    {/* remaining fields */}
</form>
```

- [ ] **Step 4: 运行静态检查，确认改动后的提交签名和 JSX 绑定没有类型错误**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npx tsc --noEmit --pretty false
```

Expected: `PASS`，不应出现 `FormEvent` 类型错误、`onSubmit` 签名不匹配，或 `saveProduct(formData)` 参数类型不兼容的报错。

### Task 2: 添加卡片级遮罩并锁定整个表单交互区

**Files:**
- Modify: `_workers_next/src/components/admin/product-form.tsx:220-617`

- [ ] **Step 1: 给卡片内容区增加相对定位容器、`fieldset` 锁定和遮罩层**

Update the card body in `_workers_next/src/components/admin/product-form.tsx`:

```tsx
<Card className="max-w-2xl mx-auto">
    <CardHeader>
        <CardTitle>{product ? t('admin.productForm.editTitle') : t('admin.productForm.addTitle')}</CardTitle>
    </CardHeader>
    <CardContent className="relative">
        {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
                <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/95 px-4 py-3 text-sm font-medium shadow-lg"
                >
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>{t('admin.productForm.saving')}</span>
                </div>
            </div>
        )}

        <form key={formSeed} onSubmit={handleSubmit} className="space-y-5" aria-busy={loading}>
            <fieldset disabled={loading} className="space-y-5">
                {currentProduct && <input type="hidden" name="id" value={currentProduct.id} />}
                {/* all existing form fields stay inside this fieldset */}
            </fieldset>
        </form>
    </CardContent>
</Card>
```

- [ ] **Step 2: 保持按钮层级反馈一致，明确禁用返回按钮和保存按钮**

Update the footer action row in `_workers_next/src/components/admin/product-form.tsx`:

```tsx
<div className="pt-4 flex justify-end gap-2">
    <Button
        variant="outline"
        type="button"
        onClick={() => router.back()}
        disabled={loading}
    >
        {t('common.cancel')}
    </Button>
    <Button type="submit" disabled={loading}>
        {loading ? (
            <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('admin.productForm.saving')}
            </>
        ) : (
            t('admin.productForm.saveButton')
        )}
    </Button>
</div>
```

- [ ] **Step 3: 确认图片上传、图库按钮、输入框和复选框都落在 `fieldset` 内，没有遗漏可点击控件**

Make sure these sections stay inside the disabled `fieldset` block:

```tsx
<Input id="name" name="name" defaultValue={currentProduct?.name} placeholder={t('admin.productForm.namePlaceholder')} required />

<Button
    type="button"
    variant="outline"
    className="w-fit"
    onClick={() => productImageFileInputRef.current?.click()}
    disabled={processingProductImageFile}
>
    {processingProductImageFile ? t('common.processing') : t('admin.productForm.imageUpload')}
</Button>

<Button
    type="button"
    variant="outline"
    onClick={handleAddGalleryImage}
    disabled={!galleryImageInputValue.trim() || !hasRoomForMoreGalleryImages}
>
    {t('admin.productForm.galleryAdd')}
</Button>
```

Expected implementation detail:
- 不修改这些控件自身的业务逻辑
- 只通过 `fieldset disabled={loading}` 让它们在保存期间统一不可操作

- [ ] **Step 4: 运行完整构建，确认局部遮罩和 `Loader2` 引入没有破坏页面编译**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run build
```

Expected: `PASS`，输出包含 `Compiled successfully`，且不会出现：
- `Loader2 is not defined`
- JSX 结构不闭合
- `Button` children 类型错误
- `fieldset` / `form` 嵌套导致的编译错误

### Task 3: 回归新建页和编辑页的保存体验

**Files:**
- Review: `_workers_next/src/components/admin/product-form.tsx`
- Review: `_workers_next/src/app/admin/product/new/page.tsx`
- Review: `_workers_next/src/app/admin/product/edit/[id]/page.tsx`

- [ ] **Step 1: 在新建商品页验证遮罩与锁定行为**

Run from `E:\local_project\git\ldc-shop\_workers_next`:

```powershell
Set-Location 'E:\local_project\git\ldc-shop\_workers_next'
npm run dev
```

Manual check in browser with admin session:
- 打开 `http://localhost:3000/admin/product/new`
- 填入最小必填字段
- 点击“保存商品”
- 立即确认：
  - 表单卡片区域出现半透明遮罩
  - 中间出现转圈图标和 `保存中...`
  - 保存按钮不可重复点击
  - 返回按钮不可点击
  - 输入框和上传区不可继续操作

Expected: 新建页保存反馈明显增强，不再出现“点了像没反应”的体感。

- [ ] **Step 2: 在编辑商品页验证相同行为，并确认成功后仍跳回商品列表**

Manual check in browser with admin session:
- 打开任意一个现有商品的编辑页，例如 `http://localhost:3000/admin/product/edit/<existing-id>`
- 修改一个非关键字段
- 点击“保存商品”
- 确认：
  - 遮罩表现和新建页一致
  - 成功后仍跳转到 `/admin/products`
  - 出现现有成功 toast

Expected: 编辑页和新建页使用相同交互，不因为 `product` 是否存在而出现分叉行为。

- [ ] **Step 3: 验证失败分支会释放遮罩并保留表单内容**

Manual failure scenario:
- 在新建或编辑页制造一个可预期失败，例如让 `slug` 使用非法字符（新建商品时）或触发未授权环境
- 点击“保存商品”
- 确认：
  - 错误 toast 仍然出现
  - 遮罩消失
  - 当前表单输入内容保留

Expected: 失败后不会卡死在 loading 状态，也不会清空用户刚输入的内容。

- [ ] **Step 4: 提交本次功能变更**

```powershell
Set-Location 'E:\local_project\git\ldc-shop'
git add _workers_next/src/components/admin/product-form.tsx
git commit -m "fix(product): 增加商品表单保存遮罩反馈"
```

## Self-Review

- 规格覆盖检查：
  - 已覆盖商品新建页和编辑页两个入口。
  - 已覆盖卡片级遮罩、提交锁定、成功跳转、失败解锁四类核心行为。
  - 明确保持 `saveProduct()` 业务逻辑不变，没有扩散到其他后台页面。
- 占位符扫描：
  - 计划中没有 `TODO`、`TBD`、或“后续补充”类占位内容。
  - 每个会改代码的步骤都给了实际代码片段和命令。
- 类型一致性：
  - 统一沿用 `loading` 作为保存态字段。
  - 统一使用 `Loader2` 和 `admin.productForm.saving` 作为可见反馈，不引入第二套命名。
