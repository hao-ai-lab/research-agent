'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Menu, PlugZap } from 'lucide-react'
import { ConnectedChatView, useChatSession } from '@/components/connected-chat-view'
import {
  AssistantWorkflowBoard,
  type AssistantConnectionTarget,
} from '@/components/assistant-workflow-board'
import { useRuns } from '@/hooks/use-runs'
import { useAlerts } from '@/hooks/use-alerts'
import { createSweep, listSweeps, type Alert as ApiAlert, type Sweep as ApiSweep } from '@/lib/api-client'
import type { ChatMode } from '@/components/chat-input'
import { DesktopSidebar } from '@/components/desktop-sidebar'
import { NavPage, type JourneySubTab, type RunsSubTab } from '@/components/nav-page'
import {
  type ChatMessage as UiChatMessage,
  type Sweep as UiSweep,
  type SweepConfig,
  SweepStatus,
} from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SweepForm } from '@/components/sweep-form'

const DESKTOP_SIDEBAR_MIN_WIDTH = 240
const DESKTOP_SIDEBAR_MAX_WIDTH = 520
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 300
const SPLIT_HEIGHT_STORAGE_KEY = 'assistantSplitHeightRatio'
const DESKTOP_ARTIFACT_SPLIT_STORAGE_KEY = 'assistantDesktopArtifactRatio'
const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = 'assistantDesktopSidebarCollapsed'
const ASSISTANT_CONNECTIONS_STORAGE_KEY = 'assistantSessionConnections'
const ASSISTANT_UNASSIGNED_SESSION_KEY = '__assistant-unassigned-session__'

const SPLIT_MIN_RATIO = 0.08
const SPLIT_MAX_RATIO = 0.92
const DESKTOP_ARTIFACT_MIN_RATIO = 0.22
const DESKTOP_ARTIFACT_MAX_RATIO = 0.78

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

function parseContextReferences(text: string): { sweepIds: string[]; runIds: string[] } {
  const sweepIds = new Set<string>()
  const runIds = new Set<string>()

  const sweepRegex = /@sweep:([A-Za-z0-9._-]+)/g
  const runRegex = /@run:([A-Za-z0-9._-]+)/g

  let match: RegExpExecArray | null
  while ((match = sweepRegex.exec(text)) !== null) {
    if (match[1]) sweepIds.add(match[1])
  }
  while ((match = runRegex.exec(text)) !== null) {
    if (match[1]) runIds.add(match[1])
  }

  return {
    sweepIds: Array.from(sweepIds),
    runIds: Array.from(runIds),
  }
}

function sweepConfigToCreateRequest(config: SweepConfig, autoStart: boolean) {
  const parameters: Record<string, unknown[]> = {}

  config.hyperparameters.forEach((param) => {
    if (param.type === 'choice' && Array.isArray(param.values) && param.values.length > 0) {
      parameters[param.name] = param.values
      return
    }

    if (param.type === 'fixed' && param.fixedValue !== undefined) {
      parameters[param.name] = [param.fixedValue]
      return
    }

    if (
      param.type === 'range' &&
      typeof param.min === 'number' &&
      typeof param.max === 'number' &&
      typeof param.step === 'number' &&
      param.step > 0
    ) {
      const values: number[] = []
      for (let value = param.min; value <= param.max && values.length < 32; value += param.step) {
        values.push(Number(value.toFixed(10)))
      }
      if (values.length > 0) {
        parameters[param.name] = values
      }
    }
  })

  if (Object.keys(parameters).length === 0) {
    parameters.default = [1]
  }

  return {
    name: config.name,
    base_command: config.command,
    parameters,
    max_runs: config.maxRuns,
    auto_start: autoStart,
  }
}

function safeParseConnections(raw: string | null): Record<string, AssistantConnectionTarget[]> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, AssistantConnectionTarget[]>
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // Ignore invalid persisted state.
  }
  return {}
}


export default function AssistantPage() {
  const router = useRouter()
  const { runs } = useRuns()
  const { alerts, respond: respondAlert } = useAlerts()
  const chatSession = useChatSession()
  const { createNewSession, selectSession, sendMessage, sessions, currentSessionId } = chatSession

  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [chatDraftInsert, setChatDraftInsert] = useState<{ id: number; text: string } | null>(null)
  const [sweeps, setSweeps] = useState<ApiSweep[]>([])
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false)
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  const [runsSubTab, setRunsSubTab] = useState<RunsSubTab>('overview')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [focusedSweepIds, setFocusedSweepIds] = useState<string[]>([])
  const [focusedRunIds, setFocusedRunIds] = useState<string[]>([])
  const [connectionsBySession, setConnectionsBySession] = useState<Record<string, AssistantConnectionTarget[]>>({})
  const [injectedMessagesBySession, setInjectedMessagesBySession] = useState<Record<string, UiChatMessage[]>>({})
  const [editingArtifactConfig, setEditingArtifactConfig] = useState<SweepConfig | null>(null)
  const [sweepDialogOpen, setSweepDialogOpen] = useState(false)

  const mobileSplitContainerRef = useRef<HTMLDivElement>(null)
  const desktopSplitContainerRef = useRef<HTMLDivElement>(null)
  const splitPointerIdRef = useRef<number | null>(null)
  const [mobileSplitRatio, setMobileSplitRatio] = useState(0.42)
  const [desktopArtifactRatio, setDesktopArtifactRatio] = useState(0.42)
  const [dragMode, setDragMode] = useState<'mobile' | 'desktop' | null>(null)
  const [isDesktopLayout, setIsDesktopLayout] = useState(false)

  const currentSessionKey = currentSessionId || ASSISTANT_UNASSIGNED_SESSION_KEY

  const fetchSweeps = useCallback(async () => {
    try {
      const nextSweeps = await listSweeps()
      setSweeps(nextSweeps)
    } catch (error) {
      console.error('Failed to fetch sweeps:', error)
    }
  }, [])

  useEffect(() => {
    fetchSweeps()
    const intervalId = window.setInterval(fetchSweeps, 5000)
    return () => window.clearInterval(intervalId)
  }, [fetchSweeps])

  useEffect(() => {
    const storedWidth = window.localStorage.getItem('desktopSidebarWidth')
    if (storedWidth) {
      const parsed = Number(storedWidth)
      if (Number.isFinite(parsed)) {
        setDesktopSidebarWidth(
          Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, parsed))
        )
      }
    }

    const storedCollapsed = window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY)
    if (storedCollapsed === '1') {
      setDesktopSidebarCollapsed(true)
    }

    const storedRatio = window.localStorage.getItem(SPLIT_HEIGHT_STORAGE_KEY)
    if (storedRatio) {
      const parsed = Number(storedRatio)
      if (Number.isFinite(parsed)) {
        setMobileSplitRatio(Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, parsed)))
      }
    }

    const storedDesktopRatio = window.localStorage.getItem(DESKTOP_ARTIFACT_SPLIT_STORAGE_KEY)
    if (storedDesktopRatio) {
      const parsed = Number(storedDesktopRatio)
      if (Number.isFinite(parsed)) {
        setDesktopArtifactRatio(
          Math.min(DESKTOP_ARTIFACT_MAX_RATIO, Math.max(DESKTOP_ARTIFACT_MIN_RATIO, parsed))
        )
      }
    }

    const storedConnections = safeParseConnections(window.localStorage.getItem(ASSISTANT_CONNECTIONS_STORAGE_KEY))
    setConnectionsBySession(storedConnections)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('desktopSidebarWidth', String(desktopSidebarWidth))
  }, [desktopSidebarWidth])

  useEffect(() => {
    window.localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY, desktopSidebarCollapsed ? '1' : '0')
  }, [desktopSidebarCollapsed])

  useEffect(() => {
    window.localStorage.setItem(SPLIT_HEIGHT_STORAGE_KEY, String(mobileSplitRatio))
  }, [mobileSplitRatio])

  useEffect(() => {
    window.localStorage.setItem(DESKTOP_ARTIFACT_SPLIT_STORAGE_KEY, String(desktopArtifactRatio))
  }, [desktopArtifactRatio])

  useEffect(() => {
    window.localStorage.setItem(ASSISTANT_CONNECTIONS_STORAGE_KEY, JSON.stringify(connectionsBySession))
  }, [connectionsBySession])

  useEffect(() => {
    if (!currentSessionId) return

    const unassignedConnections = connectionsBySession[ASSISTANT_UNASSIGNED_SESSION_KEY]
    if (unassignedConnections && unassignedConnections.length > 0) {
      setConnectionsBySession((prev) => {
        const existing = prev[currentSessionId] || []
        const nextCurrent = [...existing]
        unassignedConnections.forEach((target) => {
          if (!nextCurrent.some((item) => item.kind === target.kind && item.id === target.id)) {
            nextCurrent.push(target)
          }
        })
        const { [ASSISTANT_UNASSIGNED_SESSION_KEY]: _drop, ...rest } = prev
        return {
          ...rest,
          [currentSessionId]: nextCurrent,
        }
      })
    }

    const unassignedInjected = injectedMessagesBySession[ASSISTANT_UNASSIGNED_SESSION_KEY]
    if (unassignedInjected && unassignedInjected.length > 0) {
      setInjectedMessagesBySession((prev) => {
        const existing = prev[currentSessionId] || []
        const { [ASSISTANT_UNASSIGNED_SESSION_KEY]: _drop, ...rest } = prev
        return {
          ...rest,
          [currentSessionId]: [...existing, ...unassignedInjected],
        }
      })
    }
  }, [currentSessionId, connectionsBySession, injectedMessagesBySession])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktopLayout(mediaQuery.matches)
    onChange()
    mediaQuery.addEventListener('change', onChange)
    return () => mediaQuery.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!dragMode) return

    const onPointerMove = (event: PointerEvent) => {
      if (splitPointerIdRef.current !== null && event.pointerId !== splitPointerIdRef.current) {
        return
      }
      const container = dragMode === 'desktop'
        ? desktopSplitContainerRef.current
        : mobileSplitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (dragMode === 'desktop') {
        const nextRatio = (event.clientX - rect.left) / rect.width
        setDesktopArtifactRatio(
          Math.min(DESKTOP_ARTIFACT_MAX_RATIO, Math.max(DESKTOP_ARTIFACT_MIN_RATIO, nextRatio))
        )
        return
      }
      const nextRatio = (event.clientY - rect.top) / rect.height
      setMobileSplitRatio(Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, nextRatio)))
    }

    const onPointerUp = (event: PointerEvent) => {
      if (splitPointerIdRef.current !== null && event.pointerId !== splitPointerIdRef.current) {
        return
      }
      splitPointerIdRef.current = null
      setDragMode(null)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    document.body.style.cursor = dragMode === 'desktop' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragMode])

  const uiSweeps = useMemo<UiSweep[]>(() => sweeps.map(mapApiSweepToUiSweep), [sweeps])

  const connectedTargets = connectionsBySession[currentSessionKey] || []
  const injectedMessages = injectedMessagesBySession[currentSessionKey] || []

  const handleInsertReference = useCallback((text: string) => {
    setChatDraftInsert({
      id: Date.now(),
      text,
    })
  }, [])

  const appendInjectedMessage = useCallback((message: UiChatMessage) => {
    setInjectedMessagesBySession((prev) => {
      const list = prev[currentSessionKey] || []
      return {
        ...prev,
        [currentSessionKey]: [...list, message],
      }
    })
  }, [currentSessionKey])

  const handleOpenAlertInChat = useCallback(
    async (alert: ApiAlert) => {
      const run = runs.find((item) => item.id === alert.run_id)
      const existingSessionId = alert.session_id

      const sessionId = existingSessionId || (await createNewSession())
      if (!sessionId) return

      await selectSession(sessionId)

      if (!existingSessionId) {
        const prompt = [
          'New alert detected. Diagnose the issue and recommend the safest next action.',
          '',
          `Alert: @alert:${alert.id}`,
          `Severity: ${alert.severity}`,
          `Run: ${run?.alias || run?.name || alert.run_id}`,
          run?.command ? `Command: ${run.command}` : undefined,
          alert.choices?.length ? `Allowed responses: ${alert.choices.join(', ')}` : undefined,
          '',
          'Keep the analysis concise, then recommend one response from allowed choices.',
        ]
          .filter(Boolean)
          .join('\\n')
        await sendMessage(prompt, chatMode, sessionId)
      }
    },
    [createNewSession, selectSession, sendMessage, runs, chatMode]
  )

  const handleAlertRespond = useCallback(
    async (alertId: string, choice: string) => {
      try {
        await respondAlert(alertId, choice)
      } catch (error) {
        console.error('Failed to respond alert:', error)
      }
    },
    [respondAlert]
  )

  const handleConnectTarget = useCallback((target: AssistantConnectionTarget) => {
    setConnectionsBySession((prev) => {
      const list = prev[currentSessionKey] || []
      if (list.some((item) => item.kind === target.kind && item.id === target.id)) {
        return prev
      }
      return {
        ...prev,
        [currentSessionKey]: [...list, target],
      }
    })
  }, [currentSessionKey])

  const handleDisconnectTarget = useCallback((target: AssistantConnectionTarget) => {
    setConnectionsBySession((prev) => {
      const list = prev[currentSessionKey] || []
      return {
        ...prev,
        [currentSessionKey]: list.filter((item) => !(item.kind === target.kind && item.id === target.id)),
      }
    })
  }, [currentSessionKey])

  const handleLaunchSweepFromArtifact = useCallback(async (config: SweepConfig) => {
    try {
      const request = sweepConfigToCreateRequest(config, true)
      const created = await createSweep(request)
      await fetchSweeps()
      handleConnectTarget({ kind: 'sweep', id: created.id, label: created.name })
      handleInsertReference(`@sweep:${created.id} monitor progress, failures, and best-performing run.`)
      appendInjectedMessage({
        id: `assistant-created-${created.id}-${Date.now()}`,
        role: 'assistant',
        content: `Created and started **${created.name}** (${created.id}) with ${created.run_ids.length} runs.`,
        timestamp: new Date(),
      })
    } catch (error) {
      appendInjectedMessage({
        id: `assistant-create-error-${Date.now()}`,
        role: 'assistant',
        content: `Failed to create sweep from draft artifact: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
      })
    }
  }, [appendInjectedMessage, fetchSweeps, handleConnectTarget, handleInsertReference])

  const handleUserMessage = useCallback((message: string) => {
    const refs = parseContextReferences(message)
    if (refs.sweepIds.length > 0) {
      setFocusedSweepIds(refs.sweepIds)
    }
    if (refs.runIds.length > 0) {
      setFocusedRunIds(refs.runIds)
    }
  }, [])

  const handleTabChange = useCallback(
    (tab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report' | 'settings') => {
      if (tab === 'chat') return
      if (tab === 'settings') {
        router.push('/?tab=settings')
        return
      }
      if (tab === 'journey') {
        router.push(`/?tab=journey&journeySubTab=${journeySubTab}`)
        return
      }
      router.push('/')
    },
    [router, journeySubTab]
  )

  const eventCount = useMemo(
    () => alerts.filter((alert) => alert.status === 'pending').length,
    [alerts]
  )

  const assistantBoard = (
    <AssistantWorkflowBoard
      runs={runs}
      alerts={alerts}
      sweeps={sweeps}
      onReferInChat={handleInsertReference}
      onOpenAlertInChat={handleOpenAlertInChat}
      onAlertRespond={handleAlertRespond}
      focusedSweepIds={focusedSweepIds}
      focusedRunIds={focusedRunIds}
      connectedTargets={connectedTargets}
      onConnectTarget={handleConnectTarget}
      onDisconnectTarget={handleDisconnectTarget}
    />
  )

  const chatPane = (
    <ConnectedChatView
      runs={runs}
      alerts={alerts}
      sweeps={uiSweeps}
      mode={chatMode}
      onModeChange={setChatMode}
      onRunClick={() => {
        // Keep assistant context in-place.
      }}
      onEditSweep={(config) => setEditingArtifactConfig(config)}
      onLaunchSweep={handleLaunchSweepFromArtifact}
      chatSession={chatSession}
      insertDraft={chatDraftInsert}
      injectedMessages={injectedMessages}
      onUserMessage={handleUserMessage}
    />
  )

  return (
    <div className="w-screen h-dvh overflow-hidden bg-background">
      <main className="flex h-full w-full overflow-hidden bg-background">
        <DesktopSidebar
          activeTab="chat"
          collapsed={desktopSidebarCollapsed}
          width={desktopSidebarWidth}
          minWidth={DESKTOP_SIDEBAR_MIN_WIDTH}
          maxWidth={DESKTOP_SIDEBAR_MAX_WIDTH}
          runsSubTab={runsSubTab}
          journeySubTab={journeySubTab}
          sessions={sessions}
          runs={runs}
          sweeps={uiSweeps}
          onTabChange={handleTabChange}
          onRunsSubTabChange={(subTab) => {
            setRunsSubTab(subTab)
            router.push('/')
          }}
          onJourneySubTabChange={(subTab) => {
            setJourneySubTab(subTab)
            router.push(`/?tab=journey&journeySubTab=${subTab}`)
          }}
          onNewChat={async () => {
            await createNewSession()
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
          }}
          onNavigateToRun={() => {
            router.push('/')
          }}
          onInsertReference={handleInsertReference}
          onSettingsClick={() => router.push('/?tab=settings')}
          onToggleCollapse={() => setDesktopSidebarCollapsed((prev) => !prev)}
          onWidthChange={setDesktopSidebarWidth}
        />

        <section className="mobile-viewport-wrapper flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="shrink-0 h-11 border-b border-border px-3 flex items-center justify-between">
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLeftPanelOpen(true)}
                className="h-8 w-8 lg:hidden"
              >
                <Menu className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  const firstPending = alerts.find((alert) => alert.status === 'pending')
                  if (firstPending) {
                    void handleOpenAlertInChat(firstPending)
                  }
                }}
                className="h-8 w-8 relative"
              >
                <Bell className="h-4 w-4" />
                {eventCount > 0 && (
                  <Badge
                    variant="destructive"
                    className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] flex items-center justify-center"
                  >
                    {eventCount > 99 ? '99+' : eventCount}
                  </Badge>
                )}
                <span className="sr-only">View alerts ({eventCount})</span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5"
                title="Create Sweep"
                onClick={() => setSweepDialogOpen(true)}
              >
                <PlugZap className="h-4 w-4" />
                Sweep
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {isDesktopLayout ? (
              <div ref={desktopSplitContainerRef} className="h-full min-h-0 flex overflow-hidden">
                <section
                  className="h-full min-w-[260px] shrink-0 border-r border-border/60 bg-background/80"
                  style={{ width: `${desktopArtifactRatio * 100}%` }}
                >
                  <div className="h-full min-h-0 overflow-hidden">{assistantBoard}</div>
                </section>

                <div className="shrink-0 border-r border-border bg-background px-0.5 py-2 flex items-center">
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      splitPointerIdRef.current = event.pointerId
                      setDragMode('desktop')
                    }}
                    className="h-full cursor-col-resize select-none flex items-center"
                    aria-label="Drag to resize artifact and chat panes"
                    style={{ touchAction: 'none' }}
                  >
                    <div className="mx-auto h-8 w-[1px] rounded-full bg-muted-foreground/40 transition-colors hover:bg-muted-foreground/70" />
                  </button>
                </div>

                <section className="min-w-0 flex-1 overflow-hidden">
                  {chatPane}
                </section>
              </div>
            ) : (
              <div ref={mobileSplitContainerRef} className="h-full min-h-0 flex flex-col overflow-hidden">
                <section
                  className="shrink-0 border-b border-border/60 bg-background/80"
                  style={{ height: `${mobileSplitRatio * 100}%`, minHeight: '120px' }}
                >
                  <div className="h-full min-h-0 overflow-hidden">{assistantBoard}</div>
                </section>

                <div className="shrink-0 border-b border-border bg-background px-3 py-0">
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      splitPointerIdRef.current = event.pointerId
                      setDragMode('mobile')
                    }}
                    className="w-full cursor-row-resize select-none"
                    aria-label="Drag to resize top and bottom panes"
                    style={{ touchAction: 'none' }}
                  >
                    <div className="mx-auto h-[1px] w-7 rounded-full bg-muted-foreground/40 transition-colors hover:bg-muted-foreground/70" />
                  </button>
                </div>

                <section className="min-h-0 flex-1 overflow-hidden">
                  {chatPane}
                </section>
              </div>
            )}
          </div>

          <NavPage
            open={leftPanelOpen}
            onOpenChange={setLeftPanelOpen}
            onSettingsClick={() => router.push('/?tab=settings')}
            activeTab="chat"
            runsSubTab={runsSubTab}
            journeySubTab={journeySubTab}
            onTabChange={handleTabChange}
            onRunsSubTabChange={(subTab) => {
              setRunsSubTab(subTab)
              router.push('/')
            }}
            onJourneySubTabChange={(subTab) => {
              setJourneySubTab(subTab)
              router.push(`/?tab=journey&journeySubTab=${subTab}`)
            }}
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

      <Dialog open={Boolean(editingArtifactConfig)} onOpenChange={(open) => !open && setEditingArtifactConfig(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Sweep Artifact</DialogTitle>
            <DialogDescription>
              Update the draft sweep artifact before launch.
            </DialogDescription>
          </DialogHeader>

          {editingArtifactConfig && (
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Name</p>
                <Input
                  value={editingArtifactConfig.name}
                  onChange={(event) =>
                    setEditingArtifactConfig((prev) => (prev ? { ...prev, name: event.target.value } : prev))
                  }
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Command</p>
                <Input
                  value={editingArtifactConfig.command}
                  onChange={(event) =>
                    setEditingArtifactConfig((prev) => (prev ? { ...prev, command: event.target.value } : prev))
                  }
                  className="font-mono"
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Max Runs</p>
                <Input
                  type="number"
                  min={1}
                  value={editingArtifactConfig.maxRuns || 1}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (!Number.isFinite(value) || value < 1) return
                    setEditingArtifactConfig((prev) => (prev ? { ...prev, maxRuns: value } : prev))
                  }}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingArtifactConfig(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editingArtifactConfig) return
                setInjectedMessagesBySession((prev) => {
                  const list = prev[currentSessionKey] || []
                  return {
                    ...prev,
                    [currentSessionKey]: list.map((message) => {
                      if (message.sweepConfig?.id !== editingArtifactConfig.id) {
                        return message
                      }
                      return {
                        ...message,
                        sweepConfig: {
                          ...editingArtifactConfig,
                          updatedAt: new Date(),
                        },
                        timestamp: new Date(),
                      }
                    }),
                  }
                })
                setEditingArtifactConfig(null)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sweepDialogOpen} onOpenChange={setSweepDialogOpen}>
        <DialogContent showCloseButton={false} className="w-[95vw] h-[90vh] max-w-[900px] max-h-[800px] flex flex-col p-0 gap-0">
          <SweepForm
            onSave={() => { setSweepDialogOpen(false); fetchSweeps() }}
            onCancel={() => setSweepDialogOpen(false)}
            onLaunch={() => { setSweepDialogOpen(false); fetchSweeps() }}
            previousSweeps={uiSweeps}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
