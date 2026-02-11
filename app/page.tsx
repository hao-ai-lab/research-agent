'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FloatingNav } from '@/components/floating-nav'
import { NavPage } from '@/components/nav-page'
import { ConnectedChatView, useChatSession } from '@/components/connected-chat-view'
import { RunsView } from '@/components/runs-view'
import { ChartsView } from '@/components/charts-view'
import { InsightsView } from '@/components/insights-view'
import { EventsView } from '@/components/events-view'
import { JourneyView } from '@/components/journey-view'
import { ReportView, type ReportToolbarState } from '@/components/report-view'
import { FileExplorerView } from '@/components/file-explorer-view'
import { SettingsPageContent } from '@/components/settings-page-content'
import { SkillsBrowserView } from '@/components/skills-browser-view'
import { DesktopSidebar } from '@/components/desktop-sidebar'
import { useRuns } from '@/hooks/use-runs'
import { useAlerts } from '@/hooks/use-alerts'
import type { ChatMode } from '@/components/chat-input'
import { mockMemoryRules, mockInsightCharts, defaultTags } from '@/lib/mock-data'
import type { ExperimentRun, MemoryRule, InsightChart, TagDefinition, RunEvent, EventStatus, SweepConfig } from '@/lib/types'
import { SweepForm } from '@/components/sweep-form'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import { useApiConfig } from '@/lib/api-config'
import { getWildMode, setWildMode } from '@/lib/api-client'
import { listPromptSkills, type PromptSkill } from '@/lib/api'
import { useWildLoop } from '@/hooks/use-wild-loop'
import { useAppSettings } from '@/lib/app-settings'
import { useSweeps } from '@/hooks/use-sweeps'
import { useCluster } from '@/hooks/use-cluster'
import {
  buildHomeSearchParams,
  isJourneySubTab,
  parseHomeTab,
  type HomeTab,
  type JourneySubTab,
} from '@/lib/navigation'
const DESKTOP_SIDEBAR_MIN_WIDTH = 72
const DESKTOP_SIDEBAR_MAX_WIDTH = 520
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 300
const STORAGE_KEY_DESKTOP_SIDEBAR_WIDTH = 'desktopSidebarWidth'
const STORAGE_KEY_DESKTOP_SIDEBAR_COLLAPSED = 'desktopSidebarCollapsed'
const STORAGE_KEY_JOURNEY_SUB_TAB = 'journeySubTab'
const STORAGE_KEY_CHAT_SHOW_ARTIFACTS = 'chatShowArtifacts'
const STORAGE_KEY_CHAT_COLLAPSE_CHATS = 'chatCollapseChats'
const STORAGE_KEY_CHAT_COLLAPSE_ARTIFACTS = 'chatCollapseArtifactsInChat'
const DESKTOP_SIDEBAR_ICON_RAIL_TRIGGER_WIDTH = 136

export default function ResearchChat() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { settings, setSettings } = useAppSettings()
  const [activeTab, setActiveTab] = useState<HomeTab>('chat')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false)
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  const [reportToolbar, setReportToolbar] = useState<ReportToolbarState | null>(null)
  const sidebarWidthRef = useRef(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  const pendingSidebarWidthRef = useRef<number | null>(null)
  const sidebarRafRef = useRef<number | null>(null)

  // Use real API data via useRuns hook
  const { runs, updateRun: apiUpdateRun, refetch: refetchRuns, startExistingRun, stopExistingRun } = useRuns()
  const {
    sweeps,
    refetch: refetchSweeps,
    saveDraftSweep,
    launchSweepFromConfig,
  } = useSweeps()
  const {
    cluster,
    runSummary: clusterRunSummary,
    isLoading: clusterLoading,
    error: clusterError,
    autoDetect: detectClusterSetup,
    saveCluster: updateClusterSetup,
    refetch: refetchCluster,
  } = useCluster()
  const { alerts, respond: respondAlert } = useAlerts()

  const [memoryRules, setMemoryRules] = useState<MemoryRule[]>(mockMemoryRules)
  const [insightCharts, setInsightCharts] = useState<InsightChart[]>(mockInsightCharts)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [allTags, setAllTags] = useState<TagDefinition[]>(defaultTags)

  // State for navigation
  const [selectedRun, setSelectedRun] = useState<ExperimentRun | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)

  // Event status is tracked locally for acknowledgement/dismissal UX.
  const [eventStatusOverrides, setEventStatusOverrides] = useState<Record<string, EventStatus>>({})

  // Sweeps state
  const [showSweepForm, setShowSweepForm] = useState(false)
  const [editingSweepConfig, setEditingSweepConfig] = useState<SweepConfig | null>(null)

  // Chat panel state
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [collapseChats, setCollapseChats] = useState(false)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)
  const [chatDraftInsert, setChatDraftInsert] = useState<{ id: number; text: string } | null>(null)
  const [focusAuthTokenInApp, setFocusAuthTokenInApp] = useState(false)

  // API configuration for auth/connection check
  const { useMock, apiUrl, authToken, testConnection } = useApiConfig()

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(STORAGE_KEY_DESKTOP_SIDEBAR_WIDTH)
    if (!storedWidth) return
    const parsed = Number(storedWidth)
    if (!Number.isFinite(parsed)) return
    const widthForSidebar = parsed <= DESKTOP_SIDEBAR_ICON_RAIL_TRIGGER_WIDTH
      ? DESKTOP_SIDEBAR_DEFAULT_WIDTH
      : parsed
    setDesktopSidebarWidth(
      Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, widthForSidebar))
    )
  }, [])

  useEffect(() => {
    const storedCollapsed = window.localStorage.getItem(STORAGE_KEY_DESKTOP_SIDEBAR_COLLAPSED)
    if (storedCollapsed != null) {
      setDesktopSidebarHidden(storedCollapsed === 'true')
    }

    const storedJourneySubTab = window.localStorage.getItem(STORAGE_KEY_JOURNEY_SUB_TAB)
    if (storedJourneySubTab === 'story' || storedJourneySubTab === 'devnotes') {
      setJourneySubTab(storedJourneySubTab)
    }

    const storedShowArtifacts = window.localStorage.getItem(STORAGE_KEY_CHAT_SHOW_ARTIFACTS)
    if (storedShowArtifacts != null) {
      setShowArtifacts(storedShowArtifacts === 'true')
    }

    const storedCollapseChats = window.localStorage.getItem(STORAGE_KEY_CHAT_COLLAPSE_CHATS)
    if (storedCollapseChats != null) {
      setCollapseChats(storedCollapseChats === 'true')
    }

    const storedCollapseArtifacts = window.localStorage.getItem(STORAGE_KEY_CHAT_COLLAPSE_ARTIFACTS)
    if (storedCollapseArtifacts != null) {
      setCollapseArtifactsInChat(storedCollapseArtifacts === 'true')
    }
  }, [])

  useEffect(() => {
    sidebarWidthRef.current = desktopSidebarWidth
  }, [desktopSidebarWidth])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_DESKTOP_SIDEBAR_COLLAPSED, String(desktopSidebarHidden))
  }, [desktopSidebarHidden])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_JOURNEY_SUB_TAB, journeySubTab)
  }, [journeySubTab])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_CHAT_SHOW_ARTIFACTS, String(showArtifacts))
  }, [showArtifacts])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_CHAT_COLLAPSE_CHATS, String(collapseChats))
  }, [collapseChats])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_CHAT_COLLAPSE_ARTIFACTS, String(collapseArtifactsInChat))
  }, [collapseArtifactsInChat])

  useEffect(() => {
    return () => {
      if (sidebarRafRef.current != null) {
        cancelAnimationFrame(sidebarRafRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setActiveTab(parseHomeTab(searchParams, 'chat'))
    const journeySubTabParam = searchParams.get('journeySubTab')
    if (isJourneySubTab(journeySubTabParam)) {
      setJourneySubTab(journeySubTabParam)
    }
    setFocusAuthTokenInApp(searchParams.get('focusAuthToken') === '1')
  }, [searchParams])

  // Auto-open settings if auth token is missing or connection fails (when not in mock mode)
  useEffect(() => {
    if (useMock) return // Skip check in demo mode

    const checkConnection = async () => {
      // Check if auth token is missing
      if (!authToken) {
        setActiveTab('settings')
        router.replace('/?tab=settings&focusAuthToken=1', { scroll: false })
        setFocusAuthTokenInApp(true)
        return
      }

      // Check if connection works
      const isConnected = await testConnection()
      if (!isConnected) {
        setActiveTab('settings')
        router.replace('/?tab=settings', { scroll: false })
        setFocusAuthTokenInApp(false)
      } else {
        setFocusAuthTokenInApp(false)
      }
    }

    checkConnection()
  }, [useMock, authToken, testConnection, router])

  // Chat session hook - single instance shared with ConnectedChatView
  const chatSession = useChatSession()
  const {
    createNewSession,
    startNewChat,
    sessions,
    savedSessionIds,
    selectSession,
    saveSession,
    unsaveSession,
    archiveSession,
    currentSessionId,
    currentSession,
  } = chatSession
  const { sendMessage } = chatSession

  // Wild loop hook
  const wildLoop = useWildLoop()

  // Load prompt skills for slash commands
  const [promptSkills, setPromptSkills] = useState<PromptSkill[]>([])
  useEffect(() => {
    listPromptSkills().then(setPromptSkills).catch(() => {})
  }, [])

  const events = useMemo<RunEvent[]>(() => {
    const toEvent = alerts.map((alert) => {
      const run = runs.find(r => r.id === alert.run_id)
      const eventId = `alert-${alert.id}`
      const baseStatus: EventStatus = alert.status === 'resolved' ? 'resolved' : 'new'
      const override = eventStatusOverrides[eventId]

      const status: EventStatus = alert.status === 'resolved'
        ? (override === 'dismissed' ? 'dismissed' : 'resolved')
        : (override || 'new')

      const severityType: RunEvent['type'] =
        alert.severity === 'critical' ? 'error' :
        alert.severity === 'warning' ? 'warning' : 'info'

      const priority: RunEvent['priority'] =
        alert.severity === 'critical' ? 'critical' :
        alert.severity === 'warning' ? 'high' : 'low'

      const title =
        alert.severity === 'critical' ? 'Critical Alert' :
        alert.severity === 'warning' ? 'Warning' : 'Info'

      return {
        id: eventId,
        alertId: alert.id,
        alertSessionId: alert.session_id || undefined,
        runId: alert.run_id,
        runName: run?.name || `Run ${alert.run_id}`,
        runAlias: run?.alias,
        type: severityType,
        priority,
        status,
        title,
        summary: alert.message,
        description: alert.status === 'resolved' && alert.response
          ? `${alert.message}\n\nResponse: ${alert.response}`
          : alert.message,
        timestamp: new Date(alert.timestamp * 1000),
        choices: alert.status === 'pending' ? alert.choices : undefined,
        suggestedActions: alert.status === 'pending'
          ? alert.choices.map(choice => `Respond with: ${choice}`)
          : undefined,
      }
    })

    const priorityRank: Record<RunEvent['priority'], number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    }

    return toEvent.sort((a, b) => {
      if (priorityRank[a.priority] !== priorityRank[b.priority]) {
        return priorityRank[a.priority] - priorityRank[b.priority]
      }
      return b.timestamp.getTime() - a.timestamp.getTime()
    })
  }, [alerts, runs, eventStatusOverrides])

  useEffect(() => {
    const syncWildMode = async () => {
      try {
        const state = await getWildMode()
        setChatMode(state.enabled ? 'wild' : 'agent')
      } catch (e) {
        console.error('Failed to sync wild mode:', e)
      }
    }
    syncWildMode()
  }, [])

  const pendingAlertsByRun = useMemo(() => {
    const counts: Record<string, number> = {}
    alerts.forEach((alert) => {
      if (alert.status === 'pending') {
        counts[alert.run_id] = (counts[alert.run_id] || 0) + 1
      }
    })
    return counts
  }, [alerts])

  useEffect(() => {
    const validIds = new Set(alerts.map(alert => `alert-${alert.id}`))
    setEventStatusOverrides(prev => {
      let changed = false
      const next: Record<string, EventStatus> = {}
      Object.entries(prev).forEach(([id, status]) => {
        if (validIds.has(id)) {
          next[id] = status
        } else {
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [alerts])

  const handleTabChange = useCallback((tab: HomeTab | 'contextual') => {
    if (tab === 'contextual') {
      router.push('/contextual')
      return
    }

    setActiveTab(tab)
    setSelectedRun(null)
    setShowVisibilityManage(false)

    const params = buildHomeSearchParams(tab, journeySubTab)
    const query = params.toString()
    router.replace(query ? `/?${query}` : '/', { scroll: false })
  }, [journeySubTab, router])

  useEffect(() => {
    if (activeTab !== 'journey') return
    const params = buildHomeSearchParams('journey', journeySubTab)
    const query = params.toString()
    router.replace(query ? `/?${query}` : '/', { scroll: false })
  }, [activeTab, journeySubTab, router])

  const handleRunClick = useCallback((_run: ExperimentRun) => {
    handleTabChange('runs')
  }, [handleTabChange])

  const handleNavigateToRun = useCallback((runId: string) => {
    const run = runs.find(r => r.id === runId)
    if (run) {
      handleTabChange('runs')
      setSelectedRun(run)
    }
  }, [runs, handleTabChange])

  const handleNavigateToEvents = useCallback(() => {
    handleTabChange('events')
  }, [handleTabChange])

  const handleUpdateEventStatus = useCallback(async (eventId: string, status: EventStatus) => {
    setEventStatusOverrides(prev => ({ ...prev, [eventId]: status }))

    if (status !== 'resolved') {
      return
    }

    const event = events.find(e => e.id === eventId)
    if (!event?.alertId || !event.choices || event.choices.length === 0) {
      return
    }

    const defaultChoice = event.choices.includes('Ignore')
      ? 'Ignore'
      : (event.choices.find(choice => {
          const normalized = choice.toLowerCase()
          return !normalized.includes('stop') && !normalized.includes('kill') && !normalized.includes('terminate')
        }) || event.choices[0])
    try {
      await respondAlert(event.alertId, defaultChoice)
    } catch (e) {
      console.error('Failed to resolve alert:', e)
    }
  }, [events, respondAlert])

  const handleRespondToAlert = useCallback(async (event: RunEvent, choice: string) => {
    if (!event.alertId) {
      return
    }
    try {
      await respondAlert(event.alertId, choice)
      setEventStatusOverrides(prev => ({ ...prev, [event.id]: 'resolved' }))
    } catch (e) {
      console.error('Failed to respond to alert:', e)
    }
  }, [respondAlert])

  const handleResolveByChat = useCallback(async (event: RunEvent) => {
    const alert = alerts.find(a => a.id === event.alertId)
    const run = runs.find(r => r.id === event.runId)
    const existingSessionId = alert?.session_id

    const sessionId = existingSessionId || await createNewSession()
    if (!sessionId) return

    await selectSession(sessionId)
    handleTabChange('chat')

    if (!existingSessionId) {
      const prompt = [
        `New alert detected. Please diagnose and suggest the safest next steps.`,
        ``,
        `Alert: @alert:${alert?.id || event.alertId}`,
        `Severity: ${alert?.severity || event.type}`,
        `Message: ${event.summary}`,
        `Run: ${run?.name || event.runName} (${event.runId})`,
        run?.command ? `Command: ${run.command}` : undefined,
        alert?.choices?.length ? `Allowed responses: ${alert.choices.join(', ')}` : undefined,
        ``,
        `Provide a short analysis, then recommend the best response from the allowed list.`,
      ].filter(Boolean).join('\n')
      await sendMessage(prompt, chatMode, sessionId)
    }
  }, [alerts, runs, createNewSession, selectSession, sendMessage, chatMode, handleTabChange])

  const handleUpdateRun = useCallback((updatedRun: ExperimentRun) => {
    apiUpdateRun(updatedRun)
    // Update selected run if it's the one being updated
    if (selectedRun?.id === updatedRun.id) {
      setSelectedRun(updatedRun)
    }
  }, [selectedRun, apiUpdateRun])

  const handleToggleRule = useCallback((ruleId: string) => {
    setMemoryRules(prev =>
      prev.map(rule =>
        rule.id === ruleId ? { ...rule, isActive: !rule.isActive } : rule
      )
    )
  }, [])

  const handleAddRule = useCallback(() => {
    const newRule: MemoryRule = {
      id: `rule-${Date.now()}`,
      title: 'New Rule',
      description: 'Enter a description for this heuristic...',
      createdAt: new Date(),
      source: 'user',
      isActive: true,
    }
    setMemoryRules(prev => [newRule, ...prev])
  }, [])

  const handleCreateTag = useCallback((tag: TagDefinition) => {
    setAllTags(prev => [...prev, tag])
  }, [])

  const handleToggleChartPin = useCallback((chartId: string) => {
    setInsightCharts(prev =>
      prev.map(chart =>
        chart.id === chartId ? { ...chart, isPinned: !chart.isPinned } : chart
      )
    )
  }, [])

  const handleToggleChartOverview = useCallback((chartId: string) => {
    setInsightCharts(prev =>
      prev.map(chart => {
        if (chart.id !== chartId) return chart
        const nextFavorite = !(chart.isInOverview || chart.isFavorite)
        return {
          ...chart,
          isFavorite: nextFavorite,
          isInOverview: nextFavorite,
        }
      })
    )
  }, [])

  const handleEditSweep = useCallback((config: SweepConfig) => {
    setEditingSweepConfig(config)
    setShowSweepForm(true)
  }, [])

  const handleSaveSweep = useCallback(async (config: SweepConfig) => {
    try {
      await saveDraftSweep(config)
      setShowSweepForm(false)
      setEditingSweepConfig(null)
    } catch (error) {
      console.error('Failed to save draft sweep:', error)
    }
  }, [saveDraftSweep])

  const handleCreateSweep = useCallback(async (config: SweepConfig) => {
    try {
      const draftSweep = await saveDraftSweep(config)
      setActiveTab('chat')
      setChatDraftInsert({
        id: Date.now(),
        text: `@sweep:${draftSweep.id} You goal is to improve this sweep before we launch it. Optimize search space, metrics, and stop conditions. Do not change the name of the sweep. Use the \`/sweeps\` endpoint to get and edit the sweep information and \`/runs\` endpoint to create runs. The server base url is ${apiUrl}. IMPORTANT: All API endpoints require authentication. You MUST include the header \`X-Auth-Token\` in every request. The token should be taken from environment variable \`RESEARCH_AGENT_USER_AUTH_TOKEN\`.`,
      })
      setShowSweepForm(false)
      setEditingSweepConfig(null)
    } catch (error) {
      console.error('Failed to create draft sweep:', error)
    }
  }, [saveDraftSweep])

  const handleLaunchSweep = useCallback(async (config: SweepConfig) => {
    try {
      await launchSweepFromConfig(config)
      await refetchRuns()
      setShowSweepForm(false)
      setEditingSweepConfig(null)
    } catch (error) {
      console.error('Failed to launch sweep:', error)
    }
  }, [launchSweepFromConfig, refetchRuns])

  const handleRefreshExperimentState = useCallback(async () => {
    await Promise.all([refetchRuns(), refetchSweeps(), refetchCluster()])
  }, [refetchRuns, refetchSweeps, refetchCluster])

  const handleChatModeChange = useCallback(async (mode: ChatMode) => {
    setChatMode(mode)
    try {
      await setWildMode(mode === 'wild')
    } catch (e) {
      console.error('Failed to update wild mode:', e)
    }
  }, [])

  const handleOpenSweepCreator = useCallback(() => {
    handleTabChange('chat')
    setEditingSweepConfig(null)
    setShowSweepForm(true)
  }, [handleTabChange])

  const handleInsertChatReference = useCallback((text: string) => {
    handleTabChange('chat')
    setChatDraftInsert({
      id: Date.now(),
      text,
    })
  }, [handleTabChange])

  const handleSidebarWidthChange = useCallback((nextWidth: number) => {
    pendingSidebarWidthRef.current = nextWidth
    if (sidebarRafRef.current != null) return

    sidebarRafRef.current = requestAnimationFrame(() => {
      sidebarRafRef.current = null
      if (pendingSidebarWidthRef.current == null) return
      setDesktopSidebarWidth(pendingSidebarWidthRef.current)
      pendingSidebarWidthRef.current = null
    })
  }, [])

  const handleSidebarResizeEnd = useCallback(() => {
    if (sidebarRafRef.current != null) {
      cancelAnimationFrame(sidebarRafRef.current)
      sidebarRafRef.current = null
    }
    if (pendingSidebarWidthRef.current != null) {
      setDesktopSidebarWidth(pendingSidebarWidthRef.current)
      sidebarWidthRef.current = pendingSidebarWidthRef.current
      pendingSidebarWidthRef.current = null
    }

    window.localStorage.setItem(STORAGE_KEY_DESKTOP_SIDEBAR_WIDTH, String(sidebarWidthRef.current))
  }, [])

  // Handle session change from FloatingNav
  const handleSessionChange = useCallback(async (sessionId: string) => {
    if (sessionId === 'new') {
      startNewChat()  // Just clear state, session created when message is sent
    } else {
      await selectSession(sessionId)
    }
  }, [startNewChat, selectSession])

  // Compute context token count from chat session messages
  const contextTokenCount = useMemo(() => {
    const { messages, streamingState } = chatSession
    const historyTokens = messages.reduce((acc, msg) => {
      const textLen = msg.content?.length || 0
      const thinkingLen = msg.thinking?.length || 0
      return acc + Math.ceil((textLen + thinkingLen) / 4)
    }, 0)

    if (streamingState.isStreaming) {
      const streamTextLen = streamingState.textContent.length
      const streamThinkLen = streamingState.thinkingContent.length
      return historyTokens + Math.ceil((streamTextLen + streamThinkLen) / 4)
    }
    return historyTokens
  }, [chatSession])

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main className="flex h-full w-full overflow-hidden bg-background">
        <DesktopSidebar
          activeTab={activeTab}
          hidden={desktopSidebarHidden}
          width={desktopSidebarWidth}
          minWidth={DESKTOP_SIDEBAR_MIN_WIDTH}
          maxWidth={DESKTOP_SIDEBAR_MAX_WIDTH}
          sessions={sessions}
          savedSessionIds={savedSessionIds}
          runs={runs}
          sweeps={sweeps}
          pendingAlertsByRun={pendingAlertsByRun}
          onTabChange={handleTabChange}
          onNewChat={() => {
            startNewChat()  // Just clear state, session created when message is sent
            handleTabChange('chat')
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
            handleTabChange('chat')
          }}
          onSaveSession={async (sessionId) => {
            await saveSession(sessionId)
          }}
          onUnsaveSession={async (sessionId) => {
            await unsaveSession(sessionId)
          }}
          onArchiveSession={async (sessionId) => {
            await archiveSession(sessionId)
          }}
          onNavigateToRun={handleNavigateToRun}
          onInsertReference={handleInsertChatReference}
          onSettingsClick={() => handleTabChange('settings')}
          onToggleCollapse={() => setDesktopSidebarHidden(true)}
          onWidthChange={handleSidebarWidthChange}
          onResizeEnd={handleSidebarResizeEnd}
        />

        <section className="mobile-viewport-wrapper flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <FloatingNav
            activeTab={activeTab}
            onMenuClick={() => setLeftPanelOpen(true)}
            showDesktopSidebarToggle={desktopSidebarHidden}
            onDesktopSidebarToggle={() => setDesktopSidebarHidden(false)}
            eventCount={events.filter(e => e.status === 'new').length}
            onAlertClick={handleNavigateToEvents}
            onCreateSweepClick={handleOpenSweepCreator}
            onOpenContextualClick={() => router.push('/contextual')}
            showArtifacts={showArtifacts}
            onToggleArtifacts={() => setShowArtifacts(prev => !prev)}
            collapseChats={collapseChats}
            onToggleCollapseChats={() => setCollapseChats(prev => !prev)}
            collapseArtifactsInChat={collapseArtifactsInChat}
            onToggleCollapseArtifactsInChat={() => setCollapseArtifactsInChat(prev => !prev)}
            sessionTitle={currentSession?.title || 'New Chat'}
            currentSessionId={currentSessionId}
            sessions={sessions}
            onSessionChange={handleSessionChange}
            contextTokenCount={contextTokenCount}
            reportIsPreviewMode={reportToolbar?.isPreviewMode ?? true}
            onReportPreviewModeChange={reportToolbar?.setPreviewMode}
            onReportAddCell={reportToolbar?.addCell}
          />

          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === 'chat' && (
              <ConnectedChatView
                runs={runs}
                sweeps={sweeps}
                charts={insightCharts}
                onRunClick={handleRunClick}
                onEditSweep={handleEditSweep}
                onLaunchSweep={handleLaunchSweep}
                mode={chatMode}
                onModeChange={handleChatModeChange}
                alerts={alerts}
                collapseArtifactsInChat={collapseArtifactsInChat}
                collapseChats={collapseChats}
                chatSession={chatSession}
                wildLoop={wildLoop}
                webNotificationsEnabled={settings.notifications.webNotificationsEnabled}
                onOpenSettings={() => handleTabChange('settings')}
                insertDraft={chatDraftInsert}
                skills={promptSkills}
              />
            )}
            {activeTab === 'runs' && (
              <RunsView
                runs={runs}
                sweeps={sweeps}
                onRunClick={handleRunClick}
                onUpdateRun={handleUpdateRun}
                pendingAlertsByRun={pendingAlertsByRun}
                alerts={alerts}
                allTags={allTags}
                onCreateTag={handleCreateTag}
                onSelectedRunChange={setSelectedRun}
                onShowVisibilityManageChange={setShowVisibilityManage}
                onRefresh={handleRefreshExperimentState}
                onStartRun={startExistingRun}
                onStopRun={stopExistingRun}
                onSaveSweep={handleSaveSweep}
                onCreateSweep={handleCreateSweep}
                onLaunchSweep={handleLaunchSweep}
                cluster={cluster}
                clusterRunSummary={clusterRunSummary}
                clusterLoading={clusterLoading}
                clusterError={clusterError}
                onDetectCluster={detectClusterSetup}
                onUpdateCluster={updateClusterSetup}
                onNavigateToCharts={() => handleTabChange('charts')}
                onRespondToAlert={async (alertId, choice) => { await respondAlert(alertId, choice) }}
              />
            )}
            {activeTab === 'events' && (
              <EventsView
                events={events}
                onNavigateToRun={handleNavigateToRun}
                onResolveByChat={handleResolveByChat}
                onUpdateEventStatus={handleUpdateEventStatus}
                onRespondToAlert={handleRespondToAlert}
              />
            )}
            {activeTab === 'charts' && (
              <ChartsView
                runs={runs}
                customCharts={insightCharts}
                onTogglePin={handleToggleChartPin}
                onToggleOverview={handleToggleChartOverview}
                onUpdateRun={handleUpdateRun}
                onShowVisibilityManageChange={setShowVisibilityManage}
              />
            )}
            {activeTab === 'memory' && (
              <InsightsView
                rules={memoryRules}
                onToggleRule={handleToggleRule}
                onAddRule={handleAddRule}
              />
            )}
            {activeTab === 'skills' && (
              <SkillsBrowserView />
            )}
            {activeTab === 'report' && (
              <ReportView runs={runs} onToolbarChange={setReportToolbar} />
            )}
            {activeTab === 'explorer' && (
              <FileExplorerView />
            )}
            {activeTab === 'journey' && (
              <JourneyView
                onBack={() => handleTabChange('chat')}
                subTab={journeySubTab}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsPageContent
                settings={settings}
                onSettingsChange={setSettings}
                focusAuthToken={focusAuthTokenInApp}
                onNavigateToJourney={(subTab) => {
                  setJourneySubTab(subTab)
                  handleTabChange('journey')
                }}
              />
            )}
          </div>

          <NavPage
            open={leftPanelOpen}
            onOpenChange={setLeftPanelOpen}
            onSettingsClick={() => handleTabChange('settings')}
            activeTab={activeTab}
            journeySubTab={journeySubTab}
            onTabChange={handleTabChange}
            onJourneySubTabChange={setJourneySubTab}
            onNewChat={() => {
              startNewChat()  // Just clear state, session created when message is sent
              handleTabChange('chat')
            }}
            sessions={sessions}
            onSelectSession={async (sessionId) => {
              await selectSession(sessionId)
              handleTabChange('chat')
            }}
          />
        </section>
      </main>

      <Dialog open={showSweepForm} onOpenChange={(open) => {
        if (!open) { setShowSweepForm(false); setEditingSweepConfig(null) }
      }}>
        <DialogContent showCloseButton={false} className="w-[95vw] h-[90vh] max-w-[900px] max-h-[800px] flex flex-col p-0 gap-0">
          <SweepForm
            initialConfig={editingSweepConfig || undefined}
            previousSweeps={sweeps}
            onSave={handleSaveSweep}
            onCreate={handleCreateSweep}
            onCancel={() => {
              setShowSweepForm(false)
              setEditingSweepConfig(null)
            }}
            onLaunch={handleLaunchSweep}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
