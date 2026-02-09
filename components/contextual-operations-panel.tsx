'use client'

import { useMemo } from 'react'
import {
  AlertTriangle,
  Clock3,
  Cpu,
  Gauge,
  PlayCircle,
  Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Alert } from '@/lib/api-client'
import type { ExperimentRun, Sweep } from '@/lib/types'

interface ContextualOperationsPanelProps {
  runs: ExperimentRun[]
  sweeps: Sweep[]
  alerts: Alert[]
  onInsertPrompt: (prompt: string) => void
}

function formatRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / (60 * 1000))
  const hours = Math.floor(diffMs / (60 * 60 * 1000))

  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ContextualOperationsPanel({
  runs,
  sweeps,
  alerts,
  onInsertPrompt,
}: ContextualOperationsPanelProps) {
  const runningRuns = useMemo(
    () => runs.filter((run) => run.status === 'running'),
    [runs]
  )

  const queuedRuns = useMemo(
    () => runs.filter((run) => run.status === 'queued' || run.status === 'ready'),
    [runs]
  )

  const pendingAlerts = useMemo(
    () => alerts.filter((alert) => alert.status === 'pending').slice(0, 5),
    [alerts]
  )

  const activeSweeps = useMemo(
    () => sweeps.filter((sweep) => sweep.status === 'running' || sweep.status === 'pending').slice(0, 5),
    [sweeps]
  )

  const totalSlots = Math.max(8, runningRuns.length + queuedRuns.length)
  const utilization = Math.min(100, Math.round((runningRuns.length / Math.max(totalSlots, 1)) * 100))

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="space-y-3">
        <Card className="border-border/80 bg-card/95">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="h-4 w-4 text-primary" />
                Cluster Pulse
              </span>
              <Badge variant="outline" className="text-[10px]">
                {runningRuns.length}/{totalSlots} busy
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div>
              <div className="mb-1 flex items-center justify-between text-muted-foreground">
                <span>Utilization</span>
                <span>{utilization}%</span>
              </div>
              <div className="h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${utilization}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border/70 bg-background/70 p-2">
                <p className="text-[10px] text-muted-foreground">Running</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">{runningRuns.length}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-background/70 p-2">
                <p className="text-[10px] text-muted-foreground">Queued</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">{queuedRuns.length}</p>
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full text-xs"
              onClick={() =>
                onInsertPrompt(
                  `Given ${runningRuns.length} running jobs and ${queuedRuns.length} queued jobs, propose a queue rebalance and scheduling strategy for highest learning-per-hour.`
                )
              }
            >
              <Gauge className="h-3.5 w-3.5" />
              Rebalance Scheduler
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/80 bg-card/95">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              Job Queue
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {queuedRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground">No queued jobs right now.</p>
            ) : (
              queuedRuns.slice(0, 6).map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onInsertPrompt(`@run:${run.id} evaluate if this queued job should run now or be reordered.`)}
                  className="w-full rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-left transition-colors hover:bg-secondary/60"
                >
                  <p className="truncate text-xs font-medium text-foreground">{run.alias || run.name}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {run.status} · queued {formatRelativeTime(run.startTime)}
                  </p>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 bg-card/95">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Active Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingAlerts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No pending alerts.</p>
            ) : (
              pendingAlerts.map((alert) => (
                <button
                  key={alert.id}
                  type="button"
                  onClick={() => onInsertPrompt(`@alert:${alert.id} diagnose this issue and choose the safest allowed response.`)}
                  className="w-full rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-left transition-colors hover:bg-secondary/60"
                >
                  <p className="line-clamp-2 text-xs font-medium text-foreground">{alert.message}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="h-4 px-1.5 text-[9px] uppercase"
                    >
                      {alert.severity}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">Run {alert.run_id}</span>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 bg-card/95">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Sparkles className="h-4 w-4 text-indigo-500" />
              Sweeps In Flight
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeSweeps.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active sweeps.</p>
            ) : (
              activeSweeps.map((sweep) => (
                <button
                  key={sweep.id}
                  type="button"
                  onClick={() => onInsertPrompt(`@sweep:${sweep.id} summarize progress, bottlenecks, and next trials.`)}
                  className="w-full rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-left transition-colors hover:bg-secondary/60"
                >
                  <p className="truncate text-xs font-medium text-foreground">{sweep.config.name}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {sweep.progress.running} running · {sweep.progress.completed}/{sweep.progress.total} completed
                  </p>
                </button>
              ))
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full text-xs"
              onClick={() => onInsertPrompt('Draft a new sweep from what we learned in the last 24 hours.')}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Plan Next Sweep
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
