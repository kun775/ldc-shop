'use client'

import { useState } from "react"
import { useI18n } from "@/lib/i18n/context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import type { FormEvent } from "react"
import { saveNotificationSettings, testBarkNotification, testEmailNotification, testNotification } from "@/actions/admin"
import { Bell, CreditCard, RotateCcw, MessageSquare, ExternalLink, Mail, Smartphone } from "lucide-react"
import { AdminPageShell } from "@/components/admin/admin-page-shell"
import { resolveClientActionErrorKey } from "@/lib/errors/safe-error"

interface NotificationsContentProps {
    settings: {
        telegramBotToken: string
        telegramChatId: string
        telegramLanguage: string
        telegramEnabled: boolean
        barkEnabled: boolean
        barkServerUrl: string
        barkDeviceKey: string
        resendApiKey: string
        resendFromEmail: string
        resendFromName: string
        resendEnabled: boolean
        emailLanguage?: string | null
    }
}

export function NotificationsContent({ settings }: NotificationsContentProps) {
    const { t } = useI18n()
    const [token, setToken] = useState(settings.telegramBotToken || '')
    const [chatId, setChatId] = useState(settings.telegramChatId || '')
    const [language, setLanguage] = useState(settings.telegramLanguage || 'zh')
    const [telegramEnabled, setTelegramEnabled] = useState(settings.telegramEnabled || false)
    const [isLoading, setIsLoading] = useState(false)
    const [isTesting, setIsTesting] = useState(false)
    const [isTestingBark, setIsTestingBark] = useState(false)

    // Bark settings
    const [barkEnabled, setBarkEnabled] = useState(settings.barkEnabled || false)
    const [barkServerUrl, setBarkServerUrl] = useState(settings.barkServerUrl || 'https://api.day.app')
    const [barkDeviceKey, setBarkDeviceKey] = useState(settings.barkDeviceKey || '')

    // Email settings
    const [resendEnabled, setResendEnabled] = useState(settings.resendEnabled || false)
    const [resendApiKey, setResendApiKey] = useState(settings.resendApiKey || '')
    const [resendFromEmail, setResendFromEmail] = useState(settings.resendFromEmail || '')
    const [resendFromName, setResendFromName] = useState(settings.resendFromName || '')
    const [emailLanguage, setEmailLanguage] = useState(settings.emailLanguage || 'zh')
    const [isTestingEmail, setIsTestingEmail] = useState(false)
    const [testEmail, setTestEmail] = useState('')

    async function handleSave(formData: FormData) {
        setIsLoading(true)
        try {
            const saved = await saveNotificationSettings(formData)
            setToken(saved.telegramBotToken || '')
            setChatId(saved.telegramChatId || '')
            setLanguage(saved.telegramLanguage || 'zh')
            setTelegramEnabled(!!saved.telegramEnabled)
            setBarkEnabled(!!saved.barkEnabled)
            setBarkServerUrl(saved.barkServerUrl || 'https://api.day.app')
            setBarkDeviceKey(saved.barkDeviceKey || '')
            setResendEnabled(!!saved.resendEnabled)
            setResendApiKey(saved.resendApiKey || '')
            setResendFromEmail(saved.resendFromEmail || '')
            setResendFromName(saved.resendFromName || '')
            setEmailLanguage(saved.emailLanguage || 'zh')
            toast.success(t('common.success'))
        } catch (e: any) {
            toast.error(t(resolveClientActionErrorKey(e)))
        } finally {
            setIsLoading(false)
        }
    }

    async function handleSubmitSave(e: FormEvent<HTMLFormElement>) {
        e.preventDefault()
        await handleSave(new FormData(e.currentTarget))
    }

    async function handleTest() {
        setIsTesting(true)
        try {
            const res = await testNotification()
            if (res.success) {
                toast.success(t('admin.settings.notifications.testSuccess'))
            } else {
                toast.error(t('admin.settings.notifications.testFailed', { error: res.error }))
            }
        } catch (e: any) {
            toast.error(t('common.error'))
        } finally {
            setIsTesting(false)
        }
    }

    async function handleTestEmail() {
        if (!testEmail) {
            toast.error(t('admin.settings.email.enterTestEmail'))
            return
        }
        setIsTestingEmail(true)
        try {
            const res = await testEmailNotification(testEmail)
            if (res.success) {
                toast.success(t('admin.settings.email.testSuccess'))
            } else {
                toast.error(t('admin.settings.email.testFailed', { error: res.error }))
            }
        } catch (e: any) {
            toast.error(t('common.error'))
        } finally {
            setIsTestingEmail(false)
        }
    }

    async function handleTestBark() {
        setIsTestingBark(true)
        try {
            const res = await testBarkNotification()
            if (res.success) {
                toast.success(t('admin.settings.notifications.barkTestSuccess'))
            } else {
                toast.error(t('admin.settings.notifications.barkTestFailed', { error: res.error }))
            }
        } catch {
            toast.error(t('common.error'))
        } finally {
            setIsTestingBark(false)
        }
    }

    return (
        <AdminPageShell className="space-y-6 p-0.5">
            <h2 className="text-3xl font-bold tracking-tight">{t('admin.settings.notifications.title')}</h2>

            {/* 功能介绍卡片 */}
            <Card className="border-primary/20 bg-primary/5">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <Bell className="h-5 w-5" />
                        {t('admin.settings.notifications.featureTitle')}
                    </CardTitle>
                    <CardDescription>{t('admin.settings.notifications.featureDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-3 text-sm">
                        <div className="flex items-start gap-3 p-3 bg-background rounded-lg border">
                            <CreditCard className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="font-medium">{t('admin.settings.notifications.triggerPayment')}</p>
                                <p className="text-muted-foreground">{t('admin.settings.notifications.triggerPaymentDesc')}</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3 p-3 bg-background rounded-lg border">
                            <RotateCcw className="h-5 w-5 text-orange-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="font-medium">{t('admin.settings.notifications.triggerRefund')}</p>
                                <p className="text-muted-foreground">{t('admin.settings.notifications.triggerRefundDesc')}</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3 p-3 bg-background rounded-lg border">
                            <MessageSquare className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="font-medium">{t('admin.settings.notifications.triggerUserMessage')}</p>
                                <p className="text-muted-foreground">{t('admin.settings.notifications.triggerUserMessageDesc')}</p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* 配置表单 */}
            <Card>
                <CardHeader>
                    <CardTitle>Telegram Bot {t('admin.settings.notifications.configTitle')}</CardTitle>
                    <CardDescription>{t('admin.settings.notifications.configDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmitSave} className="space-y-4">
                        <div className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                id="telegramEnabledCheckbox"
                                checked={telegramEnabled}
                                onChange={(e) => setTelegramEnabled(e.target.checked)}
                                className="h-4 w-4 rounded border-gray-300"
                            />
                            <input type="hidden" name="telegramEnabled" value={telegramEnabled ? 'true' : 'false'} />
                            <Label htmlFor="telegramEnabledCheckbox">{t('admin.settings.notifications.telegramEnabled')}</Label>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="telegramBotToken"
                                value={token}
                                onChange={e => setToken(e.target.value)}
                                placeholder=" "
                                type="password"
                            />
                            <Label className="floating-label">{t('admin.settings.notifications.telegramBotToken')}</Label>
                        </div>
                        <div className="space-y-2">
                            <div className="floating-field">
                                <Input
                                    name="telegramChatId"
                                    value={chatId}
                                    onChange={e => setChatId(e.target.value)}
                                    placeholder=" "
                                />
                                <Label className="floating-label">{t('admin.settings.notifications.telegramChatId')}</Label>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>{t('admin.settings.notifications.language')}</Label>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant={language === 'zh' ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setLanguage('zh')}
                                >
                                    中文
                                </Button>
                                <Button
                                    type="button"
                                    variant={language === 'en' ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setLanguage('en')}
                                >
                                    English
                                </Button>
                            </div>
                            <input type="hidden" name="telegramLanguage" value={language} />
                            <input type="hidden" name="emailLanguage" value={emailLanguage} />
                            <input type="hidden" name="resendEnabled" value={resendEnabled ? 'true' : 'false'} />
                            <input type="hidden" name="resendApiKey" value={resendApiKey} />
                            <input type="hidden" name="resendFromEmail" value={resendFromEmail} />
                            <input type="hidden" name="resendFromName" value={resendFromName} />
                            <input type="hidden" name="barkEnabled" value={barkEnabled ? 'true' : 'false'} />
                            <input type="hidden" name="barkServerUrl" value={barkServerUrl} />
                            <input type="hidden" name="barkDeviceKey" value={barkDeviceKey} />
                            <p className="text-xs text-muted-foreground">{t('admin.settings.notifications.languageHint')}</p>
                        </div>

                        <div className="flex gap-4">
                            <Button type="submit" disabled={isLoading}>
                                {isLoading ? t('common.processing') : t('admin.settings.notifications.save')}
                            </Button>

                            {telegramEnabled && token && chatId && (
                                <Button type="button" variant="secondary" onClick={handleTest} disabled={isTesting}>
                                    {isTesting ? t('common.processing') : t('admin.settings.notifications.test')}
                                </Button>
                            )}
                        </div>
                    </form>
                </CardContent>
            </Card>

            {/* Bark 通知配置 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Smartphone className="h-5 w-5" />
                        {t('admin.settings.notifications.barkTitle')}
                    </CardTitle>
                    <CardDescription>{t('admin.settings.notifications.barkDesc')}</CardDescription>
                    <p className="text-xs text-muted-foreground">{t('admin.settings.notifications.barkLanguageFollow')}</p>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmitSave} className="space-y-4">
                        <div className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                id="barkEnabledCheckbox"
                                checked={barkEnabled}
                                onChange={(e) => setBarkEnabled(e.target.checked)}
                                className="h-4 w-4 rounded border-gray-300"
                            />
                            <input type="hidden" name="barkEnabled" value={barkEnabled ? 'true' : 'false'} />
                            <Label htmlFor="barkEnabledCheckbox">{t('admin.settings.notifications.barkEnabled')}</Label>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="barkServerUrl"
                                value={barkServerUrl}
                                onChange={(e) => setBarkServerUrl(e.target.value)}
                                placeholder=" "
                            />
                            <Label className="floating-label">{t('admin.settings.notifications.barkServerUrl')}</Label>
                            <p className="text-xs text-muted-foreground">{t('admin.settings.notifications.barkServerUrlHint')}</p>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="barkDeviceKey"
                                value={barkDeviceKey}
                                onChange={(e) => setBarkDeviceKey(e.target.value)}
                                placeholder=" "
                                type="password"
                            />
                            <Label className="floating-label">{t('admin.settings.notifications.barkDeviceKey')}</Label>
                            <p className="text-xs text-muted-foreground">{t('admin.settings.notifications.barkDeviceKeyHint')}</p>
                            <p className="text-xs text-muted-foreground">{t('admin.settings.notifications.barkDeviceKeyExample')}</p>
                        </div>

                        {/* Hidden fields for telegram settings */}
                        <input type="hidden" name="telegramBotToken" value={token} />
                        <input type="hidden" name="telegramChatId" value={chatId} />
                        <input type="hidden" name="telegramLanguage" value={language} />
                        <input type="hidden" name="telegramEnabled" value={telegramEnabled ? 'true' : 'false'} />
                        {/* Hidden fields for email settings */}
                        <input type="hidden" name="resendEnabled" value={resendEnabled ? 'true' : 'false'} />
                        <input type="hidden" name="resendApiKey" value={resendApiKey} />
                        <input type="hidden" name="resendFromEmail" value={resendFromEmail} />
                        <input type="hidden" name="resendFromName" value={resendFromName} />
                        <input type="hidden" name="emailLanguage" value={emailLanguage} />

                        <div className="flex gap-4">
                            <Button type="submit" disabled={isLoading}>
                                {isLoading ? t('common.processing') : t('admin.settings.notifications.save')}
                            </Button>
                            {barkEnabled && barkDeviceKey && (
                                <Button type="button" variant="secondary" onClick={handleTestBark} disabled={isTestingBark}>
                                    {isTestingBark ? t('common.processing') : t('admin.settings.notifications.barkTest')}
                                </Button>
                            )}
                        </div>
                    </form>
                </CardContent>
            </Card>

            {/* 邮件通知配置 */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Mail className="h-5 w-5" />
                        {t('admin.settings.email.title')}
                    </CardTitle>
                    <CardDescription>{t('admin.settings.email.desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmitSave} className="space-y-4">
                        <div className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                id="resendEnabledCheckbox"
                                checked={resendEnabled}
                                onChange={(e) => setResendEnabled(e.target.checked)}
                                className="h-4 w-4 rounded border-gray-300"
                            />
                            <input type="hidden" name="resendEnabled" value={resendEnabled ? 'true' : 'false'} />
                            <Label htmlFor="resendEnabledCheckbox">{t('admin.settings.email.enabled')}</Label>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="resendApiKey"
                                value={resendApiKey}
                                onChange={e => setResendApiKey(e.target.value)}
                                placeholder=" "
                                type="password"
                            />
                            <Label className="floating-label">{t('admin.settings.email.apiKey')}</Label>
                            <p className="text-xs text-muted-foreground">
                                {t('admin.settings.email.apiKeyHint')} <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">resend.com</a>
                            </p>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="resendFromEmail"
                                value={resendFromEmail}
                                onChange={e => setResendFromEmail(e.target.value)}
                                placeholder=" "
                            />
                            <Label className="floating-label">{t('admin.settings.email.fromEmail')}</Label>
                            <p className="text-xs text-muted-foreground">{t('admin.settings.email.fromEmailHint')}</p>
                        </div>

                        <div className="floating-field">
                            <Input
                                name="resendFromName"
                                value={resendFromName}
                                onChange={e => setResendFromName(e.target.value)}
                                placeholder=" "
                            />
                            <Label className="floating-label">{t('admin.settings.email.fromName')}</Label>
                        </div>

                        <div className="space-y-2">
                            <Label>{t('admin.settings.email.language')}</Label>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant={emailLanguage === 'zh' ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setEmailLanguage('zh')}
                                >
                                    中文
                                </Button>
                                <Button
                                    type="button"
                                    variant={emailLanguage === 'en' ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setEmailLanguage('en')}
                                >
                                    English
                                </Button>
                            </div>
                            <input type="hidden" name="emailLanguage" value={emailLanguage} />
                            <p className="text-xs text-muted-foreground">{t('admin.settings.email.languageHint')}</p>
                        </div>

                        {/* Hidden fields for telegram settings */}
                        <input type="hidden" name="telegramBotToken" value={token} />
                        <input type="hidden" name="telegramChatId" value={chatId} />
                        <input type="hidden" name="telegramLanguage" value={language} />
                        <input type="hidden" name="telegramEnabled" value={telegramEnabled ? 'true' : 'false'} />
                        {/* Hidden fields for bark settings */}
                        <input type="hidden" name="barkEnabled" value={barkEnabled ? 'true' : 'false'} />
                        <input type="hidden" name="barkServerUrl" value={barkServerUrl} />
                        <input type="hidden" name="barkDeviceKey" value={barkDeviceKey} />

                        <div className="flex gap-4">
                            <Button type="submit" disabled={isLoading}>
                                {isLoading ? t('common.processing') : t('admin.settings.notifications.save')}
                            </Button>
                        </div>
                    </form>

                    {resendApiKey && resendFromEmail && (
                        <div className="mt-4 pt-4 border-t">
                            <Label>{t('admin.settings.email.testLabel')}</Label>
                            <div className="flex gap-2 mt-2">
                                <div className="floating-field flex-1 min-w-0">
                                    <Input
                                        value={testEmail}
                                        onChange={e => setTestEmail(e.target.value)}
                                        placeholder=" "
                                    />
                                    <Label className="floating-label">{t('admin.settings.email.testPlaceholder')}</Label>
                                </div>
                                <Button variant="secondary" onClick={handleTestEmail} disabled={isTestingEmail}>
                                    {isTestingEmail ? t('common.processing') : t('admin.settings.email.testButton')}
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* 配置指南 */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">{t('admin.settings.notifications.guide')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Telegram Guide */}
                    <div>
                        <h3 className="flex items-center gap-2 font-semibold mb-3">
                            <Bell className="h-4 w-4" />
                            Telegram Bot
                        </h3>
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">1</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.step1Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.step1Desc')}</p>
                                    <a
                                        href="https://t.me/BotFather"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
                                    >
                                        @BotFather <ExternalLink className="h-3 w-3" />
                                    </a>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">2</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.step2Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.step2Desc')}</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">3</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.step3Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.step3Desc')}</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">4</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.step4Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.step4Desc')}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Bark Guide */}
                    <div className="border-t pt-4">
                        <h3 className="flex items-center gap-2 font-semibold mb-3">
                            <Smartphone className="h-4 w-4" />
                            Bark
                        </h3>
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">1</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.barkGuideStep1Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.barkGuideStep1Desc')}</p>
                                    <a
                                        href="https://github.com/Finb/Bark"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
                                    >
                                        Finb/Bark <ExternalLink className="h-3 w-3" />
                                    </a>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">2</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.barkGuideStep2Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.barkGuideStep2Desc')}</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">3</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.notifications.barkGuideStep3Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.notifications.barkGuideStep3Desc')}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Resend Email Guide */}
                    <div className="border-t pt-4">
                        <h3 className="flex items-center gap-2 font-semibold mb-3">
                            <Mail className="h-4 w-4" />
                            Resend Email API
                        </h3>
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">1</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.email.guideStep1Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.email.guideStep1Desc')}</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">2</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.email.guideStep2Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.email.guideStep2Desc')}</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">3</span>
                                <div>
                                    <p className="font-medium">{t('admin.settings.email.guideStep3Title')}</p>
                                    <p className="text-sm text-muted-foreground">{t('admin.settings.email.guideStep3Desc')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </AdminPageShell>
    )
}
