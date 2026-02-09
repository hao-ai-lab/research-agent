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
import { SettingsPageContent } from '@/components/settings-page-content'
import { DesktopSidebar } from '@/components/desktop-sidebar'
import { useRuns } from '@/hooks/use-runs'
import { useAlerts } from '@/hooks/use-alerts'
import type { ChatMode } from '@/components/chat-input'
import { mockMemoryRules, mockInsightCharts, defaultTags, mockSweeps } from '@/lib/mock-data'
import type { ExperimentRun, MemoryRule, InsightChart, TagDefinition, RunEvent, EventStatus, Sweep, SweepConfig } from '@/lib/types'
import { SweepForm } from '@/components/sweep-form'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import { useApiConfig } from '@/lib/api-config'
import { getWildMode, setWildMode } from '@/lib/api-client'
import { useWildLoop } from '@/hooks/use-wild-loop'
import { useAppSettings } from '@/lib/app-settings'
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
  const { runs, updateRun: apiUpdateRun, refetch, startExistingRun, stopExistingRun } = useRuns()
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
  const [sweeps, setSweeps] = useState<Sweep[]>(mockSweeps)
  const [showSweepForm, setShowSweepForm] = useState(false)
  const [editingSweepConfig, setEditingSweepConfig] = useState<SweepConfig | null>(null)

  // Chat panel state
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [collapseChats, setCollapseChats] = useState(false)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)
  const [chatDraftInsert, setChatDraftInsert] = useState<{ id: number; text: string } | null>(null)
  const [focusAuthTokenInApp, setFocusAuthTokenInApp] = useState(false)

  // API configuration for auth/connection check
  const { useMock, authToken, testConnection } = useApiConfig()

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(STORAGE_KEY_DESKTOP_SIDEBAR_WIDTH)
    if (!storedWidth) return
    const parsed = Number(storedWidth)
    if (!Number.isFinite(parsed)) return
    setDesktopSidebarWidth(
      Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, parsed))
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
  const { createNewSession, sessions, selectSession, archiveSession } = chatSession
  const { sendMessage } = chatSession

  // Wild loop hook
  const wildLoop = useWildLoop()

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
      prev.map(chart =>
        chart.id === chartId ? { ...chart, isInOverview: !chart.isInOverview } : chart
      )
    )
  }, [])

  // Sweep handlers
  const upsertSweepFromConfig = useCallback((config: SweepConfig, status: 'draft' | 'running') => {
    const now = new Date()
    const existingSweep = sweeps.find((sweep) => sweep.config.id === config.id)
    const normalizedConfig: SweepConfig = {
      ...config,
      createdAt: existingSweep?.config.createdAt || config.createdAt || now,
      updatedAt: now,
    }
    const sweepId = existingSweep?.id || `sweep-${Date.now()}`
    const createdAt = existingSweep?.createdAt || now

    const nextSweep: Sweep =
      status === 'draft'
        ? {
            id: sweepId,
            config: normalizedConfig,
            status: 'draft',
            runIds: [],
            createdAt,
            progress: {
              completed: 0,
              total: normalizedConfig.maxRuns || 0,
              failed: 0,
              running: 0,
            },
          }
        : {
            id: sweepId,
            config: normalizedConfig,
            status: 'running',
            runIds: existingSweep?.runIds || [],
            startedAt: now,
            createdAt,
            progress: {
              completed: 0,
              total: normalizedConfig.maxRuns || 10,
              failed: 0,
              running: Math.min(
                normalizedConfig.parallelRuns || 2,
                normalizedConfig.maxRuns || 10,
              ),
            },
          }

    setSweeps((prev) => {
      if (existingSweep) {
        return prev.map((sweep) => (sweep.id === existingSweep.id ? nextSweep : sweep))
      }
      return [nextSweep, ...prev]
    })

    return nextSweep
  }, [sweeps])

  const handleEditSweep = useCallback((config: SweepConfig) => {
    setEditingSweepConfig(config)
    setShowSweepForm(true)
  }, [])

  const handleSaveSweep = useCallback((config: SweepConfig) => {
    upsertSweepFromConfig(config, 'draft')
    setShowSweepForm(false)
    setEditingSweepConfig(null)
  }, [upsertSweepFromConfig])

  const handleCreateSweep = useCallback((config: SweepConfig) => {
    const draftSweep = upsertSweepFromConfig(config, 'draft')
    setActiveTab('chat')
    setChatDraftInsert({
      id: Date.now(),
      text: `@sweep:${draftSweep.id} Improve this sweep before launch. Optimize search space, metrics, and stop conditions.`,
    })
    setShowSweepForm(false)
    setEditingSweepConfig(null)
  }, [upsertSweepFromConfig])

  const handleLaunchSweep = useCallback((config: SweepConfig) => {
    upsertSweepFromConfig(config, 'running')
    setShowSweepForm(false)
    setEditingSweepConfig(null)
  }, [upsertSweepFromConfig])

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
          runs={runs}
          sweeps={sweeps}
          pendingAlertsByRun={pendingAlertsByRun}
          onTabChange={handleTabChange}
          onNewChat={async () => {
            await createNewSession()
            handleTabChange('chat')
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
            handleTabChange('chat')
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
                onRefresh={refetch}
                onStartRun={startExistingRun}
                onStopRun={stopExistingRun}
                onSaveSweep={handleSaveSweep}
                onCreateSweep={handleCreateSweep}
                onLaunchSweep={handleLaunchSweep}
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
            {activeTab === 'report' && (
              <ReportView runs={runs} onToolbarChange={setReportToolbar} />
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
            onNewChat={async () => {
              await createNewSession()
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
