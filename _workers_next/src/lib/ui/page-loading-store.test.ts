import test from "node:test"
import assert from "node:assert/strict"

const mod = await import(new URL("./page-loading-store.ts", import.meta.url).href)
const {
    PageLoadingStore,
    PAGE_LOADING_DELAY_MS,
    PAGE_LOADING_FADE_OUT_MS,
    PAGE_LOADING_STUCK_MS,
    PAGE_LOADING_INTERACTION_TAIL_MS,
} = mod

/** 手动推进的假计时器，便于确定性验证状态迁移 */
function createFakeTimers() {
    let now = 0
    let seq = 0
    const pending = new Map()

    return {
        timers: {
            setTimeout: (handler, timeout) => {
                seq += 1
                const handle = seq
                pending.set(handle, { at: now + timeout, handler })
                return handle
            },
            clearTimeout: (handle) => {
                pending.delete(handle)
            },
        },
        advance(ms) {
            const target = now + ms
            for (;;) {
                let nextHandle = null
                let nextAt = Infinity
                for (const [handle, entry] of pending) {
                    if (entry.at <= target && entry.at < nextAt) {
                        nextAt = entry.at
                        nextHandle = handle
                    }
                }
                if (nextHandle === null) break
                const entry = pending.get(nextHandle)
                pending.delete(nextHandle)
                now = entry.at
                entry.handler()
            }
            now = target
        },
        get pendingCount() {
            return pending.size
        },
    }
}

function createStore() {
    const clock = createFakeTimers()
    const store = new PageLoadingStore(clock.timers)
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
        notifications += 1
    })
    return { store, clock, unsubscribe, getNotifications: () => notifications }
}

test("starts idle and invisible", () => {
    const { store } = createStore()
    const snapshot = store.getSnapshot()

    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.visible, false)
    assert.equal(snapshot.activeCount, 0)
})

test("server snapshot is always idle so SSR never renders the overlay", () => {
    const { store } = createStore()
    store.begin('ssr-task')

    assert.equal(store.getServerSnapshot().status, 'idle')
    assert.equal(store.getServerSnapshot().visible, false)
})

test("short task stays delayed and never becomes visibly loading", () => {
    const { store, clock } = createStore()
    store.begin('navigate')
    assert.equal(store.getSnapshot().status, 'delayed')
    assert.equal(store.getSnapshot().visible, false)

    clock.advance(PAGE_LOADING_DELAY_MS - 1)
    assert.equal(store.getSnapshot().status, 'delayed')

    store.end('navigate')
    assert.equal(store.getSnapshot().status, 'idle')
    assert.equal(store.getSnapshot().visible, false)
    assert.equal(clock.pendingCount, 0)
})

test("task exceeding the delay threshold shows the overlay", () => {
    const { store, clock } = createStore()
    store.begin('navigate', 'common.loading')

    clock.advance(PAGE_LOADING_DELAY_MS)
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.status, 'loading')
    assert.equal(snapshot.visible, true)
    assert.equal(snapshot.labelKey, 'common.loading')
    assert.equal(snapshot.activeCount, 1)
})

test("reference counting keeps the overlay until every task ends", () => {
    const { store, clock } = createStore()
    store.begin('task-a')
    clock.advance(PAGE_LOADING_DELAY_MS)
    store.begin('task-b')
    assert.equal(store.getSnapshot().activeCount, 2)

    store.end('task-a')
    assert.equal(store.getSnapshot().status, 'loading')
    assert.equal(store.getSnapshot().visible, true)
    assert.equal(store.getSnapshot().activeCount, 1)

    store.end('task-b')
    assert.equal(store.getSnapshot().status, 'completed')
    assert.equal(store.getSnapshot().visible, true)

    clock.advance(PAGE_LOADING_FADE_OUT_MS)
    assert.equal(store.getSnapshot().status, 'idle')
    assert.equal(store.getSnapshot().visible, false)
    assert.equal(clock.pendingCount, 0)
})

test("an earlier task cannot close the overlay while a later task is still running", () => {
    const { store, clock } = createStore()
    store.begin('slow')
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().visible, true)

    // 较早的慢请求先返回，不应收起遮罩
    store.end('slow')
    clock.advance(PAGE_LOADING_FADE_OUT_MS + 100)
    assert.equal(store.getSnapshot().status, 'idle')

    // 此时才注册新任务：必须重新走延时阈值，不能复用旧计时器
    store.begin('late')
    assert.equal(store.getSnapshot().status, 'delayed')
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().status, 'loading')
    assert.equal(store.getSnapshot().visible, true)
})

test("duplicate begin for the same task id does not double count", () => {
    const { store, clock } = createStore()
    store.begin('dup')
    store.begin('dup')
    store.begin('dup', 'common.loading')

    assert.equal(store.getSnapshot().activeCount, 1)
    clock.advance(PAGE_LOADING_DELAY_MS)
    store.end('dup')

    assert.equal(store.getSnapshot().status, 'completed')
    clock.advance(PAGE_LOADING_FADE_OUT_MS)
    assert.equal(store.getSnapshot().status, 'idle')
})

test("re-entering during the fade-out cancels the reset and stays visible", () => {
    const { store, clock } = createStore()
    store.begin('first')
    clock.advance(PAGE_LOADING_DELAY_MS)
    store.end('first')
    assert.equal(store.getSnapshot().status, 'completed')

    store.begin('second')
    assert.equal(store.getSnapshot().status, 'loading')
    assert.equal(store.getSnapshot().visible, true)

    // 原先的淡出复位计时器必须已被取消
    clock.advance(PAGE_LOADING_FADE_OUT_MS + 50)
    assert.equal(store.getSnapshot().status, 'loading')
    assert.equal(store.getSnapshot().visible, true)
})

test("long running task switches to a recoverable stuck state instead of spinning forever", () => {
    const { store, clock } = createStore()
    store.begin('hang')
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().status, 'loading')

    clock.advance(PAGE_LOADING_STUCK_MS)
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.status, 'failed')
    assert.equal(snapshot.stuck, true)
    assert.equal(snapshot.visible, true)
})

test("dismiss releases the overlay and clears in-flight tasks", () => {
    const { store, clock } = createStore()
    store.begin('hang')
    clock.advance(PAGE_LOADING_DELAY_MS + PAGE_LOADING_STUCK_MS)
    assert.equal(store.getSnapshot().status, 'failed')

    store.dismiss()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.visible, false)
    assert.equal(snapshot.activeCount, 0)
    assert.equal(clock.pendingCount, 0)
})

test("retry restarts the stuck timer while tasks are still running", () => {
    const { store, clock } = createStore()
    store.begin('hang')
    clock.advance(PAGE_LOADING_DELAY_MS + PAGE_LOADING_STUCK_MS)
    assert.equal(store.getSnapshot().stuck, true)

    store.retry()
    assert.equal(store.getSnapshot().status, 'loading')
    assert.equal(store.getSnapshot().stuck, false)

    clock.advance(PAGE_LOADING_STUCK_MS)
    assert.equal(store.getSnapshot().stuck, true)
})

test("fail releases the overlay immediately so the error boundary is visible", () => {
    const { store, clock } = createStore()
    store.begin('boom')
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().visible, true)

    store.fail('boom')
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.visible, false)
    assert.equal(snapshot.activeCount, 0)
    assert.equal(clock.pendingCount, 0)
})

test("ending an unknown task id is a no-op", () => {
    const { store, clock } = createStore()
    const before = store.getSnapshot()
    store.end('never-started')
    assert.equal(store.getSnapshot(), before)
    assert.equal(clock.pendingCount, 0)
})

test("empty task ids are ignored", () => {
    const { store } = createStore()
    store.begin('')
    store.end('')
    assert.equal(store.getSnapshot().status, 'idle')
    assert.equal(store.getSnapshot().activeCount, 0)
})

test("notifies subscribers only on state changes", () => {
    const { store, clock, getNotifications } = createStore()
    assert.equal(getNotifications(), 0)

    store.begin('a')
    assert.equal(getNotifications(), 1)
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(getNotifications(), 2)
    store.begin('b')
    assert.equal(getNotifications(), 3)
    store.end('b')
    assert.equal(getNotifications(), 4)
})

test("unsubscribe stops further notifications", () => {
    const { store, unsubscribe, getNotifications } = createStore()
    store.begin('a')
    const before = getNotifications()
    unsubscribe()
    store.end('a')
    assert.equal(getNotifications(), before)
})

test("dispose clears tasks, listeners and timers", () => {
    const { store, clock, getNotifications } = createStore()
    store.begin('a')
    clock.advance(PAGE_LOADING_DELAY_MS)
    const before = getNotifications()

    store.dispose()
    assert.equal(store.getSnapshot().status, 'idle')
    assert.equal(store.getSnapshot().activeCount, 0)
    assert.equal(clock.pendingCount, 0)

    store.end('a')
    assert.equal(getNotifications(), before)
})

// —— 交互抑制：业务提交期间不得点亮路由级全屏遮罩 ——

test("beginInteraction suppresses route-origin tasks so submit refresh never shows the overlay", () => {
    const { store, clock } = createStore()
    const release = store.beginInteraction()

    assert.equal(store.getSnapshot().suppressed, true)

    // router.refresh() 触发的 loading.tsx fallback 上报
    store.begin('route:fallback', 'common.loading')
    assert.equal(store.getSnapshot().activeCount, 0)

    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().visible, false)
    assert.equal(store.getSnapshot().status, 'idle')

    release()
    // 尾随窗口仍在，用于覆盖 router.refresh() 之后才挂载的 fallback
    assert.equal(store.getSnapshot().suppressed, true, 'tail window still holds')

    clock.advance(PAGE_LOADING_INTERACTION_TAIL_MS)
    assert.equal(store.getSnapshot().suppressed, false)
})

test("interaction-origin tasks stay visible while suppressed", () => {
    const { store, clock } = createStore()
    const release = store.beginInteraction()

    store.begin('page:explicit', 'common.loading', 'interaction')
    clock.advance(PAGE_LOADING_DELAY_MS)

    const snapshot = store.getSnapshot()
    assert.equal(snapshot.visible, true)
    assert.equal(snapshot.activeCount, 1)

    release()
    store.end('page:explicit')
})

test("beginInteraction clears a route overlay already on screen", () => {
    const { store, clock } = createStore()
    store.begin('route:nav')
    clock.advance(PAGE_LOADING_DELAY_MS)
    assert.equal(store.getSnapshot().visible, true)

    const release = store.beginInteraction()
    assert.equal(store.getSnapshot().visible, false)
    assert.equal(store.getSnapshot().status, 'idle')
    release()
})

test("ending a suppressed task is a safe no-op", () => {
    const { store } = createStore()
    const release = store.beginInteraction()

    store.begin('route:fallback')
    // fallback 卸载时无条件调用 end，即使 begin 被忽略也不能破坏计数
    store.end('route:fallback')
    assert.equal(store.getSnapshot().activeCount, 0)

    release()
    assert.equal(store.getSnapshot().status, 'idle')
})

test("nested interactions only restore visibility after the last release", () => {
    const { store, clock } = createStore()
    const releaseOuter = store.beginInteraction()
    const releaseInner = store.beginInteraction()

    store.begin('route:a')
    assert.equal(store.getSnapshot().activeCount, 0)

    releaseInner()
    assert.equal(store.getSnapshot().suppressed, true, 'outer interaction still holds')

    store.begin('route:b')
    assert.equal(store.getSnapshot().activeCount, 0)

    releaseOuter()
    // 计数归零，但尾随窗口仍在
    clock.advance(PAGE_LOADING_INTERACTION_TAIL_MS)
    assert.equal(store.getSnapshot().suppressed, false)

    // 抑制解除后路由任务重新可用
    store.begin('route:c')
    assert.equal(store.getSnapshot().activeCount, 1)
    store.end('route:c')
})

test("release function is idempotent so finally blocks cannot underflow the depth", () => {
    const { store, clock } = createStore()
    const release = store.beginInteraction()

    release()
    release()
    release()

    clock.advance(PAGE_LOADING_INTERACTION_TAIL_MS)
    assert.equal(store.getSnapshot().suppressed, false)
    // 计数归零后可正常展示遮罩
    store.begin('route:after')
    assert.equal(store.getSnapshot().activeCount, 1)
})

test("a new interaction restarts the suppression window", () => {
    const { store, clock } = createStore()
    const releaseFirst = store.beginInteraction()
    releaseFirst()

    // 尾随窗口内发起第二次提交：窗口应重新计时而不是提前结束
    clock.advance(PAGE_LOADING_INTERACTION_TAIL_MS - 1)
    const releaseSecond = store.beginInteraction()
    releaseSecond()

    clock.advance(PAGE_LOADING_INTERACTION_TAIL_MS - 1)
    assert.equal(store.getSnapshot().suppressed, true, 'window restarted from the second release')

    clock.advance(1)
    assert.equal(store.getSnapshot().suppressed, false)
})

test("dispose clears a pending tail window", () => {
    const { store, clock } = createStore()
    const release = store.beginInteraction()
    release()

    store.dispose()
    assert.equal(store.getSnapshot().suppressed, false)
    assert.equal(clock.pendingCount, 0)
})
