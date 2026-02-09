'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LayoutGrid, Menu, MessageSquarePlus, Rows3, Settings } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import type { Sweep as UiSweep, SweepConfig, SweepStatus } from '@/lib/types'

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
  const { sessions, messages, createNewSession, selectSession } = chatSession

  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [chatMode, setChatMode] = useState<ChatMode>('agent')
  const [journeySubTab, setJourneySubTab] = useState<JourneySubTab>('story')
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false)
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  const [sweeps, setSweeps] = useState<ApiSweep[]>([])
  const [collapseChats, setCollapseChats] = useState(true)
  const [collapseArtifactsInChat, setCollapseArtifactsInChat] = useState(false)
  const [chatDraftInsert, setChatDraftInsert] = useState<{ id: number; text: string } | null>(null)
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'ops' | 'context'>('chat')

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
    setMobilePanel('chat')
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
          onTabChange={navigateFromSidebar}
          onNewChat={async () => {
            await createNewSession()
          }}
          onSelectSession={async (sessionId) => {
            await selectSession(sessionId)
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
                <Button
                  variant={collapseChats ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => setCollapseChats((prev) => !prev)}
                >
                  <Rows3 className="h-3.5 w-3.5" />
                  Collapse
                </Button>
                <Button
                  variant={collapseArtifactsInChat ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => setCollapseArtifactsInChat((prev) => !prev)}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Artifacts
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={async () => {
                    await createNewSession()
                  }}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  New
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => router.push(buildHomeHref('settings', journeySubTab))}
                  title="Settings"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-1.5 lg:hidden">
              <Button
                variant={mobilePanel === 'chat' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => setMobilePanel('chat')}
              >
                Chat
              </Button>
              <Button
                variant={mobilePanel === 'ops' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => setMobilePanel('ops')}
              >
                Ops
              </Button>
              <Button
                variant={mobilePanel === 'context' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => setMobilePanel('context')}
              >
                Context
              </Button>
            </div>
          </header>

          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="hidden h-full min-h-0 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_320px]">
              <aside className="min-h-0 border-r border-border/80 bg-card/35">{operationsPanel}</aside>
              <section className="min-h-0 overflow-hidden">
                <ConnectedChatView
                  runs={runs}
                  alerts={alerts}
                  sweeps={uiSweeps}
                  mode={chatMode}
                  onModeChange={setChatMode}
                  onRunClick={() => {
                    router.push(buildHomeHref('runs', journeySubTab))
                  }}
                  onEditSweep={(_config: SweepConfig) => {
                    // Editing remains in runs/chat views for now.
                  }}
                  onLaunchSweep={(_config: SweepConfig) => {
                    // Launch action handled by /sweep tools in chat for this page.
                  }}
                  collapseChats={collapseChats}
                  collapseArtifactsInChat={collapseArtifactsInChat}
                  chatSession={chatSession}
                  insertDraft={chatDraftInsert}
                  onOpenSettings={() => router.push(buildHomeHref('settings', journeySubTab))}
                />
              </section>
              <aside className="min-h-0 border-l border-border/80 bg-card/35">{contextPanel}</aside>
            </div>

            <div className="flex h-full min-h-0 flex-col lg:hidden">
              {mobilePanel === 'chat' ? (
                <ConnectedChatView
                  runs={runs}
                  alerts={alerts}
                  sweeps={uiSweeps}
                  mode={chatMode}
                  onModeChange={setChatMode}
                  onRunClick={() => {
                    router.push(buildHomeHref('runs', journeySubTab))
                  }}
                  onEditSweep={(_config: SweepConfig) => {
                    // Editing remains in runs/chat views for now.
                  }}
                  onLaunchSweep={(_config: SweepConfig) => {
                    // Launch action handled by /sweep tools in chat for this page.
                  }}
                  collapseChats={collapseChats}
                  collapseArtifactsInChat={collapseArtifactsInChat}
                  chatSession={chatSession}
                  insertDraft={chatDraftInsert}
                  onOpenSettings={() => router.push(buildHomeHref('settings', journeySubTab))}
                />
              ) : mobilePanel === 'ops' ? (
                <div className="min-h-0 flex-1 overflow-hidden">{operationsPanel}</div>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">{contextPanel}</div>
              )}
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
