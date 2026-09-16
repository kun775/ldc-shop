export default function Template({ children }: { children: React.ReactNode }) {
  // 这一层夹在根 layout 与 admin/layout 之间，是后台高度链路的必经环节。
  // 后台必须继承「可滚动的剩余高度」并继续向下传递，否则 [data-admin-root]
  // 会拿到内容自然高度（数千 px）后被祖先 overflow-hidden 裁切，表现为整页无法滚动。
  // 用 has-[[data-admin-root]] 限定只在后台生效，前台商城仍保持 block 自然流。
  return (
    <div className="has-[[data-admin-root]]:flex has-[[data-admin-root]]:min-h-0 has-[[data-admin-root]]:flex-1 has-[[data-admin-root]]:flex-col animate-in fade-in duration-300 motion-reduce:animate-none">
      {children}
    </div>
  )
}
