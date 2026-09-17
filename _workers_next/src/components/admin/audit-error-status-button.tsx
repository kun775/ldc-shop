'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
    markPlatformErrorHandledAction,
    reopenPlatformErrorAction,
} from '@/actions/audit'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

export function AuditErrorStatusButton({
    id,
    status,
    handleNote,
    compact = false,
}: {
    id: string
    status: string
    handleNote?: string | null
    compact?: boolean
}) {
    const router = useRouter()
    const [open, setOpen] = useState(false)
    const [note, setNote] = useState(handleNote || '')
    const [pending, startTransition] = useTransition()
    const handled = status === 'handled'

    const submit = () => {
        startTransition(async () => {
            const result = handled
                ? await reopenPlatformErrorAction(id)
                : await markPlatformErrorHandledAction(id, note)

            if (!result.ok) {
                toast.error(result.errorId ? `操作失败，错误 ID：${result.errorId}` : '操作失败')
                return
            }

            toast.success(handled ? '错误已重新打开' : '错误已标记为已处理')
            setOpen(false)
            router.refresh()
        })
    }

    return (
        <>
            <Button
                type="button"
                variant={handled ? 'outline' : 'default'}
                size="sm"
                className={compact ? 'h-8 w-8 p-0' : 'h-8 gap-1.5 text-xs'}
                title={handled ? '重新打开错误' : '标记已处理'}
                aria-label={handled ? '重新打开错误' : '标记已处理'}
                onClick={() => setOpen(true)}
            >
                {handled ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {!compact && <span>{handled ? '重新打开' : '标记已处理'}</span>}
            </Button>

            <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
                <DialogContent className="sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{handled ? '重新打开平台错误' : '标记平台错误已处理'}</DialogTitle>
                        <DialogDescription>
                            {handled
                                ? '处理说明会保留，错误状态将恢复为未处理。'
                                : '填写排查结论或处置说明。原始错误内容不会被修改。'}
                        </DialogDescription>
                    </DialogHeader>
                    {!handled && (
                        <Textarea
                            value={note}
                            onChange={(event) => setNote(event.target.value.slice(0, 1000))}
                            placeholder="例如：已修复配置缺失并完成回归验证"
                            className="min-h-28 resize-y text-sm"
                            disabled={pending}
                        />
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                            取消
                        </Button>
                        <Button type="button" onClick={submit} disabled={pending}>
                            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                            {handled ? '确认重新打开' : '确认已处理'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
