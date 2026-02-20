'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  AtSign,
  Archive,
  Clock3,
  ChevronsUpDown,
  Ellipsis,
  PanelLeftClose,
  Pencil,
  Plus,
  Settings,
  Star,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useApiConfig } from '@/lib/api-config'
import type { Alert, ChatSession, ChatSessionStatus, ChatMessageData } from '@/lib/api'
import { getSession } from '@/lib/api'
import type { ExperimentRun, Sweep } from '@/lib/types'
import { MessageSquare } from 'lucide-react'
import type { AppTab, HomeTab } from '@/lib/navigation'
import { PRIMARY_NAV_ITEMS } from '@/components/navigation/nav-items'
import { NavTabButton } from '@/components/navigation/nav-tab-button'
import { useAppSettings } from '@/lib/app-settings'

const ICON_RAIL_WIDTH = 72
const ICON_RAIL_TRIGGER_WIDTH = 136

interface DesktopSidebarProps {
  activeTab: AppTab
  hidden?: boolean
  width?: number
  minWidth?: number
  maxWidth?: number
  sessions: ChatSession[]
  savedSessionIds?: string[]
  runs: ExperimentRun[]
  sweeps: Sweep[]
  pendingAlertsByRun?: Record<string, number>
  alerts?: Alert[]
  currentSessionId?: string | null
  isCurrentSessionStreaming?: boolean
  /** Messages for the currently active session (avoids redundant API fetch) */
  currentMessages?: ChatMessageData[]
  /** Callback when a round is clicked in the hover card */
  onScrollToRound?: (sessionId: string, roundIndex: number) => void
  onTabChange: (tab: HomeTab | 'contextual') => void
  onNewChat: () => Promise<void> | void
  onSelectSession: (sessionId: string) => Promise<void> | void
  onSaveSession?: (sessionId: string) => Promise<void> | void
  onUnsaveSession?: (sessionId: string) => Promise<void> | void
  onArchiveSession?: (sessionId: string) => Promise<void> | void
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void
  onNavigateToRun: (runId: string) => void
  onNavigateToSweep?: (sweepId: string) => void
  onInsertReference: (text: string) => void
  onOpenCreateRun?: () => void
  onOpenCreateSweep?: () => void
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

export function DesktopSidebar({
  activeTab,
  hidden = false,
  width = 300,
  minWidth = 240,
  maxWidth = 520,
  sessions,
  savedSessionIds = [],
  runs,
  sweeps,
  pendingAlertsByRun = {},
  alerts = [],
  currentSessionId = null,
  isCurrentSessionStreaming = false,
  currentMessages,
  onScrollToRound,
  onTabChange,
  onNewChat,
  onSelectSession,
  onSaveSession,
  onUnsaveSession,
  onArchiveSession,
  onRenameSession,
  onNavigateToRun,
  onNavigateToSweep,
  onInsertReference,
  onOpenCreateRun,
  onOpenCreateSweep,
  onSettingsClick,
  onToggleCollapse,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
}: DesktopSidebarProps) {
  const [activePreviewKey, setActivePreviewKey] = useState<string | null>(null)
  const [isRunsMenuOpen, setIsRunsMenuOpen] = useState(false)

  // Cache for lazily-fetched session rounds (non-current sessions)
  type RoundPreview = { content: string; roundIndex: number }
  const [roundsCache, setRoundsCache] = useState<Record<string, RoundPreview[]>>({})
  const fetchingRef = useRef<Set<string>>(new Set())

  /** Compute rounds from a messages array */
  const computeRounds = useCallback((msgs: ChatMessageData[]): RoundPreview[] => {
    const rounds: RoundPreview[] = []
    let roundIdx = 0
    for (const msg of msgs) {
      if (msg.role === 'user' && msg.content?.trim()) {
        rounds.push({ content: msg.content, roundIndex: roundIdx })
        roundIdx++
      }
    }
    return rounds
  }, [])

  /** Fetch rounds for a session on hover (uses cache or current messages) */
  const fetchRoundsForSession = useCallback(async (sessionId: string) => {
    // Already cached
    if (roundsCache[sessionId]) return

    // Use current messages if this is the active session
    if (sessionId === currentSessionId && currentMessages) {
      const rounds = computeRounds(currentMessages)
      setRoundsCache(prev => ({ ...prev, [sessionId]: rounds }))
      return
    }

    // Already fetching
    if (fetchingRef.current.has(sessionId)) return
    fetchingRef.current.add(sessionId)

    try {
      const sessionData = await getSession(sessionId)
      const rounds = computeRounds(sessionData.messages)
      setRoundsCache(prev => ({ ...prev, [sessionId]: rounds }))
    } catch {
      // Silently fail — hover card will show "No rounds" or loading
    } finally {
      fetchingRef.current.delete(sessionId)
    }
  }, [roundsCache, currentSessionId, currentMessages, computeRounds])

  // Keep cache for current session in sync with live messages
  useEffect(() => {
    if (currentSessionId && currentMessages) {
      const rounds = computeRounds(currentMessages)
      setRoundsCache(prev => ({ ...prev, [currentSessionId]: rounds }))
    }
  }, [currentSessionId, currentMessages, computeRounds])

  /** Render the inside of a rounds HoverCard */
  const renderRoundsHoverContent = useCallback((sessionId: string, sessionTitle: string) => {
    const rounds = roundsCache[sessionId]
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 pb-1 border-b border-border/60">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-medium text-foreground truncate">{sessionTitle || 'Untitled chat'}</p>
          {rounds && <span className="ml-auto text-[10px] text-muted-foreground">{rounds.length} round{rounds.length !== 1 ? 's' : ''}</span>}
        </div>
        {!rounds ? (
          <p className="text-xs text-muted-foreground py-1">Loading…</p>
        ) : rounds.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">No messages yet</p>
        ) : (
          <div className="max-h-[240px] overflow-y-auto space-y-0.5">
            {rounds.map((round) => (
              <button
                key={round.roundIndex}
                type="button"
                className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-secondary/70"
                onClick={(e) => {
                  e.stopPropagation()
                  onScrollToRound?.(sessionId, round.roundIndex)
                }}
              >
                <span className="shrink-0 mt-px inline-flex h-4 min-w-4 items-center justify-center rounded bg-secondary text-[10px] font-medium text-muted-foreground">
                  {round.roundIndex + 1}
                </span>
                <span className="min-w-0 line-clamp-2 text-foreground">
                  {round.content.length > 80 ? round.content.slice(0, 77) + '…' : round.content}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }, [roundsCache, onScrollToRound])

  const getRunStatusMeta = useCallback((status: ExperimentRun['status']) => {
    switch (status) {
      case 'running':
        return { label: 'Running', className: 'text-blue-500', icon: <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" /> }
      case 'failed':
        return { label: 'Failed', className: 'text-destructive', icon: <span className="h-2.5 w-2.5 rounded-full bg-destructive" /> }
      case 'completed':
        return { label: 'Completed', className: 'text-emerald-500', icon: <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> }
      case 'canceled':
        return { label: 'Canceled', className: 'text-muted-foreground', icon: <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" /> }
      case 'queued':
        return { label: 'Queued', className: 'text-muted-foreground', icon: <Clock3 className="h-3 w-3" /> }
      case 'ready':
      default:
        return { label: 'Ready', className: 'text-muted-foreground', icon: <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/90" /> }
    }
  }, [])

  const getSweepStatusMeta = useCallback((status: Sweep['status']) => {
    switch (status) {
      case 'running':
        return { label: 'Running', className: 'text-blue-500', icon: <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" /> }
      case 'completed':
        return { label: 'Completed', className: 'text-emerald-500', icon: <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> }
      case 'failed':
        return { label: 'Failed', className: 'text-destructive', icon: <span className="h-2.5 w-2.5 rounded-full bg-destructive" /> }
      case 'pending':
        return { label: 'Pending', className: 'text-muted-foreground', icon: <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/90" /> }
      case 'draft':
        return { label: 'Draft', className: 'text-muted-foreground', icon: <span className="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground/80 bg-transparent" /> }
      case 'canceled':
      default:
        return { label: 'Canceled', className: 'text-muted-foreground', icon: <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" /> }
    }
  }, [])

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
  const { settings } = useAppSettings()
  const showSidebarNewChatButton = settings.appearance.showSidebarNewChatButton === true
  const showSidebarRunsSweepsPreview = settings.developer?.showSidebarRunsSweepsPreview !== false
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(width)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  const startEditing = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId)
    setEditingTitle(currentTitle || 'Untitled chat')
  }, [])

  const commitRename = useCallback(() => {
    if (editingSessionId && editingTitle.trim()) {
      void onRenameSession?.(editingSessionId, editingTitle.trim())
    }
    setEditingSessionId(null)
    setEditingTitle('')
  }, [editingSessionId, editingTitle, onRenameSession])

  const cancelEditing = useCallback(() => {
    setEditingSessionId(null)
    setEditingTitle('')
  }, [])
  const savedSessionIdSet = useMemo(() => new Set(savedSessionIds), [savedSessionIds])
  const savedSessions = useMemo(
    () => sessions.filter((session) => savedSessionIdSet.has(session.id)).slice(0, 10),
    [sessions, savedSessionIdSet]
  )
  const recentSessions = useMemo(
    () => sessions.filter((session) => !savedSessionIdSet.has(session.id)).slice(0, 10),
    [sessions, savedSessionIdSet]
  )
  const pendingAlertSessionIdSet = useMemo(
    () =>
      new Set(
        alerts
          .filter((alert) => alert.status === 'pending' && typeof alert.session_id === 'string')
          .map((alert) => alert.session_id as string)
      ),
    [alerts]
  )

  const getSessionStatus = useCallback((session: ChatSession): ChatSessionStatus => {
    if (pendingAlertSessionIdSet.has(session.id)) return 'awaiting_human'
    if (isCurrentSessionStreaming && currentSessionId === session.id) return 'running'
    return session.status || (session.message_count > 0 ? 'completed' : 'idle')
  }, [currentSessionId, isCurrentSessionStreaming, pendingAlertSessionIdSet])

  const renderSessionStatusIcon = useCallback((status: ChatSessionStatus) => {
    switch (status) {
      case 'running':
        return (
          <span title="Running" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-blue-500">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
          </span>
        )
      case 'completed':
        return (
          <span title="Completed" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-emerald-500">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
        )
      case 'failed':
        return (
          <span title="Failed" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-destructive">
            <span className="h-2.5 w-2.5 rounded-full bg-destructive" />
          </span>
        )
      case 'questionable':
        return (
          <span title="Needs review" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        )
      case 'awaiting_human':
        return (
          <span title="Awaiting response" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-amber-500">
            <AlertCircle className="h-3.5 w-3.5" />
          </span>
        )
      default:
        return (
          <span title="Idle" className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/90" />
          </span>
        )
    }
  }, [])

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
      className={`relative hidden h-full shrink-0 border-r border-border/80 bg-sidebar/90 backdrop-blur supports-[backdrop-filter]:bg-sidebar/75 transition-[width] ${isResizing ? 'duration-0' : 'duration-200'
        } lg:flex ${hidden ? 'w-0 border-r-0 overflow-hidden' : isIconRail ? 'w-[72px]' : ''
        }`}
      style={hidden || isIconRail ? undefined : { width: `${width}px` }}
    >
      <div className={`flex h-full w-full flex-col ${hidden ? 'pointer-events-none opacity-0' : ''}`}>
        <div className={`shrink-0 ${isIconRail ? 'px-2 py-2' : 'px-3 py-2'}`}>
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
                {showSidebarNewChatButton && (
                  <Button
                    type="button"
                    title="New Chat"
                    variant="ghost"
                    size={isIconRail ? 'icon-sm' : 'sm'}
                    onClick={() => {
                      void onNewChat()
                    }}
                    className={isIconRail ? 'h-[var(--app-btn-icon-sm)] w-full' : 'h-[var(--app-btn-h-sm)] w-full justify-start px-2.5'}
                  >
                    <Plus className={`h-4 w-4 shrink-0 ${isIconRail ? '' : 'mr-2'}`} />
                    {!isIconRail && 'New Chat'}
                    <span className="sr-only">New Chat</span>
                  </Button>
                )}
                {PRIMARY_NAV_ITEMS
                  .filter((item) => {
                    if (item.tab === 'plans') return settings.developer?.showPlanPanel
                    if (item.tab === 'memory') return settings.developer?.showMemoryPanel
                    if (item.tab === 'report') return settings.developer?.showReportPanel
                    if (item.tab === 'terminal') return settings.developer?.showTerminalPanel
                    if (item.tab === 'contextual') return settings.developer?.showContextualPanel

                    const configItem = settings.leftPanel?.items.find((i) => i.id === item.tab)
                    if (configItem) return configItem.visible

                    return true
                  })
                  .map((item) => {
                    if (item.tab === 'runs') {
                      return (
                        <DropdownMenu key={item.tab} open={isRunsMenuOpen} onOpenChange={setIsRunsMenuOpen}>
                          <DropdownMenuTrigger asChild>
                            <div
                              onMouseEnter={() => setIsRunsMenuOpen(true)}
                              onMouseLeave={() => setIsRunsMenuOpen(false)}
                            >
                              <NavTabButton
                                compact={isIconRail}
                                label={item.label}
                                icon={item.icon}
                                active={activeTab === item.tab}
                                onClick={() => onTabChange('runs')}
                              />
                            </div>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            side="right"
                            align="start"
                            className="w-64 max-h-[400px] overflow-y-auto"
                            onMouseEnter={() => setIsRunsMenuOpen(true)}
                            onMouseLeave={() => setIsRunsMenuOpen(false)}
                          >
                            <DropdownMenuItem onSelect={() => onTabChange('runs')}>
                              <span className="font-medium">View All Runs</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {runs.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                No runs found
                              </div>
                            ) : (
                              [...runs]
                                .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
                                .slice(0, 20)
                                .map((run) => {
                                  const runStatus = getRunStatusMeta(run.status)

                                  return (
                                    <DropdownMenuItem
                                      key={run.id}
                                      onSelect={() => onNavigateToRun(run.id)}
                                      className="flex flex-col items-start gap-1 p-2 focus:bg-accent focus:text-accent-foreground"
                                    >
                                      <div className="flex w-full items-center gap-2 overflow-hidden">
                                        <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                          {runStatus.icon}
                                        </div>
                                        <span className="truncate font-medium">{run.alias || run.name || run.id}</span>
                                      </div>
                                      <div className="flex w-full items-center justify-between gap-2 pl-6 text-[10px] text-muted-foreground">
                                        <span>{runStatus.label}</span>
                                        <span>{formatRelativeTime(run.startTime)}</span>
                                      </div>
                                    </DropdownMenuItem>
                                  )
                                })
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )
                    }
                    return (
                      <NavTabButton
                        key={item.tab}
                        compact={isIconRail}
                        label={item.label}
                        icon={item.icon}
                        active={activeTab === item.tab}
                        onClick={() => onTabChange(item.tab)}
                      />
                    )
                  })}
              </div>
            </section>

            {!isIconRail && (
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Saved
                  </p>
                </div>
                <div className="space-y-1">
                  {savedSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors hover:bg-secondary/50"
                    >
                      {editingSessionId === session.id ? (
                        <div className="inline-flex min-w-0 flex-1 items-center gap-1">
                          <Star className="h-3 w-3 shrink-0 text-amber-500 fill-amber-500" />
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                              if (e.key === 'Escape') cancelEditing()
                            }}
                            onBlur={commitRename}
                            className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                            autoFocus
                          />
                        </div>
                      ) : (
                        <HoverCard openDelay={300} closeDelay={100}>
                          <HoverCardTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                onTabChange('chat')
                                void onSelectSession(session.id)
                              }}
                              onMouseEnter={() => void fetchRoundsForSession(session.id)}
                              className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1 truncate text-foreground">
                                <Star className="h-3 w-3 shrink-0 text-amber-500 fill-amber-500" />
                                {renderSessionStatusIcon(getSessionStatus(session))}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="min-w-0 truncate">{session.title || 'Untitled chat'}</span>
                                  </TooltipTrigger>
                                  <TooltipContent>{session.title || 'Untitled chat'}</TooltipContent>
                                </Tooltip>
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {formatRelativeTime(new Date(session.created_at * 1000))}
                              </span>
                            </button>
                          </HoverCardTrigger>
                          <HoverCardContent side="right" align="start" className="w-72 p-2.5">
                            {renderRoundsHoverContent(session.id, session.title)}
                          </HoverCardContent>
                        </HoverCard>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                            title="Chat options"
                          >
                            <Ellipsis className="h-3.5 w-3.5" />
                            <span className="sr-only">Chat options</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => startEditing(session.id, session.title)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void onUnsaveSession?.(session.id)}>
                            <Star className="mr-2 h-3.5 w-3.5" />
                            Unsave
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onInsertReference(`@chat:${session.id} `)}>
                            <AtSign className="mr-2 h-3.5 w-3.5" />
                            Reference @
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!onArchiveSession}
                            onSelect={() => void onArchiveSession?.(session.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Archive className="mr-2 h-3.5 w-3.5" />
                            Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                  {savedSessions.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">No saved chats yet.</p>
                  )}
                </div>
              </section>
            )}

            {!isIconRail && (
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Chats
                  </p>
                </div>
                <div className="space-y-1">
                  {recentSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors hover:bg-secondary/50"
                    >
                      {editingSessionId === session.id ? (
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                            if (e.key === 'Escape') cancelEditing()
                          }}
                          onBlur={commitRename}
                          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                          autoFocus
                        />
                      ) : (
                        <HoverCard openDelay={300} closeDelay={100}>
                          <HoverCardTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                onTabChange('chat')
                                void onSelectSession(session.id)
                              }}
                              onMouseEnter={() => void fetchRoundsForSession(session.id)}
                              className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1 truncate text-foreground">
                                {renderSessionStatusIcon(getSessionStatus(session))}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="min-w-0 truncate">{session.title || 'Untitled chat'}</span>
                                  </TooltipTrigger>
                                  <TooltipContent>{session.title || 'Untitled chat'}</TooltipContent>
                                </Tooltip>
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {formatRelativeTime(new Date(session.created_at * 1000))}
                              </span>
                            </button>
                          </HoverCardTrigger>
                          <HoverCardContent side="right" align="start" className="w-72 p-2.5">
                            {renderRoundsHoverContent(session.id, session.title)}
                          </HoverCardContent>
                        </HoverCard>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                            title="Chat options"
                          >
                            <Ellipsis className="h-3.5 w-3.5" />
                            <span className="sr-only">Chat options</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => startEditing(session.id, session.title)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void onSaveSession?.(session.id)}>
                            <Star className="mr-2 h-3.5 w-3.5" />
                            Save
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onInsertReference(`@chat:${session.id} `)}>
                            <AtSign className="mr-2 h-3.5 w-3.5" />
                            Reference @
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!onArchiveSession}
                            onSelect={() => void onArchiveSession?.(session.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Archive className="mr-2 h-3.5 w-3.5" />
                            Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                  {recentSessions.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">No recent chats yet.</p>
                  )}
                </div>
              </section>
            )}

            {!isIconRail && showSidebarRunsSweepsPreview && (
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Runs
                  </p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={() => onOpenCreateRun?.()}
                        disabled={!onOpenCreateRun}
                        title="Create run"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="sr-only">Create run</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Create run</TooltipContent>
                  </Tooltip>
                </div>
                <div className="space-y-1">
                  {recentRuns.map((run) => {
                    const pendingAlertCount = pendingAlertsByRun[run.id] || run.alerts?.length || 0
                    const hasPendingAlerts = pendingAlertCount > 0
                    const runStatus = getRunStatusMeta(run.status)
                    const runTitle = run.alias || run.name

                    return (
                      <div
                        key={run.id}
                        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/50"
                      >
                        <HoverCard openDelay={200} closeDelay={100}>
                          <HoverCardTrigger asChild>
                            <button
                              type="button"
                              title={runTitle}
                              className="min-w-0 flex-1 text-left"
                              onClick={() => onNavigateToRun(run.id)}
                            >
                              <div className="flex items-center gap-1.5">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${runStatus.className}`}>
                                      {runStatus.icon}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{runStatus.label}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <p className="min-w-0 truncate text-foreground">{runTitle}</p>
                                  </TooltipTrigger>
                                  <TooltipContent>{runTitle}</TooltipContent>
                                </Tooltip>
                                {hasPendingAlerts && (
                                  <div
                                    className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center"
                                    title={`${pendingAlertCount} pending alert${pendingAlertCount > 1 ? 's' : ''}`}
                                  >
                                    <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                                    {pendingAlertCount > 1 && (
                                      <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground">
                                        {pendingAlertCount}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </button>
                          </HoverCardTrigger>
                          <HoverCardContent side="right" align="start" className="w-80 p-3">
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">{runTitle}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">{run.id}</p>
                                </div>
                                <span className={`inline-flex shrink-0 items-center gap-1 text-xs ${runStatus.className}`}>
                                  {runStatus.icon}
                                  {runStatus.label}
                                </span>
                              </div>
                              <p className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
                                {run.command}
                              </p>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[16px]"
                          onClick={() => onInsertReference(`@run:${run.id} `)}
                        >
                          @
                        </Button>
                      </div>
                    )
                  })}
                  {recentRuns.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">No recent runs yet.</p>
                  )}
                </div>
              </section>
            )}

            {!isIconRail && showSidebarRunsSweepsPreview && (
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Sweeps
                  </p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={() => onOpenCreateSweep?.()}
                        disabled={!onOpenCreateSweep}
                        title="Create sweep"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="sr-only">Create sweep</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Create sweep</TooltipContent>
                  </Tooltip>
                </div>
                <div className="space-y-1">
                  {recentSweeps.map((sweep) => {
                    const sweepStatus = getSweepStatusMeta(sweep.status)
                    const sweepTitle = sweep.config.name || sweep.creationContext.name || sweep.id
                    const sweepCommand = sweep.config.command || sweep.creationContext.command

                    return (
                      <div
                        key={sweep.id}
                        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/50"
                      >
                        <HoverCard openDelay={200} closeDelay={100}>
                          <HoverCardTrigger asChild>
                            <button
                              type="button"
                              title={sweepTitle}
                              className="min-w-0 flex-1 text-left"
                              onClick={() => void onNavigateToSweep?.(sweep.id)}
                            >
                              <div className="flex items-center gap-1.5">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${sweepStatus.className}`}>
                                      {sweepStatus.icon}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{sweepStatus.label}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <p className="min-w-0 truncate text-sm text-foreground">{sweepTitle}</p>
                                  </TooltipTrigger>
                                  <TooltipContent>{sweepTitle}</TooltipContent>
                                </Tooltip>
                              </div>
                              <p className="truncate text-[10px] text-muted-foreground">{sweep.id}</p>
                            </button>
                          </HoverCardTrigger>
                          <HoverCardContent side="right" align="start" className="w-80 p-3">
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">{sweepTitle}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">{sweep.id}</p>
                                </div>
                                <span className={`inline-flex shrink-0 items-center gap-1 text-xs ${sweepStatus.className}`}>
                                  {sweepStatus.icon}
                                  {sweepStatus.label}
                                </span>
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                {sweep.progress.completed}/{sweep.progress.total} runs completed
                              </p>
                              <p className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
                                {sweepCommand}
                              </p>
                            </div>
                          </HoverCardContent>
                        </HoverCard>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[16px]"
                          onClick={() => onInsertReference(`@sweep:${sweep.id} `)}
                        >
                          @
                        </Button>
                      </div>
                    )
                  })}
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
                className={`flex w-full items-center rounded-lg border border-border bg-card text-left transition-colors hover:bg-secondary/60 ${isIconRail ? 'justify-center px-2 py-2' : 'justify-between px-3 py-2'
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
          className={`absolute -right-2 inset-y-0 z-30 w-5 cursor-col-resize touch-none transition-colors before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 ${isResizing ? 'before:bg-primary/45' : 'before:bg-transparent hover:before:bg-border'
            }`}
        />
      )}
    </aside>
  )
}
