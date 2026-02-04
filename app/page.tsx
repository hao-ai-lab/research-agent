'use client'

import { useState, useCallback, useMemo } from 'react'
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
import type { ChatMode } from '@/components/chat-input'
import { mockMessages, generateLossData, mockMemoryRules, mockInsightCharts, defaultTags, getRunEvents, mockSweeps, createDefaultSweepConfig } from '@/lib/mock-data'
import type { ChatMessage, ExperimentRun, MemoryRule, InsightChart, AppSettings, TagDefinition, RunEvent, EventStatus, Sweep, SweepConfig } from '@/lib/types'
import { SweepForm } from '@/components/sweep-form'

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

type ActiveTab = 'chat' | 'runs' | 'charts' | 'insights' | 'events' | 'journey' | 'report'

const tabLabels: Record<ActiveTab, string> = {
  chat: 'Chat',
  runs: 'Runs',
  charts: 'Charts',
  insights: 'Insights',
  events: 'Events',
  journey: 'Journey',
  report: 'Report',
}

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
  const { runs, updateRun: apiUpdateRun, isLoading: runsLoading, error: runsError, refetch, startExistingRun, stopExistingRun } = useRuns()

  const [lossData] = useState(() => generateLossData())
  const [memoryRules, setMemoryRules] = useState<MemoryRule[]>(mockMemoryRules)
  const [insightCharts, setInsightCharts] = useState<InsightChart[]>(mockInsightCharts)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [chatMode, setChatMode] = useState<ChatMode>('wild')
  const [allTags, setAllTags] = useState<TagDefinition[]>(defaultTags)

  // State for breadcrumb navigation
  const [selectedRun, setSelectedRun] = useState<ExperimentRun | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)

  // Events state (will be updated when runs change)
  const [events, setEvents] = useState<RunEvent[]>([])

  // Sweeps state
  const [sweeps, setSweeps] = useState<Sweep[]>(mockSweeps)
  const [showSweepForm, setShowSweepForm] = useState(false)
  const [editingSweepConfig, setEditingSweepConfig] = useState<SweepConfig | null>(null)

  // Chat panel state
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [collapseChats, setCollapseChats] = useState(false)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)

  // Chat session hook for New Chat functionality
  const { createNewSession } = useChatSession()

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
    } else if (activeTab === 'insights') {
      items.push({ label: 'Insights' })
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
    setActiveTab('runs')
    setRunsSubTab('events')
  }, [])

  const handleDismissEvent = useCallback((eventId: string) => {
    setEvents(prev =>
      prev.map(e => e.id === eventId ? { ...e, status: 'dismissed' as EventStatus } : e)
    )
  }, [])

  const handleUpdateEventStatus = useCallback((eventId: string, status: EventStatus) => {
    setEvents(prev =>
      prev.map(e => e.id === eventId ? { ...e, status } : e)
    )
  }, [])

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
    // Regenerate events when runs change
    setEvents(getRunEvents(runs.map(r => r.id === updatedRun.id ? updatedRun : r)))
  }, [selectedRun, runs, apiUpdateRun])

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

  // Calculate scale for very small screens
  const MOBILE_WIDTH = 300
  const MOBILE_HEIGHT = 644

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main
        className="mobile-viewport-wrapper flex flex-col bg-background overflow-hidden w-full h-full md:w-full md:h-full"
        style={{
          minWidth: `${MOBILE_WIDTH}px`,
          minHeight: `${MOBILE_HEIGHT}px`,
        }}
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
          {activeTab === 'runs' && runsSubTab !== 'events' && (
            <RunsView
              runs={runs}
              subTab={runsSubTab}
              onRunClick={handleRunClick}
              onUpdateRun={handleUpdateRun}
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
          {activeTab === 'insights' && (
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
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onSettingsChange={setSettings}
          onNavigateToJourney={(subTab) => {
            setActiveTab('journey')
            setJourneySubTab(subTab)
          }}
        />
      </main>
    </div>
  )
}
