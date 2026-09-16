# `_workers_next` 店铺设置页积分统计补充设计

## 1. 背景

当前 `_workers_next` 的店铺设置页顶部已经有一组后台统计卡片：

- 今日
- 近 7 天
- 本月
- 总计
- 顾客数

其中前四张卡片只展示订单维度数据：

- 大号数字：订单数
- 小字：LDC 收入

这套统计只能反映订单规模和 LDC 收款情况，无法反映签到积分系统的真实运行状态。当前后台存在两个明显缺口：

- 看不到签到积分在不同时间范围内的实际产出情况。
- 看不到订单抵扣积分在不同时间范围内的实际消耗情况。

这会导致运营在后台无法快速回答两个高频问题：

- 今日 / 近 7 天 / 本月，到底发出了多少签到积分？
- 同一时间范围内，用户到底消耗了多少积分用于订单抵扣？

因此需要在不改现有卡片布局逻辑的前提下，把积分产出 / 消耗统计补进店铺设置页顶部统计区域。

## 2. 目标

本次只针对 `_workers_next` 店铺设置页的统计展示做增强，不改积分记账逻辑、不改数据库结构、不改签到和下单行为。

目标如下：

- 店铺设置页顶部四张时间卡片同时展示订单统计和积分统计。
- 每张时间卡片保留现有“大号订单数”视觉层级。
- 在每张卡片内补充：
  - LDC 收入
  - 签到积分产出
  - 订单积分消耗
- 统计口径在四个时间范围内保持一致：
  - 今日
  - 近 7 天
  - 本月
  - 总计

## 3. 范围

### 3.1 本次范围内

- `/admin/settings` 顶部统计卡片
- 后台统计聚合查询
- 中英文文案补充

### 3.2 不在本次范围内

- 不修改积分账本入账规则
- 不修改签到奖励逻辑
- 不修改订单积分抵扣逻辑
- 不增加新的报表页
- 不新增图表、趋势线或导出能力
- 不改顾客详情页积分流水展示

## 4. 统计口径

### 4.1 订单统计口径

订单统计保持现有实现不变：

- 仅统计 `orders.status = 'delivered'`
- 订单数沿用现有 `count(*)`
- LDC 收入沿用现有 `sum(CAST(orders.amount AS REAL))`

### 4.2 积分统计口径

本次用户已明确确认的积分口径如下：

- `积分产出`：只统计 `user_point_ledger.event_type = 'checkin_reward'`
- `积分消耗`：只统计 `user_point_ledger.event_type = 'order_deduction'`

以下事件明确不计入这组统计：

- `refund_return`
- `admin_adjust`

### 4.3 数值方向

在积分账本里：

- `checkin_reward` 的 `delta` 为正数
- `order_deduction` 的 `delta` 为负数

因此展示口径统一为：

- `积分产出 = sum(checkin_reward.delta)`
- `积分消耗 = abs(sum(order_deduction.delta))`

后台页面只展示“消耗多少积分”，不展示负号。

### 4.4 时间范围

时间范围与现有统计保持一致：

- 今日：从当天 00:00:00 开始
- 近 7 天：从当前日期往前推 7 天
- 本月：从当月 1 日 00:00:00 开始
- 总计：全部历史

订单统计使用 `orders.paid_at` 的现有口径不变。  
积分统计使用 `user_point_ledger.created_at`。

## 5. 推荐方案

采用“扩展现有 `getDashboardStats()` 返回结构”的方案，不新增第二套页面级查询拼装逻辑。

原因如下：

- 当前店铺设置页已经只依赖一个顶部统计对象 `stats`。
- 这次新增的是同一块仪表盘信息，继续由一个 `stats` 对象承载更自然。
- 页面层不需要同时维护“订单统计 props”和“积分统计 props”两套并行数据。

但在函数内部仍然保持职责清晰：

- 一段查询负责订单聚合
- 一段查询负责积分聚合
- 最终在 `getDashboardStats()` 中合并成统一返回结构

这样可以兼顾：

- 对外接口最小改动
- 对内统计逻辑仍然清晰可维护

## 6. 页面展示设计

### 6.1 顶部卡片布局

顶部卡片数量保持不变：

- 4 张时间统计卡
- 1 张顾客数卡

不新增第二排积分卡片。

### 6.2 单张时间卡片展示结构

用户已确认采用以下展示方式：

- 大号数字继续显示订单数
- 下面补 3 行小字：
  - `LDC 收入`
  - `积分产出`
  - `积分消耗`

即每张时间卡片统一结构为：

- 标题：今日 / 近 7 天 / 本月 / 总计
- 主值：订单数
- 次级信息 1：LDC 收入
- 次级信息 2：积分产出
- 次级信息 3：积分消耗

### 6.3 顾客数卡片

顾客数卡片保持原样，不并入积分统计。

## 7. 数据结构设计

当前 `settings-content.tsx` 中的 `Stats` 类型为：

- `today: { count, revenue }`
- `week: { count, revenue }`
- `month: { count, revenue }`
- `total: { count, revenue }`

本次扩展为：

- `today: { count, revenue, pointsProduced, pointsConsumed }`
- `week: { count, revenue, pointsProduced, pointsConsumed }`
- `month: { count, revenue, pointsProduced, pointsConsumed }`
- `total: { count, revenue, pointsProduced, pointsConsumed }`

含义如下：

- `count`：订单数
- `revenue`：LDC 收入
- `pointsProduced`：签到积分产出
- `pointsConsumed`：订单积分消耗

## 8. 实现影响面

预计涉及文件：

- `_workers_next/src/lib/db/queries.ts`
- `_workers_next/src/app/admin/settings/page.tsx`
- `_workers_next/src/components/admin/settings-content.tsx`
- `_workers_next/src/locales/zh.json`
- `_workers_next/src/locales/en.json`

### 8.1 `_workers_next/src/lib/db/queries.ts`

职责：

- 扩展 `getDashboardStats(nowMs)`
- 在现有订单聚合基础上新增积分聚合
- 合并返回统一的 `stats` 结构

### 8.2 `_workers_next/src/app/admin/settings/page.tsx`

职责：

- 继续只取一次 `getDashboardStats(nowMs)`
- 无需增加新的页面层拼装逻辑
- 透传扩展后的 `stats`

### 8.3 `_workers_next/src/components/admin/settings-content.tsx`

职责：

- 扩展 `Stats` 类型
- 修改顶部四张统计卡的内容结构
- 保持顾客数卡片不变

### 8.4 多语言文案

职责：

- 新增积分统计相关文案：
  - `LDC 收入`
  - `积分产出`
  - `积分消耗`

## 9. 风险与约束

### 9.1 不改数据库结构

本次完全基于已有的 `user_point_ledger` 表统计，不新增表、不新增字段、不做迁移。

### 9.2 时间字段口径不同

订单统计按 `orders.paid_at`。  
积分统计按 `user_point_ledger.created_at`。

这是当前最合理口径，但需要在实现中保持注释和命名清晰，避免后续误解为同一个时间字段。

### 9.3 消耗值必须去负号

如果直接展示 `order_deduction.delta` 的求和结果，会出现负数。  
页面必须展示为正数“消耗量”，否则运营会误读。

## 10. 验证要求

至少验证以下场景：

- 店铺设置页顶部四张时间卡仍正常渲染。
- 每张卡片的大号数字仍为订单数。
- 每张卡片都出现三行次级统计：
  - LDC 收入
  - 积分产出
  - 积分消耗
- `checkin_reward` 会累计进积分产出。
- `order_deduction` 会累计进积分消耗，且页面显示为正数。
- `refund_return` 不会计入积分产出。
- `admin_adjust` 不会计入积分产出或积分消耗。
- 顾客数卡片仍保持原有展示与跳转行为。

## 11. 结论

这次改动的本质，是把店铺设置页顶部统计从“只看订单”升级为“同时看订单与积分”：

- 订单数继续体现成交规模
- LDC 收入继续体现现金收入
- 积分产出体现签到系统发放规模
- 积分消耗体现积分抵扣的实际使用规模

这样后台在一个入口里就能同时看到订单侧和积分侧的运行情况，不需要再去顾客流水里手动推断。
