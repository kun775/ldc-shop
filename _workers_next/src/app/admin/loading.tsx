import { RouteLoadingIndicator } from '@/components/page-loading/route-loading-indicator'

export default function AdminLoading() {
  return (
    <>
      <RouteLoadingIndicator />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2">
        <div className="space-y-4">
          <div className="h-8 w-40 rounded-md bg-muted/60 animate-pulse" />
          <div className="h-20 w-full rounded-xl bg-muted/40 animate-pulse" />
          <div className="h-20 w-full rounded-xl bg-muted/40 animate-pulse" />
          <div className="h-20 w-full rounded-xl bg-muted/40 animate-pulse" />
        </div>
      </div>
    </>
  )
}
