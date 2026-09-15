'use client'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Trash2, Plus, GripVertical } from "lucide-react"
import {
    CHECKOUT_FIELD_LIMITS,
    createEmptyCheckoutField,
    type CheckoutFieldConfig,
    type CheckoutFieldType,
} from "@/lib/checkout-fields"

type ProductCheckoutFieldsSectionProps = {
    showCheckoutFields: boolean
    setShowCheckoutFields: (value: boolean) => void
    checkoutFields: CheckoutFieldConfig[]
    setCheckoutFields: (value: CheckoutFieldConfig[]) => void
    t: (key: string, params?: Record<string, string | number>) => string
}

function updateField(
    fields: CheckoutFieldConfig[],
    index: number,
    patch: Partial<CheckoutFieldConfig>
) {
    return fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field)
}

export function ProductCheckoutFieldsSection({
    showCheckoutFields,
    setShowCheckoutFields,
    checkoutFields,
    setCheckoutFields,
    t,
}: ProductCheckoutFieldsSectionProps) {
    const canAddMore = checkoutFields.length < CHECKOUT_FIELD_LIMITS.maxFields

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('admin.productForm.checkoutFieldsSectionTitle')}</CardTitle>
                <CardDescription>{t('admin.productForm.checkoutFieldsSectionHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                    <input
                        id="showCheckoutFields"
                        type="checkbox"
                        checked={showCheckoutFields}
                        onChange={(event) => {
                            setShowCheckoutFields(event.target.checked)
                            if (!event.target.checked) setCheckoutFields([])
                            else if (checkoutFields.length === 0) setCheckoutFields([createEmptyCheckoutField()])
                        }}
                        className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <div className="space-y-1">
                        <Label htmlFor="showCheckoutFields" className="cursor-pointer">
                            {t('admin.productForm.checkoutFieldsLabel')}
                        </Label>
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.checkoutFieldsHint')}</p>
                    </div>
                </div>

                {showCheckoutFields && (
                    <div className="space-y-3">
                        <input type="hidden" name="checkoutFields" value={JSON.stringify(checkoutFields)} />
                        {checkoutFields.map((field, index) => (
                            <div key={field.id} className="space-y-3 rounded-xl border border-border/70 bg-background/90 p-3.5 shadow-2xs transition-all">
                                <div className="flex items-center justify-between pb-1 border-b border-border/50">
                                    <div className="flex items-center gap-2">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground">
                                            #{index + 1}
                                        </span>
                                        <span className="text-xs font-medium text-foreground">
                                            {field.label || t('admin.productForm.checkoutFieldLabelPlaceholder')}
                                        </span>
                                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                            {field.type === 'textarea' ? '多行文本' : field.type === 'select' ? '下拉单选' : '单行输入'}
                                        </span>
                                        {field.required && (
                                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                                必填
                                            </span>
                                        )}
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => setCheckoutFields(checkoutFields.filter((_, fieldIndex) => fieldIndex !== index))}
                                        title="删除此采集项"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                                <div className="flex items-start gap-2">
                                    <div className="grid flex-1 gap-3 sm:grid-cols-2">
                                        <div className="space-y-1.5">
                                            <Label>{t('admin.productForm.checkoutFieldLabel')}</Label>
                                            <Input
                                                value={field.label}
                                                maxLength={CHECKOUT_FIELD_LIMITS.maxLabelLength}
                                                onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, { label: event.target.value }))}
                                                placeholder={t('admin.productForm.checkoutFieldLabelPlaceholder')}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label>{t('admin.productForm.checkoutFieldType')}</Label>
                                            <select
                                                value={field.type}
                                                onChange={(event) => {
                                                    const type = event.target.value as CheckoutFieldType
                                                    setCheckoutFields(updateField(checkoutFields, index, {
                                                        type,
                                                        options: type === 'select' ? (field.options.length ? field.options : ['']) : [],
                                                        maxLength: type === 'textarea'
                                                            ? CHECKOUT_FIELD_LIMITS.defaultTextareaMaxLength
                                                            : CHECKOUT_FIELD_LIMITS.defaultTextMaxLength,
                                                    }))
                                                }}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                                            >
                                                <option value="text">{t('admin.productForm.checkoutFieldTypeText')}</option>
                                                <option value="textarea">{t('admin.productForm.checkoutFieldTypeTextarea')}</option>
                                                <option value="select">{t('admin.productForm.checkoutFieldTypeSelect')}</option>
                                            </select>
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label>{t('admin.productForm.checkoutFieldPlaceholder')}</Label>
                                            <Input
                                                value={field.placeholder}
                                                maxLength={CHECKOUT_FIELD_LIMITS.maxPlaceholderLength}
                                                onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, { placeholder: event.target.value }))}
                                                placeholder={t('admin.productForm.checkoutFieldPlaceholderHint')}
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label>{t('admin.productForm.checkoutFieldMaxLength')}</Label>
                                            <Input
                                                type="number"
                                                min={1}
                                                max={CHECKOUT_FIELD_LIMITS.absoluteMaxLength}
                                                value={field.maxLength}
                                                onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, {
                                                    maxLength: Number.parseInt(event.target.value, 10) || field.maxLength,
                                                }))}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <Label>{t('admin.productForm.checkoutFieldHint')}</Label>
                                    <Input
                                        value={field.hint}
                                        maxLength={CHECKOUT_FIELD_LIMITS.maxHintLength}
                                        onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, { hint: event.target.value }))}
                                        placeholder={t('admin.productForm.checkoutFieldHintPlaceholder')}
                                    />
                                </div>
                                {field.type === 'select' && (
                                    <div className="space-y-1.5">
                                        <Label>{t('admin.productForm.checkoutFieldOptions')}</Label>
                                        <Textarea
                                            value={field.options.join('\n')}
                                            onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, {
                                                options: event.target.value.split(/\r?\n/),
                                            }))}
                                            placeholder={t('admin.productForm.checkoutFieldOptionsPlaceholder')}
                                            className="min-h-24"
                                        />
                                        <p className="text-xs text-muted-foreground">{t('admin.productForm.checkoutFieldOptionsHint')}</p>
                                    </div>
                                )}
                                <label className="flex items-center gap-2 text-sm cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={field.required}
                                        onChange={(event) => setCheckoutFields(updateField(checkoutFields, index, { required: event.target.checked }))}
                                        className="h-4 w-4 rounded accent-primary"
                                    />
                                    <span className="font-medium text-foreground">{t('admin.productForm.checkoutFieldRequired')}</span>
                                </label>
                            </div>
                        ))}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!canAddMore}
                            onClick={() => setCheckoutFields([...checkoutFields, createEmptyCheckoutField()])}
                            className="gap-1.5 text-xs"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            {t('admin.productForm.addCheckoutField')}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
