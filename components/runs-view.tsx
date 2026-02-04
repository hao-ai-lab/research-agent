'use client'

import React from "react"

import { useState, useMemo, useRef, useCallback } from 'react'
import {
  Play,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  Layers,
  Archive,
  Star,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Repeat,
  PlugZap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { RunManageView } from './run-manage-view'
import { VisibilityManageView } from './visibility-manage-view'
import { CreateSweepDialog } from './create-sweep-dialog'
import { RunName } from './run-name'
import type { ExperimentRun, TagDefinition, VisibilityGroup } from '@/lib/types'
import { getRunsOverview } from '@/lib/mock-data'
import { getStatusText, getStatusBadgeClass as getStatusBadgeClassUtil, getStatusDotColor } from '@/lib/status-utils'
import { createSweep } from '@/lib/api'

type RunsSubTab = 'overview' | 'details' | 'manage'
type DetailsView = 'time' | 'priority'

// Inline sweep form for popover
function SweepFormPopover({ onClose }: { onClose: () => void }) {
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
  subTab: RunsSubTab
  onRunClick?: (run: ExperimentRun) => void
  onUpdateRun?: (run: ExperimentRun) => void
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
  onSelectedRunChange?: (run: ExperimentRun | null) => void
  onShowVisibilityManageChange?: (show: boolean) => void
}

export function RunsView({ runs, subTab, onRunClick, onUpdateRun, allTags, onCreateTag, onSelectedRunChange, onShowVisibilityManageChange }: RunsViewProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detailsView, setDetailsView] = useState<DetailsView>('time')
  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(runs.filter((r) => !r.isArchived).map((r) => r.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)
  const [sweepDialogOpen, setSweepDialogOpen] = useState(false)
  const scrollPositionRef = useRef<number>(0)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const activeRuns = runs.filter((r) => !r.isArchived)
  const archivedRuns = runs.filter((r) => r.isArchived)
  const overview = getRunsOverview(activeRuns)
  const selectedRun = selectedRunId ? runs.find(r => r.id === selectedRunId) : null

  // Sort runs for quick access - favorites first
  const quickAccessRuns = useMemo(() => {
    return [...activeRuns].sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1
      if (!a.isFavorite && b.isFavorite) return 1
      return b.startTime.getTime() - a.startTime.getTime()
    }).slice(0, 6)
  }, [activeRuns])

  // Sort runs for details view
  const sortedRuns = useMemo(() => {
    if (detailsView === 'time') {
      return [...runs].sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    }
    // Priority view - group by category
    return runs
  }, [runs, detailsView])

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
      setVisibleRunIds(new Set(activeRuns.map(r => r.id)))
    }
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups(prev => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups(prev => prev.filter(g => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(activeRuns.map(r => r.id)))
    }
  }

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    scrollPositionRef.current = target.scrollTop
  }, [])

  const handleRunClick = (run: ExperimentRun) => {
    setSelectedRunId(run.id)
    onSelectedRunChange?.(run)
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

  const RunItem = ({ run, showChevron = true }: { run: ExperimentRun; showChevron?: boolean }) => (
    <button
      type="button"
      onClick={() => handleRunClick(run)}
      className="w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-muted-foreground/50 active:scale-[0.99]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="h-3 w-3 rounded-full shrink-0"
            style={{ backgroundColor: run.color || '#4ade80' }}
          />
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
          {showChevron && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>
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
            runs={runs}
            onRunSelect={(r) => handleRunClick(r)}
            onUpdateRun={onUpdateRun}
            allTags={allTags}
            onCreateTag={onCreateTag}
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

  // Manage view
  if (subTab === 'manage') {
    return (
      <RunManageView
        runs={runs}
        onUpdateRun={onUpdateRun}
        allTags={allTags}
        onCreateTag={onCreateTag}
      />
    )
  }

  // Details view
  if (subTab === 'details') {
    const favoriteRuns = activeRuns.filter(r => r.isFavorite)
    const alertRuns = activeRuns.filter(r => r.alerts && r.alerts.length > 0 && !r.isFavorite)
    const runningRuns = activeRuns.filter(r => r.status === 'running' && !r.isFavorite && !(r.alerts && r.alerts.length > 0))
    const failedRuns = activeRuns.filter(r => r.status === 'failed' && !r.isFavorite && !(r.alerts && r.alerts.length > 0))
    const completedRuns = activeRuns.filter(r => r.status === 'completed' && !r.isFavorite)

    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="shrink-0 border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">Runs</h3>
          <div className="flex items-center gap-2">
            <Popover open={sweepDialogOpen} onOpenChange={setSweepDialogOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title="Create Sweep"
                >
                  <PlugZap className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <SweepFormPopover onClose={() => setSweepDialogOpen(false)} />
              </PopoverContent>
            </Popover>
            <Select value={detailsView} onValueChange={(v) => setDetailsView(v as DetailsView)}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="time">Time</SelectItem>
                <SelectItem value="priority">Priority</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
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
                  {archivedRuns.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Archive className="h-4 w-4 text-muted-foreground" />
                        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Archived</h4>
                      </div>
                      <div className="space-y-2 opacity-60">
                        {archivedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  {sortedRuns.map((run) => <RunItem key={run.id} run={run} />)}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    )
  }

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
                runs={activeRuns}
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
