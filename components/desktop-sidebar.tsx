'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  BarChart3,
  Bell,
  ChevronsUpDown,
  FileText,
  FlaskConical,
  Lightbulb,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Settings,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useApiConfig } from '@/lib/api-config'
import type { ChatSession } from '@/lib/api'
import type { ExperimentRun, Sweep } from '@/lib/types'
import { getStatusText } from '@/lib/status-utils'
import type { JourneySubTab } from './nav-page'

type ActiveTab = 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report' | 'settings'
const ICON_RAIL_WIDTH = 72
const ICON_RAIL_TRIGGER_WIDTH = 136

interface DesktopSidebarProps {
  activeTab: ActiveTab
  hidden?: boolean
  width?: number
  minWidth?: number
  maxWidth?: number
  journeySubTab: JourneySubTab
  sessions: ChatSession[]
  runs: ExperimentRun[]
  sweeps: Sweep[]
  onTabChange: (tab: ActiveTab) => void
  onJourneySubTabChange: (subTab: JourneySubTab) => void
  onNewChat: () => Promise<void> | void
  onSelectSession: (sessionId: string) => Promise<void> | void
  onNavigateToRun: (runId: string) => void
  onInsertReference: (text: string) => void
  onSettingsClick: () => void
  onToggleCollapse?: () => void
  onWidthChange?: (width: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
}

function formatRelativeTime(date: Date) {
  const now = Date.now()
  const timestamp = date.getTime()
  const diffMs = now - timestamp
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 60) return `${Math.max(diffMins, 0)}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function getSweepStatusClass(status: Sweep['status']) {
  switch (status) {
    case 'draft':
      return 'bg-violet-500/15 text-violet-500 border-violet-500/30'
    case 'running':
      return 'bg-blue-500/15 text-blue-500 border-blue-500/30'
    case 'completed':
      return 'bg-green-500/15 text-green-500 border-green-500/30'
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30'
    case 'pending':
      return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
    case 'canceled':
      return 'bg-muted text-muted-foreground border-muted-foreground/30'
    default:
      return 'bg-secondary text-muted-foreground border-border'
  }
}

export function DesktopSidebar({
  activeTab,
  hidden = false,
  width = 300,
  minWidth = 240,
  maxWidth = 520,
  journeySubTab,
  sessions,
  runs,
  sweeps,
  onTabChange,
  onJourneySubTabChange,
  onNewChat,
  onSelectSession,
  onNavigateToRun,
  onInsertReference,
  onSettingsClick,
  onToggleCollapse,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
}: DesktopSidebarProps) {
  const isIconRail = !hidden && width <= ICON_RAIL_TRIGGER_WIDTH
  const recentRuns = useMemo(
    () =>
      [...runs]
        .filter((run) => !run.isArchived)
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
        .slice(0, 8),
    [runs]
  )

  const recentSweeps = useMemo(
    () =>
      [...sweeps]
        .sort(
          (a, b) =>
            (b.startedAt?.getTime() || b.createdAt.getTime()) -
            (a.startedAt?.getTime() || a.createdAt.getTime())
        )
        .slice(0, 6),
    [sweeps]
  )
  const { useMock: isDemoMode } = useApiConfig()
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(width)

  const handleResizeStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (hidden) return
    e.preventDefault()
    resizeStartXRef.current = e.clientX
    resizeStartWidthRef.current = width
    setIsResizing(true)
    onResizeStart?.()
  }, [hidden, onResizeStart, width])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartXRef.current
      const rawWidth = Math.min(maxWidth, Math.max(minWidth, resizeStartWidthRef.current + deltaX))
      const snappedWidth = rawWidth <= ICON_RAIL_TRIGGER_WIDTH ? ICON_RAIL_WIDTH : rawWidth
      onWidthChange?.(snappedWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, maxWidth, minWidth, onResizeEnd, onWidthChange])

  return (
    <aside
      className={`relative hidden h-full shrink-0 border-r border-border/80 bg-sidebar/90 backdrop-blur supports-[backdrop-filter]:bg-sidebar/75 transition-[width] ${
        isResizing ? 'duration-0' : 'duration-200'
      } lg:flex ${
        hidden ? 'w-0 border-r-0 overflow-hidden' : isIconRail ? 'w-[72px]' : ''
      }`}
      style={hidden || isIconRail ? undefined : { width: `${width}px` }}
    >
      <div className={`flex h-full w-full flex-col ${hidden ? 'pointer-events-none opacity-0' : ''}`}>
        <div className={`shrink-0 border-b border-border/80 ${isIconRail ? 'px-2 py-2' : 'px-3 py-2'}`}>
          <div className={`relative inline-flex ${isIconRail ? 'mx-auto' : ''}`}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapse}
              className={`h-8 w-8 ${isDemoMode ? 'ring-2 ring-red-500/50 ring-offset-1 ring-offset-background' : ''}`}
              title="Hide sidebar"
            >
              <PanelLeftClose className={`h-4 w-4 ${isDemoMode ? 'text-red-500' : ''}`} />
              <span className="sr-only">
                Hide sidebar
              </span>
            </Button>
            {isDemoMode && (
              <Badge
                variant="destructive"
                className="absolute -top-1.5 -right-2 h-4 px-1 text-[9px] font-bold"
              >
                demo
              </Badge>
            )}
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className={`space-y-5 py-3 ${isIconRail ? 'px-2' : 'px-3'}`}>
            <section>
              {!isIconRail && (
                <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sections
                </p>
              )}
              <div className="space-y-1">
                <button
                  type="button"
                  title="New Chat"
                  onClick={() => {
                    void onNewChat()
                  }}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    isIconRail
                      ? 'justify-center px-2 text-foreground hover:bg-secondary/50'
                      : 'gap-2 px-2 text-foreground hover:bg-secondary/50'
                  }`}
                >
                  <Plus className="h-4 w-4 shrink-0" />
                  {!isIconRail && 'New Chat'}
                </button>

                <button
                  type="button"
                  title="Chat"
                  onClick={() => onTabChange('chat')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'chat'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <MessageSquare className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Chat'}
                </button>

                <button
                  type="button"
                  title="Runs"
                  onClick={() => onTabChange('runs')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'runs'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <FlaskConical className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Runs'}
                </button>

                <button
                  type="button"
                  title="Events"
                  onClick={() => onTabChange('events')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'events'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Bell className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Events'}
                </button>

                <button
                  type="button"
                  title="Charts"
                  onClick={() => onTabChange('charts')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'charts'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <BarChart3 className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Charts'}
                </button>

                <button
                  type="button"
                  title="Memory"
                  onClick={() => onTabChange('memory')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'memory'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Lightbulb className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Memory'}
                </button>

                <button
                  type="button"
                  title="Report"
                  onClick={() => onTabChange('report')}
                  className={`flex w-full items-center rounded-md py-2 text-sm transition-colors ${isIconRail ? 'justify-center px-2' : 'px-2'} ${
                    activeTab === 'report'
                      ? 'border border-border/80 bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <FileText className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                  {!isIconRail && 'Report'}
                </button>
              </div>
            </section>

            {!isIconRail && (
              <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Chats
                </p>
                <span className="text-[10px] text-muted-foreground">Click @ to reference</span>
              </div>
              <div className="space-y-1">
                {sessions.slice(0, 10).map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors hover:bg-secondary/50"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onTabChange('chat')
                        void onSelectSession(session.id)
                      }}
                      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left"
                    >
                      <span className="min-w-0 truncate text-foreground">{session.title || 'Untitled chat'}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {formatRelativeTime(new Date(session.created_at * 1000))}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[16px]"
                      onClick={() => onInsertReference(`@chat:${session.id} `)}
                    >
                      @
                    </Button>
                  </div>
                ))}
                {sessions.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No recent chats yet.</p>
                )}
              </div>
              </section>
            )}

            {!isIconRail && (
              <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Runs
                </p>
                <span className="text-[10px] text-muted-foreground">Click @ to reference</span>
              </div>
              <div className="space-y-1">
                {recentRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/50"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigateToRun(run.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-foreground">{run.alias || run.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{getStatusText(run.status)}</p>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[16px]"
                      onClick={() => onInsertReference(`@run:${run.id} `)}
                    >
                      @
                    </Button>
                  </div>
                ))}
                {recentRuns.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No recent runs yet.</p>
                )}
              </div>
              </section>
            )}

            {!isIconRail && (
              <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Sweeps
                </p>
                <span className="text-[10px] text-muted-foreground">Click @ to reference</span>
              </div>
              <div className="space-y-1">
                {recentSweeps.map((sweep) => (
                  <div
                    key={sweep.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/50"
                  >
                    <div className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm text-foreground">{sweep.config.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{sweep.id}</p>
                    </div>
                    <Badge variant="outline" className={`h-5 text-[9px] capitalize ${getSweepStatusClass(sweep.status)}`}>
                      {sweep.status}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[16px]"
                      onClick={() => onInsertReference(`@sweep:${sweep.id} `)}
                    >
                      @
                    </Button>
                  </div>
                ))}
                {recentSweeps.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No sweeps yet.</p>
                )}
              </div>
              </section>
            )}
          </div>
        </ScrollArea>

        <div className={`shrink-0 border-t border-border/80 ${isIconRail ? 'p-2' : 'p-3'}`}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={isIconRail ? 'Workspace / Settings' : undefined}
                className={`flex w-full items-center rounded-lg border border-border bg-card text-left transition-colors hover:bg-secondary/60 ${
                  isIconRail ? 'justify-center px-2 py-2' : 'justify-between px-3 py-2'
                }`}
              >
                {isIconRail ? (
                  <Settings className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">Research Lab</p>
                      <p className="truncate text-[10px] text-muted-foreground">Current project</p>
                    </div>
                    <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align={isIconRail ? 'center' : 'start'} className="w-64">
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              <DropdownMenuItem disabled>Research Lab</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  onSettingsClick()
                }}
              >
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {!hidden && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={handleResizeStart}
          className={`absolute -right-2 inset-y-0 z-30 w-5 cursor-col-resize touch-none transition-colors before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 ${
            isResizing ? 'before:bg-primary/45' : 'before:bg-transparent hover:before:bg-border'
          }`}
        />
      )}
    </aside>
  )
}
