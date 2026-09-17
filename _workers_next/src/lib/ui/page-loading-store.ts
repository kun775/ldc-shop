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
 */

export type PageLoadingStatus = 'idle' | 'delayed' | 'loading' | 'completed' | 'failed'

export interface PageLoadingSnapshot {
    status: PageLoadingStatus
    /** 是否需要渲染遮罩（completed 阶段仍需渲染以播放淡出） */
    visible: boolean
    /** 是否处于「加载过久」的可恢复状态 */
    stuck: boolean
    activeCount: number
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

const IDLE_SNAPSHOT: PageLoadingSnapshot = Object.freeze({
    status: 'idle',
    visible: false,
    stuck: false,
    activeCount: 0,
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
    private tasks = new Map<string, string | null>()
    private status: PageLoadingStatus = 'idle'
    private stuck = false
    private listeners = new Set<() => void>()
    private snapshot: PageLoadingSnapshot = IDLE_SNAPSHOT
    private delayTimer: unknown = null
    private stuckTimer: unknown = null
    private resetTimer: unknown = null
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
     */
    begin(taskId: string, labelKey?: string | null): void {
        if (!taskId) return
        const isNewTask = !this.tasks.has(taskId)
        // 总是更新文案，保证后续任务能覆盖旧文案
        this.tasks.set(taskId, labelKey ?? null)
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
        this.tasks.clear()
        this.listeners.clear()
        this.stuck = false
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

    private clearAllTimers(): void {
        this.clearDelayTimer()
        this.clearStuckTimer()
        this.clearResetTimer()
    }

    private emit(): void {
        const labelKey = this.tasks.size > 0 ? Array.from(this.tasks.values()).pop() ?? null : null
        this.snapshot = {
            status: this.status,
            visible: this.status === 'loading' || this.status === 'failed' || this.status === 'completed',
            stuck: this.stuck,
            activeCount: this.tasks.size,
            labelKey,
        }
        for (const listener of this.listeners) {
            listener()
        }
    }
}

export const pageLoadingStore = new PageLoadingStore()
