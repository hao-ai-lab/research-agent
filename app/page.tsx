'use client'

import { useState, useCallback, useMemo } from 'react'
import { FloatingNav } from '@/components/floating-nav'
import { LeftPanel, type RunsSubTab } from '@/components/left-panel'
import { ChatView } from '@/components/chat-view'
import { RunsView } from '@/components/runs-view'
import { ChartsView } from '@/components/charts-view'
import { InsightsView } from '@/components/insights-view'
import { EventsView } from '@/components/events-view'
import { JourneyView } from '@/components/journey-view'
import { SettingsDialog } from '@/components/settings-dialog'
import type { ChatMode } from '@/components/chat-input'
import { mockRuns, mockMessages, generateLossData, mockMemoryRules, mockInsightCharts, defaultTags, getRunEvents } from '@/lib/mock-data'
import type { ChatMessage, ExperimentRun, MemoryRule, InsightChart, AppSettings, TagDefinition, RunEvent, EventStatus } from '@/lib/types'

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

type ActiveTab = 'chat' | 'runs' | 'charts' | 'insights' | 'journey'

const tabLabels: Record<ActiveTab, string> = {
  chat: 'Chat',
  runs: 'Runs',
  charts: 'Charts',
  insights: 'Insights',
  journey: 'Journey',
}

const runsSubTabLabels: Record<RunsSubTab, string> = {
  overview: 'Overview',
  details: 'Details',
  manage: 'Manage',
  events: 'Events',
}

export default function ResearchChat() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')
  const [runsSubTab, setRunsSubTab] = useState<RunsSubTab>('overview')
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages)
  const [runs, setRuns] = useState<ExperimentRun[]>(mockRuns)
  const [lossData] = useState(() => generateLossData())
  const [memoryRules, setMemoryRules] = useState<MemoryRule[]>(mockMemoryRules)
  const [insightCharts, setInsightCharts] = useState<InsightChart[]>(mockInsightCharts)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [chatMode, setChatMode] = useState<ChatMode>('wild')
  const [allTags, setAllTags] = useState<TagDefinition[]>(defaultTags)
  
  // State for breadcrumb navigation
  const [selectedRun, setSelectedRun] = useState<ExperimentRun | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)
  
  // Events state
  const [events, setEvents] = useState<RunEvent[]>(() => getRunEvents(mockRuns))

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
    } else if (activeTab === 'insights') {
      items.push({ label: 'Insights' })
    } else if (activeTab === 'journey') {
      items.push({ label: 'Our Journey' })
    }
    
    return items
  }, [activeTab, runsSubTab, selectedRun, showVisibilityManage])

  const handleSendMessage = useCallback(
    (content: string, attachments?: File[], mode?: ChatMode) => {
      const currentMode = mode || chatMode
      const modePrefix = currentMode === 'wild' ? '[Wild Mode] ' : '[Debug Mode] '
      
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: content,
        timestamp: new Date(),
        attachments: attachments?.map((f) => ({
          name: f.name,
          type: f.type,
          url: URL.createObjectURL(f),
        })),
      }
      setMessages((prev) => [...prev, userMessage])

      setTimeout(() => {
        const aiMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: currentMode === 'wild'
            ? `${modePrefix}I've received your message: "${content}"\n\nRunning in Wild Mode - I'll autonomously explore the parameter space and launch experiments to optimize your model. Based on your current runs, I'm initiating a hyperparameter sweep for learning rates between 1e-5 and 5e-4.\n\n**Automated Actions:**\n- Queued 5 new training runs\n- Set up early stopping at epoch 20\n- Configured loss monitoring\n\nI'll notify you when significant improvements are found.`
            : `${modePrefix}I've received your message: "${content}"\n\nRunning in Debug Mode - I'll provide detailed analysis before any actions. Your active runs show promising results with the GPT-4 fine-tuning achieving a loss of 0.234 at epoch 15.\n\n**Analysis:**\n- Training is progressing smoothly\n- No signs of overfitting detected\n- GPU utilization is optimal\n\n**Would you like me to:**\n1. Launch a comparative experiment?\n2. Adjust hyperparameters?\n3. Export current metrics?`,
          thinking: `${modePrefix}Processing user query...\n\nAnalyzing context:\n- User has ${runs.length} experiments\n- ${runs.filter((r) => r.status === 'running').length} currently running\n- Mode: ${currentMode}\n\nFormulating response based on mode and available data...`,
          timestamp: new Date(),
        }
        setMessages((prev) => [...prev, aiMessage])
      }, 1000)
    },
    [runs, chatMode]
  )

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
    // Navigate to chat and send a message about the event
    setActiveTab('chat')
    const message = `Help me resolve this ${event.type}: "${event.summary}" from run "${event.runAlias || event.runName}"`
    handleSendMessage(message)
  }, [handleSendMessage])

  const handleUpdateRun = useCallback((updatedRun: ExperimentRun) => {
    setRuns((prev) =>
      prev.map((run) => (run.id === updatedRun.id ? updatedRun : run))
    )
    // Update selected run if it's the one being updated
    if (selectedRun?.id === updatedRun.id) {
      setSelectedRun(updatedRun)
    }
    // Regenerate events when runs change
    setEvents(getRunEvents(runs.map(r => r.id === updatedRun.id ? updatedRun : r)))
  }, [selectedRun, runs])

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
    <main className="flex h-dvh flex-col bg-background overflow-hidden">
      <FloatingNav
        activeTab={activeTab}
        runsSubTab={runsSubTab}
        onMenuClick={() => setLeftPanelOpen(true)}
        breadcrumbs={breadcrumbs}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'chat' && (
          <ChatView
            messages={messages}
            runs={runs}
            events={events}
            lossData={lossData}
            onSendMessage={handleSendMessage}
            onRunClick={handleRunClick}
            onNavigateToRun={handleNavigateToRun}
            onNavigateToEvents={handleNavigateToEvents}
            onDismissEvent={handleDismissEvent}
            mode={chatMode}
            onModeChange={setChatMode}
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
          />
        )}
        {activeTab === 'runs' && runsSubTab === 'events' && (
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
        {activeTab === 'journey' && (
          <JourneyView
            onBack={() => setActiveTab('chat')}
          />
        )}
      </div>

      <LeftPanel 
        open={leftPanelOpen} 
        onOpenChange={setLeftPanelOpen}
        onSettingsClick={() => setSettingsOpen(true)}
        activeTab={activeTab}
        runsSubTab={runsSubTab}
        onTabChange={handleTabChange}
        onRunsSubTabChange={handleRunsSubTabChange}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </main>
  )
}
