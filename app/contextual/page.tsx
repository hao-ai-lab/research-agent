'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Bell,
  Clock3,
  Cpu,
  LayoutGrid,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Rows3,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DesktopSidebar } from '@/components/desktop-sidebar'
import { NavPage } from '@/components/nav-page'
import { ConnectedChatView, useChatSession } from '@/components/connected-chat-view'
import { ContextualOperationsPanel } from '@/components/contextual-operations-panel'
import { ContextualContextCanvas } from '@/components/contextual-context-canvas'
import { useRuns } from '@/hooks/use-runs'
import { useAlerts } from '@/hooks/use-alerts'
import { listSweeps, type Sweep as ApiSweep } from '@/lib/api-client'
import { buildHomeHref, type HomeTab, type JourneySubTab } from '@/lib/navigation'
import { extractContextReferences } from '@/lib/contextual-chat'
import type { ChatMode } from '@/components/chat-input'
import type { Sweep as UiSweep, SweepStatus } from '@/lib/types'

const DESKTOP_SIDEBAR_MIN_WIDTH = 72
const DESKTOP_SIDEBAR_MAX_WIDTH = 520
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 300

function mapApiSweepStatusToUi(status: ApiSweep['status']): SweepStatus {
  if (status === 'ready') return 'pending'
  return status
}

function toChoiceValues(values: unknown[]): Array<string | number> {
  return values.filter((value): value is string | number => {
    return typeof value === 'string' || typeof value === 'number'
  })
}

function mapApiSweepToUiSweep(sweep: ApiSweep): UiSweep {
  const createdAt = new Date(sweep.created_at * 1000)
  return {
    id: sweep.id,
    config: {
      id: sweep.id,
      name: sweep.name,
      description: sweep.goal || '',
      goal: sweep.goal || '',
      command: sweep.base_command,
      hyperparameters: Object.entries(sweep.parameters || {}).map(([name, values]) => ({
        name,
        type: 'choice' as const,
        values: Array.isArray(values) ? toChoiceValues(values) : [],
      })),
      metrics: [],
      insights: [],
      maxRuns: sweep.progress.total,
      parallelRuns: Math.max(1, sweep.progress.running),
      earlyStoppingEnabled: false,
      earlyStoppingPatience: 3,
      createdAt,
      updatedAt: createdAt,
    },
    status: mapApiSweepStatusToUi(sweep.status),
    runIds: sweep.run_ids,
    createdAt,
    startedAt: sweep.status === 'running' ? createdAt : undefined,
    progress: {
      completed: sweep.progress.completed,
      total: sweep.progress.total,
      failed: sweep.progress.failed,
      running: sweep.progress.running,
    },
  }
}

export default function ContextualChatPage() {
  const router = useRouter()
  const { runs } = useRuns()
  const { alerts } = useAlerts()
  const chatSession = useChatSession()
  const { sessions, messages, createNewSession, selectSession, archiveSession } = chatSession

  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false)
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  const [sweeps, setSweeps] = useState<ApiSweep[]>([])
  const [collapseChats, setCollapseChats] = useState(true)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)
  const [showOpsPanel, setShowOpsPanel] = useState(true)
  const [showContextPanel, setShowContextPanel] = useState(true)
  const [chatDraftInsert, setChatDraftInsert] = useState<{ id: number; text: string } | null>(null)

  const fetchSweeps = useCallback(async () => {
    try {
      const next = await listSweeps()
      setSweeps(next)
    } catch (error) {
      console.error('Failed to fetch sweeps:', error)
    }
  }, [])

  useEffect(() => {
    fetchSweeps()
    const intervalId = window.setInterval(fetchSweeps, 5000)
    return () => window.clearInterval(intervalId)
  }, [fetchSweeps])

  const uiSweeps = useMemo(() => sweeps.map(mapApiSweepToUiSweep), [sweeps])

  const contextReferences = useMemo(
    () => extractContextReferences(messages, runs, uiSweeps, alerts),
    [messages, runs, uiSweeps, alerts]
  )

  const insertPrompt = useCallback((prompt: string) => {
    setChatDraftInsert({
      id: Date.now(),
      text: prompt,
    })
  }, [])

  const navigateFromSidebar = useCallback((tab: HomeTab | 'contextual') => {
    if (tab === 'contextual') return
    router.push(buildHomeHref(tab, journeySubTab))
  }, [journeySubTab, router])

  const operationsPanel = (
    <ContextualOperationsPanel
      runs={runs}
      sweeps={uiSweeps}
      alerts={alerts}
      onInsertPrompt={insertPrompt}
    />
  )

  const contextPanel = (
    <ContextualContextCanvas
      references={contextReferences}
      onInsertPrompt={insertPrompt}
    />
  )

  const runningRunCount = useMemo(
    () => runs.filter((run) => run.status === 'running').length,
    [runs]
  )
  const queuedRunCount = useMemo(
    () => runs.filter((run) => run.status === 'queued' || run.status === 'ready').length,
    [runs]
  )
  const pendingAlerts = useMemo(
    () => alerts.filter((alert) => alert.status === 'pending').sort((a, b) => b.timestamp - a.timestamp),
    [alerts]
  )
  const pendingAlertsByRun = useMemo(() => {
    const counts: Record<string, number> = {}
    alerts.forEach((alert) => {
      if (alert.status === 'pending') {
        counts[alert.run_id] = (counts[alert.run_id] || 0) + 1
      }
    })
    return counts
  }, [alerts])
  const activeSweepCount = useMemo(
    () => uiSweeps.filter((sweep) => sweep.status === 'running' || sweep.status === 'pending').length,
    [uiSweeps]
  )
  const topContextReferences = useMemo(
    () => contextReferences.slice(0, 3),
    [contextReferences]
  )
  const queuedRunsPreview = useMemo(
    () =>
      runs
        .filter((run) => run.status === 'queued' || run.status === 'ready')
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
        .slice(0, 2),
    [runs]
  )
  const activeSweepsPreview = useMemo(
    () =>
      uiSweeps
        .filter((sweep) => sweep.status === 'running' || sweep.status === 'pending')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 2),
    [uiSweeps]
  )

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main className="flex h-full w-full overflow-hidden bg-background">
        <DesktopSidebar
          activeTab="contextual"
          hidden={desktopSidebarHidden}
          width={desktopSidebarWidth}
          minWidth={DESKTOP_SIDEBAR_MIN_WIDTH}
          maxWidth={DESKTOP_SIDEBAR_MAX_WIDTH}
          sessions={sessions}
          runs={runs}
          sweeps={uiSweeps}
          pendingAlertsByRun={pendingAlertsByRun}
          onTabChange={navigateFromSidebar}
          onNewChat={async () => {
            await createNewSession()
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
          }}
          onArchiveSession={async (sessionId) => {
            await archiveSession(sessionId)
          }}
          onNavigateToRun={(runId) => {
            router.push(buildHomeHref('runs', journeySubTab) + `#${runId}`)
          }}
          onInsertReference={(text) => insertPrompt(text)}
          onSettingsClick={() => router.push(buildHomeHref('settings', journeySubTab))}
          onToggleCollapse={() => setDesktopSidebarHidden((prev) => !prev)}
          onWidthChange={setDesktopSidebarWidth}
        />

        <section className="mobile-viewport-wrapper flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <header className="shrink-0 border-b border-border/80 bg-background/95 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 lg:hidden"
                  onClick={() => setLeftPanelOpen(true)}
                >
                  <Menu className="h-4 w-4" />
                </Button>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Contextual Chatting</p>
                  <p className="text-[11px] text-muted-foreground">Artifacts stay visible while you reason.</p>
                </div>
                <Badge variant="outline" className="hidden md:inline-flex text-[10px]">
                  {contextReferences.length} context items
                </Badge>
              </div>

              <div className="flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Chat view settings"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      <span className="sr-only">Chat view settings</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel>Chat View</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={collapseChats}
                      onCheckedChange={(checked) => setCollapseChats(Boolean(checked))}
                    >
                      <Rows3 className="mr-1 h-3.5 w-3.5" />
                      Collapse chats
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={collapseArtifactsInChat}
                      onCheckedChange={(checked) => setCollapseArtifactsInChat(Boolean(checked))}
                    >
                      <LayoutGrid className="mr-1 h-3.5 w-3.5" />
                      Collapse artifacts
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="mt-2 lg:hidden">
              <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <section className="w-[78vw] max-w-[300px] shrink-0 snap-start rounded-xl border border-border/80 bg-card/90 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
                      <Cpu className="h-3.5 w-3.5 text-primary" />
                      Cluster Pulse
                    </p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {runningRunCount} running
                    </Badge>
                  </div>
                  <div className="mb-2 grid grid-cols-2 gap-1.5 text-[10px]">
                    <div className="rounded-md border border-border/70 bg-background/70 px-1.5 py-1 text-center">
                      <p className="text-muted-foreground">Queued</p>
                      <p className="mt-0.5 font-semibold text-foreground">{queuedRunCount}</p>
                    </div>
                    <div className="rounded-md border border-border/70 bg-background/70 px-1.5 py-1 text-center">
                      <p className="text-muted-foreground">Sweeps</p>
                      <p className="mt-0.5 font-semibold text-foreground">{activeSweepCount}</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() =>
                      insertPrompt(
                        `Given ${runningRunCount} running jobs and ${queuedRunCount} queued jobs, propose a queue rebalance strategy for the next hour.`
                      )
                    }
                  >
                    Rebalance queue
                  </Button>
                </section>

                <section className="w-[78vw] max-w-[300px] shrink-0 snap-start rounded-xl border border-border/80 bg-card/90 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
                      <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                      Job Queue
                    </p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {queuedRunCount}
                    </Badge>
                  </div>
                  <div className="mb-2 space-y-1">
                    {queuedRunsPreview.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/80 bg-background/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                        No queued jobs.
                      </p>
                    ) : (
                      queuedRunsPreview.map((run) => (
                        <div
                          key={run.id}
                          className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
                        >
                          <p className="truncate text-[10px] text-foreground">{run.alias || run.name}</p>
                          <p className="text-[9px] text-muted-foreground">{run.status}</p>
                        </div>
                      ))
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() =>
                      insertPrompt('Review the queued jobs and reorder for fastest learning feedback.')
                    }
                  >
                    Optimize queue
                  </Button>
                </section>

                <section className="w-[78vw] max-w-[300px] shrink-0 snap-start rounded-xl border border-border/80 bg-card/90 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
                      <Bell className="h-3.5 w-3.5 text-amber-500" />
                      Active Alerts
                    </p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {pendingAlerts.length}
                    </Badge>
                  </div>
                  <div className="mb-2 space-y-1">
                    {pendingAlerts.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/80 bg-background/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                        No pending alerts.
                      </p>
                    ) : (
                      pendingAlerts.slice(0, 2).map((alert) => (
                        <div
                          key={alert.id}
                          className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
                        >
                          <p className="line-clamp-2 text-[10px] text-foreground">{alert.message}</p>
                          <p className="text-[9px] text-muted-foreground">{alert.severity}</p>
                        </div>
                      ))
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() =>
                      insertPrompt(
                        pendingAlerts[0]
                          ? `@alert:${pendingAlerts[0].id} diagnose this alert and recommend the safest response.`
                          : 'No pending alerts. Suggest a preventive checklist for upcoming runs.'
                      )
                    }
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Triage
                  </Button>
                </section>

                <section className="w-[78vw] max-w-[300px] shrink-0 snap-start rounded-xl border border-border/80 bg-card/90 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
                      <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                      Sweeps In Flight
                    </p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {activeSweepCount}
                    </Badge>
                  </div>
                  <div className="mb-2 space-y-1">
                    {activeSweepsPreview.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/80 bg-background/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                        No active sweeps.
                      </p>
                    ) : (
                      activeSweepsPreview.map((sweep) => (
                        <div
                          key={sweep.id}
                          className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
                        >
                          <p className="truncate text-[10px] text-foreground">{sweep.config.name}</p>
                          <p className="text-[9px] text-muted-foreground">
                            {sweep.progress.running} running · {sweep.progress.completed}/{sweep.progress.total}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() =>
                      insertPrompt('Summarize active sweep progress and recommend the next parameter experiments.')
                    }
                  >
                    Review sweeps
                  </Button>
                </section>

                <section className="w-[78vw] max-w-[300px] shrink-0 snap-start rounded-xl border border-border/80 bg-card/90 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-xs font-semibold text-foreground">Context Artifacts</p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {contextReferences.length}
                    </Badge>
                  </div>
                  <div className="mb-2 space-y-1">
                    {topContextReferences.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border/80 bg-background/60 px-2 py-1.5 text-[10px] text-muted-foreground">
                        Mention `@run`, `@sweep`, or `@alert` to pin context here.
                      </p>
                    ) : (
                      topContextReferences.map((reference) => (
                        <div
                          key={reference.key}
                          className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
                        >
                          <p className="min-w-0 truncate text-[10px] text-foreground">{reference.label}</p>
                          <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
                            {reference.kind}
                          </Badge>
                        </div>
                      ))
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    onClick={() =>
                      insertPrompt('Summarize current context artifacts and give me the next best action.')
                    }
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Summarize context
                  </Button>
                </section>
              </div>
            </div>
          </header>

          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="hidden h-full min-h-0 lg:flex">
              {showOpsPanel && (
                <aside className="h-full w-[280px] shrink-0 min-h-0 border-r border-border/80 bg-card/35">
                  {operationsPanel}
                </aside>
              )}
              <section className="relative min-w-0 flex-1 min-h-0 overflow-hidden">
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute left-2 top-2 z-20 h-7 w-7 bg-background/95 backdrop-blur"
                  onClick={() => setShowOpsPanel((prev) => !prev)}
                  title={showOpsPanel ? 'Hide ops panel' : 'Show ops panel'}
                >
                  {showOpsPanel ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
                  <span className="sr-only">{showOpsPanel ? 'Hide ops panel' : 'Show ops panel'}</span>
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute right-2 top-2 z-20 h-7 w-7 bg-background/95 backdrop-blur"
                  onClick={() => setShowContextPanel((prev) => !prev)}
                  title={showContextPanel ? 'Hide context panel' : 'Show context panel'}
                >
                  {showContextPanel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                  <span className="sr-only">{showContextPanel ? 'Hide context panel' : 'Show context panel'}</span>
                </Button>
                <ConnectedChatView
                  runs={runs}
                  alerts={alerts}
                  sweeps={uiSweeps}
                  mode={chatMode}
                  onModeChange={setChatMode}
                  onRunClick={() => {
                    router.push(buildHomeHref('runs', journeySubTab))
                  }}
                  collapseChats={collapseChats}
                  collapseArtifactsInChat={collapseArtifactsInChat}
                  chatSession={chatSession}
                  insertDraft={chatDraftInsert}
                  onOpenSettings={() => router.push(buildHomeHref('settings', journeySubTab))}
                />
              </section>
              {showContextPanel && (
                <aside className="h-full w-[320px] shrink-0 min-h-0 border-l border-border/80 bg-card/35">
                  {contextPanel}
                </aside>
              )}
            </div>

            <div className="flex h-full min-h-0 flex-col lg:hidden">
              <ConnectedChatView
                runs={runs}
                alerts={alerts}
                sweeps={uiSweeps}
                mode={chatMode}
                onModeChange={setChatMode}
                onRunClick={() => {
                  router.push(buildHomeHref('runs', journeySubTab))
                }}
                collapseChats={collapseChats}
                collapseArtifactsInChat={collapseArtifactsInChat}
                chatSession={chatSession}
                insertDraft={chatDraftInsert}
                onOpenSettings={() => router.push(buildHomeHref('settings', journeySubTab))}
              />
            </div>
          </div>

          <NavPage
            open={leftPanelOpen}
            onOpenChange={setLeftPanelOpen}
            onSettingsClick={() => router.push(buildHomeHref('settings', journeySubTab))}
            activeTab="contextual"
            journeySubTab={journeySubTab}
            onTabChange={navigateFromSidebar}
            onJourneySubTabChange={setJourneySubTab}
            onNewChat={async () => {
              await createNewSession()
            }}
            sessions={sessions}
            onSelectSession={async (sessionId) => {
              await selectSession(sessionId)
            }}
          />
        </section>
      </main>
    </div>
  )
}
