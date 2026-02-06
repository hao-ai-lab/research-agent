'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
import { FloatingNav } from '@/components/floating-nav'
import { NavPage, type RunsSubTab, type JourneySubTab } from '@/components/nav-page'
import { ConnectedChatView, useChatSession } from '@/components/connected-chat-view'
import { RunsView } from '@/components/runs-view'
import { ChartsView } from '@/components/charts-view'
import { InsightsView } from '@/components/insights-view'
import { EventsView } from '@/components/events-view'
import { JourneyView } from '@/components/journey-view'
import { ReportView } from '@/components/report-view'
import { SettingsDialog } from '@/components/settings-dialog'
import { useRuns } from '@/hooks/use-runs'
import { useAlerts } from '@/hooks/use-alerts'
import type { ChatMode } from '@/components/chat-input'
import { mockMemoryRules, mockInsightCharts, defaultTags, mockSweeps } from '@/lib/mock-data'
import type { ExperimentRun, MemoryRule, InsightChart, AppSettings, TagDefinition, RunEvent, EventStatus, Sweep, SweepConfig } from '@/lib/types'
import { SweepForm } from '@/components/sweep-form'
import { useApiConfig } from '@/lib/api-config'

const defaultSettings: AppSettings = {
  appearance: {
    theme: 'dark',
    fontSize: 'medium',
    buttonSize: 'default',
  },
  integrations: {},
  notifications: {
    alertsEnabled: true,
    alertTypes: ['error', 'warning', 'info'],
  },
}

type ActiveTab = 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report'

const runsSubTabLabels: Record<RunsSubTab, string> = {
  overview: 'Overview',
  details: 'Details',
  manage: 'Manage',
}

export default function ResearchChat() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')
  const [runsSubTab, setRunsSubTab] = useState<RunsSubTab>('overview')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Use real API data via useRuns hook
  const { runs, updateRun: apiUpdateRun, refetch, startExistingRun, stopExistingRun } = useRuns()
  const { alerts, respond: respondAlert } = useAlerts()

  const [memoryRules, setMemoryRules] = useState<MemoryRule[]>(mockMemoryRules)
  const [insightCharts, setInsightCharts] = useState<InsightChart[]>(mockInsightCharts)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [chatMode, setChatMode] = useState<ChatMode>('wild')
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

  // API configuration for auth/connection check
  const { useMock, authToken, testConnection } = useApiConfig()
  const [focusAuthToken, setFocusAuthToken] = useState(false)

  // Auto-open settings if auth token is missing or connection fails (when not in mock mode)
  useEffect(() => {
    if (useMock) return // Skip check in demo mode

    const checkConnection = async () => {
      // Check if auth token is missing
      if (!authToken) {
        setFocusAuthToken(true)
        setSettingsOpen(true)
        return
      }

      // Check if connection works
      const isConnected = await testConnection()
      if (!isConnected) {
        setSettingsOpen(true)
      }
    }

    checkConnection()
  }, [useMock, authToken, testConnection])

  // Chat session hook - single instance shared with ConnectedChatView
  const chatSession = useChatSession()
  const { createNewSession, sessions, selectSession } = chatSession

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
      // First level: Runs (clickable if we're deeper)
      if (selectedRun || showVisibilityManage) {
        items.push({
          label: 'Runs',
          onClick: () => {
            setSelectedRun(null)
            setShowVisibilityManage(false)
          }
        })
      } else {
        items.push({ label: 'Runs' })
      }

      // Second level: Sub-tab (clickable if we're deeper)
      if (selectedRun) {
        items.push({
          label: runsSubTabLabels[runsSubTab],
          onClick: () => setSelectedRun(null)
        })
        items.push({ label: selectedRun.alias || selectedRun.name })
      } else if (showVisibilityManage) {
        items.push({
          label: runsSubTabLabels[runsSubTab],
          onClick: () => setShowVisibilityManage(false)
        })
        items.push({ label: 'Visibility' })
      } else {
        items.push({ label: runsSubTabLabels[runsSubTab] })
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
      items.push({
        label: 'Settings',
        onClick: () => setSettingsOpen(true)
      })
      items.push({ label: journeySubTab === 'story' ? 'Journey Story' : 'Dev Notes' })
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

  const handleResolveByChat = useCallback((event: RunEvent) => {
    // Navigate to chat - user can type their own message about the event
    setActiveTab('chat')
  }, [])

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

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main
        className="mobile-viewport-wrapper flex flex-col bg-background overflow-hidden w-full h-full"
      >
        <FloatingNav
          activeTab={activeTab}
          runsSubTab={runsSubTab}
          onMenuClick={() => setLeftPanelOpen(true)}
          breadcrumbs={breadcrumbs}
          eventCount={events.filter(e => e.status === 'new').length}
          onAlertClick={handleNavigateToEvents}
          showArtifacts={showArtifacts}
          onToggleArtifacts={() => setShowArtifacts(prev => !prev)}
          collapseChats={collapseChats}
          onToggleCollapseChats={() => setCollapseChats(prev => !prev)}
          collapseArtifactsInChat={collapseArtifactsInChat}
          onToggleCollapseArtifactsInChat={() => setCollapseArtifactsInChat(prev => !prev)}
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
              onModeChange={setChatMode}
              collapseArtifactsInChat={collapseArtifactsInChat}
              chatSession={chatSession}
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
            <ReportView runs={runs} />
          )}
          {activeTab === 'journey' && (
            <JourneyView
              onBack={() => setActiveTab('chat')}
              subTab={journeySubTab}
            />
          )}
        </div>

        <NavPage
          open={leftPanelOpen}
          onOpenChange={setLeftPanelOpen}
          onSettingsClick={() => setSettingsOpen(true)}
          activeTab={activeTab}
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

        {/* Hidden trigger for programmatic settings access */}
        <button
          type="button"
          data-settings-trigger
          onClick={() => setSettingsOpen(true)}
          className="hidden"
          aria-hidden="true"
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open) setFocusAuthToken(false)
          }}
          settings={settings}
          onSettingsChange={setSettings}
          onNavigateToJourney={(subTab) => {
            setActiveTab('journey')
            setJourneySubTab(subTab)
          }}
          focusAuthToken={focusAuthToken}
          onRefresh={refetch}
        />
      </main>
    </div>
  )
}
