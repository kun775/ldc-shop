'use client'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type ProductQuestion = {
    q: string
    a: string
}

type ProductQuestionsSectionProps = {
    showQuestions: boolean
    setShowQuestions: (value: boolean) => void
    purchaseQuestions: ProductQuestion[]
    setPurchaseQuestions: (value: ProductQuestion[]) => void
    t: (key: string, params?: Record<string, string | number>) => string
}

export function ProductQuestionsSection({
    showQuestions,
    setShowQuestions,
    purchaseQuestions,
    setPurchaseQuestions,
    t,
}: ProductQuestionsSectionProps) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('admin.productForm.questionsSectionTitle')}</CardTitle>
                <CardDescription>{t('admin.productForm.questionsSectionHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
                    <input
                        id="showQuestions"
                        type="checkbox"
                        checked={showQuestions}
                        onChange={(event) => {
                            setShowQuestions(event.target.checked)
                            if (!event.target.checked) setPurchaseQuestions([])
                        }}
                        className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <div className="space-y-1">
                        <Label htmlFor="showQuestions" className="cursor-pointer">
                            {t('admin.productForm.purchaseQuestionsLabel')}
                        </Label>
                        <p className="text-xs text-muted-foreground">{t('admin.productForm.purchaseQuestionsHint')}</p>
                    </div>
                </div>

                {showQuestions && (
                    <div className="space-y-3">
                        <input type="hidden" name="purchaseQuestions" value={JSON.stringify(purchaseQuestions)} />
                        {purchaseQuestions.map((item, index) => (
                            <div key={index} className="flex items-start gap-2 rounded-lg border bg-background/80 p-3">
                                <div className="flex-1 space-y-2">
                                    <Input
                                        value={item.q}
                                        onChange={(event) => {
                                            const next = [...purchaseQuestions]
                                            next[index] = { ...next[index], q: event.target.value }
                                            setPurchaseQuestions(next)
                                        }}
                                        placeholder={t('admin.productForm.questionPlaceholder')}
                                    />
                                    <Input
                                        value={item.a}
                                        onChange={(event) => {
                                            const next = [...purchaseQuestions]
                                            next[index] = { ...next[index], a: event.target.value }
                                            setPurchaseQuestions(next)
                                        }}
                                        placeholder={t('admin.productForm.answerPlaceholder')}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 text-destructive hover:text-destructive"
                                    onClick={() => setPurchaseQuestions(purchaseQuestions.filter((_, questionIndex) => questionIndex !== index))}
                                >
                                    ×
                                </Button>
                            </div>
                        ))}

                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setPurchaseQuestions([...purchaseQuestions, { q: '', a: '' }])}
                        >
                            + {t('admin.productForm.addQuestion')}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
