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
