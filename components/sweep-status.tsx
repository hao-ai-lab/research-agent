'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Play,
  Pause,
  Square,
  RefreshCw,
  Sparkles,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  BarChart3,
  Target,
  FileText,
  Terminal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Sweep, ExperimentRun, SweepStatus as SweepStatusType } from '@/lib/types'

interface SweepStatusProps {
  sweep: Sweep
  runs: ExperimentRun[]
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  onRunClick?: (run: ExperimentRun) => void
  isCollapsed?: boolean
}

export function SweepStatus({
  sweep,
  runs,
  onPause,
  onResume,
  onCancel,
  onRunClick,
  isCollapsed = false,
}: SweepStatusProps) {
  const [expanded, setExpanded] = useState(!isCollapsed)
  const [showAllRuns, setShowAllRuns] = useState(false)

  // Filter runs that belong to this sweep
  const sweepRuns = runs.filter(r => sweep.runIds.includes(r.id))
  
  // Get status-specific runs
  const runningRuns = sweepRuns.filter(r => r.status === 'running')
  const completedRuns = sweepRuns.filter(r => r.status === 'completed')
  const failedRuns = sweepRuns.filter(r => r.status === 'failed')
  const queuedRuns = sweepRuns.filter(r => r.status === 'queued')

  const progressPercent = (sweep.progress.completed / sweep.progress.total) * 100
  const primaryMetric = sweep.config.metrics.find(m => m.isPrimary)

  const getStatusIcon = (status: SweepStatusType) => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-3 w-3 animate-spin text-accent" />
      case 'completed':
        return <CheckCircle2 className="h-3 w-3 text-emerald-400" />
      case 'failed':
        return <XCircle className="h-3 w-3 text-destructive" />
      case 'pending':
        return <Clock className="h-3 w-3 text-muted-foreground" />
      case 'draft':
        return <Sparkles className="h-3 w-3 text-violet-500" />
      case 'canceled':
        return <Square className="h-3 w-3 text-muted-foreground" />
      default:
        return null
    }
  }

  const getStatusColor = (status: SweepStatusType) => {
    switch (status) {
      case 'draft':
        return 'bg-violet-500/18 text-violet-500 border-violet-500/35'
      case 'running':
        return 'bg-accent/20 text-accent border-accent/30'
      case 'completed':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
      case 'failed':
        return 'bg-destructive/20 text-destructive border-destructive/30'
      case 'canceled':
        return 'bg-muted/20 text-muted-foreground border-muted/30'
      default:
        return 'bg-secondary text-muted-foreground border-border'
    }
  }

  const getRunStatusIcon = (status: ExperimentRun['status']) => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-3 w-3 animate-spin text-accent" />
      case 'completed':
        return <CheckCircle2 className="h-3 w-3 text-emerald-400" />
      case 'failed':
        return <XCircle className="h-3 w-3 text-destructive" />
      case 'queued':
        return <Clock className="h-3 w-3 text-muted-foreground" />
      case 'canceled':
        return <Square className="h-3 w-3 text-muted-foreground" />
      default:
        return null
    }
  }

  const formatDuration = (start?: Date, end?: Date) => {
    if (!start) return '--'
    const endTime = end || new Date()
    const diff = endTime.getTime() - new Date(start).getTime()
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  const formatTimestamp = (value?: Date) => {
    if (!value) return '--'
    return value.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const creation = sweep.creationContext
  const goal = (creation.goal || '').trim()
  const description = (creation.description || '').trim()
  const notes = (creation.notes || '').trim()
  const commandPreview = (creation.command || '').trim()
  const hyperparameterNames = sweep.config.hyperparameters
    .map((param) => param.name.trim())
    .filter(Boolean)
  const maxRuns = creation.maxRuns ?? sweep.config.maxRuns ?? sweep.progress.total ?? null
  const parallelRuns = creation.parallelRuns ?? sweep.config.parallelRuns ?? 1
  const hyperparameterCount = creation.hyperparameterCount ?? sweep.config.hyperparameters.length
  const metricCount = creation.metricCount ?? sweep.config.metrics.length
  const insightCount = creation.insightCount ?? sweep.config.insights.length
  const earlyStoppingText = creation.earlyStoppingEnabled === null
    ? 'Not provided'
    : creation.earlyStoppingEnabled
    ? `Enabled${creation.earlyStoppingPatience ? ` (${creation.earlyStoppingPatience})` : ''}`
    : 'Disabled'

  const renderField = (value: string) => (value ? value : 'Not provided')

  const displayRuns = showAllRuns ? sweepRuns : sweepRuns.slice(0, 5)

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <Sparkles className="h-3.5 w-3.5 text-purple-400 shrink-0" />
        <span className="text-sm font-medium text-foreground truncate flex-1">
          {sweep.config.name}
        </span>
        
        {/* Status Badge */}
        <Badge variant="outline" className={`text-[10px] gap-1 ${getStatusColor(sweep.status)}`}>
          {getStatusIcon(sweep.status)}
          <span className="capitalize">{sweep.status}</span>
        </Badge>
        
        {/* Progress mini */}
        {!expanded && sweep.status === 'running' && (
          <span className="text-[10px] text-muted-foreground">
            {sweep.progress.completed}/{sweep.progress.total}
          </span>
        )}
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50">
          <div className="pt-3">
            <div className="rounded-md border border-border bg-secondary/20 p-2.5">
              <div className="mb-2 flex items-center gap-1.5">
                <FileText className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Creation Context
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div className="rounded-sm bg-background/70 px-2 py-1">
                  <p className="text-muted-foreground">Created</p>
                  <p className="text-foreground">{formatTimestamp(creation.createdAt || sweep.createdAt)}</p>
                </div>
                <div className="rounded-sm bg-background/70 px-2 py-1">
                  <p className="text-muted-foreground">Updated</p>
                  <p className="text-foreground">{formatTimestamp(sweep.config.updatedAt || creation.createdAt || sweep.createdAt)}</p>
                </div>
                <div className="rounded-sm bg-background/70 px-2 py-1">
                  <p className="text-muted-foreground">Max Runs</p>
                  <p className="text-foreground">{maxRuns ?? 'Not provided'}</p>
                </div>
                <div className="rounded-sm bg-background/70 px-2 py-1">
                  <p className="text-muted-foreground">Parallel Runs</p>
                  <p className="text-foreground">{parallelRuns ?? 'Not provided'}</p>
                </div>
                <div className="rounded-sm bg-background/70 px-2 py-1">
                  <p className="text-muted-foreground">Early Stopping</p>
                  <p className="text-foreground">{earlyStoppingText}</p>
                </div>
              </div>

              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Target className="h-3 w-3" />
                  <span>Goal</span>
                </div>
                <p className="text-xs text-foreground whitespace-pre-wrap break-words">{renderField(goal)}</p>
              </div>

              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  <span>Description</span>
                </div>
                <p className="text-xs text-foreground whitespace-pre-wrap break-words">{renderField(description)}</p>
              </div>

              <div className="mt-2">
                <p className="text-[10px] text-muted-foreground">Notes</p>
                <p className="text-xs text-foreground whitespace-pre-wrap break-words">{renderField(notes)}</p>
              </div>

              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Terminal className="h-3 w-3" />
                  <span>Command</span>
                </div>
                <p className="rounded-sm bg-background/70 px-2 py-1 font-mono text-[10px] text-foreground break-all whitespace-pre-wrap">
                  {renderField(commandPreview)}
                </p>
              </div>

              <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                <span>{hyperparameterCount} hyperparameters</span>
                <span>•</span>
                <span>{metricCount} metrics</span>
                <span>•</span>
                <span>{insightCount} insight rules</span>
              </div>
              {hyperparameterNames.length > 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Params: {hyperparameterNames.join(', ')}
                </p>
              )}
              {hyperparameterNames.length === 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Params: Not provided
                </p>
              )}
            </div>
          </div>

          {/* Progress Section */}
          <div className="pt-3">
            <div className="flex items-center justify-between text-[10px] mb-1.5">
              <span className="text-muted-foreground">
                {sweep.progress.completed} of {sweep.progress.total} runs completed
              </span>
              <span className="text-foreground font-medium">
                {progressPercent.toFixed(0)}%
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
            
            {/* Status breakdown */}
            <div className="flex items-center gap-4 mt-2 text-[10px]">
              {sweep.progress.running > 0 && (
                <span className="flex items-center gap-1 text-accent">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  {sweep.progress.running} running
                </span>
              )}
              {completedRuns.length > 0 && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  {completedRuns.length} done
                </span>
              )}
              {failedRuns.length > 0 && (
                <span className="flex items-center gap-1 text-destructive">
                  <XCircle className="h-2.5 w-2.5" />
                  {failedRuns.length} failed
                </span>
              )}
              {queuedRuns.length > 0 && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  {queuedRuns.length} queued
                </span>
              )}
            </div>
          </div>

          {/* Best Result */}
          {sweep.bestRunId && sweep.bestMetricValue !== undefined && (
            <div className="p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <BarChart3 className="h-3 w-3 text-emerald-400" />
                  <span className="text-[10px] text-emerald-400 font-medium">Best Result</span>
                </div>
                <span className="text-xs text-foreground font-mono">
                  {primaryMetric?.name}: {sweep.bestMetricValue.toFixed(4)}
                </span>
              </div>
              {(() => {
                const bestRun = sweepRuns.find(r => r.id === sweep.bestRunId)
                if (bestRun) {
                  return (
                    <button
                      type="button"
                      onClick={() => onRunClick?.(bestRun)}
                      className="mt-1 text-[10px] text-emerald-400/80 hover:text-emerald-400 flex items-center gap-1"
                    >
                      {bestRun.alias || bestRun.name}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </button>
                  )
                }
                return null
              })()}
            </div>
          )}

          {/* Runs List */}
          <Collapsible open={showAllRuns} onOpenChange={setShowAllRuns}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Runs</span>
              {sweepRuns.length > 5 && (
                <CollapsibleTrigger className="text-[10px] text-accent hover:underline">
                  {showAllRuns ? 'Show less' : `Show all ${sweepRuns.length}`}
                </CollapsibleTrigger>
              )}
            </div>
            
            <div className="mt-1.5 space-y-1">
              {displayRuns.map(run => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onRunClick?.(run)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors text-left"
                >
                  {getRunStatusIcon(run.status)}
                  <span className="text-[10px] text-foreground truncate flex-1">
                    {run.alias || run.name}
                  </span>
                  {run.metrics?.loss !== undefined && (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {run.metrics.loss.toFixed(4)}
                    </span>
                  )}
                  <span className="text-[9px] text-muted-foreground/60">
                    {formatDuration(run.startTime, run.endTime)}
                  </span>
                </button>
              ))}
              
              <CollapsibleContent className="space-y-1">
                {sweepRuns.slice(5).map(run => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => onRunClick?.(run)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors text-left"
                  >
                    {getRunStatusIcon(run.status)}
                    <span className="text-[10px] text-foreground truncate flex-1">
                      {run.alias || run.name}
                    </span>
                    {run.metrics?.loss !== undefined && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {run.metrics.loss.toFixed(4)}
                      </span>
                    )}
                    <span className="text-[9px] text-muted-foreground/60">
                      {formatDuration(run.startTime, run.endTime)}
                    </span>
                  </button>
                ))}
              </CollapsibleContent>
            </div>
          </Collapsible>

          {/* Control Actions */}
          {(sweep.status === 'running' || sweep.status === 'pending') && (
            <div className="flex items-center gap-2 pt-2 border-t border-border/50">
              {sweep.status === 'running' && onPause && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] gap-1"
                  onClick={onPause}
                >
                  <Pause className="h-3 w-3" />
                  Pause
                </Button>
              )}
              {sweep.status === 'pending' && onResume && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] gap-1"
                  onClick={onResume}
                >
                  <Play className="h-3 w-3" />
                  Resume
                </Button>
              )}
              {onCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] gap-1 text-destructive hover:text-destructive"
                  onClick={onCancel}
                >
                  <Square className="h-3 w-3" />
                  Cancel
                </Button>
              )}
            </div>
          )}

          {/* Duration info */}
          {sweep.startedAt && (
            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
              <span>Started: {new Date(sweep.startedAt).toLocaleString()}</span>
              <span>Duration: {formatDuration(sweep.startedAt, sweep.completedAt)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
