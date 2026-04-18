'use client'

import Link from "next/link"
import { useState } from "react"
import { toggleBlock } from "@/actions/admin-users"
import { ClientDate } from "@/components/client-date"
import { CopyButton } from "@/components/copy-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/lib/i18n/context"
import { getDisplayUsername, getExternalProfileUrl } from "@/lib/user-profile-link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { UserPointAdjustmentDialog } from "./user-point-adjustment-dialog"

function getOrderStatusVariant(status: string | null) {
    switch (status) {
        case "delivered":
            return "default" as const
        case "paid":
            return "secondary" as const
        case "refunded":
            return "destructive" as const
        case "cancelled":
            return "secondary" as const
        default:
            return "outline" as const
    }
}

export function AdminUserDetailContent(props: {
    user: {
        userId: string
        username: string | null
        email: string | null
        points: number
        isBlocked: boolean
        createdAt: Date | null
        lastLoginAt: Date | null
        orderCount: number
    }
    ledger: {
        items: Array<{
            id: number
            eventType: string
            delta: number
            reason: string
            sourceId: string | null
            sourceType: string
            operatorUsername: string | null
            balanceAfter: number | null
            createdAt: Date
        }>
        total: number
        page: number
        pageSize: number
    }
    orders: {
        items: Array<{
            orderId: string
            productName: string
            productVariantLabel: string | null
            amount: string
            status: string | null
            email: string | null
            tradeNo: string | null
            cardKey: string | null
            pointsUsed: number
            quantity: number
            createdAt: Date | null
            paidAt: Date | null
            deliveredAt: Date | null
        }>
        total: number
        page: number
        pageSize: number
    }
    hasLegacyBalanceInit: boolean
}) {
    const { t } = useI18n()
    const router = useRouter()
    const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([])
    const [adjustOpen, setAdjustOpen] = useState(false)
    const [blocking, setBlocking] = useState(false)

    const toggleOrder = (orderId: string) => {
        setExpandedOrderIds((current) =>
            current.includes(orderId)
                ? current.filter((item) => item !== orderId)
                : [...current, orderId]
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">{t("admin.users.detailTitle")}</h1>
                    <p className="mt-2 font-mono text-xs text-muted-foreground">{props.user.userId}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" asChild>
                        <Link href="/admin/users">{t("common.back")}</Link>
                    </Button>
                    <Button
                        variant={props.user.isBlocked ? "default" : "destructive"}
                        disabled={blocking}
                        onClick={async () => {
                            const nextBlocked = !props.user.isBlocked
                            const confirmKey = nextBlocked ? "admin.users.confirmBlock" : "admin.users.confirmUnblock"
                            if (!confirm(t(confirmKey))) return

                            setBlocking(true)
                            try {
                                await toggleBlock(props.user.userId, nextBlocked)
                                toast.success(t("common.success"))
                                router.refresh()
                            } catch (error: any) {
                                toast.error(error?.message || t("common.error"))
                            } finally {
                                setBlocking(false)
                            }
                        }}
                    >
                        {props.user.isBlocked ? t("admin.users.unblock") : t("admin.users.block")}
                    </Button>
                    <Button onClick={() => setAdjustOpen(true)}>{t("admin.users.adjustPoints")}</Button>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>{t("admin.users.profileSection")}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.username")}</div>
                        {props.user.username ? (
                            <a
                                href={getExternalProfileUrl(props.user.username, props.user.userId) || "#"}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-primary hover:underline"
                            >
                                {getDisplayUsername(props.user.username, props.user.userId)}
                            </a>
                        ) : (
                            <div className="font-medium">-</div>
                        )}
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.email")}</div>
                        <div className="font-medium break-all">{props.user.email || "-"}</div>
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.points")}</div>
                        <div className="font-medium">{props.user.points}</div>
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.blockStatus")}</div>
                        <Badge variant={props.user.isBlocked ? "destructive" : "secondary"}>
                            {props.user.isBlocked ? t("admin.users.blocked") : t("admin.users.active")}
                        </Badge>
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.createdAt")}</div>
                        <ClientDate value={props.user.createdAt} format="dateTime" placeholder="-" />
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.lastLogin")}</div>
                        <ClientDate value={props.user.lastLoginAt} format="dateTime" placeholder="-" />
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm text-muted-foreground">{t("admin.users.orders")}</div>
                        <div className="font-medium">{props.user.orderCount}</div>
                    </div>
                </CardContent>
            </Card>

            {props.hasLegacyBalanceInit ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{t("admin.users.legacyNoteTitle")}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t("admin.users.legacyNoteBody")}
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <CardTitle>{t("admin.users.ledgerTitle")}</CardTitle>
                    <div className="text-sm text-muted-foreground">
                        {t("admin.users.ledgerCount", { count: String(props.ledger.total) })}
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    {props.ledger.items.length === 0 ? (
                        <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                            {t("search.noResults")}
                        </div>
                    ) : props.ledger.items.map((entry) => (
                        <div key={entry.id} className="rounded-md border p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="font-medium">{t(`admin.users.ledgerType.${entry.eventType}`)}</div>
                                <div className={entry.delta >= 0 ? "font-semibold text-emerald-600" : "font-semibold text-destructive"}>
                                    {entry.delta >= 0 ? `+${entry.delta}` : entry.delta}
                                </div>
                            </div>
                            <div className="mt-2 text-sm text-muted-foreground">{entry.reason}</div>
                            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                                <span>{t("admin.users.ledgerBalanceAfter")}: {entry.balanceAfter ?? "-"}</span>
                                <span>{t("admin.users.ledgerOperator")}: {entry.operatorUsername || "-"}</span>
                                {entry.sourceId && (entry.sourceType === "order" || entry.sourceType === "refund") ? (
                                    <Link href={`/admin/orders/${entry.sourceId}`} className="text-primary hover:underline">
                                        {entry.sourceId}
                                    </Link>
                                ) : null}
                                <ClientDate value={entry.createdAt} format="dateTime" placeholder="-" />
                            </div>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <CardTitle>{t("admin.users.ordersSection")}</CardTitle>
                    <div className="text-sm text-muted-foreground">
                        {t("admin.users.orderCount", { count: String(props.orders.total) })}
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    {props.orders.items.length === 0 ? (
                        <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                            {t("search.noResults")}
                        </div>
                    ) : props.orders.items.map((order) => {
                        const expanded = expandedOrderIds.includes(order.orderId)

                        return (
                            <div key={order.orderId} className="rounded-md border p-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="space-y-1">
                                        <div className="font-medium">
                                            {order.productName}
                                            {order.productVariantLabel ? ` · ${order.productVariantLabel}` : ""}
                                        </div>
                                        <div className="font-mono text-xs text-muted-foreground">{order.orderId}</div>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={getOrderStatusVariant(order.status)}>
                                            {t(`order.status.${order.status || "pending"}`)}
                                        </Badge>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => toggleOrder(order.orderId)}
                                        >
                                            {expanded ? t("admin.users.orderDetail.collapse") : t("admin.users.orderDetail.expand")}
                                        </Button>
                                        <Button asChild type="button" variant="ghost" size="sm">
                                            <Link href={`/admin/orders/${order.orderId}`}>
                                                {t("admin.users.orderDetail.viewOrder")}
                                            </Link>
                                        </Button>
                                    </div>
                                </div>

                                {expanded ? (
                                    <div className="mt-4 grid gap-3 rounded-md bg-muted/20 p-3 md:grid-cols-2">
                                        <div>{t("admin.users.orderDetail.amount")}: {Number(order.amount)}</div>
                                        <div>{t("admin.users.orderDetail.pointsUsed")}: {order.pointsUsed || 0}</div>
                                        <div>{t("admin.users.orderDetail.quantity")}: {order.quantity}</div>
                                        <div>{t("admin.users.orderDetail.email")}: {order.email || "-"}</div>
                                        <div className="space-y-1">
                                            <div>{t("admin.users.orderDetail.tradeNo")}</div>
                                            {order.tradeNo ? <CopyButton text={order.tradeNo} truncate maxLength={28} /> : <div>-</div>}
                                        </div>
                                        <div className="space-y-1">
                                            <div>{t("admin.users.orderDetail.cardKey")}</div>
                                            {order.cardKey ? <CopyButton text={order.cardKey} truncate maxLength={28} /> : <div>-</div>}
                                        </div>
                                        <div className="space-y-1">
                                            <div>{t("admin.users.orderDetail.createdAt")}</div>
                                            <ClientDate value={order.createdAt} format="dateTime" placeholder="-" />
                                        </div>
                                        <div className="space-y-1">
                                            <div>{t("admin.users.orderDetail.paidAt")}</div>
                                            <ClientDate value={order.paidAt} format="dateTime" placeholder="-" />
                                        </div>
                                        <div className="space-y-1">
                                            <div>{t("admin.users.orderDetail.deliveredAt")}</div>
                                            <ClientDate value={order.deliveredAt} format="dateTime" placeholder="-" />
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}
                </CardContent>
            </Card>

            <UserPointAdjustmentDialog
                open={adjustOpen}
                onOpenChange={setAdjustOpen}
                userId={props.user.userId}
                username={props.user.username}
                currentPoints={props.user.points}
                onSuccess={() => router.refresh()}
            />
        </div>
    )
}
