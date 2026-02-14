'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Pencil,
  Play,
  RotateCcw,
  Server,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Alert } from '@/lib/api-client'
import { getStatusBadgeClass } from '@/lib/status-utils'
import type { ExperimentRun, Sweep } from '@/lib/types'

interface ChatStarterCardsProps {
  runs: ExperimentRun[]
  sweeps: Sweep[]
  alerts: Alert[]
  onPromptSelect: (prompt: string) => void
  customTemplates?: Record<string, string>
  onEditTemplate?: (cardId: string, template: string | null) => void
}

interface SelectorOption {
  value: string
  label: string
}

interface CardSelectorProps {
  value: string
  options: SelectorOption[]
  onValueChange: (value: string) => void
  emptyLabel?: string
}

const CLUSTER_SETUP_OPTIONS: SelectorOption[] = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'slurm', label: 'Slurm cluster' },
  { value: 'local_gpu', label: 'Local GPU cluster' },
  { value: 'kubernetes', label: 'Kubernetes cluster' },
  { value: 'ray', label: 'Ray cluster' },
  { value: 'shared_head_node', label: 'Shared head node SSH' },
]

const CLUSTER_SETUP_LABELS: Record<string, string> = {
  auto: 'Auto detect',
  slurm: 'Slurm cluster',
  local_gpu: 'Local GPU cluster',
  kubernetes: 'Kubernetes cluster',
  ray: 'Ray cluster',
  shared_head_node: 'Shared head node SSH cluster',
}

/** Default prompt templates keyed by stable card identifiers. */
export const DEFAULT_PROMPT_TEMPLATES: Record<string, string> = {
  'observe-run':
    '@run:{{runId}} summarize what just happened, key outcomes, and the safest next experiment.',
  'observe-run-empty':
    'Help me set up the first run and explain what signals to monitor first.',
  'review-sweep':
    '@sweep:{{sweepId}} rank current candidates, explain why the top configs win, and propose the next 3 runs.',
  'review-sweep-empty':
    'Draft a practical sweep plan with candidate ranges and stop criteria.',
  'metric-check':
    '@run:{{runId}} report the primary metric trend, recent movement, and a threshold that should trigger intervention.',
  'metric-check-empty':
    'I need a compact primary-metric tracking plan for this project.',
  'resolve-alert':
    '@alert:{{alertId}} diagnose this alert, evaluate allowed responses, and recommend the safest one.',
  'resolve-alert-empty':
    'No active alerts. Give me a preventive checklist for the next 3 runs.',
  'schedule-jobs':
    'Given {{runningJobs}} running jobs, {{queuedJobs}} queued jobs, and {{pendingAlerts}} pending alerts, propose a scheduling strategy that maximizes learning-per-hour.',
  'cluster-setup-auto':
    'Help me identify my cluster setup (Slurm, local GPU, Kubernetes, Ray, or shared head-node SSH). Ask the minimum questions, give verification commands, and tell me what to set in Runs > Cluster Status.',
  'cluster-setup':
    'My cluster setup is {{clusterLabel}}. Give me an onboarding checklist for runs/sweeps, command templates, scheduler assumptions, and failure checks.',
}

function resolveTemplate(
  cardId: string,
  customTemplates: Record<string, string> | undefined,
  vars: Record<string, string>,
): string {
  const template = customTemplates?.[cardId] ?? DEFAULT_PROMPT_TEMPLATES[cardId] ?? ''
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

interface StarterInteractiveCardProps {
  title: string
  hint?: string
  previewNode?: ReactNode
  className?: string
  icon: ComponentType<{ className?: string }>
  toneClass: string
  onActivate: () => void
  onContextEdit?: () => void
  selector?: CardSelectorProps
}

interface EditPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardId: string
  cardTitle: string
  currentTemplate: string
  defaultTemplate: string
  onSave: (cardId: string, template: string | null) => void
}

function formatRelative(date: Date) {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function toStatusLabel(status: ExperimentRun['status']) {
  switch (status) {
    case 'running':
      return 'Running'
    case 'queued':
      return 'Queued'
    case 'ready':
      return 'Ready'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'canceled':
      return 'Canceled'
    default:
      return status
  }
}

function getRunStatusIcon(status: ExperimentRun['status']) {
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
      return <Clock3 className="h-3 w-3" />
  }
}

function formatMetricSnapshot(run: ExperimentRun | undefined) {
  if (!run) return undefined

  if (run.metrics && typeof run.metrics.loss === 'number' && typeof run.metrics.accuracy === 'number') {
    return `Loss ${run.metrics.loss.toFixed(4)} · Acc ${run.metrics.accuracy.toFixed(3)} · Epoch ${run.metrics.epoch ?? '?'}`
  }

  const latestPoint = run.lossHistory?.at(-1)
  if (!latestPoint) return undefined

  if (typeof latestPoint.valLoss === 'number') {
    return `Train ${latestPoint.trainLoss.toFixed(4)} · Val ${latestPoint.valLoss.toFixed(4)}`
  }

  return `Train ${latestPoint.trainLoss.toFixed(4)}`
}

function formatQueuePreview(runs: ExperimentRun[]) {
  const queuedRuns = runs
    .filter((run) => run.status === 'queued' || run.status === 'ready')
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, 3)

  if (queuedRuns.length === 0) return 'No queued jobs'
  return queuedRuns.map((run) => run.alias || run.name).join(' · ')
}

function getAlertEventTone(severity: Alert['severity']) {
  if (severity === 'critical') {
    return {
      container: 'border-destructive/50 bg-destructive/5',
      iconClass: 'text-destructive',
      priorityBadge: 'border-destructive/50 bg-destructive/10 text-destructive',
      priorityLabel: 'Critical',
    }
  }

  if (severity === 'warning') {
    return {
      container: 'border-warning/50 bg-warning/5',
      iconClass: 'text-warning',
      priorityBadge: 'border-warning/50 bg-warning/10 text-warning',
      priorityLabel: 'High',
    }
  }

  return {
    container: 'border-blue-400/30 bg-blue-400/5',
    iconClass: 'text-blue-400',
    priorityBadge: 'border-blue-400/50 bg-blue-400/10 text-blue-400',
    priorityLabel: 'Info',
  }
}

function getSweepStatusClass(status: Sweep['status']) {
  switch (status) {
    case 'running':
      return 'border-blue-500/50 bg-blue-500/10 text-blue-400'
    case 'completed':
      return 'border-green-500/50 bg-green-500/10 text-green-400'
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    case 'pending':
      return 'border-amber-500/50 bg-amber-500/10 text-amber-400'
    case 'canceled':
      return 'border-muted-foreground/35 bg-muted text-muted-foreground'
    default:
      return 'border-border bg-secondary/70 text-muted-foreground'
  }
}

interface MiniMetricChartProps {
  label: string
  values: number[]
  stroke: string
}

function MiniMetricChart({ label, values, stroke }: MiniMetricChartProps) {
  if (values.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/80 bg-background/70 px-2 py-1.5">
        <p className="text-[10px] text-muted-foreground">{label}: no series yet</p>
      </div>
    )
  }

  const series = values.length === 1 ? [values[0], values[0]] : values
  const min = Math.min(...series)
  const max = Math.max(...series)
  const range = max - min || 1
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * 100
      const y = 24 - ((value - min) / range) * 20
      return `${x},${y}`
    })
    .join(' ')
  const areaPoints = `0,28 ${points} 100,28`
  const lastValue = series[series.length - 1]

  return (
    <div className="rounded-md border border-border/65 bg-background/75 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium text-foreground">{label}</p>
        <p className="text-[10px] text-muted-foreground">{lastValue.toFixed(4)}</p>
      </div>
      <svg viewBox="0 0 100 28" className="h-10 w-full" aria-hidden>
        <polyline
          fill={`${stroke}24`}
          stroke="none"
          points={areaPoints}
        />
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
    </div>
  )
}

function EditPromptDialog({
  open,
  onOpenChange,
  cardId,
  cardTitle,
  currentTemplate,
  defaultTemplate,
  onSave,
}: EditPromptDialogProps) {
  const [draft, setDraft] = useState(currentTemplate)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Sync draft when dialog opens with a new template
  useEffect(() => {
    if (open) setDraft(currentTemplate)
  }, [open, currentTemplate])

  const isDefault = draft === defaultTemplate

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit prompt — {cardTitle}</DialogTitle>
          <DialogDescription>
            Customise the prompt template for this card. Use <code className="rounded bg-muted px-1 text-xs">{'{{variable}}'}</code> placeholders for dynamic values.
          </DialogDescription>
        </DialogHeader>

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
        />

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDefault}
            onClick={() => setDraft(defaultTemplate)}
            className="gap-1.5 text-xs text-muted-foreground"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to default
          </Button>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onSave(cardId, draft === defaultTemplate ? null : draft)
                onOpenChange(false)
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StarterInteractiveCard({
  title,
  hint,
  previewNode,
  className,
  icon: Icon,
  toneClass,
  onActivate,
  onContextEdit,
  selector,
}: StarterInteractiveCardProps) {
  const cardContent = (
    <Card
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onActivate()
        }
      }}
      className={`w-full cursor-pointer overflow-hidden border bg-gradient-to-br ${toneClass} ${className || ''} transition-[border-color,box-shadow,transform] hover:border-foreground/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.995]`}
    >
      <CardHeader className="space-y-1 px-3.5 py-2.5 pb-1.5">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base leading-tight">
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background/85 text-foreground">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="font-semibold">{title}</span>
        </CardTitle>

        {selector && selector.options.length > 0 && (
          <div
            className="w-full max-w-full"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Select value={selector.value} onValueChange={selector.onValueChange}>
              <SelectTrigger className="h-8 w-full min-w-0 max-w-full overflow-hidden rounded-lg border-border/75 bg-background/90 px-2.5 text-xs [&>span]:truncate">
                <SelectValue placeholder={selector.emptyLabel || 'Select'} />
              </SelectTrigger>
              <SelectContent align="start" className="max-w-[340px]">
                {selector.options.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-1.5 px-3.5 pb-2.5 pt-0">
        {previewNode}
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )

  if (!onContextEdit) return cardContent

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardContent}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={onContextEdit} className="gap-2 text-xs">
          <Pencil className="h-3.5 w-3.5" />
          Edit prompt
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function StarterCardSlide({ children }: { children: ReactNode }) {
  return (
    <div className="w-[min(20rem,calc(100vw-5rem))] max-w-full shrink-0 snap-center sm:w-[min(21rem,calc(100vw-4.5rem))] md:w-[22.5rem] md:snap-start">
      {children}
    </div>
  )
}

export function ChatStarterCards({
  runs,
  sweeps,
  alerts,
  onPromptSelect,
  customTemplates,
  onEditTemplate,
}: ChatStarterCardsProps) {
  // Edit-dialog state
  const [editingCard, setEditingCard] = useState<{ id: string; title: string } | null>(null)

  const openEdit = useCallback((id: string, title: string) => {
    setEditingCard({ id, title })
  }, [])

  const handleSaveTemplate = useCallback(
    (cardId: string, template: string | null) => {
      onEditTemplate?.(cardId, template)
    },
    [onEditTemplate],
  )
  const recentRuns = useMemo(
    () =>
      [...runs]
        .filter((run) => !run.isArchived)
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime()),
    [runs]
  )

  const recentSweeps = useMemo(
    () => [...sweeps].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [sweeps]
  )

  const pendingAlerts = useMemo(
    () => alerts.filter((alert) => alert.status === 'pending').sort((a, b) => b.timestamp - a.timestamp),
    [alerts]
  )

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedSweepId, setSelectedSweepId] = useState<string | null>(null)
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null)
  const [selectedClusterSetup, setSelectedClusterSetup] = useState<string>('auto')

  useEffect(() => {
    if (recentRuns.length === 0) {
      setSelectedRunId(null)
      return
    }
    setSelectedRunId((current) => {
      if (current && recentRuns.some((run) => run.id === current)) return current
      return recentRuns[0].id
    })
  }, [recentRuns])

  useEffect(() => {
    if (recentSweeps.length === 0) {
      setSelectedSweepId(null)
      return
    }
    setSelectedSweepId((current) => {
      if (current && recentSweeps.some((sweep) => sweep.id === current)) return current
      return recentSweeps[0].id
    })
  }, [recentSweeps])

  useEffect(() => {
    if (pendingAlerts.length === 0) {
      setSelectedAlertId(null)
      return
    }
    setSelectedAlertId((current) => {
      if (current && pendingAlerts.some((alert) => alert.id === current)) return current
      return pendingAlerts[0].id
    })
  }, [pendingAlerts])

  const selectedRun = useMemo(
    () => recentRuns.find((run) => run.id === selectedRunId) || recentRuns[0],
    [recentRuns, selectedRunId]
  )

  const selectedSweep = useMemo(
    () => recentSweeps.find((sweep) => sweep.id === selectedSweepId) || recentSweeps[0],
    [recentSweeps, selectedSweepId]
  )

  const selectedAlert = useMemo(
    () => pendingAlerts.find((alert) => alert.id === selectedAlertId) || pendingAlerts[0],
    [pendingAlerts, selectedAlertId]
  )

  const runningJobs = runs.filter((run) => run.status === 'running').length
  const queuedJobs = runs.filter((run) => run.status === 'queued' || run.status === 'ready').length

  const runOptions = useMemo<SelectorOption[]>(
    () =>
      recentRuns.slice(0, 8).map((run) => ({
        value: run.id,
        label: run.alias || run.name,
      })),
    [recentRuns]
  )

  const sweepOptions = useMemo<SelectorOption[]>(
    () =>
      recentSweeps.slice(0, 8).map((sweep) => ({
        value: sweep.id,
        label: sweep.config.name,
      })),
    [recentSweeps]
  )

  const alertOptions = useMemo<SelectorOption[]>(
    () =>
      pendingAlerts.slice(0, 8).map((alert) => ({
        value: alert.id,
        label: alert.message.slice(0, 48),
      })),
    [pendingAlerts]
  )

  const pendingAlertsByRun = useMemo(() => {
    const counts: Record<string, number> = {}
    pendingAlerts.forEach((alert) => {
      counts[alert.run_id] = (counts[alert.run_id] || 0) + 1
    })
    return counts
  }, [pendingAlerts])

  const latestRunPoint = selectedRun?.lossHistory?.at(-1)
  const selectedRunMetrics = formatMetricSnapshot(selectedRun)
  const queuePreview = formatQueuePreview(runs)

  const trainLossSeries = useMemo(() => {
    return (selectedRun?.lossHistory || [])
      .slice(-24)
      .map((point) => point.trainLoss)
      .filter((value): value is number => Number.isFinite(value))
  }, [selectedRun])

  const valLossSeries = useMemo(() => {
    return (selectedRun?.lossHistory || [])
      .slice(-24)
      .map((point) => point.valLoss)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  }, [selectedRun])

  const selectedRunPendingAlerts = selectedRun ? pendingAlertsByRun[selectedRun.id] || 0 : 0
  const alertTone = selectedAlert ? getAlertEventTone(selectedAlert.severity) : null
  const selectedSweepProgressPct =
    selectedSweep && selectedSweep.progress.total > 0
      ? Math.round((selectedSweep.progress.completed / selectedSweep.progress.total) * 100)
      : 0

  return (
    <div className="space-y-2.5">
      <div className="text-center">
        {/* <h2 className="text-base font-semibold tracking-tight text-foreground">Context-first research chat</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Pick a card to stage a contextual prompt.</p> */}
      </div>

      <div className="w-full">
        <div className="flex items-start snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1.5 pb-2 [scrollbar-width:thin]">
          <StarterCardSlide>
            <StarterInteractiveCard
              title="Observe latest run"
              icon={FlaskConical}
              toneClass="from-sky-500/12 to-cyan-500/5 border-sky-500/25"
              selector={
                runOptions.length > 0
                  ? {
                      value: selectedRun?.id || runOptions[0].value,
                      options: runOptions,
                      onValueChange: setSelectedRunId,
                    }
                  : undefined
              }
              hint={selectedRun ? `Started ${formatRelative(selectedRun.startTime)}` : 'No recent run available'}
              previewNode={
                selectedRun ? (
                  <div className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: selectedRun.color || '#4ade80' }}
                          />
                          <p className="min-w-0 truncate text-sm font-medium text-foreground">
                            {selectedRun.alias || selectedRun.name}
                          </p>
                        </div>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">Run {selectedRun.id}</p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {selectedRunPendingAlerts > 0 && (
                          <div
                            className="relative inline-flex h-5 w-5 items-center justify-center"
                            title={`${selectedRunPendingAlerts} pending alert${selectedRunPendingAlerts > 1 ? 's' : ''}`}
                          >
                            <AlertTriangle className="h-4 w-4 text-warning" />
                            {selectedRunPendingAlerts > 1 && (
                              <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground">
                                {selectedRunPendingAlerts}
                              </span>
                            )}
                          </div>
                        )}
                        <Badge variant="outline" className={`h-5 gap-1 px-1.5 text-[10px] ${getStatusBadgeClass(selectedRun.status)}`}>
                          {getRunStatusIcon(selectedRun.status)}
                          <span>{toStatusLabel(selectedRun.status)}</span>
                        </Badge>
                      </div>
                    </div>
                    {selectedRunMetrics && (
                      <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{selectedRunMetrics}</p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/80 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
                    No recent run available.
                  </div>
                )
              }
              onContextEdit={onEditTemplate ? () => openEdit(
                selectedRun ? 'observe-run' : 'observe-run-empty',
                'Observe latest run',
              ) : undefined}
              onActivate={() => {
                const prompt = selectedRun
                  ? resolveTemplate('observe-run', customTemplates, { runId: selectedRun.id })
                  : resolveTemplate('observe-run-empty', customTemplates, {})
                onPromptSelect(prompt)
              }}
            />
          </StarterCardSlide>

          <StarterCardSlide>
            <StarterInteractiveCard
              title="Review recent sweep"
              icon={Sparkles}
              toneClass="from-indigo-500/12 to-violet-500/5 border-indigo-500/25"
              selector={
                sweepOptions.length > 0
                  ? {
                      value: selectedSweep?.id || sweepOptions[0].value,
                      options: sweepOptions,
                      onValueChange: setSelectedSweepId,
                    }
                  : undefined
              }
              hint={
                selectedSweep ? `${selectedSweepProgressPct}% complete` : 'No sweeps yet'
              }
              previewNode={
                selectedSweep ? (
                  <div className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 text-sm font-medium text-foreground">{selectedSweep.config.name}</p>
                      <Badge variant="outline" className={`h-5 px-1.5 text-[10px] capitalize ${getSweepStatusClass(selectedSweep.status)}`}>
                        {selectedSweep.status}
                      </Badge>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-border/80">
                      <div
                        className="h-full rounded-full bg-indigo-400"
                        style={{ width: `${selectedSweepProgressPct}%` }}
                      />
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                      <span>{selectedSweep.progress.completed}/{selectedSweep.progress.total} done</span>
                      <span>{selectedSweep.progress.running} running</span>
                      <span>{selectedSweep.progress.failed} failed</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/80 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
                    No sweep selected.
                  </div>
                )
              }
              onContextEdit={onEditTemplate ? () => openEdit(
                selectedSweep ? 'review-sweep' : 'review-sweep-empty',
                'Review recent sweep',
              ) : undefined}
              onActivate={() => {
                const prompt = selectedSweep
                  ? resolveTemplate('review-sweep', customTemplates, { sweepId: selectedSweep.id })
                  : resolveTemplate('review-sweep-empty', customTemplates, {})
                onPromptSelect(prompt)
              }}
            />
          </StarterCardSlide>

          <StarterCardSlide>
            <StarterInteractiveCard
              title="Primary metric check"
              icon={BarChart3}
              toneClass="from-emerald-500/10 to-teal-500/5 border-emerald-500/25"
              selector={
                runOptions.length > 0
                  ? {
                      value: selectedRun?.id || runOptions[0].value,
                      options: runOptions,
                      onValueChange: setSelectedRunId,
                    }
                  : undefined
              }
              hint={latestRunPoint ? `Latest step ${latestRunPoint.step}` : 'Primary metric trend'}
              previewNode={
                selectedRun ? (
                  <div className="space-y-1.5">
                    <div className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{selectedRun.alias || selectedRun.name}</p>
                        <Badge variant="outline" className={`h-5 gap-1 px-1.5 text-[10px] ${getStatusBadgeClass(selectedRun.status)}`}>
                          {getRunStatusIcon(selectedRun.status)}
                          <span>{toStatusLabel(selectedRun.status)}</span>
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {selectedRunMetrics || 'No metric snapshot yet'}
                      </p>
                    </div>
                    <MiniMetricChart label="Train loss" values={trainLossSeries} stroke="#f97316" />
                    <MiniMetricChart label="Val loss" values={valLossSeries} stroke="#38bdf8" />
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/80 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
                    No run selected.
                  </div>
                )
              }
              onContextEdit={onEditTemplate ? () => openEdit(
                selectedRun ? 'metric-check' : 'metric-check-empty',
                'Primary metric check',
              ) : undefined}
              onActivate={() => {
                const prompt = selectedRun
                  ? resolveTemplate('metric-check', customTemplates, { runId: selectedRun.id })
                  : resolveTemplate('metric-check-empty', customTemplates, {})
                onPromptSelect(prompt)
              }}
            />
          </StarterCardSlide>

          <StarterCardSlide>
            <StarterInteractiveCard
              title="Resolve recent alert"
              icon={AlertTriangle}
              toneClass="from-amber-500/12 to-orange-500/5 border-amber-500/30"
              selector={
                alertOptions.length > 0
                  ? {
                      value: selectedAlert?.id || alertOptions[0].value,
                      options: alertOptions,
                      onValueChange: setSelectedAlertId,
                    }
                  : undefined
              }
              hint={
                selectedAlert
                  ? `Raised ${formatRelative(new Date(selectedAlert.timestamp * 1000))}`
                  : 'No pending alerts'
              }
              previewNode={
                selectedAlert && alertTone ? (
                  <div className={`rounded-lg border px-2.5 py-2.5 ${alertTone.container}`}>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className={`mt-0.5 h-4 w-4 ${alertTone.iconClass}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className={`h-4 px-1.5 text-[9px] ${alertTone.priorityBadge}`}>
                            {alertTone.priorityLabel}
                          </Badge>
                          <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                            {selectedAlert.status}
                          </Badge>
                        </div>
                        <p className="mt-1.5 text-xs text-foreground">{selectedAlert.message}</p>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span>Run {selectedAlert.run_id}</span>
                          <span>·</span>
                          <span>{formatRelative(new Date(selectedAlert.timestamp * 1000))}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/80 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
                    No pending alerts.
                  </div>
                )
              }
              onContextEdit={onEditTemplate ? () => openEdit(
                selectedAlert ? 'resolve-alert' : 'resolve-alert-empty',
                'Resolve recent alert',
              ) : undefined}
              onActivate={() => {
                const prompt = selectedAlert
                  ? resolveTemplate('resolve-alert', customTemplates, { alertId: selectedAlert.id })
                  : resolveTemplate('resolve-alert-empty', customTemplates, {})
                onPromptSelect(prompt)
              }}
            />
          </StarterCardSlide>

          <StarterCardSlide>
            <StarterInteractiveCard
              title="Schedule jobs better"
              icon={Clock3}
              toneClass="from-rose-500/10 to-pink-500/5 border-rose-500/25"
              hint="Rebalance for faster feedback loops."
              previewNode={
                <div className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{runningJobs} running · {queuedJobs} queued</p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {pendingAlerts.length} alerts
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{queuePreview}</p>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] text-muted-foreground">Running</p>
                      <p className="text-sm font-medium text-foreground">{runningJobs}</p>
                    </div>
                    <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] text-muted-foreground">Queued</p>
                      <p className="text-sm font-medium text-foreground">{queuedJobs}</p>
                    </div>
                  </div>
                </div>
              }
              onContextEdit={onEditTemplate ? () => openEdit('schedule-jobs', 'Schedule jobs better') : undefined}
              onActivate={() => {
                onPromptSelect(
                  resolveTemplate('schedule-jobs', customTemplates, {
                    runningJobs: String(runningJobs),
                    queuedJobs: String(queuedJobs),
                    pendingAlerts: String(pendingAlerts.length),
                  })
                )
              }}
            />
          </StarterCardSlide>

          <StarterCardSlide>
            <StarterInteractiveCard
              title="Identify cluster setup"
              icon={Server}
              toneClass="from-violet-500/12 to-fuchsia-500/5 border-violet-500/25"
              selector={{
                value: selectedClusterSetup,
                options: CLUSTER_SETUP_OPTIONS,
                onValueChange: setSelectedClusterSetup,
              }}
              hint="Onboarding card for run/sweep execution environment."
              previewNode={
                <div className="rounded-lg border border-border/70 bg-background/80 px-2.5 py-2.5">
                  <p className="text-sm font-medium text-foreground">
                    {CLUSTER_SETUP_LABELS[selectedClusterSetup] || 'Auto detect'}
                  </p>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Determine whether this project uses Slurm, local GPU, Kubernetes, Ray, or a shared head node.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {['Slurm', 'Local GPU', 'Kubernetes', 'Ray'].map((label) => (
                      <span key={label} className="rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              }
              onContextEdit={onEditTemplate ? () => openEdit(
                selectedClusterSetup === 'auto' ? 'cluster-setup-auto' : 'cluster-setup',
                'Identify cluster setup',
              ) : undefined}
              onActivate={() => {
                const selectedLabel = CLUSTER_SETUP_LABELS[selectedClusterSetup] || 'Auto detect'
                const prompt = selectedClusterSetup === 'auto'
                  ? resolveTemplate('cluster-setup-auto', customTemplates, {})
                  : resolveTemplate('cluster-setup', customTemplates, { clusterLabel: selectedLabel })
                onPromptSelect(prompt)
              }}
            />
          </StarterCardSlide>
        </div>
      </div>

      {/* Edit prompt dialog */}
      {editingCard && (
        <EditPromptDialog
          open={!!editingCard}
          onOpenChange={(open) => { if (!open) setEditingCard(null) }}
          cardId={editingCard.id}
          cardTitle={editingCard.title}
          currentTemplate={customTemplates?.[editingCard.id] ?? DEFAULT_PROMPT_TEMPLATES[editingCard.id] ?? ''}
          defaultTemplate={DEFAULT_PROMPT_TEMPLATES[editingCard.id] ?? ''}
          onSave={handleSaveTemplate}
        />
      )}
    </div>
  )
}
