'use client'

import { useSyncExternalStore } from 'react'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'

/**
 * 根级错误边界（`global-error.tsx`）。
 *
 * 与其他 error boundary 不同，这个组件会**替换整个根布局**，因此：
 *  1. `globals.css` / Tailwind / 主题 CSS 变量都不会被应用 —— 所有样式必须内联；
 *  2. 语言 Provider 也不存在，`useI18n()` 只会退回英文 —— 这里直接读 locale cookie；
 *  3. 必须自行渲染 `<html>` / `<body>`。
 *
 * 它捕获的是「根布局自身抛错」这种最坏情况（此前完全没有兜底，用户会看到
 * 浏览器的默认白屏）。样式尽量克制，保证在任何主题下都清晰可读。
 */

const STRINGS = {
    en: {
        lang: 'en',
        title: en.common.errorTitle,
        description: en.common.errorDescription,
        idLabel: en.common.errorIdLabel,
        retry: en.common.retry,
    },
    zh: {
        lang: 'zh-CN',
        title: zh.common.errorTitle,
        description: zh.common.errorDescription,
        idLabel: zh.common.errorIdLabel,
        retry: zh.common.retry,
    },
} as const

type LocaleKey = keyof typeof STRINGS

const CSS = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.25rem calc(2rem + env(safe-area-inset-bottom, 0px));
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #ffffff;
  color: #0a0a0a;
  -webkit-font-smoothing: antialiased;
}
.ge-wrap { max-width: 26rem; text-align: center; }
.ge-badge {
  width: 3rem; height: 3rem; margin: 0 auto 1.25rem;
  display: flex; align-items: center; justify-content: center;
  border-radius: 1rem;
  background: rgba(220, 38, 38, 0.1);
  color: #dc2626;
}
.ge-title { margin: 0 0 0.5rem; font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; }
.ge-desc { margin: 0; font-size: 0.875rem; line-height: 1.5; color: #52525b; }
.ge-id { margin: 0.75rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; color: #71717a; word-break: break-all; }
.ge-actions { margin-top: 1.5rem; }
.ge-btn {
  appearance: none; border: 1px solid transparent; cursor: pointer;
  border-radius: 0.5rem; padding: 0.5rem 1rem; font: inherit; font-size: 0.875rem; font-weight: 500;
  background: #18181b; color: #fafafa;
}
.ge-btn:hover { background: #27272a; }
.ge-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  body { background: #0a0a0a; color: #fafafa; }
  .ge-desc { color: #a1a1aa; }
  .ge-id { color: #71717a; }
  .ge-btn { background: #fafafa; color: #18181b; }
  .ge-btn:hover { background: #e4e4e7; }
}
`

const LOCALE_COOKIE_PATTERN = /(?:^|;\s*)ldc-locale=(zh|en)/

/** 语言 cookie 在本页生命周期内不会变化，无需真正订阅任何外部源。 */
const subscribeLocale = () => () => {}

function getClientLocale(): LocaleKey {
    if (typeof document === 'undefined') return 'en'
    const match = document.cookie.match(LOCALE_COOKIE_PATTERN)
    return match ? (match[1] as LocaleKey) : 'en'
}

function getServerLocale(): LocaleKey {
    return 'en'
}

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    // 根布局被替换，没有 I18nProvider，只能从 cookie 读语言。
    // 用 useSyncExternalStore 而不是 useEffect + setState：
    //   - 服务端快照固定 'en'，客户端首帧也用 'en'，水合后自动切到真实语言，
    //     不存在 hydration mismatch；
    //   - 不在 effect 里同步 setState（React 官方不推荐，也会被 lint 判错）。
    const locale = useSyncExternalStore<LocaleKey>(
        subscribeLocale,
        getClientLocale,
        getServerLocale,
    )

    const s = STRINGS[locale]
    const errorId = error.digest || ''

    return (
        <html lang={s.lang} suppressHydrationWarning>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
                <title>{s.title}</title>
                <style dangerouslySetInnerHTML={{ __html: CSS }} />
            </head>
            <body>
                <div className="ge-wrap">
                    <div className="ge-badge" aria-hidden="true">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                    </div>
                    <h1 className="ge-title">{s.title}</h1>
                    <p className="ge-desc">{s.description}</p>
                    {errorId && (
                        <p className="ge-id">
                            {s.idLabel}: {errorId}
                        </p>
                    )}
                    <div className="ge-actions">
                        <button type="button" className="ge-btn" onClick={() => reset()}>
                            {s.retry}
                        </button>
                    </div>
                </div>
            </body>
        </html>
    )
}
