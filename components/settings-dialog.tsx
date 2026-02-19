'use client'

import React, { useState, useMemo, useCallback } from 'react'
import {
  Slack,
  Moon,
  Sun,
  Monitor,
  Eye,
  EyeOff,
  Copy,
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
  LayoutDashboard,
  LayoutGrid,
  FileText,
  Bug,
  ExternalLink,
  Loader2,
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
import { createSetupShareLink, useApiConfig } from '@/lib/api-config'
import type { AppSettings } from '@/lib/types'
import { LeftPanelConfig } from '@/components/left-panel-config'
import { PromptSkillEditor } from '@/components/prompt-skill-editor'

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
  const [activeSectionId, setActiveSectionId] = useState<'api' | 'integrations' | 'appearance' | 'notifications' | 'devMode' | 'promptSkills' | 'about'>('api')
  const [slackDialogOpen, setSlackDialogOpen] = useState(false)
  const [slackApiKey, setSlackApiKey] = useState(settings.integrations.slack?.apiKey || '')
  const [slackChannel, setSlackChannel] = useState(settings.integrations.slack?.channel || '')
  const [slackSigningSecret, setSlackSigningSecret] = useState(settings.integrations.slack?.signingSecret || '')
  const [slackNotifyComplete, setSlackNotifyComplete] = useState(settings.integrations.slack?.notifyOnComplete !== false)
  const [slackNotifyFailed, setSlackNotifyFailed] = useState(settings.integrations.slack?.notifyOnFailed !== false)
  const [slackNotifyAlert, setSlackNotifyAlert] = useState(settings.integrations.slack?.notifyOnAlert !== false)
  const [showSlackApiKey, setShowSlackApiKey] = useState(false)
  const [slackLoading, setSlackLoading] = useState(false)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackSuccess, setSlackSuccess] = useState<string | null>(null)
  const [slackSetupOpen, setSlackSetupOpen] = useState(false)

  // API Configuration
  const {
    apiUrl,
    useMock,
    authToken,
    researchAgentKey,
    setApiUrl,
    setUseMock,
    setAuthToken,
    setResearchAgentKey,
    resetToDefaults,
    testConnection,
  } = useApiConfig()
  const [apiUrlInput, setApiUrlInput] = useState(apiUrl)
  const [authTokenInput, setAuthTokenInput] = useState(authToken)
  const [researchAgentKeyInput, setResearchAgentKeyInput] = useState(researchAgentKey)
  const [showAuthToken, setShowAuthToken] = useState(false)
  const [showResearchAgentKey, setShowResearchAgentKey] = useState(false)
  const [authTokenCopied, setAuthTokenCopied] = useState(false)
  const [researchAgentKeyCopied, setResearchAgentKeyCopied] = useState(false)
  const [setupLinkCopied, setSetupLinkCopied] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'failed'>('idle')
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
  const [chatInputInitialHeightInput, setChatInputInitialHeightInput] = useState<string>(
    settings.appearance.chatInputInitialHeightPx?.toString() ?? ''
  )
  const [toolBoxHeightInput, setToolBoxHeightInput] = useState<string>(
    settings.appearance.streamingToolBoxHeightRem?.toString() ?? ''
  )
  const [primaryColorInput, setPrimaryColorInput] = useState<string>(
    settings.appearance.customPrimaryColor ?? ''
  )
  const [accentColorInput, setAccentColorInput] = useState<string>(
    settings.appearance.customAccentColor ?? ''
  )
  const [wildLoopTasksFontSizeInput, setWildLoopTasksFontSizeInput] = useState<string>(
    settings.appearance.wildLoopTasksFontSizePx?.toString() ?? ''
  )
  const [wildLoopHistoryFontSizeInput, setWildLoopHistoryFontSizeInput] = useState<string>(
    settings.appearance.wildLoopHistoryFontSizePx?.toString() ?? ''
  )
  const [wildLoopTasksBoxHeightInput, setWildLoopTasksBoxHeightInput] = useState<string>(
    settings.appearance.wildLoopTasksBoxHeightPx?.toString() ?? ''
  )
  const [wildLoopHistoryBoxHeightInput, setWildLoopHistoryBoxHeightInput] = useState<string>(
    settings.appearance.wildLoopHistoryBoxHeightPx?.toString() ?? ''
  )

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
    setChatInputInitialHeightInput(settings.appearance.chatInputInitialHeightPx?.toString() ?? '')
  }, [settings.appearance.chatInputInitialHeightPx])

  React.useEffect(() => {
    setToolBoxHeightInput(settings.appearance.streamingToolBoxHeightRem?.toString() ?? '')
  }, [settings.appearance.streamingToolBoxHeightRem])

  React.useEffect(() => {
    setPrimaryColorInput(settings.appearance.customPrimaryColor ?? '')
  }, [settings.appearance.customPrimaryColor])

  React.useEffect(() => {
    setAccentColorInput(settings.appearance.customAccentColor ?? '')
  }, [settings.appearance.customAccentColor])

  React.useEffect(() => {
    setWildLoopTasksFontSizeInput(settings.appearance.wildLoopTasksFontSizePx?.toString() ?? '')
  }, [settings.appearance.wildLoopTasksFontSizePx])

  React.useEffect(() => {
    setWildLoopHistoryFontSizeInput(settings.appearance.wildLoopHistoryFontSizePx?.toString() ?? '')
  }, [settings.appearance.wildLoopHistoryFontSizePx])

  React.useEffect(() => {
    setWildLoopTasksBoxHeightInput(settings.appearance.wildLoopTasksBoxHeightPx?.toString() ?? '')
  }, [settings.appearance.wildLoopTasksBoxHeightPx])

  React.useEffect(() => {
    setWildLoopHistoryBoxHeightInput(settings.appearance.wildLoopHistoryBoxHeightPx?.toString() ?? '')
  }, [settings.appearance.wildLoopHistoryBoxHeightPx])

  // Sync apiUrlInput when apiUrl changes (e.g. on reset)
  React.useEffect(() => {
    setApiUrlInput(apiUrl)
  }, [apiUrl])

  // Sync authTokenInput when authToken changes (e.g. on reset)
  React.useEffect(() => {
    setAuthTokenInput(authToken)
  }, [authToken])

  React.useEffect(() => {
    setResearchAgentKeyInput(researchAgentKey)
  }, [researchAgentKey])

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
    const nextApiUrl = apiUrlInput.trim()
    const nextAuthToken = authTokenInput.trim()
    setConnectionStatus('testing')
    const isConnected = await testConnection({
      apiUrl: nextApiUrl,
      authToken: nextAuthToken,
      researchAgentKey: researchAgentKeyInput.trim(),
    })
    if (isConnected) {
      setApiUrl(nextApiUrl)
      setAuthToken(nextAuthToken)
      onRefresh?.()
    }
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

  const handleSaveResearchAgentKey = () => {
    setResearchAgentKey(researchAgentKeyInput.trim())
    onRefresh?.()
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

  const handleCopyResearchAgentKey = async () => {
    if (!researchAgentKeyInput.trim()) return
    try {
      await navigator.clipboard.writeText(researchAgentKeyInput)
      setResearchAgentKeyCopied(true)
      setTimeout(() => setResearchAgentKeyCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy RESEARCH_AGENT_KEY:', error)
    }
  }

  const handleCopySetupLink = async () => {
    const nextApiUrl = apiUrlInput.trim()
    const nextAuthToken = authTokenInput.trim()
    if (!nextApiUrl || !nextAuthToken) return

    const confirmed = window.confirm(
      'You are copying a setup link with the full auth token. Anyone with this link can access this entire session. Continue?'
    )
    if (!confirmed) return

    const setupLink = createSetupShareLink({
      apiUrl: nextApiUrl,
      authToken: nextAuthToken,
    })
    if (!setupLink) return

    try {
      await navigator.clipboard.writeText(setupLink)
      setSetupLinkCopied(true)
      setTimeout(() => setSetupLinkCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy setup link:', error)
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
          id: 'showStarterCards',
          label: 'Starter Cards',
          description: 'Show contextual prompt cards on new chats',
          icon: LayoutGrid,
          type: 'select' as const,
          options: ['none', 'novice', 'expert'],
          value: settings.appearance.starterCardFlavor || 'novice',
        },
        {
          id: 'showChatContextPanel',
          label: 'Chat Context Panel',
          description: 'Show or hide the right-side context panel in chat',
          icon: settings.appearance.showChatContextPanel !== false ? Eye : EyeOff,
          type: 'toggle' as const,
          value: settings.appearance.showChatContextPanel !== false,
        },
        {
          id: 'showChatArtifacts',
          label: 'Show Artifacts',
          description: 'Show or hide artifacts panel in chat views',
          icon: LayoutGrid,
          type: 'toggle' as const,
          value: settings.appearance.showChatArtifacts === true,
        },
        {
          id: 'chatCollapseArtifactsInChat',
          label: 'Collapse Artifacts In Chat',
          description: 'Render artifacts collapsed inside chat messages',
          icon: LayoutGrid,
          type: 'toggle' as const,
          value: settings.appearance.chatCollapseArtifactsInChat === true,
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
      id: 'devMode',
      title: 'Dev Mode',
      items: [
        {
          id: 'leftPanelConfig',
          label: 'Left Panel Items',
          description: 'Reorder and toggle navigation items',
          icon: LayoutDashboard,
          type: 'custom' as const,
        },
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
        {
          id: 'showSidebarRunsSweepsPreview',
          label: 'Sidebar Runs/Sweeps Preview',
          description: 'Show or hide recent Runs and Sweeps preview blocks in the desktop sidebar',
          icon: Eye,
          type: 'toggle' as const,
          value: settings.developer?.showSidebarRunsSweepsPreview !== false,
        },
      ],
    },
    {
      id: 'promptSkills',
      title: 'Prompt Skills',
      items: [
        {
          id: 'promptSkillEditor',
          label: 'Prompt Templates',
          description: 'Edit Wild Loop prompt templates',
          icon: FileText,
          type: 'custom' as const,
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

  const updateAppearanceSettings = (updates: Partial<AppSettings['appearance']>) => {
    onSettingsChange({
      ...settings,
      appearance: {
        ...settings.appearance,
        ...updates,
      },
    })
  }

  const normalizeHexColor = (value: string): string | null => {
    const trimmed = value.trim()
    if (!trimmed) return null
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null
  }

  const handleCustomFontSizeChange = (value: string) => {
    setFontSizeInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
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
    const clamped = Math.max(1, Math.min(1000, parsed))
    updateAppearanceSettings({ customFontSizePx: clamped })
    setFontSizeInput(clamped.toString())
  }

  const handleCustomButtonScaleChange = (value: string) => {
    setButtonScaleInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
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
    const clamped = Math.max(1, Math.min(1000, parsed))
    updateAppearanceSettings({ customButtonScalePercent: clamped })
    setButtonScaleInput(clamped.toString())
  }

  const handleChatToolbarButtonSizeChange = (value: string) => {
    setChatToolbarSizeInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
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
    const clamped = Math.max(1, Math.min(1000, parsed))
    updateAppearanceSettings({ chatToolbarButtonSizePx: clamped })
    setChatToolbarSizeInput(clamped.toString())
  }

  const handleChatInputInitialHeightChange = (value: string, currentInput: string) => {
    // If input was empty and spinner was clicked, browser uses min value - adjust to default (48)
    if (!currentInput && value === '40') {
      setChatInputInitialHeightInput('48')
      updateAppearanceSettings({ chatInputInitialHeightPx: 48 })
      return
    }
    setChatInputInitialHeightInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 40 && parsed <= 120) {
      updateAppearanceSettings({ chatInputInitialHeightPx: parsed })
    }
  }

  const handleChatInputInitialHeightBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ chatInputInitialHeightPx: null })
      setChatInputInitialHeightInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(40, Math.min(120, parsed))
    updateAppearanceSettings({ chatInputInitialHeightPx: clamped })
    setChatInputInitialHeightInput(clamped.toString())
  }

  const handleToolBoxHeightChange = (value: string, currentInput: string) => {
    if (!currentInput && value === '4') {
      setToolBoxHeightInput('7.5')
      updateAppearanceSettings({ streamingToolBoxHeightRem: 7.5 })
      return
    }
    setToolBoxHeightInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
      updateAppearanceSettings({ streamingToolBoxHeightRem: parsed })
    }
  }

  const handleToolBoxHeightBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ streamingToolBoxHeightRem: null })
      setToolBoxHeightInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(1, Math.min(1000, parsed))
    updateAppearanceSettings({ streamingToolBoxHeightRem: clamped })
    setToolBoxHeightInput(clamped.toString())
  }

  const handlePrimaryColorChange = (value: string) => {
    setPrimaryColorInput(value)
    const normalized = normalizeHexColor(value)
    if (normalized) {
      updateAppearanceSettings({ customPrimaryColor: normalized })
    }
  }

  const handlePrimaryColorBlur = (value: string) => {
    const normalized = normalizeHexColor(value)
    if (!value.trim()) {
      setPrimaryColorInput('')
      updateAppearanceSettings({ customPrimaryColor: null })
      return
    }
    if (normalized) {
      setPrimaryColorInput(normalized)
      updateAppearanceSettings({ customPrimaryColor: normalized })
    }
  }

  const handleAccentColorChange = (value: string) => {
    setAccentColorInput(value)
    const normalized = normalizeHexColor(value)
    if (normalized) {
      updateAppearanceSettings({ customAccentColor: normalized })
    }
  }

  const handleAccentColorBlur = (value: string) => {
    const normalized = normalizeHexColor(value)
    if (!value.trim()) {
      setAccentColorInput('')
      updateAppearanceSettings({ customAccentColor: null })
      return
    }
    if (normalized) {
      setAccentColorInput(normalized)
      updateAppearanceSettings({ customAccentColor: normalized })
    }
  }
  const handleWildLoopTasksFontSizeChange = (value: string, currentInput: string) => {
    if (!currentInput && value === '12') {
      setWildLoopTasksFontSizeInput('16')
      updateAppearanceSettings({ wildLoopTasksFontSizePx: 16 })
      return
    }
    setWildLoopTasksFontSizeInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 12 && parsed <= 28) {
      updateAppearanceSettings({ wildLoopTasksFontSizePx: parsed })
    }
  }

  const handleWildLoopTasksFontSizeBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ wildLoopTasksFontSizePx: null })
      setWildLoopTasksFontSizeInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(12, Math.min(28, parsed))
    updateAppearanceSettings({ wildLoopTasksFontSizePx: clamped })
    setWildLoopTasksFontSizeInput(clamped.toString())
  }

  const handleWildLoopHistoryFontSizeChange = (value: string, currentInput: string) => {
    if (!currentInput && value === '12') {
      setWildLoopHistoryFontSizeInput('15')
      updateAppearanceSettings({ wildLoopHistoryFontSizePx: 15 })
      return
    }
    setWildLoopHistoryFontSizeInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 12 && parsed <= 28) {
      updateAppearanceSettings({ wildLoopHistoryFontSizePx: parsed })
    }
  }

  const handleWildLoopHistoryFontSizeBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ wildLoopHistoryFontSizePx: null })
      setWildLoopHistoryFontSizeInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(12, Math.min(28, parsed))
    updateAppearanceSettings({ wildLoopHistoryFontSizePx: clamped })
    setWildLoopHistoryFontSizeInput(clamped.toString())
  }

  const handleWildLoopTasksBoxHeightChange = (value: string, currentInput: string) => {
    if (!currentInput && value === '160') {
      setWildLoopTasksBoxHeightInput('420')
      updateAppearanceSettings({ wildLoopTasksBoxHeightPx: 420 })
      return
    }
    setWildLoopTasksBoxHeightInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 160 && parsed <= 1200) {
      updateAppearanceSettings({ wildLoopTasksBoxHeightPx: parsed })
    }
  }

  const handleWildLoopTasksBoxHeightBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ wildLoopTasksBoxHeightPx: null })
      setWildLoopTasksBoxHeightInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(160, Math.min(1200, parsed))
    updateAppearanceSettings({ wildLoopTasksBoxHeightPx: clamped })
    setWildLoopTasksBoxHeightInput(clamped.toString())
  }

  const handleWildLoopHistoryBoxHeightChange = (value: string, currentInput: string) => {
    if (!currentInput && value === '120') {
      setWildLoopHistoryBoxHeightInput('300')
      updateAppearanceSettings({ wildLoopHistoryBoxHeightPx: 300 })
      return
    }
    setWildLoopHistoryBoxHeightInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && parsed >= 120 && parsed <= 1000) {
      updateAppearanceSettings({ wildLoopHistoryBoxHeightPx: parsed })
    }
  }

  const handleWildLoopHistoryBoxHeightBlur = (value: string) => {
    if (!value.trim()) {
      updateAppearanceSettings({ wildLoopHistoryBoxHeightPx: null })
      setWildLoopHistoryBoxHeightInput('')
      return
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const clamped = Math.max(120, Math.min(1000, parsed))
    updateAppearanceSettings({ wildLoopHistoryBoxHeightPx: clamped })
    setWildLoopHistoryBoxHeightInput(clamped.toString())
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

  const handleSlackSave = useCallback(async () => {
    setSlackLoading(true)
    setSlackError(null)
    setSlackSuccess(null)
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' }
      if (authToken) headers['X-Auth-Token'] = authToken
      const resp = await fetch(`${apiUrl}/integrations/slack/configure`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bot_token: slackApiKey,
          channel: slackChannel,
          signing_secret: slackSigningSecret,
          notify_on_complete: slackNotifyComplete,
          notify_on_failed: slackNotifyFailed,
          notify_on_alert: slackNotifyAlert,
        }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: 'Connection failed' }))
        throw new Error(data.detail || `HTTP ${resp.status}`)
      }
      const result = await resp.json()
      onSettingsChange({
        ...settings,
        integrations: {
          ...settings.integrations,
          slack: {
            enabled: true,
            apiKey: slackApiKey,
            channel: slackChannel,
            signingSecret: slackSigningSecret,
            notifyOnComplete: slackNotifyComplete,
            notifyOnFailed: slackNotifyFailed,
            notifyOnAlert: slackNotifyAlert,
          },
        },
      })
      setSlackSuccess(`Connected to ${result.team || 'Slack'}!`)
    } catch (e: unknown) {
      setSlackError(e instanceof Error ? e.message : 'Failed to configure Slack')
    } finally {
      setSlackLoading(false)
    }
  }, [apiUrl, authToken, slackApiKey, slackChannel, slackSigningSecret, slackNotifyComplete, slackNotifyFailed, slackNotifyAlert, settings, onSettingsChange])

  const handleSlackDisconnect = useCallback(async () => {
    setSlackLoading(true)
    setSlackError(null)
    setSlackSuccess(null)
    try {
      const headers: HeadersInit = {}
      if (authToken) headers['X-Auth-Token'] = authToken
      await fetch(`${apiUrl}/integrations/slack/configure`, {
        method: 'DELETE',
        headers,
      })
      onSettingsChange({
        ...settings,
        integrations: {
          ...settings.integrations,
          slack: undefined,
        },
      })
      setSlackApiKey('')
      setSlackChannel('')
      setSlackSigningSecret('')
      setSlackSuccess(null)
    } catch {
      setSlackError('Failed to disconnect')
    } finally {
      setSlackLoading(false)
    }
  }, [apiUrl, authToken, settings, onSettingsChange])

  const handleSlackTest = useCallback(async () => {
    setSlackLoading(true)
    setSlackError(null)
    setSlackSuccess(null)
    try {
      const headers: HeadersInit = {}
      if (authToken) headers['X-Auth-Token'] = authToken
      const resp = await fetch(`${apiUrl}/integrations/slack/test`, {
        method: 'POST',
        headers,
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: 'Test failed' }))
        throw new Error(data.detail || `HTTP ${resp.status}`)
      }
      setSlackSuccess('Test message sent! Check your Slack channel.')
    } catch (e: unknown) {
      setSlackError(e instanceof Error ? e.message : 'Failed to send test')
    } finally {
      setSlackLoading(false)
    }
  }, [apiUrl, authToken])

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
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3 md:min-w-0 md:flex-1">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground md:truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground md:truncate">{item.description}</p>
                </div>
              </div>
              <div className="flex w-full gap-2 md:ml-4 md:w-auto md:min-w-[280px] md:max-w-[420px] md:flex-1">
                {item.options?.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      if (item.id === 'theme') handleThemeChange(option as 'dark' | 'light' | 'system')
                      if (item.id === 'fontSize') handleFontSizeChange(option as 'small' | 'medium' | 'large')
                      if (item.id === 'buttonSize') handleButtonSizeChange(option as 'compact' | 'default' | 'large')
                      if (item.id === 'starterCardFlavor') updateAppearanceSettings({ starterCardFlavor: option as 'none' | 'novice' | 'expert' })
                      if (item.id === 'showStarterCards') updateAppearanceSettings({ starterCardFlavor: option as 'none' | 'novice' | 'expert' })
                    }}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium capitalize whitespace-nowrap transition-colors ${item.value === option
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
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
                if (item.id === 'showChatContextPanel') updateAppearanceSettings({ showChatContextPanel: checked })
                if (item.id === 'showChatArtifacts') updateAppearanceSettings({ showChatArtifacts: checked })
                if (item.id === 'chatCollapseArtifactsInChat') updateAppearanceSettings({ chatCollapseArtifactsInChat: checked })
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
                if (item.id === 'showSidebarRunsSweepsPreview') {
                  onSettingsChange({
                    ...settings,
                    developer: { ...settings.developer, showSidebarRunsSweepsPreview: checked },
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
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-background">
                  <Square className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Advanced Appearance</p>
                  <p className="text-xs text-muted-foreground">Numeric control for fonts and buttons</p>
                </div>
              </div>

              <div className="mt-4 space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2">
                    <div>
                      <Label htmlFor="sidebar-new-chat-toggle-dialog" className="text-xs">Sidebar New Chat Button</Label>
                      <p className="text-[11px] text-muted-foreground">Show or hide the New Chat button in the desktop sidebar</p>
                    </div>
                    <Switch
                      id="sidebar-new-chat-toggle-dialog"
                      checked={settings.appearance.showSidebarNewChatButton === true}
                      onCheckedChange={(checked) => updateAppearanceSettings({ showSidebarNewChatButton: checked })}
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-font-size-dialog" className="text-xs">Font Size (px) <span className="font-normal text-muted-foreground">1–1000</span></Label>
                      <p className="text-[11px] text-muted-foreground">Overrides small/medium/large when set</p>
                    </div>
                    <Input
                      id="custom-font-size-dialog"
                      type="number"
                      min={1}
                      max={1000}
                      value={fontSizeInput}
                      onChange={(e) => handleCustomFontSizeChange(e.target.value)}
                      onBlur={(e) => handleCustomFontSizeBlur(e.target.value)}
                      placeholder={settings.appearance.fontSize === 'small' ? '14' : settings.appearance.fontSize === 'large' ? '18' : '16'}
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-button-scale-dialog" className="text-xs">Button Scale (%) <span className="font-normal text-muted-foreground">1–1000</span></Label>
                      <p className="text-[11px] text-muted-foreground">Scales global button sizes</p>
                    </div>
                    <Input
                      id="custom-button-scale-dialog"
                      type="number"
                      min={1}
                      max={1000}
                      value={buttonScaleInput}
                      onChange={(e) => handleCustomButtonScaleChange(e.target.value)}
                      onBlur={(e) => handleCustomButtonScaleBlur(e.target.value)}
                      placeholder="120"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="chat-toolbar-button-size-dialog" className="text-xs">Chat Bottom Buttons (px) <span className="font-normal text-muted-foreground">1–1000</span></Label>
                      <p className="text-[11px] text-muted-foreground">Mode/add/mention/command controls</p>
                    </div>
                    <Input
                      id="chat-toolbar-button-size-dialog"
                      type="number"
                      min={1}
                      max={1000}
                      value={chatToolbarSizeInput}
                      onChange={(e) => handleChatToolbarButtonSizeChange(e.target.value)}
                      onBlur={(e) => handleChatToolbarButtonSizeBlur(e.target.value)}
                      placeholder="36"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="chat-input-initial-height-dialog" className="text-xs">Chat Input Initial Height (px) <span className="font-normal text-muted-foreground">40–120</span></Label>
                      <p className="text-[11px] text-muted-foreground">Default one-line composer height before expansion</p>
                    </div>
                    <Input
                      id="chat-input-initial-height-dialog"
                      type="number"
                      min={40}
                      max={120}
                      value={chatInputInitialHeightInput}
                      onChange={(e) => handleChatInputInitialHeightChange(e.target.value, chatInputInitialHeightInput)}
                      onBlur={(e) => handleChatInputInitialHeightBlur(e.target.value)}
                      placeholder="48"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="tool-box-height-dialog" className="text-xs">Tool / Thinking Box Height (rem) <span className="font-normal text-muted-foreground">1–1000</span></Label>
                      <p className="text-[11px] text-muted-foreground">Max height of tool/thinking boxes during streaming</p>
                    </div>
                    <Input
                      id="tool-box-height-dialog"
                      type="number"
                      min={1}
                      max={1000}
                      step={0.5}
                      value={toolBoxHeightInput}
                      onChange={(e) => handleToolBoxHeightChange(e.target.value, toolBoxHeightInput)}
                      onBlur={(e) => handleToolBoxHeightBlur(e.target.value)}
                      placeholder="7.5"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-primary-color-dialog" className="text-xs">Primary Color</Label>
                      <p className="text-[11px] text-muted-foreground">Hex color for --primary (example: #f59e0b)</p>
                    </div>
                    <Input
                      id="custom-primary-color-dialog"
                      value={primaryColorInput}
                      onChange={(e) => handlePrimaryColorChange(e.target.value)}
                      onBlur={(e) => handlePrimaryColorBlur(e.target.value)}
                      placeholder="#f59e0b"
                      className="h-8 w-28 text-xs font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="wild-loop-tasks-font-size-dialog" className="text-xs">Wild Loop Tasks Font (px) <span className="font-normal text-muted-foreground">12–28</span></Label>
                      <p className="text-[11px] text-muted-foreground">tasks.md text size in the Wild Loop Debug panel</p>
                    </div>
                    <Input
                      id="wild-loop-tasks-font-size-dialog"
                      type="number"
                      min={12}
                      max={28}
                      value={wildLoopTasksFontSizeInput}
                      onChange={(e) => handleWildLoopTasksFontSizeChange(e.target.value, wildLoopTasksFontSizeInput)}
                      onBlur={(e) => handleWildLoopTasksFontSizeBlur(e.target.value)}
                      placeholder="16"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="wild-loop-tasks-box-height-dialog" className="text-xs">Wild Loop Tasks Box Height (px) <span className="font-normal text-muted-foreground">160–1200</span></Label>
                      <p className="text-[11px] text-muted-foreground">Max height of the tasks.md scroll area in the Wild Loop Debug panel</p>
                    </div>
                    <Input
                      id="wild-loop-tasks-box-height-dialog"
                      type="number"
                      min={160}
                      max={1200}
                      value={wildLoopTasksBoxHeightInput}
                      onChange={(e) => handleWildLoopTasksBoxHeightChange(e.target.value, wildLoopTasksBoxHeightInput)}
                      onBlur={(e) => handleWildLoopTasksBoxHeightBlur(e.target.value)}
                      placeholder="420"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="custom-accent-color-dialog" className="text-xs">Accent Color</Label>
                      <p className="text-[11px] text-muted-foreground">Hex color for --accent (example: #fb923c)</p>
                    </div>
                    <Input
                      id="custom-accent-color-dialog"
                      value={accentColorInput}
                      onChange={(e) => handleAccentColorChange(e.target.value)}
                      onBlur={(e) => handleAccentColorBlur(e.target.value)}
                      placeholder="#fb923c"
                      className="h-8 w-28 text-xs font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="wild-loop-history-font-size-dialog" className="text-xs">Wild Loop History Font (px) <span className="font-normal text-muted-foreground">12–28</span></Label>
                      <p className="text-[11px] text-muted-foreground">iteration history text size in the Wild Loop Debug panel</p>
                    </div>
                    <Input
                      id="wild-loop-history-font-size-dialog"
                      type="number"
                      min={12}
                      max={28}
                      value={wildLoopHistoryFontSizeInput}
                      onChange={(e) => handleWildLoopHistoryFontSizeChange(e.target.value, wildLoopHistoryFontSizeInput)}
                      onBlur={(e) => handleWildLoopHistoryFontSizeBlur(e.target.value)}
                      placeholder="15"
                      className="h-8 w-24 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <div>
                      <Label htmlFor="wild-loop-history-box-height-dialog" className="text-xs">Wild Loop History Box Height (px) <span className="font-normal text-muted-foreground">120–1000</span></Label>
                      <p className="text-[11px] text-muted-foreground">Max height of iteration history list in the Wild Loop Debug panel</p>
                    </div>
                    <Input
                      id="wild-loop-history-box-height-dialog"
                      type="number"
                      min={120}
                      max={1000}
                      value={wildLoopHistoryBoxHeightInput}
                      onChange={(e) => handleWildLoopHistoryBoxHeightChange(e.target.value, wildLoopHistoryBoxHeightInput)}
                      onBlur={(e) => handleWildLoopHistoryBoxHeightBlur(e.target.value)}
                      placeholder="300"
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
                          chatInputInitialHeightPx: null,
                          streamingToolBoxHeightRem: null,
                          customPrimaryColor: null,
                          customAccentColor: null,
                          wildLoopTasksFontSizePx: null,
                          wildLoopHistoryFontSizePx: null,
                          wildLoopTasksBoxHeightPx: null,
                          wildLoopHistoryBoxHeightPx: null,
                        })
                      }
                    >
                      Reset Advanced
                    </Button>
                  </div>
                </div>
            </div>
          )
        }

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
                        className="px-2"
                        title={showAuthToken ? 'Hide token' : 'Show token'}
                      >
                        {showAuthToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        <span className="sr-only">{showAuthToken ? 'Hide token' : 'Show token'}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopyAuthToken}
                        disabled={!authTokenInput.trim()}
                        className="px-2"
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

                  <div className="space-y-2">
                    <Label htmlFor="research-agent-key" className="text-xs">RESEARCH_AGENT_KEY</Label>
                    <p className="text-xs text-muted-foreground">Gateway key used by model provider requests</p>
                    <div className="flex gap-2">
                      <Input
                        id="research-agent-key"
                        type={showResearchAgentKey ? 'text' : 'password'}
                        placeholder="Enter RESEARCH_AGENT_KEY..."
                        value={researchAgentKeyInput}
                        onChange={(e) => setResearchAgentKeyInput(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowResearchAgentKey((prev) => !prev)}
                        className="px-2"
                        title={showResearchAgentKey ? 'Hide key' : 'Show key'}
                      >
                        {showResearchAgentKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        <span className="sr-only">{showResearchAgentKey ? 'Hide key' : 'Show key'}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopyResearchAgentKey}
                        disabled={!researchAgentKeyInput.trim()}
                        className="px-2"
                        title="Copy RESEARCH_AGENT_KEY"
                      >
                        {researchAgentKeyCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveResearchAgentKey}
                        disabled={researchAgentKeyInput.trim() === researchAgentKey}
                      >
                        Save
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                    <Label className="text-xs">Share Setup Link</Label>
                    <p className="text-xs text-muted-foreground">
                      Copy a one-click setup link with this server URL and auth token.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopySetupLink}
                      disabled={!apiUrlInput.trim() || !authTokenInput.trim()}
                      className="w-full justify-center gap-2"
                    >
                      {setupLinkCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                      {setupLinkCopied ? 'Copied' : 'Copy Setup Link'}
                    </Button>
                    <p className="text-xs text-amber-700">
                      Warning: This includes the full auth token. Anyone with the link gets full session access.
                    </p>
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

        if (item.id === 'leftPanelConfig') {
          return <LeftPanelConfig settings={settings} onSettingsChange={onSettingsChange} />
        }

        if (item.id === 'promptSkillEditor') {
          return <PromptSkillEditor />
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

          <div className="border-b border-border/60 px-4 py-3">
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

          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <div className="space-y-3 pt-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {activeSection.title}
              </h3>
              <div className="space-y-2">
                {activeSection.items.map((item) => (
                  <div key={item.id}>{renderSettingItem(item)}</div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Slack Integration Dialog */}
      <Dialog open={slackDialogOpen} onOpenChange={(open) => { setSlackDialogOpen(open); if (!open) { setSlackError(null); setSlackSuccess(null) } }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Slack className="h-5 w-5" />
              Slack Integration
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {slackError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-xs text-red-400">{slackError}</p>
              </div>
            )}
            {slackSuccess && (
              <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
                <p className="text-xs text-accent">{slackSuccess}</p>
              </div>
            )}

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

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Notification Events</p>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-notify-complete" className="text-xs">Run Completed</Label>
                    <Switch id="dlg-notify-complete" checked={slackNotifyComplete} onCheckedChange={setSlackNotifyComplete} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-notify-failed" className="text-xs">Run Failed</Label>
                    <Switch id="dlg-notify-failed" checked={slackNotifyFailed} onCheckedChange={setSlackNotifyFailed} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-notify-alert" className="text-xs">Experiment Alerts</Label>
                    <Switch id="dlg-notify-alert" checked={slackNotifyAlert} onCheckedChange={setSlackNotifyAlert} />
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 bg-transparent"
                    onClick={handleSlackTest}
                    disabled={slackLoading}
                  >
                    {slackLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bell className="mr-2 h-4 w-4" />}
                    Send Test
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 bg-transparent text-red-400 hover:text-red-300"
                    onClick={handleSlackDisconnect}
                    disabled={slackLoading}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg border border-border/50 bg-secondary/30">
                  <button
                    type="button"
                    onClick={() => setSlackSetupOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between p-3 text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">How to set up Slack integration</span>
                    <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${slackSetupOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {slackSetupOpen && (
                    <div className="space-y-2 border-t border-border/50 px-3 pb-3 pt-2">
                      <div className="space-y-1.5 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">1. Create a Slack App</p>
                        <p>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline inline-flex items-center gap-0.5">api.slack.com/apps <ExternalLink className="h-3 w-3" /></a> and click &quot;Create New App&quot; &rarr; &quot;From scratch&quot;.</p>
                        <p className="font-medium text-foreground pt-1">2. Add Bot Token Scopes</p>
                        <p>Under <strong>OAuth &amp; Permissions</strong>: <code className="text-[11px]">chat:write, channels:read, groups:read</code></p>
                        <p className="font-medium text-foreground pt-1">3. Install &amp; Copy Token</p>
                        <p>Install to workspace, copy the <code className="text-[11px]">xoxb-</code> token.</p>
                        <p className="font-medium text-foreground pt-1">4. Invite Bot to Channel</p>
                        <p>Type <code className="text-[11px]">/invite @YourBotName</code> in channel.</p>
                      </div>
                      <a
                        href="https://github.com/hao-ai-lab/research-agent/blob/main/docs/SLACK_INTEGRATION.md"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        Full setup guide <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <Label htmlFor="dlg-slack-api" className="text-xs">
                      Bot Token
                    </Label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Input
                        id="dlg-slack-api"
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
                    <Label htmlFor="dlg-slack-channel" className="text-xs">
                      Default Channel
                    </Label>
                    <Input
                      id="dlg-slack-channel"
                      placeholder="#ml-experiments"
                      value={slackChannel}
                      onChange={(e) => setSlackChannel(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="dlg-slack-signing-secret" className="text-xs">
                      Signing Secret <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="dlg-slack-signing-secret"
                      type="password"
                      placeholder="abc123..."
                      value={slackSigningSecret}
                      onChange={(e) => setSlackSigningSecret(e.target.value)}
                      className="mt-1.5"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Notification Events</p>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-setup-complete" className="text-xs">Run Completed</Label>
                    <Switch id="dlg-setup-complete" checked={slackNotifyComplete} onCheckedChange={setSlackNotifyComplete} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-setup-failed" className="text-xs">Run Failed</Label>
                    <Switch id="dlg-setup-failed" checked={slackNotifyFailed} onCheckedChange={setSlackNotifyFailed} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
                    <Label htmlFor="dlg-setup-alert" className="text-xs">Experiment Alerts</Label>
                    <Switch id="dlg-setup-alert" checked={slackNotifyAlert} onCheckedChange={setSlackNotifyAlert} />
                  </div>
                </div>

                <Button
                  className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={handleSlackSave}
                  disabled={!slackApiKey.trim() || !slackChannel.trim() || slackLoading}
                >
                  {slackLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Slack className="mr-2 h-4 w-4" />}
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
