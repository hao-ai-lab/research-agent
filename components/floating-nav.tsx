'use client'

import { useState, useEffect } from 'react'
import { Menu, Bell, Settings, PlugZap, Eye, Edit3, Plus, ChevronDown, Type, Code, BarChart3, Sparkles, PanelLeftOpen, Orbit, Pause, Play, Square, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useApiConfig } from '@/lib/api-config'
import type { WildLoopPhase } from '@/lib/types'
import type { RunStats } from '@/hooks/use-wild-loop'
import type { Alert } from '@/lib/api'
import type { ReportCellType } from './report-view'
import type { HomeTab } from '@/lib/navigation'
import type { ChatSession } from '@/lib/api'

const phaseConfig: Record<WildLoopPhase, { icon: string; label: string; color: string }> = {
  idle: { icon: '⏸', label: 'Idle', color: 'text-muted-foreground' },
  starting: { icon: '🚀', label: 'Starting', color: 'text-violet-400' },
  exploring: { icon: '🔭', label: 'Exploring', color: 'text-violet-400' },
  onboarding: { icon: '🎯', label: 'Understanding', color: 'text-violet-400' },
  designing: { icon: '🧪', label: 'Designing', color: 'text-violet-400' },
  monitoring: { icon: '📡', label: 'Monitoring', color: 'text-violet-400' },
  analyzing: { icon: '🔍', label: 'Analyzing', color: 'text-violet-400' },
  fixing: { icon: '🔧', label: 'Fixing', color: 'text-amber-400' },
  complete: { icon: '✅', label: 'Complete', color: 'text-green-400' },
  paused: { icon: '⏯️', label: 'Paused', color: 'text-amber-400' },
  waiting_for_human: { icon: '🙋', label: 'Needs Input', color: 'text-red-400' },
}

interface WildLoopNavProps {
  isActive: boolean
  isPaused: boolean
  phase: WildLoopPhase
  iteration: number
  goal: string | null
  startedAt: number | null
  runStats?: RunStats
  activeAlerts?: Alert[]
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

interface FloatingNavProps {
  activeTab: HomeTab
  onMenuClick: () => void
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
  // Chat-specific props
  eventCount?: number
  onAlertClick?: () => void
  onCreateSweepClick?: () => void
  onOpenContextualClick?: () => void
  showArtifacts?: boolean
  onToggleArtifacts?: () => void
  collapseChats?: boolean
  onToggleCollapseChats?: () => void
  collapseArtifactsInChat?: boolean
  onToggleCollapseArtifactsInChat?: () => void
  // Session selector props (for chat tab)
  sessionTitle?: string
  currentSessionId?: string | null
  sessions?: ChatSession[]
  onSessionChange?: (sessionId: string) => void
  contextTokenCount?: number
  // Wild loop props
  wildLoop?: WildLoopNavProps | null
  // Report-specific props
  reportIsPreviewMode?: boolean
  onReportPreviewModeChange?: (isPreviewMode: boolean) => void
  onReportAddCell?: (type: ReportCellType) => void
}

export function FloatingNav({
  activeTab,
  onMenuClick,
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
  eventCount = 0,
  onAlertClick,
  onCreateSweepClick,
  onOpenContextualClick,
  showArtifacts = false,
  onToggleArtifacts,
  collapseChats = false,
  onToggleCollapseChats,
  collapseArtifactsInChat = false,
  onToggleCollapseArtifactsInChat,
  sessionTitle = 'New Chat',
  currentSessionId,
  sessions = [],
  onSessionChange,
  contextTokenCount = 0,
  wildLoop,
  reportIsPreviewMode = true,
  onReportPreviewModeChange,
  onReportAddCell,
}: FloatingNavProps) {
  const isChat = activeTab === 'chat'
  const isReport = activeTab === 'report'
  const isSparseDesktopNav = !isChat && !isReport
  const { useMock: isDemoMode } = useApiConfig()
  const wl = wildLoop

  const formatTokenCount = (count: number) => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
    return count.toString()
  }

  return (
    <header className={`shrink-0 h-14 flex items-center gap-3 px-3 border-b border-border/80 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75 ${isSparseDesktopNav ? 'lg:hidden' : ''}`}>
      <div className="relative">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className={`h-9 w-9 shrink-0 lg:hidden ${isDemoMode ? 'ring-2 ring-red-500/50 ring-offset-1 ring-offset-background' : ''}`}
        >
          <Menu className={`h-5 w-5 ${isDemoMode ? 'text-red-500' : ''}`} />
          <span className="sr-only">Open menu</span>
        </Button>
        {isDemoMode && (
          <Badge
            variant="destructive"
            className="absolute -top-1.5 -right-2 h-4 px-1 text-[9px] font-bold lg:hidden"
          >
            demo
          </Badge>
        )}
      </div>

      {showDesktopSidebarToggle && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onDesktopSidebarToggle}
          className="hidden h-9 w-9 shrink-0 lg:inline-flex"
          title="Show sidebar"
        >
          <PanelLeftOpen className="h-5 w-5" />
          <span className="sr-only">Show sidebar</span>
        </Button>
      )}

      {/* Session Selector - only show in chat tab */}
      {isChat && onSessionChange && (
        <div className="min-w-0 max-w-md shrink-0">
          <Select
            value={currentSessionId || 'new'}
            onValueChange={onSessionChange}
          >
            <SelectTrigger className="w-full border-0 px-2 py-1.5 shadow-none focus:ring-0 bg-secondary/60 hover:bg-secondary/80 rounded-lg transition-colors h-9">
              <SelectValue>
                <span className="text-base font-semibold text-foreground truncate">
                  {sessionTitle}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">
                <div className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  <span className="font-medium">New Chat</span>
                </div>
              </SelectItem>
              {sessions
                .sort((a, b) => b.created_at - a.created_at)
                .map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    <div className="flex flex-col">
                      <span className="font-medium">{session.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {session.message_count} message{session.message_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Wild Loop status — compact pill + popover */}
      {isChat && wl?.isActive && (
        <WildLoopNavDropdown {...wl} />
      )}

      {/* Context Usage moved to chat input */}

      {/* Spacer to push icons to the right */}
      <div className="flex-1" />

      {/* Right side buttons - only show in chat */}
      {isChat && (
        <div className="flex items-center gap-1 shrink-0">
          {/* Alert Button with Badge */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onAlertClick}
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
            size="icon"
            onClick={onCreateSweepClick}
            className="h-8 w-8"
            title="Create sweep"
          >
            <PlugZap className="h-4 w-4" />
            <span className="sr-only">Create sweep</span>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenContextualClick}
            className="h-8 w-8"
            title="Open contextual chat"
          >
            <Orbit className="h-4 w-4" />
            <span className="sr-only">Open contextual chat</span>
          </Button>

          {/* Settings Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
              >
                <Settings className="h-4 w-4" />
                <span className="sr-only">Chat settings</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Chat Settings</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleArtifacts?.()
                }}
              >
                <Label htmlFor="show-artifacts" className="cursor-pointer">Show artifacts</Label>
                <Switch
                  id="show-artifacts"
                  checked={showArtifacts}
                  onCheckedChange={onToggleArtifacts}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleCollapseChats?.()
                }}
              >
                <Label htmlFor="collapse-chats" className="cursor-pointer">Collapse all chats</Label>
                <Switch
                  id="collapse-chats"
                  checked={collapseChats}
                  onCheckedChange={onToggleCollapseChats}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleCollapseArtifactsInChat?.()
                }}
              >
                <Label htmlFor="collapse-artifacts" className="cursor-pointer">Collapse artifacts in chat</Label>
                <Switch
                  id="collapse-artifacts"
                  checked={collapseArtifactsInChat}
                  onCheckedChange={onToggleCollapseArtifactsInChat}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {isReport && onReportPreviewModeChange && onReportAddCell && (
        <div className="flex items-center gap-2 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                {reportIsPreviewMode ? (
                  <>
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </>
                ) : (
                  <>
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit
                  </>
                )}
                <ChevronDown className="h-3 w-3 ml-1 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => onReportPreviewModeChange(true)}
                className={reportIsPreviewMode ? 'bg-secondary' : ''}
              >
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onReportPreviewModeChange(false)}
                className={!reportIsPreviewMode ? 'bg-secondary' : ''}
              >
                <Edit3 className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Add Cell
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onReportAddCell('markdown')}>
                <Type className="h-4 w-4 mr-2" />
                Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('code')}>
                <Code className="h-4 w-4 mr-2" />
                Code
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('chart')}>
                <BarChart3 className="h-4 w-4 mr-2" />
                Chart
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('insight')}>
                <Sparkles className="h-4 w-4 mr-2" />
                Insight
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  )
}

// ---------------------------------------------------------------------------
// Wild Loop Nav Dropdown — compact pill + popover
// ---------------------------------------------------------------------------

function WildLoopNavDropdown({
  isPaused,
  phase,
  iteration,
  goal,
  startedAt,
  runStats,
  activeAlerts = [],
  onPause,
  onResume,
  onStop,
}: WildLoopNavProps) {
  const [elapsed, setElapsed] = useState('0:00')

  useEffect(() => {
    if (!startedAt) return
    const tick = () => {
      const secs = Math.floor(Date.now() / 1000 - startedAt)
      const mins = Math.floor(secs / 60)
      const hrs = Math.floor(mins / 60)
      setElapsed(
        hrs > 0
          ? `${hrs}:${String(mins % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
          : `${mins}:${String(secs % 60).padStart(2, '0')}`
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startedAt])

  const cfg = phaseConfig[phase] || phaseConfig.idle
  const hasJobs = runStats && runStats.total > 0
  const alertCount = activeAlerts.length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-violet-500/20 shrink-0 ${cfg.color}`}
        >
          <span className="text-sm leading-none">{cfg.icon}</span>
          <span className="hidden sm:inline">{cfg.label}</span>
          <span className="rounded-full bg-violet-500/20 px-1.5 py-px text-[10px] font-semibold text-violet-300">
            #{iteration}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{elapsed}</span>
          {alertCount > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-base">{cfg.icon}</span>
            <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
            <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">
              #{iteration}
            </span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">⏱ {elapsed}</span>
        </div>

        {/* Goal */}
        {goal && (
          <div className="border-b border-border/40 px-4 py-2.5">
            <div className="flex items-start gap-1.5">
              <Target className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{goal}</p>
            </div>
          </div>
        )}

        {/* Run stats */}
        {hasJobs && (
          <div className="border-b border-border/40 px-4 py-2.5">
            <div className="flex flex-wrap gap-2">
              {runStats.running > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-400">
                  🏃 {runStats.running} running
                </span>
              )}
              {runStats.completed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-400">
                  ✅ {runStats.completed} done
                </span>
              )}
              {runStats.failed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-400">
                  ❌ {runStats.failed} failed
                </span>
              )}
              {runStats.queued > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  ⏳ {runStats.queued} queued
                </span>
              )}
            </div>
          </div>
        )}

        {/* Alerts */}
        {alertCount > 0 && (
          <div className="border-b border-border/40 px-4 py-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 border border-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-400 animate-pulse">
              ⚠️ {alertCount} pending alert{alertCount > 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 px-4 py-3">
          {isPaused ? (
            <Button size="sm" onClick={onResume} className="h-7 gap-1.5 text-xs bg-violet-600 hover:bg-violet-700">
              <Play className="h-3 w-3" />
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onPause} className="h-7 gap-1.5 text-xs">
              <Pause className="h-3 w-3" />
              Pause
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onStop} className="h-7 gap-1.5 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10">
            <Square className="h-3 w-3" />
            Stop
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
