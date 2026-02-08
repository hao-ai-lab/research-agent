'use client'

import React from "react"

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import {
  Play,
  AlertCircle,
  CheckCircle2,
  CheckSquare,
  Square,
  Clock,
  XCircle,
  Layers,
  Archive,
  Undo2,
  Palette,
  Star,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Settings2,
  PlugZap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AllRunsChart } from './all-runs-chart'
import { RunDetailView } from './run-detail-view'
import { VisibilityManageView } from './visibility-manage-view'
import { CreateSweepDialog } from './create-sweep-dialog'
import { RunName } from './run-name'
import type { ExperimentRun, TagDefinition, VisibilityGroup } from '@/lib/types'
import type { Alert } from '@/lib/api-client'
import { DEFAULT_RUN_COLORS, getRunsOverview } from '@/lib/mock-data'
import { getStatusText, getStatusBadgeClass as getStatusBadgeClassUtil, getStatusDotColor } from '@/lib/status-utils'
import { createSweep } from '@/lib/api-client'

type DetailsView = 'time' | 'priority'
type GroupByMode = 'none' | 'sweep'
const STORAGE_KEY_RUNS_VIEW_PREFERENCES = 'runsViewPreferences'

const RUN_STATUS_OPTIONS: ExperimentRun['status'][] = [
  'ready',
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
]

// Inline sweep form for popover
function SweepFormPopover({ onClose, onRefresh }: { onClose: () => void; onRefresh?: () => void }) {
  const [name, setName] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [params, setParams] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async () => {
    if (!name.trim() || !command.trim() || !params.trim()) {
      setError('All fields required')
      return
    }

    // Parse params: "lr=0.001,0.01;batch=32,64" -> {lr: [0.001, 0.01], batch: [32, 64]}
    const paramObj: Record<string, unknown[]> = {}
    try {
      params.split(';').forEach(p => {
        const [key, vals] = p.split('=')
        if (key && vals) {
          paramObj[key.trim()] = vals.split(',').map(v => {
            const num = Number(v.trim())
            return isNaN(num) ? v.trim() : num
          })
        }
      })
    } catch {
      setError('Invalid param format')
      return
    }

    if (Object.keys(paramObj).length === 0) {
      setError('At least one parameter required')
      return
    }

    setIsSubmitting(true)
    try {
      await createSweep({
        name: name.trim(),
        base_command: command.trim(),
        parameters: paramObj,
        max_runs: 10,
        auto_start: false,
      })
      onClose()
      onRefresh?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="font-medium text-sm">Create Sweep</div>
      <div className="space-y-2">
        <Input
          placeholder="Sweep name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 text-xs"
        />
        <Textarea
          placeholder="python train.py"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="h-16 text-xs font-mono"
        />
        <Input
          placeholder="lr=0.001,0.01;batch=32,64"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          className="h-8 text-xs font-mono"
        />
        <p className="text-[10px] text-muted-foreground">
          Format: key=val1,val2;key2=val3,val4
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting} className="flex-1">
          {isSubmitting ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

interface RunsViewProps {
  runs: ExperimentRun[]
  onRunClick?: (run: ExperimentRun) => void
  onUpdateRun?: (run: ExperimentRun) => void
  pendingAlertsByRun?: Record<string, number>
  alerts?: Alert[]
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
  onSelectedRunChange?: (run: ExperimentRun | null) => void
  onShowVisibilityManageChange?: (show: boolean) => void
  onRefresh?: () => Promise<void>
  onStartRun?: (runId: string) => Promise<void>
  onStopRun?: (runId: string) => Promise<void>
}

export function RunsView({ runs, onRunClick, onUpdateRun, pendingAlertsByRun = {}, alerts = [], allTags, onCreateTag, onSelectedRunChange, onShowVisibilityManageChange, onRefresh, onStartRun, onStopRun }: RunsViewProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detailsView, setDetailsView] = useState<DetailsView>('time')
  const [manageMode, setManageMode] = useState(false)
  const [selectedManageRunIds, setSelectedManageRunIds] = useState<Set<string>>(new Set())
  const [groupByMode, setGroupByMode] = useState<GroupByMode>('none')
  const [sweepFilter, setSweepFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<Set<ExperimentRun['status']>>(
    () => new Set(RUN_STATUS_OPTIONS)
  )
  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(runs.filter((r) => !r.isArchived).map((r) => r.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)
  const [sweepDialogOpen, setSweepDialogOpen] = useState(false)
  const scrollPositionRef = useRef<number>(0)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const allActiveRuns = runs.filter((r) => !r.isArchived)
  const overview = getRunsOverview(allActiveRuns)
  const selectedRun = selectedRunId ? runs.find(r => r.id === selectedRunId) : null
  const selectedRunAlerts = selectedRun ? alerts.filter(alert => alert.run_id === selectedRun.id) : []
  const sweepOptions = useMemo(
    () =>
      Array.from(new Set(runs.map((run) => run.sweepId).filter(Boolean) as string[])).sort((a, b) =>
        a.localeCompare(b)
      ),
    [runs]
  )

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY_RUNS_VIEW_PREFERENCES)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as {
        detailsView?: DetailsView
        groupByMode?: GroupByMode
        sweepFilter?: string
        statusFilter?: ExperimentRun['status'][]
      }

      if (parsed.detailsView === 'time' || parsed.detailsView === 'priority') {
        setDetailsView(parsed.detailsView)
      }
      if (parsed.groupByMode === 'none' || parsed.groupByMode === 'sweep') {
        setGroupByMode(parsed.groupByMode)
      }
      if (typeof parsed.sweepFilter === 'string') {
        setSweepFilter(parsed.sweepFilter)
      }
      if (Array.isArray(parsed.statusFilter)) {
        const validStatuses = parsed.statusFilter.filter((status): status is ExperimentRun['status'] =>
          RUN_STATUS_OPTIONS.includes(status as ExperimentRun['status'])
        )
        if (validStatuses.length > 0) {
          setStatusFilter(new Set(validStatuses))
        }
      }
    } catch (error) {
      console.warn('Failed to parse runs view preferences:', error)
    }
  }, [])

  useEffect(() => {
    if (sweepFilter === 'all' || sweepFilter === 'none') return
    if (sweepOptions.includes(sweepFilter)) return
    setSweepFilter('all')
  }, [sweepFilter, sweepOptions])

  useEffect(() => {
    const preferences = {
      detailsView,
      groupByMode,
      sweepFilter,
      statusFilter: Array.from(statusFilter),
    }
    window.localStorage.setItem(STORAGE_KEY_RUNS_VIEW_PREFERENCES, JSON.stringify(preferences))
  }, [detailsView, groupByMode, sweepFilter, statusFilter])

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (!statusFilter.has(run.status)) return false
      if (sweepFilter === 'all') return true
      if (sweepFilter === 'none') return !run.sweepId
      return run.sweepId === sweepFilter
    })
  }, [runs, statusFilter, sweepFilter])

  const filteredActiveRuns = useMemo(
    () => filteredRuns.filter((run) => !run.isArchived),
    [filteredRuns]
  )

  const filteredArchivedRuns = useMemo(
    () => filteredRuns.filter((run) => run.isArchived),
    [filteredRuns]
  )

  const selectedManageRuns = useMemo(
    () => filteredRuns.filter((run) => selectedManageRunIds.has(run.id)),
    [filteredRuns, selectedManageRunIds]
  )

  // Sort runs for quick access - favorites first
  const quickAccessRuns = useMemo(() => {
    return [...allActiveRuns].sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1
      if (!a.isFavorite && b.isFavorite) return 1
      return b.startTime.getTime() - a.startTime.getTime()
    }).slice(0, 6)
  }, [allActiveRuns])

  // Sort runs for details view
  const sortedRuns = useMemo(() => {
    if (detailsView === 'time') {
      return [...filteredRuns].sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    }
    // Priority view - group by category
    return filteredRuns
  }, [filteredRuns, detailsView])

  const groupedRunsBySweep = useMemo(() => {
    const groups = new Map<string, ExperimentRun[]>()
    sortedRuns.forEach((run) => {
      const key = run.sweepId || 'no-sweep'
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(run)
    })
    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === 'no-sweep') return 1
        if (b === 'no-sweep') return -1
        return a.localeCompare(b)
      })
      .map(([sweepId, sweepRuns]) => ({ sweepId, runs: sweepRuns }))
  }, [sortedRuns])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Play className="h-3 w-3" />
      case 'failed':
        return <AlertCircle className="h-3 w-3" />
      case 'completed':
        return <CheckCircle2 className="h-3 w-3" />
      case 'canceled':
        return <XCircle className="h-3 w-3" />
      default:
        return <Clock className="h-3 w-3" />
    }
  }

  const getStatusBadgeClass = (status: string) => getStatusBadgeClassUtil(status as any)

  const toggleRunVisibility = (runId: string) => {
    setVisibleRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
    setActiveGroupId(null)
  }

  const handleSelectGroup = (groupId: string | null) => {
    setActiveGroupId(groupId)
    if (groupId) {
      const group = visibilityGroups.find(g => g.id === groupId)
      if (group) {
        setVisibleRunIds(new Set(group.runIds))
      }
    } else {
      setVisibleRunIds(new Set(allActiveRuns.map(r => r.id)))
    }
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups(prev => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups(prev => prev.filter(g => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(allActiveRuns.map(r => r.id)))
    }
  }

  const toggleStatusFilter = (status: ExperimentRun['status']) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }

  const resetStatusFilter = () => {
    setStatusFilter(new Set(RUN_STATUS_OPTIONS))
  }

  const toggleManageRunSelection = (runId: string) => {
    setSelectedManageRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const clearManageSelection = () => {
    setSelectedManageRunIds(new Set())
  }

  const selectAllFilteredRuns = () => {
    setSelectedManageRunIds(new Set(filteredRuns.map((run) => run.id)))
  }

  const archiveSelectedRuns = () => {
    selectedManageRuns.forEach((run) => {
      if (!run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: true })
      }
    })
    clearManageSelection()
  }

  const unarchiveSelectedRuns = () => {
    selectedManageRuns.forEach((run) => {
      if (run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: false })
      }
    })
    clearManageSelection()
  }

  const setColorForSelectedRuns = (color: string) => {
    selectedManageRuns.forEach((run) => {
      onUpdateRun?.({ ...run, color })
    })
  }

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    scrollPositionRef.current = target.scrollTop
  }, [])

  const handleRunClick = (run: ExperimentRun) => {
    setSelectedRunId(run.id)
    onSelectedRunChange?.(run)
    onRunClick?.(run)
  }

  const handleBack = () => {
    setSelectedRunId(null)
    onSelectedRunChange?.(null)
    // Restore scroll position after state update
    requestAnimationFrame(() => {
      if (scrollAreaRef.current) {
        const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]')
        if (viewport) {
          viewport.scrollTop = scrollPositionRef.current
        }
      }
    })
  }

  const handleShowVisibilityManage = (show: boolean) => {
    setShowVisibilityManage(show)
    onShowVisibilityManageChange?.(show)
  }

  const RunItem = ({ run, showChevron = true }: { run: ExperimentRun; showChevron?: boolean }) => {
    const pendingAlertCount = pendingAlertsByRun[run.id] || 0
    const hasPendingAlerts = pendingAlertCount > 0
    const isManageSelectionEnabled = manageMode
    const isSelectedForManage = selectedManageRunIds.has(run.id)

    return (
    <button
      type="button"
      onClick={() => {
        if (isManageSelectionEnabled) {
          toggleManageRunSelection(run.id)
          return
        }
        handleRunClick(run)
      }}
      className={`w-full rounded-xl border bg-card p-3 text-left transition-colors active:scale-[0.99] ${
        isSelectedForManage
          ? 'border-accent bg-accent/10'
          : 'border-border hover:border-muted-foreground/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isManageSelectionEnabled && (
            <span className="shrink-0 text-muted-foreground">
              {isSelectedForManage ? (
                <CheckSquare className="h-4 w-4 text-accent" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </span>
          )}
          <div
            className="h-3 w-3 rounded-full shrink-0"
            style={{ backgroundColor: run.color || '#4ade80' }}
          />
          {hasPendingAlerts && (
            <div className="relative shrink-0" title={`${pendingAlertCount} pending alert${pendingAlertCount > 1 ? 's' : ''}`}>
              <AlertTriangle className="h-4 w-4 text-warning alert-triangle-shake" />
              {pendingAlertCount > 1 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground">
                  {pendingAlertCount}
                </span>
              )}
            </div>
          )}
          <h4 className="font-medium text-sm text-foreground truncate">
            <RunName run={run} />
          </h4>
          {run.isFavorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className={`${getStatusBadgeClass(run.status)}`}>
            {getStatusIcon(run.status)}
            <span className="ml-1 text-[10px]">{getStatusText(run.status)}</span>
          </Badge>
          {showChevron && !isManageSelectionEnabled && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground truncate">
        Run: {run.id}
        {run.sweepId ? ` • Sweep: ${run.sweepId}` : ' • No sweep'}
      </p>
      {run.tags && run.tags.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {run.tags.slice(0, 3).map((tagName) => {
            const tag = allTags.find(t => t.name === tagName)
            return (
              <span
                key={tagName}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: tag ? `${tag.color}20` : '#4ade8020',
                  color: tag?.color || '#4ade80',
                }}
              >
                {tagName}
              </span>
            )
          })}
          {run.tags.length > 3 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground">
              +{run.tags.length - 3}
            </span>
          )}
        </div>
      )}
    </button>
    )
  }

  // Show visibility manage view
  if (showVisibilityManage) {
    return (
      <VisibilityManageView
        runs={runs}
        visibleRunIds={visibleRunIds}
        onToggleVisibility={toggleRunVisibility}
        onSetVisibleRuns={setVisibleRunIds}
        visibilityGroups={visibilityGroups}
        onCreateGroup={handleCreateGroup}
        onDeleteGroup={handleDeleteGroup}
        onUpdateRun={onUpdateRun}
        onBack={() => handleShowVisibilityManage(false)}
      />
    )
  }

  // If a run is selected, show the detail view with slide animation
  if (selectedRun) {
    return (
      <div className="flex flex-col h-full overflow-hidden animate-in slide-in-from-right-5 duration-200">
        <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className="h-9 w-9 shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <Select
              value={selectedRun.id}
              onValueChange={(id) => {
                const newRun = runs.find(r => r.id === id)
                if (newRun) handleRunClick(newRun)
              }}
            >
              <SelectTrigger className="h-auto p-0 border-0 bg-transparent hover:bg-secondary/50 rounded-lg px-2 py-1 -ml-2 focus:ring-0 focus:ring-offset-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: selectedRun.color || '#4ade80' }}
                  />
                  <div className="text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground truncate"><RunName run={selectedRun} /></span>
                      {selectedRun.isFavorite && <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 shrink-0" />}
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {selectedRun.config?.model}
                      {selectedRun.sweepId ? ` • ${selectedRun.sweepId}` : ''}
                    </p>
                  </div>
                </div>
              </SelectTrigger>
              <SelectContent align="start" className="max-h-[300px]">
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: r.color || '#4ade80' }}
                      />
                      <span className="truncate max-w-[180px]"><RunName run={r} /></span>
                      {r.isFavorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
                      <span className={`ml-auto text-[10px] ${getStatusDotColor(r.status).replace('bg-', 'text-')}`}>
                        {getStatusText(r.status)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Badge variant="outline" className={getStatusBadgeClass(selectedRun.status)}>
            {getStatusText(selectedRun.status)}
          </Badge>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <RunDetailView
            run={selectedRun}
            alerts={selectedRunAlerts}
            runs={runs}
            onRunSelect={(r) => handleRunClick(r)}
            onUpdateRun={onUpdateRun}
            allTags={allTags}
            onCreateTag={onCreateTag}
            onRefresh={onRefresh}
            onStartRun={onStartRun}
            onStopRun={onStopRun}
          />
        </div>

        {/* Sweep Dialog */}
        <CreateSweepDialog
          open={sweepDialogOpen}
          onOpenChange={setSweepDialogOpen}
          baseCommand={selectedRun.command}
          onSweepCreated={(sweepId, runCount) => {
            // Dialog will close, runs will be refetched by polling
            console.log(`Created sweep ${sweepId} with ${runCount} runs`)
          }}
        />
      </div>
    )
  }

  const favoriteRuns = filteredActiveRuns.filter(r => r.isFavorite)
  const alertRuns = filteredActiveRuns.filter(r => (pendingAlertsByRun[r.id] || 0) > 0 && !r.isFavorite)
  const runningRuns = filteredActiveRuns.filter(r => r.status === 'running' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const readyRuns = filteredActiveRuns.filter(r => r.status === 'ready' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const queuedRuns = filteredActiveRuns.filter(r => r.status === 'queued' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const failedRuns = filteredActiveRuns.filter(r => r.status === 'failed' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const completedRuns = filteredActiveRuns.filter(r => r.status === 'completed' && !r.isFavorite)
  const canceledRuns = filteredActiveRuns.filter(r => r.status === 'canceled' && !r.isFavorite)
  const isAllStatusSelected = statusFilter.size === RUN_STATUS_OPTIONS.length
  const canArchiveSelection = selectedManageRuns.some((run) => !run.isArchived)
  const canUnarchiveSelection = selectedManageRuns.some((run) => run.isArchived)

  // Overview view (default)
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollAreaRef} onScrollCapture={handleScroll}>
          <div className="p-4 space-y-5">
            {/* Overview Stats */}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                  <Layers className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-sm font-medium text-foreground">
                    Experiments Overview
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {overview.total} total runs
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                <div className="text-center p-2 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <p className="text-lg font-semibold text-blue-400">
                    {overview.running}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Running</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-green-500/10 border border-green-500/30">
                  <p className="text-lg font-semibold text-green-400">
                    {overview.completed}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Finished</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <p className="text-lg font-semibold text-destructive">
                    {overview.failed}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Failed</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-foreground/5 border border-foreground/20">
                  <p className="text-lg font-semibold text-foreground">
                    {overview.queued}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Queued</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-muted/50 border border-muted-foreground/20">
                  <p className="text-lg font-semibold text-muted-foreground">
                    {overview.canceled}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Canceled</p>
                </div>
              </div>
            </div>

            {/* Charts Section */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Charts
              </h3>
              <AllRunsChart
                runs={allActiveRuns}
                visibleRunIds={visibleRunIds}
                onToggleVisibility={toggleRunVisibility}
                visibilityGroups={visibilityGroups}
                activeGroupId={activeGroupId}
                onSelectGroup={handleSelectGroup}
                onOpenManage={() => handleShowVisibilityManage(true)}
              />
            </div>

            {/* Quick Access to Runs */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Quick Access
              </h3>
              <div className="space-y-2">
                {quickAccessRuns.map((run) => (
                  <RunItem key={run.id} run={run} />
                ))}
              </div>
            </div>

            {/* All Runs */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  All Runs
                </h3>
              </div>
              <div className="rounded-xl border border-border bg-card">
                <div className="border-b border-border px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2 overflow-x-auto">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Select value={detailsView} onValueChange={(v) => setDetailsView(v as DetailsView)}>
                        <SelectTrigger className="w-28 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="time">Time</SelectItem>
                          <SelectItem value="priority">Priority</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select value={groupByMode} onValueChange={(v) => setGroupByMode(v as GroupByMode)}>
                        <SelectTrigger className="w-32 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Group: None</SelectItem>
                          <SelectItem value="sweep">Group: Sweep</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select value={sweepFilter} onValueChange={setSweepFilter}>
                        <SelectTrigger className="w-36 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Sweep: All</SelectItem>
                          <SelectItem value="none">No Sweep</SelectItem>
                          {sweepOptions.map((sweepId) => (
                            <SelectItem key={sweepId} value={sweepId}>
                              Sweep: {sweepId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="h-8 text-xs">
                            Status: {isAllStatusSelected ? 'All' : statusFilter.size}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-medium text-foreground">Filter by status</p>
                            <Button variant="ghost" size="sm" onClick={resetStatusFilter} className="h-6 px-2 text-[10px]">
                              Reset
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            {RUN_STATUS_OPTIONS.map((status) => {
                              const selected = statusFilter.has(status)
                              return (
                                <button
                                  key={status}
                                  type="button"
                                  onClick={() => toggleStatusFilter(status)}
                                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                                    selected
                                      ? 'border-primary/40 bg-primary/10 text-primary'
                                      : 'border-border bg-card text-muted-foreground hover:bg-secondary/40'
                                  }`}
                                >
                                  {selected ? <CheckSquare className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-sm border border-current/50" />}
                                  {getStatusText(status)}
                                </button>
                              )
                            })}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>

                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <Popover open={sweepDialogOpen} onOpenChange={setSweepDialogOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5"
                            title="Create Sweep"
                          >
                            <PlugZap className="h-4 w-4" />
                            Sweep
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="end">
                          <SweepFormPopover onClose={() => setSweepDialogOpen(false)} onRefresh={onRefresh} />
                        </PopoverContent>
                      </Popover>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={manageMode ? 'default' : 'outline'}
                            size="icon"
                            onClick={() => {
                              setManageMode((prev) => {
                                const next = !prev
                                if (!next) {
                                  clearManageSelection()
                                }
                                return next
                              })
                            }}
                            aria-label={manageMode ? 'Exit Manage' : 'Manage'}
                            className="h-8 w-8"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{manageMode ? 'Exit Manage' : 'Manage'}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  {manageMode && (
                    <div className="rounded-lg border border-border bg-card px-2 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {selectedManageRuns.length} selected
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={selectedManageRuns.length === filteredRuns.length ? clearManageSelection : selectAllFilteredRuns}
                          className="h-7 px-2 text-[11px]"
                        >
                          {selectedManageRuns.length === filteredRuns.length ? 'Clear' : 'Select All'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={archiveSelectedRuns}
                          disabled={selectedManageRuns.length === 0 || !canArchiveSelection}
                          className="h-7 px-2 text-[11px]"
                        >
                          <Archive className="mr-1 h-3 w-3" />
                          Archive
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={unarchiveSelectedRuns}
                          disabled={selectedManageRuns.length === 0 || !canUnarchiveSelection}
                          className="h-7 px-2 text-[11px]"
                        >
                          <Undo2 className="mr-1 h-3 w-3" />
                          Unarchive
                        </Button>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={selectedManageRuns.length === 0}
                              className="h-7 px-2 text-[11px]"
                            >
                              <Palette className="mr-1 h-3 w-3" />
                              Color
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-44 p-3" align="start">
                            <p className="mb-2 text-xs font-medium text-muted-foreground">
                              Color for selected
                            </p>
                            <div className="grid grid-cols-5 gap-2">
                              {DEFAULT_RUN_COLORS.map((color) => (
                                <button
                                  key={color}
                                  type="button"
                                  onClick={() => setColorForSelectedRuns(color)}
                                  className="h-7 w-7 rounded-full border-2 border-transparent transition-transform hover:scale-110 hover:border-foreground"
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-4 space-y-5">
                  {detailsView === 'priority' ? (
                    <>
                      {favoriteRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Star className="h-4 w-4 text-yellow-500" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Favorites</h4>
                          </div>
                          <div className="space-y-2">
                            {favoriteRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {alertRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <AlertTriangle className="h-4 w-4 text-warning" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Has Alerts</h4>
                          </div>
                          <div className="space-y-2">
                            {alertRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {runningRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Play className="h-4 w-4 text-accent" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Running</h4>
                          </div>
                          <div className="space-y-2">
                            {runningRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {readyRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Clock className="h-4 w-4 text-amber-400" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Ready</h4>
                          </div>
                          <div className="space-y-2">
                            {readyRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {queuedRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Clock className="h-4 w-4 text-foreground" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Queued</h4>
                          </div>
                          <div className="space-y-2">
                            {queuedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {failedRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <AlertCircle className="h-4 w-4 text-destructive" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Failed</h4>
                          </div>
                          <div className="space-y-2">
                            {failedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {completedRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <CheckCircle2 className="h-4 w-4 text-green-400" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Finished</h4>
                          </div>
                          <div className="space-y-2">
                            {completedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {canceledRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <XCircle className="h-4 w-4 text-muted-foreground" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Canceled</h4>
                          </div>
                          <div className="space-y-2">
                            {canceledRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {filteredArchivedRuns.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Archive className="h-4 w-4 text-muted-foreground" />
                            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Archived</h4>
                          </div>
                          <div className="space-y-2 opacity-60">
                            {filteredArchivedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          </div>
                        </div>
                      )}
                      {filteredRuns.length === 0 && (
                        <div className="py-10 text-center text-sm text-muted-foreground">
                          No runs match the current filters.
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {groupByMode === 'sweep' ? (
                        groupedRunsBySweep.length > 0 ? (
                          groupedRunsBySweep.map((group) => (
                            <div key={group.sweepId}>
                              <div className="flex items-center gap-2 mb-3">
                                <PlugZap className="h-4 w-4 text-muted-foreground" />
                                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                  {group.sweepId === 'no-sweep' ? 'No Sweep' : `Sweep ${group.sweepId}`}
                                </h4>
                              </div>
                              <div className="space-y-2">
                                {group.runs.map((run) => <RunItem key={run.id} run={run} />)}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="py-10 text-center text-sm text-muted-foreground">
                            No runs match the current filters.
                          </div>
                        )
                      ) : (
                        <div className="space-y-2">
                          {sortedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                          {sortedRuns.length === 0 && (
                            <div className="py-10 text-center text-sm text-muted-foreground">
                              No runs match the current filters.
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Sweep Dialog */}
      <CreateSweepDialog
        open={sweepDialogOpen}
        onOpenChange={setSweepDialogOpen}
        onSweepCreated={(sweepId, runCount) => {
          console.log(`Created sweep ${sweepId} with ${runCount} runs`)
        }}
      />
    </div>
  )
}
