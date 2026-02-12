'use client'

import React, { useMemo, useState } from 'react'
import {
  Bell,
  Check,
  ChevronRight,
  Code,
  Copy,
  Eye,
  EyeOff,
  LayoutGrid,
  Monitor,
  Moon,
  Rows3,
  RotateCcw,
  Server,
  Clock,
  Slack,
  Sparkles,
  Square,
  Sun,
  Type,
  Wifi,
  WifiOff,
  X,
  Bug,
  FileText,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useApiConfig } from '@/lib/api-config'
import type { AppSettings } from '@/lib/types'

interface SettingsPageContentProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onNavigateToJourney?: (subTab: 'story' | 'devnotes') => void
  focusAuthToken?: boolean
}

export function SettingsPageContent({
  settings,
  onSettingsChange,
  onNavigateToJourney,
  focusAuthToken = false,
}: SettingsPageContentProps) {
  const [activeSectionId, setActiveSectionId] = useState<'api' | 'integrations' | 'appearance' | 'notifications' | 'developer' | 'about'>('api')
  const [slackDialogOpen, setSlackDialogOpen] = useState(false)
  const [slackApiKey, setSlackApiKey] = useState(settings.integrations.slack?.apiKey || '')
  const [slackChannel, setSlackChannel] = useState(settings.integrations.slack?.channel || '')
  const [showSlackApiKey, setShowSlackApiKey] = useState(false)

  const { apiUrl, useMock, authToken, setApiUrl, setUseMock, setAuthToken, resetToDefaults, testConnection } = useApiConfig()
  const [apiUrlInput, setApiUrlInput] = useState(apiUrl)
  const [authTokenInput, setAuthTokenInput] = useState(authToken)
  const [showAuthToken, setShowAuthToken] = useState(false)
  const [authTokenCopied, setAuthTokenCopied] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'failed'>('idle')
  const [appearanceAdvancedOpen, setAppearanceAdvancedOpen] = useState(false)
  const authTokenInputRef = React.useRef<HTMLInputElement>(null)

  // Local state for advanced appearance inputs (only update settings on blur)
  const [fontSizeInput, setFontSizeInput] = useState<string>(
    settings.appearance.customFontSizePx?.toString() ?? ''
  )
  const [buttonScaleInput, setButtonScaleInput] = useState<string>(
    settings.appearance.customButtonScalePercent?.toString() ?? ''
  )
  const [chatToolbarSizeInput, setChatToolbarSizeInput] = useState<string>(
    settings.appearance.chatToolbarButtonSizePx?.toString() ?? ''
  )

  React.useEffect(() => {
    setApiUrlInput(apiUrl)
  }, [apiUrl])

  React.useEffect(() => {
    setAuthTokenInput(authToken)
  }, [authToken])

  // Sync local inputs when settings change externally (e.g. reset)
  React.useEffect(() => {
    setFontSizeInput(settings.appearance.customFontSizePx?.toString() ?? '')
  }, [settings.appearance.customFontSizePx])

  React.useEffect(() => {
    setButtonScaleInput(settings.appearance.customButtonScalePercent?.toString() ?? '')
  }, [settings.appearance.customButtonScalePercent])

  React.useEffect(() => {
    setChatToolbarSizeInput(settings.appearance.chatToolbarButtonSizePx?.toString() ?? '')
  }, [settings.appearance.chatToolbarButtonSizePx])

  React.useEffect(() => {
    if (!focusAuthToken) return
    const timer = setTimeout(() => {
      authTokenInputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [focusAuthToken])

  const handleTestConnection = async () => {
    setConnectionStatus('testing')
    const isConnected = await testConnection()
    setConnectionStatus(isConnected ? 'connected' : 'failed')
    setTimeout(() => setConnectionStatus('idle'), 3000)
  }

  const handleSaveApiUrl = () => {
    setApiUrl(apiUrlInput)
    setConnectionStatus('idle')
  }

  const handleSaveAuthToken = () => {
    setAuthToken(authTokenInput)
  }

  const handleCopyAuthToken = async () => {
    if (!authTokenInput.trim()) return
    try {
      await navigator.clipboard.writeText(authTokenInput)
      setAuthTokenCopied(true)
      setTimeout(() => setAuthTokenCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy auth token:', error)
    }
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
        {
          id: 'runItemInteractionMode',
          label: 'Runs/Sweeps Click Mode',
          description: 'Open detail page or expand inline details',
          icon: Rows3,
          type: 'select' as const,
          options: ['detail-page', 'inline-expand'],
          value: settings.appearance.runItemInteractionMode || 'detail-page',
        },
        {
          id: 'showRunItemMetadata',
          label: 'Run Item Metadata',
          description: 'Show Start, Created, and Runtime under each run name',
          icon: Clock,
          type: 'toggle' as const,
          value: settings.appearance.showRunItemMetadata !== false,
        },
        {
          id: 'showStarterCards',
          label: 'Starter Cards',
          description: 'Show contextual prompt cards on new chats',
          icon: LayoutGrid,
          type: 'toggle' as const,
          value: settings.appearance.showStarterCards !== false,
        },
        {
          id: 'appearanceAdvanced',
          label: 'Advanced Appearance',
          description: 'Set exact numeric sizes',
          icon: Square,
          type: 'custom' as const,
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
        {
          id: 'webNotifications',
          label: 'Browser Notifications',
          description: 'Show OS notification banner when bot responds',
          icon: Bell,
          type: 'toggle' as const,
          value: settings.notifications.webNotificationsEnabled,
        },
      ],
    },
    {
      id: 'developer',
      title: 'Developer',
      items: [
        {
          id: 'showWildLoopState',
          label: 'Wild Loop Debug Panel',
          description: 'Show backend state panel when in wild mode',
          icon: Bug,
          type: 'toggle' as const,
          value: settings.developer?.showWildLoopState === true,
        },
        {
          id: 'showPlanPanel',
          label: 'Plan Panel',
          description: 'Show the Plans tab for managing experiment plans',
          icon: FileText,
          type: 'toggle' as const,
          value: settings.developer?.showPlanPanel === true,
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

  const activeSection = settingsSections.find((section) => section.id === activeSectionId) || settingsSections[0]

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

  const handleRunItemInteractionModeChange = (mode: 'detail-page' | 'inline-expand') => {
    onSettingsChange({
      ...settings,
      appearance: { ...settings.appearance, runItemInteractionMode: mode },
    })
  }

  const updateAppearanceSettings = (updates: Partial<AppSettings['appearance']>) => {
    onSettingsChange({
      ...settings,
      appearance: {
        ...settings.appearance,
        ...updates,
      },
    })
  }

  const handleCustomFontSizeChange = (value: string, currentInput: string) => {
    // If input was empty and spinner was clicked, browser uses min value - adjust to default
    if (!currentInput && value === '12') {
      const defaultSize = settings.appearance.fontSize === 'small' ? 14 : settings.appearance.fontSize === 'large' ? 18 : 16
      setFontSizeInput(defaultSize.toString())
      updateAppearanceSettings({ customFontSizePx: defaultSize })
      return
    }
    setFontSizeInput(value)
    // Apply immediately if value is within bounds (e.g. spinner click)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 12 && parsed <= 24) {
      updateAppearanceSettings({ customFontSizePx: parsed })
    }
  }

  const handleCustomFontSizeBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ customFontSizePx: null })
      setFontSizeInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(12, Math.min(24, parsed))
    updateAppearanceSettings({ customFontSizePx: clamped })
    setFontSizeInput(clamped.toString())
  }

  const handleCustomButtonScaleChange = (value: string, currentInput: string) => {
    // If input was empty and spinner was clicked, browser uses min value - adjust to default (120)
    if (!currentInput && value === '70') {
      setButtonScaleInput('120')
      updateAppearanceSettings({ customButtonScalePercent: 120 })
      return
    }
    setButtonScaleInput(value)
    // Apply immediately if value is within bounds (e.g. spinner click)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 70 && parsed <= 160) {
      updateAppearanceSettings({ customButtonScalePercent: parsed })
    }
  }

  const handleCustomButtonScaleBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ customButtonScalePercent: null })
      setButtonScaleInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(70, Math.min(160, parsed))
    updateAppearanceSettings({ customButtonScalePercent: clamped })
    setButtonScaleInput(clamped.toString())
  }

  const handleChatToolbarButtonSizeChange = (value: string, currentInput: string) => {
    // If input was empty and spinner was clicked, browser uses min value - adjust to default (36)
    if (!currentInput && value === '20') {
      setChatToolbarSizeInput('36')
      updateAppearanceSettings({ chatToolbarButtonSizePx: 36 })
      return
    }
    setChatToolbarSizeInput(value)
    // Apply immediately if value is within bounds (e.g. spinner click)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 20 && parsed <= 56) {
      updateAppearanceSettings({ chatToolbarButtonSizePx: parsed })
    }
  }

  const handleChatToolbarButtonSizeBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ chatToolbarButtonSizePx: null })
      setChatToolbarSizeInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(20, Math.min(56, parsed))
    updateAppearanceSettings({ chatToolbarButtonSizePx: clamped })
    setChatToolbarSizeInput(clamped.toString())
  }

  const handleAlertsToggle = (enabled: boolean) => {
    onSettingsChange({
      ...settings,
      notifications: { ...settings.notifications, alertsEnabled: enabled },
    })
  }

  const handleWebNotificationsToggle = (enabled: boolean) => {
    onSettingsChange({
      ...settings,
      notifications: { ...settings.notifications, webNotificationsEnabled: enabled },
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

  const renderSettingItem = (item: typeof settingsSections[0]['items'][0]) => {
    const Icon = item.icon

    switch (item.type) {
      case 'nav':
        return (
          <button
            type="button"
            onClick={() => {
              if (item.id === 'journeyStory') onNavigateToJourney?.('story')
              if (item.id === 'devNotes') onNavigateToJourney?.('devnotes')
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
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </button>
        )
      case 'select':
        return (
          <div className="rounded-lg bg-secondary/50 p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            </div>
            <div className="ml-13 flex gap-2">
              {item.options?.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    if (item.id === 'theme') handleThemeChange(option as 'dark' | 'light' | 'system')
                    if (item.id === 'fontSize') handleFontSizeChange(option as 'small' | 'medium' | 'large')
                    if (item.id === 'buttonSize') handleButtonSizeChange(option as 'compact' | 'default' | 'large')
                    if (item.id === 'runItemInteractionMode') handleRunItemInteractionModeChange(option as 'detail-page' | 'inline-expand')
                  }}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium capitalize transition-colors ${item.value === option
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-background text-muted-foreground hover:text-foreground'}`}
                >
                  {option.replace('-', ' ')}
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
                if (item.id === 'webNotifications') handleWebNotificationsToggle(checked)
                if (item.id === 'showRunItemMetadata') updateAppearanceSettings({ showRunItemMetadata: checked })
                if (item.id === 'showStarterCards') updateAppearanceSettings({ showStarterCards: checked })
                if (item.id === 'showWildLoopState') {
                  onSettingsChange({
                    ...settings,
                    developer: { ...settings.developer, showWildLoopState: checked },
                  })
                }
                if (item.id === 'showPlanPanel') {
                  onSettingsChange({
                    ...settings,
                    developer: { ...settings.developer, showPlanPanel: checked },
                  })
                }
              }}
            />
          </div>
        )
      case 'custom':
        if (item.id === 'appearanceAdvanced') {
          return (
            <div className="rounded-lg bg-secondary/50 p-4">
              <button
                type="button"
                onClick={() => setAppearanceAdvancedOpen((prev) => !prev)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                    <Square className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Advanced Appearance</p>
                    <p className="text-xs text-muted-foreground">Numeric control for fonts and buttons</p>
                  </div>
                </div>
                <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${appearanceAdvancedOpen ? 'rotate-90' : ''}`} />
              </button>

              {appearanceAdvancedOpen && (
                <div className="mt-4 space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2">
                    <div>
                      <Label htmlFor="sidebar-new-chat-toggle" className="text-xs">Sidebar New Chat Button</Label>
                      <p className="text-[11px] text-muted-foreground">Show or hide the New Chat button in the desktop sidebar</p>
                    </div>
                    <Switch
                      id="sidebar-new-chat-toggle"
                      checked={settings.appearance.showSidebarNewChatButton === true}
                      onCheckedChange={(checked) => updateAppearanceSettings({ showSidebarNewChatButton: checked })}
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-font-size" className="text-xs">Font Size (px) <span className="font-normal text-muted-foreground">12–24</span></Label>
                      <p className="text-[11px] text-muted-foreground">Overrides small/medium/large when set</p>
                    </div>
                    <Input
                      id="custom-font-size"
                      type="number"
                      min={12}
                      max={24}
                      value={fontSizeInput}
                      onChange={(e) => handleCustomFontSizeChange(e.target.value, fontSizeInput)}
                      onBlur={(e) => handleCustomFontSizeBlur(e.target.value)}
                      placeholder={settings.appearance.fontSize === 'small' ? '14' : settings.appearance.fontSize === 'large' ? '18' : '16'}
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-button-scale" className="text-xs">Button Scale (%) <span className="font-normal text-muted-foreground">70–160</span></Label>
                      <p className="text-[11px] text-muted-foreground">Scales global button sizes</p>
                    </div>
                    <Input
                      id="custom-button-scale"
                      type="number"
                      min={70}
                      max={160}
                      value={buttonScaleInput}
                      onChange={(e) => handleCustomButtonScaleChange(e.target.value, buttonScaleInput)}
                      onBlur={(e) => handleCustomButtonScaleBlur(e.target.value)}
                      placeholder="120"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="chat-toolbar-button-size" className="text-xs">Chat Bottom Buttons (px) <span className="font-normal text-muted-foreground">20–56</span></Label>
                      <p className="text-[11px] text-muted-foreground">Mode/add/mention/command controls</p>
                    </div>
                    <Input
                      id="chat-toolbar-button-size"
                      type="number"
                      min={20}
                      max={56}
                      value={chatToolbarSizeInput}
                      onChange={(e) => handleChatToolbarButtonSizeChange(e.target.value, chatToolbarSizeInput)}
                      onBlur={(e) => handleChatToolbarButtonSizeBlur(e.target.value)}
                      placeholder="36"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateAppearanceSettings({
                          customFontSizePx: null,
                          customButtonScalePercent: null,
                          chatToolbarButtonSizePx: null,
                        })
                      }
                    >
                      Reset Advanced
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        }

        if (item.id !== 'apiConfig') return null

        return (
          <div className="space-y-4 rounded-lg bg-secondary/50 p-4">
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

            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm text-foreground">Use Demo Mode</p>
                <p className="text-xs text-muted-foreground">Use mock data instead of real server</p>
              </div>
              <Switch checked={useMock} onCheckedChange={setUseMock} />
            </div>

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

                <div className="space-y-2">
                  <Label htmlFor="auth-token" className="text-xs">Auth Token</Label>
                  <p className="text-xs text-muted-foreground">Required for secure remote access</p>
                  <div className="flex gap-2">
                    <Input
                      id="auth-token"
                      ref={authTokenInputRef}
                      type={showAuthToken ? 'text' : 'password'}
                      placeholder="Enter auth token..."
                      value={authTokenInput}
                      onChange={(e) => setAuthTokenInput(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAuthToken((prev) => !prev)}
                      className="gap-1.5"
                      title={showAuthToken ? 'Hide token' : 'Show token'}
                    >
                      {showAuthToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      {showAuthToken ? 'Hide' : 'Show'}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyAuthToken}
                      disabled={!authTokenInput.trim()}
                      title="Copy token"
                    >
                      {authTokenCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
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

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTestConnection}
                    disabled={connectionStatus === 'testing'}
                    className="flex-1"
                  >
                    {connectionStatus === 'testing' ? (
                      <><RotateCcw className="mr-2 h-3 w-3 animate-spin" />Testing...</>
                    ) : connectionStatus === 'connected' ? (
                      <><Wifi className="mr-2 h-3 w-3 text-green-500" />Connected</>
                    ) : connectionStatus === 'failed' ? (
                      <><WifiOff className="mr-2 h-3 w-3 text-red-500" />Failed</>
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
      default:
        return null
    }
  }

  return (
    <>
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden lg:flex-row">
        <aside className="shrink-0 border-b border-border/60 px-4 py-3 lg:w-64 lg:border-b-0 lg:border-r lg:px-3 lg:py-4">
          <h2 className="mb-3 hidden px-2 text-sm font-medium text-foreground lg:block">Settings</h2>

          <div className="lg:hidden">
            <div className="-mx-1 overflow-x-auto">
              <div className="flex min-w-max items-center gap-2 px-1">
                {settingsSections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSectionId(section.id as typeof activeSectionId)}
                    className={`h-8 rounded-full px-3 text-xs font-medium whitespace-nowrap transition-colors ${activeSection.id === section.id
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <nav className="hidden lg:block">
            <div className="space-y-1">
              {settingsSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSectionId(section.id as typeof activeSectionId)}
                  className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${activeSection.id === section.id
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                    }`}
                >
                  {section.title}
                </button>
              ))}
            </div>
          </nav>
        </aside>

        <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 lg:px-6">
          <div className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {activeSection.title}
            </h3>
            <div className="space-y-2">
              {activeSection.items.map((item) => (
                <div key={item.id}>{renderSettingItem(item)}</div>
              ))}
            </div>
          </div>
        </section>
      </div>

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
                <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
                  <div className="flex items-center gap-2 text-accent">
                    <Check className="h-4 w-4" />
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Channel: {settings.integrations.slack.channel || 'Not set'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="w-full bg-transparent"
                  onClick={handleSlackDisconnect}
                >
                  <X className="mr-2 h-4 w-4" />
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
                    <div className="mt-1.5 flex items-center gap-2">
                      <Input
                        id="slack-api"
                        type={showSlackApiKey ? 'text' : 'password'}
                        placeholder="xoxb-..."
                        value={slackApiKey}
                        onChange={(e) => setSlackApiKey(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowSlackApiKey((prev) => !prev)}
                        title={showSlackApiKey ? 'Hide token' : 'Show token'}
                      >
                        {showSlackApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        {showSlackApiKey ? 'Hide' : 'Show'}
                      </Button>
                    </div>
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
    </>
  )
}
