/**
 * 页面级 Loading 遮罩状态机（纯逻辑，无 React 依赖）。
 *
 * 设计要点：
 *   - 引用计数：多个并发任务同时加载时，只有全部结束才收起遮罩，
 *     避免较早结束的请求误关仍在使用的遮罩。
 *   - 延时阈值：任务在 DELAY_MS 内结束不渲染遮罩，快速导航不闪烁。
 *   - 卡死保护：超过 STUCK_MS 仍未结束，切换为可恢复状态（failed），
 *     由用户选择「继续等待」或「关闭」，绝不出现永久旋转遮罩。
 *   - 状态语义：idle → delayed → loading →（completed | failed）
 *     completed 只用于播放淡出动画，动画结束回到 idle 并彻底移除 DOM。
 *   - **交互抑制（interaction lock）**：业务提交（保存/删除/发货）期间，
 *     禁止路由级任务点亮全屏遮罩。原因见下方 `beginInteraction` 注释 ——
 *     这是「提交后刷新触发 loading.tsx，全屏遮罩盖住业务卡片」的根因修复。
 */

export type PageLoadingStatus = 'idle' | 'delayed' | 'loading' | 'completed' | 'failed'

/**
 * 任务来源。
 *   - route：由 `loading.tsx` 的 Suspense fallback 上报（页面/路由装载）。
 *     会受交互抑制影响 —— 业务提交触发的 `router.refresh()` 会短暂挂载
 *     fallback，但这并不代表用户需要看到全屏遮罩。
 *   - interaction：由业务流程显式上报（真正的页面级导航）。不受抑制影响。
 */
export type PageLoadingOrigin = 'route' | 'interaction'

interface PageLoadingTask {
    labelKey: string | null
    origin: PageLoadingOrigin
}

export interface PageLoadingSnapshot {
    status: PageLoadingStatus
    /** 是否需要渲染遮罩（completed 阶段仍需渲染以播放淡出） */
    visible: boolean
    /** 是否处于「加载过久」的可恢复状态 */
    stuck: boolean
    activeCount: number
    /** 当前是否因业务提交而抑制路由级遮罩 */
    suppressed: boolean
    labelKey: string | null
}

export interface PageLoadingTimers {
    setTimeout: (handler: () => void, timeout: number) => unknown
    clearTimeout: (handle: unknown) => void
}

/** 少于该时长的加载不显示遮罩，避免闪烁 */
export const PAGE_LOADING_DELAY_MS = 180
/** 淡出动画时长，与遮罩上的 animate-out duration 保持一致 */
export const PAGE_LOADING_FADE_OUT_MS = 220
/** 超过该时长仍未结束则进入可恢复状态，而不是无限旋转 */
export const PAGE_LOADING_STUCK_MS = 12000
/**
 * 业务交互释放后的「尾随抑制」窗口。
 *
 * 为什么光有引用计数不够：`router.refresh()` 是即发即忘的，它返回后
 * RSC 重新渲染才真正发生 —— 此时 `loading.tsx` 的 fallback 才挂载。
 * 如果 release 一调用就解除抑制，抑制窗口会早于 fallback 挂载，
 * 遮罩照样会闪出来。因此释放后再保持一段短尾随窗口，
 * 覆盖「refresh 触发 → fallback 挂载 → 数据回填 → fallback 卸载」全程。
 *
 * 800ms 的取值依据：刷新渲染通常远快于此；即便真的更慢，
 * 最坏结果也只是不显示页面级遮罩（业务自身的提交反馈仍在），
 * 不会出现「遮罩盖住操作」这种阻断性故障。
 */
export const PAGE_LOADING_INTERACTION_TAIL_MS = 800

const IDLE_SNAPSHOT: PageLoadingSnapshot = Object.freeze({
    status: 'idle',
    visible: false,
    stuck: false,
    activeCount: 0,
    suppressed: false,
    labelKey: null,
})

const defaultTimers: PageLoadingTimers = {
    setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (handle) => {
        if (handle === null || handle === undefined) return
        globalThis.clearTimeout(handle as never)
    },
}

export class PageLoadingStore {
    private tasks = new Map<string, PageLoadingTask>()
    private status: PageLoadingStatus = 'idle'
    private stuck = false
    private listeners = new Set<() => void>()
    private snapshot: PageLoadingSnapshot = IDLE_SNAPSHOT
    private delayTimer: unknown = null
    private stuckTimer: unknown = null
    private resetTimer: unknown = null
    /**
     * 业务交互计数。
     *
     * 为什么需要它：业务提交成功后普遍会调用 `router.refresh()`。
     * RSC 刷新会让 `loading.tsx` 的 Suspense fallback 短暂挂载，
     * 于是路由级任务点亮全屏遮罩 —— 而此时的「加载」只是提交后的
     * 数据回填，用户真正在等的是业务卡片自己的 submitting 状态。
     * 结果是业务遮罩被全屏遮罩盖住、页面点击被拦截，表现为「提交后卡住」。
     *
     * 因此业务提交期间主动抑制路由级任务；业务流程需要真正的页面级
     * 反馈时使用 origin='interaction' 显式上报，不受抑制影响。
     */
    private interactionDepth = 0
    /** 释放后仍在生效的尾随抑制截止时间戳（由 timers.setTimeout 驱动） */
    private interactionTailTimer: unknown = null
    private readonly timers: PageLoadingTimers

    constructor(timers: PageLoadingTimers = defaultTimers) {
        this.timers = timers
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    getSnapshot = (): PageLoadingSnapshot => {
        return this.snapshot
    }

    /** SSR / 首屏渲染使用：始终返回空状态，避免服务端输出遮罩 */
    getServerSnapshot = (): PageLoadingSnapshot => {
        return IDLE_SNAPSHOT
    }

    /**
     * begin 注册一个加载任务。同一 taskId 重复注册不会重复计数。
     *
     * 交互抑制：业务提交期间（`interactionDepth > 0`）到达的路由级任务
     * 直接忽略 —— 它由提交后的 `router.refresh()` 触发，不代表用户等导航。
     * 忽略是幂等的：刷新结束 fallback 卸载时调用 `end(taskId)` 找不到该 id，
     * 会安全地什么都不做，不会破坏引用计数。
     */
    begin(taskId: string, labelKey?: string | null, origin: PageLoadingOrigin = 'route'): void {
        if (!taskId) return
        if (origin === 'route' && this.isSuppressed()) return

        const isNewTask = !this.tasks.has(taskId)
        // 总是更新文案，保证后续任务能覆盖旧文案
        this.tasks.set(taskId, { labelKey: labelKey ?? null, origin })
        if (!isNewTask) {
            this.emit()
            return
        }

        // 若正处于淡出阶段，取消复位并直接回到展示状态
        this.clearResetTimer()
        if (this.status === 'completed') {
            this.status = 'loading'
            this.stuck = false
            this.scheduleStuckTimer()
            this.emit()
            return
        }

        if (this.status === 'idle' || this.status === 'failed') {
            // failed 状态下降级为重新开始计时，而不是叠加
            this.status = 'delayed'
            this.stuck = false
            this.clearStuckTimer()
            this.scheduleDelayTimer()
        } else if (this.status === 'delayed') {
            // 已存在延时中的任务，无需重复计时
        } else if (this.status === 'loading') {
            // 已在展示，保持计时器
        }
        this.emit()
    }

    /**
     * beginInteraction 声明一次业务提交开始。
     *
     * 返回一个**幂等**的释放函数，调用方应在 `finally` 中调用它，
     * 保证任何异常路径都不会让抑制状态永久残留（否则页面级遮罩会永久失效，
     * 那比「遮罩乱闪」更糟）。
     *
     * 用法：
     *   const release = pageLoadingStore.beginInteraction()
     *   try { await submit() } finally { release() }
     */
    beginInteraction(): () => void {
        this.interactionDepth += 1
        // 新交互重新开始 → 取消上一轮尾随窗口
        this.clearInteractionTailTimer()
        let released = false

        // 抑制开始时先收掉已在展示的路由级遮罩。
        // 场景：用户点链接触发了导航遮罩，随即在页面上完成一次提交 ——
        // 此时全屏遮罩必须立刻让位给业务卡片自己的提交反馈，否则就出现
        // 「遮罩盖住正在操作的区域」的观感。仅清理 route 来源的任务，
        // 显式 interaction 任务（真正的页面级等待）保持不动。
        for (const [taskId, task] of this.tasks) {
            if (task.origin === 'route') this.tasks.delete(taskId)
        }
        if (this.tasks.size === 0) {
            this.clearAllTimers()
            this.stuck = false
            this.status = 'idle'
        }

        this.emit()
        return () => {
            if (released) return
            released = true
            this.interactionDepth = Math.max(0, this.interactionDepth - 1)

            if (this.interactionDepth === 0) {
                // 开启尾随窗口，覆盖 router.refresh() 之后的 fallback 挂载期
                this.clearInteractionTailTimer()
                this.interactionTailTimer = this.timers.setTimeout(() => {
                    this.interactionTailTimer = null
                    this.emit()
                }, PAGE_LOADING_INTERACTION_TAIL_MS)
            }

            this.emit()
        }
    }

    /** isSuppressed 当前是否处于业务提交抑制窗口内（含尾随窗口） */
    isSuppressed(): boolean {
        return this.interactionDepth > 0 || this.interactionTailTimer !== null
    }

    /**
     * end 结束一个加载任务。全部任务结束后进入 completed 并播放淡出。
     */
    end(taskId: string): void {
        if (!taskId) return
        if (!this.tasks.delete(taskId)) return

        if (this.tasks.size > 0) {
            this.emit()
            return
        }

        this.clearDelayTimer()
        this.clearStuckTimer()
        this.stuck = false

        if (this.status === 'delayed') {
            // 从未展示过，直接回到 idle，不播放淡出
            this.status = 'idle'
            this.emit()
            return
        }

        if (this.status === 'loading' || this.status === 'failed') {
            this.status = 'completed'
            this.emit()
            this.scheduleResetTimer()
            return
        }

        this.status = 'idle'
        this.emit()
    }

    /**
     * fail 标记任务失败。失败时立即释放遮罩，让错误界面第一时间可见。
     */
    fail(taskId: string): void {
        if (!taskId) return
        this.tasks.delete(taskId)
        this.clearAllTimers()
        this.stuck = false
        this.status = 'idle'
        this.emit()
    }

    /** dismiss 用户主动关闭「加载过久」的遮罩 */
    dismiss(): void {
        this.tasks.clear()
        this.clearAllTimers()
        this.stuck = false
        this.status = 'idle'
        this.emit()
    }

    /** retry 用户选择继续等待：清空卡死标记并重新计时 */
    retry(): void {
        if (this.tasks.size === 0) {
            this.status = 'idle'
            this.stuck = false
            this.emit()
            return
        }
        this.stuck = false
        this.status = 'loading'
        this.clearStuckTimer()
        this.scheduleStuckTimer()
        this.emit()
    }

    /** dispose 释放所有计时器与订阅（用于极端场景下的彻底清理） */
    dispose(): void {
        this.clearAllTimers()
        this.clearInteractionTailTimer()
        this.tasks.clear()
        this.listeners.clear()
        this.stuck = false
        this.interactionDepth = 0
        this.status = 'idle'
        this.snapshot = IDLE_SNAPSHOT
    }

    private scheduleDelayTimer(): void {
        this.clearDelayTimer()
        this.delayTimer = this.timers.setTimeout(() => {
            this.delayTimer = null
            if (this.tasks.size === 0) return
            this.status = 'loading'
            this.scheduleStuckTimer()
            this.emit()
        }, PAGE_LOADING_DELAY_MS)
    }

    private scheduleStuckTimer(): void {
        this.clearStuckTimer()
        this.stuckTimer = this.timers.setTimeout(() => {
            this.stuckTimer = null
            if (this.tasks.size === 0) return
            this.stuck = true
            this.status = 'failed'
            this.emit()
        }, PAGE_LOADING_STUCK_MS)
    }

    private scheduleResetTimer(): void {
        this.clearResetTimer()
        this.resetTimer = this.timers.setTimeout(() => {
            this.resetTimer = null
            if (this.tasks.size > 0) return
            this.status = 'idle'
            this.emit()
        }, PAGE_LOADING_FADE_OUT_MS)
    }

    private clearDelayTimer(): void {
        if (this.delayTimer === null) return
        this.timers.clearTimeout(this.delayTimer)
        this.delayTimer = null
    }

    private clearStuckTimer(): void {
        if (this.stuckTimer === null) return
        this.timers.clearTimeout(this.stuckTimer)
        this.stuckTimer = null
    }

    private clearResetTimer(): void {
        if (this.resetTimer === null) return
        this.timers.clearTimeout(this.resetTimer)
        this.resetTimer = null
    }

    private clearInteractionTailTimer(): void {
        if (this.interactionTailTimer === null) return
        this.timers.clearTimeout(this.interactionTailTimer)
        this.interactionTailTimer = null
    }

    private clearAllTimers(): void {
        this.clearDelayTimer()
        this.clearStuckTimer()
        this.clearResetTimer()
    }

    private emit(): void {
        const labelKey = this.tasks.size > 0
            ? Array.from(this.tasks.values()).pop()?.labelKey ?? null
            : null
        this.snapshot = {
            status: this.status,
            visible: this.status === 'loading' || this.status === 'failed' || this.status === 'completed',
            stuck: this.stuck,
            activeCount: this.tasks.size,
            suppressed: this.isSuppressed(),
            labelKey,
        }
        for (const listener of this.listeners) {
            listener()
        }
    }
}

export const pageLoadingStore = new PageLoadingStore()
