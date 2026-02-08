'use client'

import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Link2,
  ListChecks,
  Play,
  Unlink2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LossChart } from '@/components/loss-chart'
import { type Alert as ApiAlert, type Sweep as ApiSweep } from '@/lib/api-client'
import type { ExperimentRun } from '@/lib/types'

type CardId = string

export interface AssistantConnectionTarget {
  kind: 'sweep' | 'run'
  id: string
  label: string
}

interface AssistantWorkflowBoardProps {
  runs: ExperimentRun[]
  alerts: ApiAlert[]
  sweeps: ApiSweep[]
  onReferInChat: (text: string) => void
  onOpenAlertInChat: (alert: ApiAlert) => void | Promise<void>
  onAlertRespond: (alertId: string, choice: string) => void | Promise<void>
  focusedSweepIds?: string[]
  focusedRunIds?: string[]
  connectedTargets?: AssistantConnectionTarget[]
  onConnectTarget?: (target: AssistantConnectionTarget) => void
  onDisconnectTarget?: (target: AssistantConnectionTarget) => void
}

interface GroupedSweep {
  id: string
  name: string
  status: 'running' | 'ready' | 'completed' | 'failed'
  baseCommand: string
  parameters: Record<string, unknown[]>
  runs: ExperimentRun[]
  progress: {
    total: number
    running: number
    completed: number
    failed: number
    queued: number
  }
}

const DEFAULT_SWEEP_COMMAND = 'python train.py'

function severityRank(severity: ApiAlert['severity']) {
  switch (severity) {
    case 'critical':
      return 0
    case 'warning':
      return 1
    default:
      return 2
  }
}

function mapApiSweepStatus(status: ApiSweep['status']): GroupedSweep['status'] {
  if (status === 'running') return 'running'
  if (status === 'failed') return 'failed'
  if (status === 'completed') return 'completed'
  return 'ready'
}

function buildSweepOverviewCurve(runs: ExperimentRun[]) {
  const stepMap = new Map<number, { trainSum: number; valSum: number; trainCount: number; valCount: number }>()
  runs.forEach((run) => {
    if (!Array.isArray(run.lossHistory)) return
    run.lossHistory.forEach((point) => {
      const entry = stepMap.get(point.step) || { trainSum: 0, valSum: 0, trainCount: 0, valCount: 0 }
      entry.trainSum += point.trainLoss
      entry.trainCount += 1
      if (typeof point.valLoss === 'number') {
        entry.valSum += point.valLoss
        entry.valCount += 1
      }
      stepMap.set(point.step, entry)
    })
  })

  return Array.from(stepMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([step, entry]) => ({
      step,
      trainLoss: entry.trainCount > 0 ? entry.trainSum / entry.trainCount : 0,
      valLoss: entry.valCount > 0 ? entry.valSum / entry.valCount : undefined,
    }))
    .filter((point) => Number.isFinite(point.trainLoss))
}

export function AssistantWorkflowBoard({
  runs,
  alerts,
  sweeps,
  onReferInChat,
  onOpenAlertInChat,
  onAlertRespond,
  focusedSweepIds = [],
  focusedRunIds = [],
  connectedTargets = [],
  onConnectTarget,
  onDisconnectTarget,
}: AssistantWorkflowBoardProps) {
  const [expandedCards, setExpandedCards] = useState<Set<CardId>>(new Set())
  const [openSweepDialogId, setOpenSweepDialogId] = useState<string | null>(null)

  const toggleCard = (id: CardId) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const isExpanded = (id: CardId) => expandedCards.has(id)

  const groupedSweeps = useMemo<GroupedSweep[]>(() => {
    const runsBySweep = new Map<string, ExperimentRun[]>()
    runs.forEach((run) => {
      if (!run.sweepId) return
      if (!runsBySweep.has(run.sweepId)) runsBySweep.set(run.sweepId, [])
      runsBySweep.get(run.sweepId)!.push(run)
    })

    const ids = new Set<string>()
    sweeps.forEach((sweep) => ids.add(sweep.id))
    runsBySweep.forEach((_, sweepId) => ids.add(sweepId))

    const result: GroupedSweep[] = []
    ids.forEach((sweepId) => {
      const apiSweep = sweeps.find((sweep) => sweep.id === sweepId)
      const sweepRuns = (runsBySweep.get(sweepId) || []).sort((a, b) => b.startTime.getTime() - a.startTime.getTime())

      const computedProgress = {
        total: sweepRuns.length,
        running: sweepRuns.filter((run) => run.status === 'running').length,
        completed: sweepRuns.filter((run) => run.status === 'completed').length,
        failed: sweepRuns.filter((run) => run.status === 'failed').length,
        queued: sweepRuns.filter((run) => run.status === 'queued' || run.status === 'ready').length,
      }

      const progress = apiSweep
        ? {
            total: apiSweep.progress.total,
            running: apiSweep.progress.running,
            completed: apiSweep.progress.completed,
            failed: apiSweep.progress.failed,
            queued: apiSweep.progress.queued || apiSweep.progress.ready || 0,
          }
        : computedProgress

      const status: GroupedSweep['status'] = apiSweep
        ? mapApiSweepStatus(apiSweep.status)
        : computedProgress.running > 0 || computedProgress.queued > 0
          ? 'running'
          : computedProgress.failed > 0 && computedProgress.completed === 0
            ? 'failed'
            : computedProgress.completed > 0
              ? 'completed'
              : 'ready'

      result.push({
        id: sweepId,
        name: apiSweep?.name || `Sweep ${sweepId}`,
        status,
        baseCommand: apiSweep?.base_command || sweepRuns[0]?.command || DEFAULT_SWEEP_COMMAND,
        parameters: apiSweep?.parameters || {},
        runs: sweepRuns,
        progress,
      })
    })

    const rank = { running: 0, failed: 1, ready: 2, completed: 3 }
    return result.sort((a, b) => {
      if (a.status !== b.status) return rank[a.status] - rank[b.status]
      return b.progress.total - a.progress.total
    })
  }, [runs, sweeps])

  const pendingAlerts = useMemo(
    () =>
      alerts
        .filter((alert) => alert.status === 'pending')
        .sort((a, b) => {
          const rankDiff = severityRank(a.severity) - severityRank(b.severity)
          if (rankDiff !== 0) return rankDiff
          return b.timestamp - a.timestamp
        }),
    [alerts]
  )

  const connectedSweepIds = useMemo(
    () => new Set(connectedTargets.filter((target) => target.kind === 'sweep').map((target) => target.id)),
    [connectedTargets]
  )

  const connectedRunIds = useMemo(
    () => new Set(connectedTargets.filter((target) => target.kind === 'run').map((target) => target.id)),
    [connectedTargets]
  )

  const focusedSweepSet = useMemo(() => new Set(focusedSweepIds), [focusedSweepIds])
  const focusedRunSet = useMemo(() => new Set(focusedRunIds), [focusedRunIds])

  const contextualSweeps = useMemo(
    () =>
      groupedSweeps.filter(
        (sweep) =>
          focusedSweepSet.has(sweep.id) ||
          connectedSweepIds.has(sweep.id) ||
          sweep.runs.some((run) => focusedRunSet.has(run.id) || connectedRunIds.has(run.id))
      ),
    [groupedSweeps, focusedSweepSet, focusedRunSet, connectedSweepIds, connectedRunIds]
  )

  const recommendedSweeps = useMemo(
    () => groupedSweeps.filter((sweep) => sweep.status === 'running' || sweep.status === 'failed').slice(0, 4),
    [groupedSweeps]
  )

  const previewSweeps = useMemo(() => {
    const base = contextualSweeps.length > 0 ? contextualSweeps : recommendedSweeps
    return [...base].sort((a, b) => {
      const aConnected = connectedSweepIds.has(a.id) ? 0 : 1
      const bConnected = connectedSweepIds.has(b.id) ? 0 : 1
      if (aConnected !== bConnected) return aConnected - bConnected
      return 0
    })
  }, [contextualSweeps, recommendedSweeps, connectedSweepIds])

  const completedRuns = useMemo(() => runs.filter((run) => run.status === 'completed'), [runs])
  const firstTimeUser = runs.length === 0 && sweeps.length === 0

  const highlightedRuns = useMemo(() => {
    const baseRuns = contextualSweeps.length > 0 ? contextualSweeps.flatMap((sweep) => sweep.runs) : runs
    return baseRuns
      .filter((run) => Array.isArray(run.lossHistory) && run.lossHistory.length > 1)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, 2)
  }, [contextualSweeps, runs])

  const connectedSweepCharts = useMemo(() => {
    const connectedSweeps = previewSweeps.filter((sweep) => connectedSweepIds.has(sweep.id))
    return connectedSweeps
      .map((sweep) => ({
        sweep,
        data: buildSweepOverviewCurve(sweep.runs),
      }))
      .filter((item) => item.data.length > 1)
  }, [previewSweeps, connectedSweepIds])

  const openSweepDialog = groupedSweeps.find((item) => item.id === openSweepDialogId) || null

  return (
    <div className="h-full overflow-y-auto px-2 pb-2 pt-1.5">
      <div className="columns-1 gap-2 sm:columns-2 2xl:columns-3">
        {connectedTargets.length > 0 && (
          <section className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" />
              <span>Connected Context</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {connectedTargets.map((target) => (
                <div
                  key={`${target.kind}:${target.id}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px]"
                >
                  <span className="font-medium text-foreground">{target.label}</span>
                  <span className="text-muted-foreground">{target.kind}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => onDisconnectTarget?.(target)}
                    aria-label={`Disconnect ${target.label}`}
                  >
                    <Unlink2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {connectedSweepCharts.length > 0 && (
          <section className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
            <button
              type="button"
              onClick={() => toggleCard('connected-charts')}
              className="flex w-full items-center gap-2 text-left"
            >
              {isExpanded('connected-charts') ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <BarChart3 className="h-3.5 w-3.5 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">Connected Sweep Charts</p>
                <p className="text-[10px] text-muted-foreground">Pinned overview curves for this chat.</p>
              </div>
            </button>

            {isExpanded('connected-charts') && (
              <div className="mt-2 space-y-2">
                {connectedSweepCharts.map(({ sweep, data }) => (
                  <div key={`connected-chart-${sweep.id}`} className="rounded-md border border-border/60 bg-background/60 p-1.5">
                    <LossChart data={data} title={`${sweep.name} (overview)`} />
                    <div className="mt-1 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px]"
                        onClick={() => onReferInChat(`@sweep:${sweep.id} analyze this overall sweep curve and next action.`)}
                      >
                        Analyze in Chat
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {firstTimeUser && (
          <section className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
            <button
              type="button"
              onClick={() => toggleCard('onboarding')}
              className="flex w-full items-center gap-2 text-left"
            >
              {isExpanded('onboarding') ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <ListChecks className="h-3.5 w-3.5 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">First-Time Setup</p>
                <p className="text-[10px] text-muted-foreground">Connect project, define sweep, read first curves.</p>
              </div>
            </button>
            {isExpanded('onboarding') && (
              <div className="mt-2 space-y-1.5 text-[11px] text-foreground">
                <div className="rounded-md border border-border/60 bg-background/60 p-2">1. Point to your `verl` workdir and verify train command.</div>
                <div className="rounded-md border border-border/60 bg-background/60 p-2">2. Describe hypotheses in plain language and draft a sweep.</div>
                <div className="rounded-md border border-border/60 bg-background/60 p-2">3. Ask chat to compare clip strategy and offpoliciness.</div>
              </div>
            )}
          </section>
        )}

        {previewSweeps.map((sweep) => {
          const cardId = `sweep-${sweep.id}`
          const chartRun = sweep.runs.find((run) => Array.isArray(run.lossHistory) && run.lossHistory.length > 1)
          const progressPercent = sweep.progress.total
            ? Math.round(((sweep.progress.completed + sweep.progress.failed) / sweep.progress.total) * 100)
            : 0
          const connected = connectedSweepIds.has(sweep.id)

          return (
            <section key={cardId} className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
              <button
                type="button"
                onClick={() => toggleCard(cardId)}
                className="flex w-full items-center gap-2 text-left"
              >
                {isExpanded(cardId) ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <FlaskConical className="h-3.5 w-3.5 text-blue-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{sweep.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {sweep.progress.running} running · {sweep.progress.completed} done · {sweep.progress.failed} failed
                  </p>
                </div>
                {connected && (
                  <Badge variant="secondary" className="text-[9px]">
                    connected
                  </Badge>
                )}
                <Badge variant="outline" className="text-[9px] capitalize">
                  {sweep.status}
                </Badge>
              </button>

              {isExpanded(cardId) && (
                <div className="mt-2 space-y-1.5">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Progress</span>
                      <span>{progressPercent}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-secondary">
                      <div className="h-1 rounded-full bg-accent" style={{ width: `${progressPercent}%` }} />
                    </div>
                  </div>

                  {chartRun?.lossHistory && chartRun.lossHistory.length > 1 ? (
                    <div className="rounded-md border border-border/60 bg-background/60 p-1.5">
                      <LossChart data={chartRun.lossHistory} title={`${chartRun.alias || chartRun.name} Loss`} />
                    </div>
                  ) : (
                    <div className="rounded-md border border-border/60 bg-background/60 p-2 text-[10px] text-muted-foreground">
                      No curve data yet.
                    </div>
                  )}

                  <div className="space-y-1">
                    {sweep.runs.slice(0, 3).map((run) => {
                      const runConnected = connectedRunIds.has(run.id)
                      return (
                        <div key={run.id} className="flex items-center justify-between rounded-md bg-secondary/30 px-2 py-1 text-[10px]">
                          <span className="truncate text-foreground">{run.alias || run.name}</span>
                          <div className="flex items-center gap-1.5">
                            {runConnected && <Badge variant="secondary" className="text-[9px]">connected</Badge>}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 px-1.5 text-[9px]"
                              onClick={() =>
                                onConnectTarget?.({ kind: 'run', id: run.id, label: run.alias || run.name })
                              }
                            >
                              Connect
                            </Button>
                            <span className="text-muted-foreground">{run.status}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={connected ? 'secondary' : 'outline'}
                      className="h-7 text-[11px]"
                      onClick={() =>
                        connected
                          ? onDisconnectTarget?.({ kind: 'sweep', id: sweep.id, label: sweep.name })
                          : onConnectTarget?.({ kind: 'sweep', id: sweep.id, label: sweep.name })
                      }
                    >
                      {connected ? <Unlink2 className="mr-1 h-3.5 w-3.5" /> : <Link2 className="mr-1 h-3.5 w-3.5" />}
                      {connected ? 'Disconnect' : 'Connect'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => setOpenSweepDialogId(sweep.id)}
                    >
                      Open Artifact
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() =>
                        onReferInChat(`@sweep:${sweep.id} summarize status, active runs, failures, and next action.`)
                      }
                    >
                      Refer in Chat
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )
        })}

        {pendingAlerts.slice(0, 3).map((alert) => {
          const cardId = `alert-${alert.id}`
          const severityClass =
            alert.severity === 'critical'
              ? 'text-destructive'
              : alert.severity === 'warning'
                ? 'text-amber-400'
                : 'text-blue-400'

          return (
            <section key={cardId} className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
              <button
                type="button"
                onClick={() => toggleCard(cardId)}
                className="flex w-full items-center gap-2 text-left"
              >
                {isExpanded(cardId) ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <AlertTriangle className={`h-3.5 w-3.5 ${severityClass}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{alert.message}</p>
                  <p className="text-[10px] text-muted-foreground">run: {alert.run_id}</p>
                </div>
              </button>

              {isExpanded(cardId) && (
                <div className="mt-2 space-y-1.5">
                  <p className="rounded-md bg-secondary/30 p-2 text-[11px] text-foreground">{alert.message}</p>
                  {alert.choices.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {alert.choices.map((choice) => (
                        <Button
                          key={`${alert.id}-${choice}`}
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() => onAlertRespond(alert.id, choice)}
                        >
                          {choice}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" className="h-7 text-[11px]" onClick={() => onOpenAlertInChat(alert)}>
                      <Bot className="mr-1 h-3.5 w-3.5" />
                      Open in Chat
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={() => onReferInChat(`@alert:${alert.id} explain root cause and safest response.`)}
                    >
                      Refer in Chat
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )
        })}

        {highlightedRuns.length > 0 && (
          <section className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
            <button
              type="button"
              onClick={() => toggleCard('charts')}
              className="flex w-full items-center gap-2 text-left"
            >
              {isExpanded('charts') ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <BarChart3 className="h-3.5 w-3.5 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">Highlighted Curves</p>
                <p className="text-[10px] text-muted-foreground">Quick previews for context you referenced.</p>
              </div>
            </button>

            {isExpanded('charts') && (
              <div className="mt-2 space-y-1.5">
                {highlightedRuns.map((run) => (
                  <div key={`chart-${run.id}`} className="rounded-md border border-border/60 bg-background/60 p-1.5">
                    <LossChart data={run.lossHistory || []} title={run.alias || run.name} />
                    <div className="mt-1 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px]"
                        onClick={() => onReferInChat(`@run:${run.id} analyze this curve trend and suggest next action.`)}
                      >
                        Analyze in Chat
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {completedRuns.length > 1 && (
          <section className="mb-2 break-inside-avoid rounded-lg border border-border bg-card px-2 py-1.5">
            <button
              type="button"
              onClick={() => toggleCard('analysis')}
              className="flex w-full items-center gap-2 text-left"
            >
              {isExpanded('analysis') ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">Result Analysis</p>
                <p className="text-[10px] text-muted-foreground">{completedRuns.length} finished runs ready for conclusions.</p>
              </div>
            </button>
            {isExpanded('analysis') && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => onReferInChat('Which clip strategy works better? Show curve evidence and caveats.')}
                >
                  Compare Clip Strategy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => onReferInChat('Which offpoliciness setting works better ({64,64}, {64,32}, {64,16})?')}
                >
                  Compare Offpoliciness
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => onReferInChat('Write a concise RL experiment report with setup, result, and conclusion.')}
                >
                  Write Report
                </Button>
              </div>
            )}
          </section>
        )}
      </div>

      <Dialog open={Boolean(openSweepDialog)} onOpenChange={(open) => !open && setOpenSweepDialogId(null)}>
        <DialogContent className="max-w-2xl">
          {openSweepDialog && (
            <>
              <DialogHeader>
                <DialogTitle>{openSweepDialog.name}</DialogTitle>
                <DialogDescription>
                  Sweep artifact preview. Connect it to chat for persistent context.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded-md border border-border/60 bg-secondary/20 p-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</p>
                    <p className="text-sm text-foreground capitalize">{openSweepDialog.status}</p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-secondary/20 p-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Progress</p>
                    <p className="text-sm text-foreground">
                      {openSweepDialog.progress.completed}/{openSweepDialog.progress.total} complete · {openSweepDialog.progress.failed} failed
                    </p>
                  </div>
                </div>

                <div className="rounded-md border border-border/60 bg-background/60 p-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Base Command</p>
                  <p className="font-mono text-xs text-foreground break-all">{openSweepDialog.baseCommand}</p>
                </div>

                <div className="rounded-md border border-border/60 bg-background/60 p-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Parameters</p>
                  <pre className="max-h-56 overflow-auto text-[10px] text-muted-foreground">
                    {JSON.stringify(openSweepDialog.parameters, null, 2)}
                  </pre>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onConnectTarget?.({ kind: 'sweep', id: openSweepDialog.id, label: openSweepDialog.name })}
                  >
                    <Link2 className="mr-1 h-3.5 w-3.5" />
                    Connect to Chat
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onReferInChat(`@sweep:${openSweepDialog.id} summarize this sweep and recommend next step.`)}
                  >
                    Refer in Chat
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
