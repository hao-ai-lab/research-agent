'use client'

import { useMemo } from 'react'
import {
  BarChart3,
  Bell,
  ChevronsUpDown,
  FileText,
  FlaskConical,
  Lightbulb,
  List,
  MessageSquare,
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
import type { ChatSession } from '@/lib/api'
import type { ExperimentRun, Sweep } from '@/lib/types'
import { getStatusText } from '@/lib/status-utils'
import type { JourneySubTab, RunsSubTab } from './nav-page'

type ActiveTab = 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report'

interface DesktopSidebarProps {
  activeTab: ActiveTab
  runsSubTab: RunsSubTab
  journeySubTab: JourneySubTab
  sessions: ChatSession[]
  runs: ExperimentRun[]
  sweeps: Sweep[]
  onTabChange: (tab: ActiveTab) => void
  onRunsSubTabChange: (subTab: RunsSubTab) => void
  onJourneySubTabChange: (subTab: JourneySubTab) => void
  onNewChat: () => Promise<void> | void
  onSelectSession: (sessionId: string) => Promise<void> | void
  onNavigateToRun: (runId: string) => void
  onInsertReference: (text: string) => void
  onSettingsClick: () => void
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
  runsSubTab,
  journeySubTab,
  sessions,
  runs,
  sweeps,
  onTabChange,
  onRunsSubTabChange,
  onJourneySubTabChange,
  onNewChat,
  onSelectSession,
  onNavigateToRun,
  onInsertReference,
  onSettingsClick,
}: DesktopSidebarProps) {
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

  return (
    <aside className="hidden h-full w-[300px] shrink-0 border-r border-border bg-background lg:flex">
      <div className="flex h-full w-full flex-col">
        <div className="shrink-0 border-b border-border px-3 py-3">
          <Button
            className="w-full justify-start gap-2 bg-accent text-accent-foreground hover:bg-accent/90"
            onClick={() => {
              void onNewChat()
            }}
          >
            <Plus className="h-4 w-4" />
            New Chat
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-3 py-3">
            <section>
              <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Sections
              </p>
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => onTabChange('chat')}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'chat'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <MessageSquare className="h-4 w-4" />
                  Chat
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onTabChange('runs')
                    onRunsSubTabChange('overview')
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'runs' && runsSubTab === 'overview'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <FlaskConical className="h-4 w-4" />
                  Runs Overview
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onTabChange('runs')
                    onRunsSubTabChange('details')
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'runs' && runsSubTab === 'details'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <List className="h-4 w-4" />
                  Runs Details
                </button>

                <button
                  type="button"
                  onClick={() => onTabChange('events')}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'events'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Bell className="h-4 w-4" />
                  Events
                </button>

                <button
                  type="button"
                  onClick={() => onTabChange('charts')}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'charts'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <BarChart3 className="h-4 w-4" />
                  Charts
                </button>

                <button
                  type="button"
                  onClick={() => onTabChange('memory')}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'memory'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Lightbulb className="h-4 w-4" />
                  Memory
                </button>

                <button
                  type="button"
                  onClick={() => onTabChange('report')}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'report'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <FileText className="h-4 w-4" />
                  Report
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onTabChange('journey')
                    onJourneySubTabChange(journeySubTab)
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ${
                    activeTab === 'journey'
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Sparkles className="h-4 w-4" />
                  Journey
                </button>
              </div>
            </section>

            <section>
              <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent Chats
              </p>
              <div className="space-y-1">
                {sessions.slice(0, 10).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      onTabChange('chat')
                      void onSelectSession(session.id)
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary/50"
                  >
                    <span className="truncate">{session.title || 'Untitled chat'}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatRelativeTime(new Date(session.created_at * 1000))}
                    </span>
                  </button>
                ))}
                {sessions.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No recent chats yet.</p>
                )}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recent Runs
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
                      className="h-6 px-2 text-[10px]"
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

            <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recent Sweeps
                </p>
                <span className="text-[10px] text-muted-foreground">Click to reference</span>
              </div>
              <div className="space-y-1">
                {recentSweeps.map((sweep) => (
                  <button
                    key={sweep.id}
                    type="button"
                    onClick={() => onInsertReference(`/sweep ${sweep.id} `)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{sweep.config.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{sweep.id}</p>
                    </div>
                    <Badge variant="outline" className={`text-[10px] ${getSweepStatusClass(sweep.status)}`}>
                      {sweep.status}
                    </Badge>
                  </button>
                ))}
                {recentSweeps.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No sweeps yet.</p>
                )}
              </div>
            </section>
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t border-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-secondary/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">Research Lab</p>
                  <p className="truncate text-[10px] text-muted-foreground">Current project</p>
                </div>
              <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-64">
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
    </aside>
  )
}
