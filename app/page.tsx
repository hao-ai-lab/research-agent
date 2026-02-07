'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { FloatingNav } from '@/components/floating-nav'
import { NavPage, type RunsSubTab, type JourneySubTab } from '@/components/nav-page'
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
import { useApiConfig } from '@/lib/api-config'
import { getWildMode, setWildMode } from '@/lib/api-client'
import { useWildLoop } from '@/hooks/use-wild-loop'
import { useAppSettings } from '@/lib/app-settings'

type ActiveTab = 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report' | 'settings'
const DESKTOP_SIDEBAR_MIN_WIDTH = 240
const DESKTOP_SIDEBAR_MAX_WIDTH = 520
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 300

export default function ResearchChat() {
  const searchParams = useSearchParams()
  const { settings, setSettings } = useAppSettings()
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')
  const [runsSubTab, setRunsSubTab] = useState<RunsSubTab>('overview')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false)
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

  // State for breadcrumb navigation
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
    const storedWidth = window.localStorage.getItem('desktopSidebarWidth')
    if (!storedWidth) return
    const parsed = Number(storedWidth)
    if (!Number.isFinite(parsed)) return
    setDesktopSidebarWidth(
      Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, parsed))
    )
  }, [])

  useEffect(() => {
    sidebarWidthRef.current = desktopSidebarWidth
  }, [desktopSidebarWidth])

  useEffect(() => {
    return () => {
      if (sidebarRafRef.current != null) {
        cancelAnimationFrame(sidebarRafRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const tab = searchParams.get('tab')
    const journeySubTabParam = searchParams.get('journeySubTab')

    if (tab === 'journey') {
      setActiveTab('journey')
    }
    if (tab === 'settings') {
      setActiveTab('settings')
    }
    if (journeySubTabParam === 'story' || journeySubTabParam === 'devnotes') {
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
        setFocusAuthTokenInApp(true)
        return
      }

      // Check if connection works
      const isConnected = await testConnection()
      if (!isConnected) {
        setActiveTab('settings')
        setFocusAuthTokenInApp(false)
      } else {
        setFocusAuthTokenInApp(false)
      }
    }

    checkConnection()
  }, [useMock, authToken, testConnection])

  // Chat session hook - single instance shared with ConnectedChatView
  const chatSession = useChatSession()
  const { createNewSession, sessions, selectSession } = chatSession
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

  // Build breadcrumbs based on current state
  const breadcrumbs = useMemo(() => {
    const items: { label: string; onClick?: () => void }[] = []

    if (activeTab === 'chat') {
      items.push({ label: 'Chat' })
    } else if (activeTab === 'runs') {
      const baseRunsLabel = runsSubTab === 'overview' ? 'Overview' : 'Runs'

      // Base level (clickable if we're deeper)
      if (selectedRun || showVisibilityManage) {
        items.push({
          label: baseRunsLabel,
          onClick: () => {
            setSelectedRun(null)
            setShowVisibilityManage(false)
          }
        })
      } else {
        items.push({ label: baseRunsLabel })
      }

      // Details beyond base level
      if (selectedRun) {
        items.push({ label: selectedRun.alias || selectedRun.name })
      } else if (showVisibilityManage) {
        items.push({ label: 'Visibility' })
      }
    } else if (activeTab === 'charts') {
      if (showVisibilityManage) {
        items.push({
          label: 'Charts',
          onClick: () => setShowVisibilityManage(false)
        })
        items.push({ label: 'Visibility' })
      } else {
        items.push({ label: 'Charts' })
      }
    } else if (activeTab === 'events') {
      items.push({ label: 'Events' })
    } else if (activeTab === 'memory') {
      items.push({ label: 'Memory' })
    } else if (activeTab === 'report') {
      items.push({ label: 'Report' })
    } else if (activeTab === 'journey') {
      items.push({ label: 'Journey' })
      items.push({ label: journeySubTab === 'story' ? 'Journey Story' : 'Dev Notes' })
    } else if (activeTab === 'settings') {
      items.push({ label: 'Settings' })
    }

    return items
  }, [activeTab, runsSubTab, selectedRun, showVisibilityManage, journeySubTab])

  const handleRunClick = useCallback((run: ExperimentRun) => {
    setActiveTab('runs')
    setRunsSubTab('overview')
  }, [])

  const handleNavigateToRun = useCallback((runId: string) => {
    const run = runs.find(r => r.id === runId)
    if (run) {
      setActiveTab('runs')
      setRunsSubTab('details')
      setSelectedRun(run)
    }
  }, [runs])

  const handleNavigateToEvents = useCallback(() => {
    setActiveTab('events')
  }, [])

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
    setActiveTab('chat')

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
  }, [alerts, runs, createNewSession, selectSession, sendMessage, chatMode])

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
  const handleEditSweep = useCallback((config: SweepConfig) => {
    setEditingSweepConfig(config)
    setShowSweepForm(true)
  }, [])

  const handleSaveSweep = useCallback((config: SweepConfig) => {
    // Check if this is an edit or new sweep
    const existingSweepIndex = sweeps.findIndex(s => s.config.id === config.id)
    if (existingSweepIndex >= 0) {
      // Update existing sweep's config
      setSweeps(prev => prev.map(s =>
        s.config.id === config.id
          ? { ...s, config: { ...config, updatedAt: new Date() } }
          : s
      ))
    }
    // Sweep saved - would normally trigger a toast notification
    // Messages are now handled by the backend
    setShowSweepForm(false)
    setEditingSweepConfig(null)
  }, [sweeps])

  const handleLaunchSweep = useCallback((config: SweepConfig) => {
    // Create a new sweep from the config
    const newSweep: Sweep = {
      id: `sweep-${Date.now()}`,
      config,
      status: 'running',
      runIds: [], // Will be populated as runs are created
      startedAt: new Date(),
      createdAt: new Date(),
      progress: {
        completed: 0,
        total: config.maxRuns || 10,
        failed: 0,
        running: Math.min(config.parallelRuns || 2, config.maxRuns || 10),
      },
    }
    setSweeps(prev => [...prev, newSweep])

    // Sweep launched - would normally trigger a toast notification
    // Messages are now handled by the backend
    setShowSweepForm(false)
    setEditingSweepConfig(null)
  }, [])

  // Clear run selection when changing tabs
  const handleTabChange = useCallback((tab: ActiveTab) => {
    setActiveTab(tab)
    setSelectedRun(null)
    setShowVisibilityManage(false)
  }, [])

  const handleRunsSubTabChange = useCallback((subTab: RunsSubTab) => {
    setRunsSubTab(subTab)
    setSelectedRun(null)
    setShowVisibilityManage(false)
  }, [])

  const handleChatModeChange = useCallback(async (mode: ChatMode) => {
    setChatMode(mode)
    try {
      await setWildMode(mode === 'wild')
    } catch (e) {
      console.error('Failed to update wild mode:', e)
    }
  }, [])

  const handleOpenSweepCreator = useCallback(() => {
    setActiveTab('chat')
    setEditingSweepConfig(null)
    setShowSweepForm(true)
  }, [])

  const handleInsertChatReference = useCallback((text: string) => {
    setActiveTab('chat')
    setChatDraftInsert({
      id: Date.now(),
      text,
    })
  }, [])

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

    window.localStorage.setItem('desktopSidebarWidth', String(sidebarWidthRef.current))
  }, [])

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main className="flex h-full w-full overflow-hidden bg-background">
        <DesktopSidebar
          activeTab={activeTab}
          collapsed={desktopSidebarCollapsed}
          width={desktopSidebarWidth}
          minWidth={DESKTOP_SIDEBAR_MIN_WIDTH}
          maxWidth={DESKTOP_SIDEBAR_MAX_WIDTH}
          runsSubTab={runsSubTab}
          journeySubTab={journeySubTab}
          sessions={sessions}
          runs={runs}
          sweeps={sweeps}
          onTabChange={handleTabChange}
          onRunsSubTabChange={handleRunsSubTabChange}
          onJourneySubTabChange={setJourneySubTab}
          onNewChat={async () => {
            await createNewSession()
            setActiveTab('chat')
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
            setActiveTab('chat')
          }}
          onNavigateToRun={handleNavigateToRun}
          onInsertReference={handleInsertChatReference}
          onSettingsClick={() => setActiveTab('settings')}
          onToggleCollapse={() => setDesktopSidebarCollapsed((prev) => !prev)}
          onWidthChange={handleSidebarWidthChange}
          onResizeEnd={handleSidebarResizeEnd}
        />

        <section className="mobile-viewport-wrapper flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <FloatingNav
            activeTab={activeTab}
            runsSubTab={runsSubTab}
            onMenuClick={() => setLeftPanelOpen(true)}
            breadcrumbs={breadcrumbs}
            eventCount={events.filter(e => e.status === 'new').length}
            onAlertClick={handleNavigateToEvents}
            onCreateSweepClick={handleOpenSweepCreator}
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
            {activeTab === 'chat' && !showSweepForm && (
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
                chatSession={chatSession}
                wildLoop={wildLoop}
                webNotificationsEnabled={settings.notifications.webNotificationsEnabled}
                onOpenSettings={() => setActiveTab('settings')}
                insertDraft={chatDraftInsert}
              />
            )}
            {activeTab === 'chat' && showSweepForm && (
              <SweepForm
                initialConfig={editingSweepConfig || undefined}
                onSave={handleSaveSweep}
                onCancel={() => {
                  setShowSweepForm(false)
                  setEditingSweepConfig(null)
                }}
                onLaunch={handleLaunchSweep}
              />
            )}
            {activeTab === 'runs' && (
              <RunsView
                runs={runs}
                subTab={runsSubTab}
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
                onBack={() => setActiveTab('chat')}
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
                  setActiveTab('journey')
                }}
              />
            )}
          </div>

          <NavPage
            open={leftPanelOpen}
            onOpenChange={setLeftPanelOpen}
            onSettingsClick={() => setActiveTab('settings')}
            activeTab={activeTab === 'settings' ? 'chat' : activeTab}
            runsSubTab={runsSubTab}
            journeySubTab={journeySubTab}
            onTabChange={handleTabChange}
            onRunsSubTabChange={handleRunsSubTabChange}
            onJourneySubTabChange={setJourneySubTab}
            onNewChat={async () => {
              await createNewSession()
              setActiveTab('chat')
            }}
            sessions={sessions}
            onSelectSession={async (sessionId) => {
              await selectSession(sessionId)
              setActiveTab('chat')
            }}
          />
        </section>
      </main>
    </div>
  )
}
