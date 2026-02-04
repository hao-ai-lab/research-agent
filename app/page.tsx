'use client'

import { useState, useCallback, useMemo } from 'react'
import { FloatingNav } from '@/components/floating-nav'
import { NavPage, type RunsSubTab, type JourneySubTab } from '@/components/nav-page'
import { ChatView } from '@/components/chat-view'
import { RunsView } from '@/components/runs-view'
import { ChartsView } from '@/components/charts-view'
import { InsightsView } from '@/components/insights-view'
import { EventsView } from '@/components/events-view'
import { JourneyView } from '@/components/journey-view'
import { ReportView } from '@/components/report-view'
import { SettingsDialog } from '@/components/settings-dialog'
import type { ChatMode } from '@/components/chat-input'
import { mockRuns, mockMessages, generateLossData, mockMemoryRules, mockInsightCharts, defaultTags, getRunEvents, mockSweeps, createDefaultSweepConfig } from '@/lib/mock-data'
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

  // Sweeps state
  const [sweeps, setSweeps] = useState<Sweep[]>(mockSweeps)
  const [showSweepForm, setShowSweepForm] = useState(false)
  const [editingSweepConfig, setEditingSweepConfig] = useState<SweepConfig | null>(null)

  // Chat panel state
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [collapseChats, setCollapseChats] = useState(false)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)

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
      items.push({ label: 'Our Journey' })
    }
    
    return items
  }, [activeTab, runsSubTab, selectedRun, showVisibilityManage])

  const handleSendMessage = useCallback(
    (content: string, attachments?: File[], mode?: ChatMode) => {
      const currentMode = mode || chatMode
      const modePrefix = currentMode === 'wild' ? '[Wild Mode] ' : currentMode === 'debug' ? '[Debug Mode] ' : '[Sweep Mode] '
      
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
        // Handle sweep mode - generate a sweep config based on user input
        if (currentMode === 'sweep') {
          const generatedConfig: SweepConfig = {
            ...createDefaultSweepConfig(),
            id: `sweep-config-${Date.now()}`,
            name: content.includes('learning rate') ? 'Learning Rate Sweep' : 
                  content.includes('batch') ? 'Batch Size Sweep' : 
                  'Hyperparameter Sweep',
            description: `Generated from: "${content}"`,
            goal: content,
            command: 'python train.py --lr {learning_rate} --batch-size {batch_size} --epochs {epochs}',
            hyperparameters: [
              { name: 'learning_rate', type: 'range', min: 0.00001, max: 0.001, step: 0.0001 },
              { name: 'batch_size', type: 'choice', values: [8, 16, 32, 64] },
              { name: 'epochs', type: 'fixed', fixedValue: 25 },
            ],
            metrics: [
              { name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true },
              { name: 'Training Loss', path: 'train/loss', goal: 'minimize', isPrimary: false },
            ],
            insights: [
              { id: 'i1', type: 'failure', condition: 'loss > 10 or NaN', description: 'Training diverged' },
              { id: 'i2', type: 'suspicious', condition: 'val_loss increases for 3 epochs', description: 'Possible overfitting' },
            ],
          }

          const aiMessage: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `${modePrefix}I've analyzed your request and generated a sweep configuration.\n\n**Goal:** ${content}\n\nI've set up a sweep with the following:\n- **3 hyperparameters** to explore (learning rate, batch size, epochs)\n- **2 metrics** to track (validation and training loss)\n- **2 insight rules** to detect failures and overfitting\n\nYou can review and edit the configuration below, then launch the sweep when ready.`,
            thinking: `${modePrefix}Processing sweep request...\n\nAnalyzing user intent:\n- User wants to explore: "${content}"\n- Generating appropriate hyperparameter ranges\n- Setting up metrics and insight detection\n\nCreating sweep configuration...`,
            timestamp: new Date(),
            sweepConfig: generatedConfig,
          }
          setMessages((prev) => [...prev, aiMessage])
        } else {
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
        }
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
    // Add a message confirming the save
    const saveMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'assistant',
      content: `[Sweep Mode] Sweep configuration "${config.name}" has been saved as a draft. You can launch it anytime from the chat or by using the launch button.`,
      timestamp: new Date(),
      sweepConfig: config,
    }
    setMessages(prev => [...prev, saveMessage])
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
    
    // Add a message confirming the launch
    const launchMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'assistant',
      content: `[Sweep Mode] Launching sweep "${config.name}"!\n\n**Configuration:**\n- Max runs: ${config.maxRuns || 10}\n- Parallel runs: ${config.parallelRuns || 2}\n- Primary metric: ${config.metrics.find(m => m.isPrimary)?.name || 'N/A'}\n\nThe sweep is now running. You can track its progress below.`,
      timestamp: new Date(),
      sweepConfig: config,
      sweepId: newSweep.id,
    }
    setMessages(prev => [...prev, launchMessage])
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
          <ChatView
            messages={messages}
            runs={runs}
            sweeps={sweeps}
            charts={insightCharts}
            onSendMessage={handleSendMessage}
            onRunClick={handleRunClick}
            onEditSweep={handleEditSweep}
            onLaunchSweep={handleLaunchSweep}
            mode={chatMode}
            onModeChange={setChatMode}
            showArtifacts={showArtifacts}
            collapseChats={collapseChats}
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
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </main>
    </div>
  )
}
