'use client'

import { useState, useMemo } from 'react'
import {
  Search,
  Slack,
  Moon,
  Sun,
  Monitor,
  Type,
  Square,
  Bell,
  X,
  Check,
  ChevronRight,
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
import type { AppSettings } from '@/lib/types'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
}: SettingsDialogProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [slackDialogOpen, setSlackDialogOpen] = useState(false)
  const [slackApiKey, setSlackApiKey] = useState(settings.integrations.slack?.apiKey || '')
  const [slackChannel, setSlackChannel] = useState(settings.integrations.slack?.channel || '')

  const settingsSections = useMemo(() => [
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

  const renderSettingItem = (item: typeof settingsSections[0]['items'][0]) => {
    const Icon = item.icon

    switch (item.type) {
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
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium capitalize transition-colors ${
                    item.value === option
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
    </>
  )
}
