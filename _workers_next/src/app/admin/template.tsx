export default function Template({ children }: { children: React.ReactNode }) {
  // 后台是固定工作台布局：这一层必须把「可滚动的剩余高度」传递给页面，
  // 否则会切断 <main> 到 AdminPageShell / AdminListPage 的高度链路，
  // 导致页面内容被 overflow-hidden 裁切且无法滚动。
  return (
    <div className="flex min-h-0 flex-1 flex-col animate-in fade-in duration-200 motion-reduce:animate-none">
      {children}
    </div>
  )
}
