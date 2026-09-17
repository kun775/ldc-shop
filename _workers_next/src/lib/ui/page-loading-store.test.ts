import test from "node:test"
import assert from "node:assert/strict"

const mod = await import(new URL("./page-loading-store.ts", import.meta.url).href)
const {
    PageLoadingStore,
    PAGE_LOADING_DELAY_MS,
    PAGE_LOADING_FADE_OUT_MS,
    PAGE_LOADING_STUCK_MS,
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
