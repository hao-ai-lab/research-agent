'use client'

import React, { useState, useMemo } from 'react'
import {
  Search,
  Slack,
  Send,
  Moon,
  Sun,
  Monitor,
  Type,
  Square,
  Bell,
  X,
  Check,
  ChevronRight,
  Sparkles,
  Code,
  Server,
  Wifi,
  WifiOff,
  RotateCcw,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useApiConfig } from '@/lib/api-config'
import type { AppSettings } from '@/lib/types'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onNavigateToJourney?: (subTab: 'story' | 'devnotes') => void
  focusAuthToken?: boolean
  onRefresh?: () => void
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
  onNavigateToJourney,
  focusAuthToken = false,
  onRefresh,
}: SettingsDialogProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [slackDialogOpen, setSlackDialogOpen] = useState(false)
  const [slackApiKey, setSlackApiKey] = useState(settings.integrations.slack?.apiKey || '')
  const [slackChannel, setSlackChannel] = useState(settings.integrations.slack?.channel || '')

  // Telegram state
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false)
  const [telegramBotToken, setTelegramBotToken] = useState(settings.integrations.telegram?.botToken || '')
  const [telegramChatId, setTelegramChatId] = useState(settings.integrations.telegram?.chatId || '')
  const [telegramWebhookUrl, setTelegramWebhookUrl] = useState(settings.integrations.telegram?.webhookUrl || '')
  const [telegramTestStatus, setTelegramTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle')
  const [webhookStatus, setWebhookStatus] = useState<'idle' | 'setting' | 'success' | 'failed'>('idle')

  // API Configuration
  const { apiUrl, useMock, authToken, setApiUrl, setUseMock, setAuthToken, resetToDefaults, testConnection } = useApiConfig()
  const [apiUrlInput, setApiUrlInput] = useState(apiUrl)
  const [authTokenInput, setAuthTokenInput] = useState(authToken)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'failed'>('idle')
  const authTokenInputRef = React.useRef<HTMLInputElement>(null)

  // Sync apiUrlInput when apiUrl changes (e.g. on reset)
  React.useEffect(() => {
    setApiUrlInput(apiUrl)
  }, [apiUrl])

  // Sync authTokenInput when authToken changes (e.g. on reset)
  React.useEffect(() => {
    setAuthTokenInput(authToken)
  }, [authToken])

  // Auto-focus auth token input when requested
  React.useEffect(() => {
    if (focusAuthToken && open) {
      // Small delay to ensure dialog is mounted
      const timer = setTimeout(() => {
        authTokenInputRef.current?.focus()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [focusAuthToken, open])

  const handleTestConnection = async () => {
    setConnectionStatus('testing')
    const isConnected = await testConnection()
    setConnectionStatus(isConnected ? 'connected' : 'failed')
    // Reset after 3 seconds
    setTimeout(() => setConnectionStatus('idle'), 3000)
  }

  const handleSaveApiUrl = () => {
    setApiUrl(apiUrlInput)
    setConnectionStatus('idle')
  }

  const handleSaveAuthToken = () => {
    setAuthToken(authTokenInput)
    // Trigger API refresh after saving auth token
    onRefresh?.()
  }

  const settingsSections = useMemo(() => [
    {
      id: 'api',
      title: 'API Configuration',
      items: [
        {
          id: 'apiConfig',
          label: 'Server Connection',
          description: 'Configure API server URL and connection mode',
          icon: Server,
          type: 'custom' as const,
        },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      items: [
        {
          id: 'slack',
          label: 'Slack',
          description: 'Connect to Slack for notifications',
          icon: Slack,
          type: 'action' as const,
        },
        {
          id: 'telegram',
          label: 'Telegram',
          description: 'Connect to Telegram for notifications & commands',
          icon: Send,
          type: 'action' as const,
        },
      ],
    },
    {
      id: 'appearance',
      title: 'Appearance',
      items: [
        {
          id: 'theme',
          label: 'Theme',
          description: 'Choose your preferred color scheme',
          icon: settings.appearance.theme === 'dark' ? Moon : settings.appearance.theme === 'light' ? Sun : Monitor,
          type: 'select' as const,
          options: ['dark', 'light', 'system'],
          value: settings.appearance.theme,
        },
        {
          id: 'fontSize',
          label: 'Font Size',
          description: 'Adjust the text size',
          icon: Type,
          type: 'select' as const,
          options: ['small', 'medium', 'large'],
          value: settings.appearance.fontSize,
        },
        {
          id: 'buttonSize',
          label: 'Button Size',
          description: 'Adjust button and control sizes',
          icon: Square,
          type: 'select' as const,
          options: ['compact', 'default', 'large'],
          value: settings.appearance.buttonSize,
        },
      ],
    },
    {
      id: 'notifications',
      title: 'Notifications',
      items: [
        {
          id: 'alertsEnabled',
          label: 'Enable Alerts',
          description: 'Show experiment alerts and warnings',
          icon: Bell,
          type: 'toggle' as const,
          value: settings.notifications.alertsEnabled,
        },
      ],
    },
    {
      id: 'about',
      title: 'About',
      items: [
        {
          id: 'journeyStory',
          label: 'Journey Story',
          description: 'Learn about our development journey',
          icon: Sparkles,
          type: 'nav' as const,
        },
        {
          id: 'devNotes',
          label: 'Dev Notes',
          description: 'Technical notes and documentation',
          icon: Code,
          type: 'nav' as const,
        },
      ],
    },
  ], [settings])

  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) return settingsSections

    const query = searchQuery.toLowerCase()
    return settingsSections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            item.label.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query) ||
            section.title.toLowerCase().includes(query)
        ),
      }))
      .filter((section) => section.items.length > 0)
  }, [searchQuery, settingsSections])

  const handleThemeChange = (theme: 'dark' | 'light' | 'system') => {
    onSettingsChange({
      ...settings,
      appearance: { ...settings.appearance, theme },
    })
  }

  const handleFontSizeChange = (fontSize: 'small' | 'medium' | 'large') => {
    onSettingsChange({
      ...settings,
      appearance: { ...settings.appearance, fontSize },
    })
  }

  const handleButtonSizeChange = (buttonSize: 'compact' | 'default' | 'large') => {
    onSettingsChange({
      ...settings,
      appearance: { ...settings.appearance, buttonSize },
    })
  }

  const handleAlertsToggle = (enabled: boolean) => {
    onSettingsChange({
      ...settings,
      notifications: { ...settings.notifications, alertsEnabled: enabled },
    })
  }

  const handleSlackSave = () => {
    onSettingsChange({
      ...settings,
      integrations: {
        ...settings.integrations,
        slack: {
          enabled: true,
          apiKey: slackApiKey,
          channel: slackChannel,
        },
      },
    })
    setSlackDialogOpen(false)
  }

  const handleSlackDisconnect = () => {
    onSettingsChange({
      ...settings,
      integrations: {
        ...settings.integrations,
        slack: undefined,
      },
    })
    setSlackApiKey('')
    setSlackChannel('')
  }

  const handleTelegramTestConnection = async () => {
    if (!telegramBotToken.trim() || !telegramChatId.trim()) return
    setTelegramTestStatus('testing')
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: '✅ Research Agent connected successfully!\n\nAvailable commands:\n/status - System status\n/runs - List experiments\n/link - Get webapp URL\n/help - Show commands',
            parse_mode: 'HTML',
          }),
        }
      )
      const data = await response.json()
      if (data.ok) {
        setTelegramTestStatus('success')
      } else {
        setTelegramTestStatus('failed')
      }
    } catch {
      setTelegramTestStatus('failed')
    }
    setTimeout(() => setTelegramTestStatus('idle'), 3000)
  }

  const handleTelegramSave = () => {
    onSettingsChange({
      ...settings,
      integrations: {
        ...settings.integrations,
        telegram: {
          enabled: true,
          botToken: telegramBotToken,
          chatId: telegramChatId,
          webhookUrl: telegramWebhookUrl,
        },
      },
    })
    setTelegramDialogOpen(false)
  }

  const handleSetupWebhook = async () => {
    if (!telegramBotToken.trim() || !telegramWebhookUrl.trim()) return
    setWebhookStatus('setting')
    try {
      // Construct webhook URL: server_url + /api/telegram/webhook
      const webhookEndpoint = telegramWebhookUrl.replace(/\/$/, '') + '/api/telegram/webhook'
      const response = await fetch(
        `https://api.telegram.org/bot${telegramBotToken}/setWebhook?url=${encodeURIComponent(webhookEndpoint)}`,
        { method: 'GET' }
      )
      const data = await response.json()
      if (data.ok) {
        setWebhookStatus('success')
      } else {
        setWebhookStatus('failed')
      }
    } catch {
      setWebhookStatus('failed')
    }
    setTimeout(() => setWebhookStatus('idle'), 3000)
  }

  const handleTelegramDisconnect = () => {
    onSettingsChange({
      ...settings,
      integrations: {
        ...settings.integrations,
        telegram: undefined,
      },
    })
    setTelegramBotToken('')
    setTelegramChatId('')
  }

  const renderSettingItem = (item: typeof settingsSections[0]['items'][0]) => {
    const Icon = item.icon

    switch (item.type) {
      case 'nav':
        return (
          <button
            type="button"
            onClick={() => {
              if (item.id === 'journeyStory') {
                onNavigateToJourney?.('story')
                onOpenChange(false)
              } else if (item.id === 'devNotes') {
                onNavigateToJourney?.('devnotes')
                onOpenChange(false)
              }
            }}
            className="flex w-full items-center justify-between rounded-lg bg-secondary/50 p-4 text-left transition-colors hover:bg-secondary"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        )
      case 'action':
        return (
          <button
            type="button"
            onClick={() => {
              if (item.id === 'slack') setSlackDialogOpen(true)
              if (item.id === 'telegram') setTelegramDialogOpen(true)
            }}
            className="flex w-full items-center justify-between rounded-lg bg-secondary/50 p-4 text-left transition-colors hover:bg-secondary"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {settings.integrations.slack?.enabled && item.id === 'slack' && (
                <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
                  Connected
                </span>
              )}
              {settings.integrations.telegram?.enabled && item.id === 'telegram' && (
                <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
                  Connected
                </span>
              )}
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </button>
        )
      case 'select':
        return (
          <div className="rounded-lg bg-secondary/50 p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </div>
            <div className="flex gap-2 ml-13">
              {item.options?.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    if (item.id === 'theme') handleThemeChange(option as 'dark' | 'light' | 'system')
                    if (item.id === 'fontSize') handleFontSizeChange(option as 'small' | 'medium' | 'large')
                    if (item.id === 'buttonSize') handleButtonSizeChange(option as 'compact' | 'default' | 'large')
                  }}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium capitalize transition-colors ${item.value === option
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-background text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        )
      case 'toggle':
        return (
          <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </div>
            <Switch
              checked={item.value as boolean}
              onCheckedChange={(checked) => {
                if (item.id === 'alertsEnabled') handleAlertsToggle(checked)
              }}
            />
          </div>
        )
      case 'custom':
        if (item.id === 'apiConfig') {
          return (
            <div className="rounded-lg bg-secondary/50 p-4 space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                  <Server className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">Server Connection</p>
                  <p className="text-xs text-muted-foreground">Configure API server URL and mode</p>
                </div>
                {useMock && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-500">
                    Demo Mode
                  </span>
                )}
              </div>

              {/* Mock Mode Toggle */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm text-foreground">Use Demo Mode</p>
                  <p className="text-xs text-muted-foreground">Use mock data instead of real server</p>
                </div>
                <Switch
                  checked={useMock}
                  onCheckedChange={setUseMock}
                />
              </div>

              {/* Server URL (hidden in mock mode) */}
              {!useMock && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <Label htmlFor="api-url" className="text-xs">Server URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="api-url"
                        placeholder="http://localhost:10000"
                        value={apiUrlInput}
                        onChange={(e) => setApiUrlInput(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveApiUrl}
                        disabled={apiUrlInput === apiUrl}
                      >
                        Save
                      </Button>
                    </div>
                  </div>

                  {/* Auth Token */}
                  <div className="space-y-2">
                    <Label htmlFor="auth-token" className="text-xs">Auth Token</Label>
                    <p className="text-xs text-muted-foreground">Required for secure remote access</p>
                    <div className="flex gap-2">
                      <Input
                        id="auth-token"
                        ref={authTokenInputRef}
                        type="password"
                        placeholder="Enter auth token..."
                        value={authTokenInput}
                        onChange={(e) => setAuthTokenInput(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveAuthToken}
                        disabled={authTokenInput === authToken}
                      >
                        Save
                      </Button>
                    </div>
                  </div>

                  {/* Connection Test */}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestConnection}
                      disabled={connectionStatus === 'testing'}
                      className="flex-1"
                    >
                      {connectionStatus === 'testing' ? (
                        <><RotateCcw className="h-3 w-3 mr-2 animate-spin" />Testing...</>
                      ) : connectionStatus === 'connected' ? (
                        <><Wifi className="h-3 w-3 mr-2 text-green-500" />Connected</>
                      ) : connectionStatus === 'failed' ? (
                        <><WifiOff className="h-3 w-3 mr-2 text-red-500" />Failed</>
                      ) : (
                        <>Test Connection</>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        resetToDefaults()
                        setConnectionStatus('idle')
                      }}
                    >
                      Reset
                    </Button>
                  </div>

                  {connectionStatus === 'failed' && (
                    <p className="text-xs text-amber-500">
                      Tip: Enable Demo Mode above to use the app without a server.
                    </p>
                  )}
                </>
              )}
            </div>
          )
        }
        return null
      default:
        return null
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="p-4 pb-0">
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>

          <div className="px-4 py-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search settings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-secondary border-0"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {filteredSections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Search className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">No settings found</p>
              </div>
            ) : (
              <div className="space-y-6">
                {filteredSections.map((section) => (
                  <div key={section.id}>
                    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                      {section.title}
                    </h3>
                    <div className="space-y-2">
                      {section.items.map((item) => (
                        <div key={item.id}>{renderSettingItem(item)}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Slack Integration Dialog */}
      <Dialog open={slackDialogOpen} onOpenChange={setSlackDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Slack className="h-5 w-5" />
              Slack Integration
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {settings.integrations.slack?.enabled ? (
              <>
                <div className="rounded-lg bg-accent/10 border border-accent/30 p-3">
                  <div className="flex items-center gap-2 text-accent">
                    <Check className="h-4 w-4" />
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Channel: {settings.integrations.slack.channel || 'Not set'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="w-full bg-transparent"
                  onClick={handleSlackDisconnect}
                >
                  <X className="h-4 w-4 mr-2" />
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="slack-api" className="text-xs">
                      Slack API Token
                    </Label>
                    <Input
                      id="slack-api"
                      type="password"
                      placeholder="xoxb-..."
                      value={slackApiKey}
                      onChange={(e) => setSlackApiKey(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="slack-channel" className="text-xs">
                      Default Channel
                    </Label>
                    <Input
                      id="slack-channel"
                      placeholder="#ml-experiments"
                      value={slackChannel}
                      onChange={(e) => setSlackChannel(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                </div>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={handleSlackSave}
                  disabled={!slackApiKey.trim()}
                >
                  Connect to Slack
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Telegram Integration Dialog */}
      <Dialog open={telegramDialogOpen} onOpenChange={setTelegramDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Telegram Integration
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {settings.integrations.telegram?.enabled ? (
              <>
                <div className="rounded-lg bg-accent/10 border border-accent/30 p-3">
                  <div className="flex items-center gap-2 text-accent">
                    <Check className="h-4 w-4" />
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Chat ID: {settings.integrations.telegram.chatId || 'Not set'}
                  </p>
                </div>

                {/* Webhook Setup Section */}
                <div className="space-y-2 rounded-lg bg-secondary/50 p-3">
                  <Label htmlFor="telegram-webhook" className="text-xs">
                    Webhook URL (Optional)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Your public server URL to receive /commands
                  </p>
                  <Input
                    id="telegram-webhook"
                    placeholder="https://your-server.com"
                    value={telegramWebhookUrl}
                    onChange={(e) => setTelegramWebhookUrl(e.target.value)}
                    className="mt-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleSetupWebhook}
                    disabled={!telegramWebhookUrl.trim() || webhookStatus === 'setting'}
                  >
                    {webhookStatus === 'setting' ? (
                      <><RotateCcw className="h-3 w-3 mr-2 animate-spin" />Setting up...</>
                    ) : webhookStatus === 'success' ? (
                      <><Check className="h-3 w-3 mr-2 text-green-500" />Webhook Set!</>
                    ) : webhookStatus === 'failed' ? (
                      <><X className="h-3 w-3 mr-2 text-red-500" />Failed</>
                    ) : (
                      <>Setup Webhook</>
                    )}
                  </Button>
                </div>

                <Button
                  variant="outline"
                  className="w-full bg-transparent"
                  onClick={handleTelegramDisconnect}
                >
                  <X className="h-4 w-4 mr-2" />
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="telegram-token" className="text-xs">
                      Bot Token
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Get from @BotFather on Telegram
                    </p>
                    <Input
                      id="telegram-token"
                      type="password"
                      placeholder="123456:ABC-DEF..."
                      value={telegramBotToken}
                      onChange={(e) => setTelegramBotToken(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="telegram-chat" className="text-xs">
                      Chat ID
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Your Telegram user or group ID
                    </p>
                    <Input
                      id="telegram-chat"
                      placeholder="123456789"
                      value={telegramChatId}
                      onChange={(e) => setTelegramChatId(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleTelegramTestConnection}
                    disabled={!telegramBotToken.trim() || !telegramChatId.trim() || telegramTestStatus === 'testing'}
                  >
                    {telegramTestStatus === 'testing' ? (
                      <><RotateCcw className="h-3 w-3 mr-2 animate-spin" />Testing...</>
                    ) : telegramTestStatus === 'success' ? (
                      <><Check className="h-3 w-3 mr-2 text-green-500" />Sent!</>
                    ) : telegramTestStatus === 'failed' ? (
                      <><X className="h-3 w-3 mr-2 text-red-500" />Failed</>
                    ) : (
                      <>Test Connection</>
                    )}
                  </Button>
                </div>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={handleTelegramSave}
                  disabled={!telegramBotToken.trim() || !telegramChatId.trim()}
                >
                  Connect to Telegram
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
