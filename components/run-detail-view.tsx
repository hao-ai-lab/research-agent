'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Terminal,
  Settings,
  FileText,
  ImageIcon,
  Package,
  FileCode,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Star,
  Palette,
  Archive,
  Plus,
  MoreHorizontal,
  Pencil,
  X,
  RefreshCw,
  Play,
  Square,
  BarChart3,
  AlertTriangle,
  Sparkles,
  Bell,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { getStatusText, getStatusBadgeClass } from '@/lib/status-utils'
import { RunName } from './run-name'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from 'recharts'
import { TagsDialog } from './tags-dialog'
import { LogViewer } from './log-viewer'
import { TmuxTerminalPanel } from './tmux-terminal-panel'
import { SweepArtifact } from './sweep-artifact'
import { SweepStatus } from './sweep-status'
import type { ExperimentRun, TagDefinition, MetricVisualization, Sweep } from '@/lib/types'
import { DEFAULT_RUN_COLORS, defaultMetricVisualizations } from '@/lib/mock-data'
import { getSweep, type Alert } from '@/lib/api-client'
import { mapApiSweepToUiSweep } from '@/lib/sweep-mappers'

interface RunDetailViewProps {
  run: ExperimentRun
  alerts?: Alert[]
  runs?: ExperimentRun[]
  onRunSelect?: (run: ExperimentRun) => void
  onUpdateRun?: (run: ExperimentRun) => void
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
  onRefresh?: () => void
  onStartRun?: (runId: string) => Promise<void>
  onStopRun?: (runId: string) => Promise<void>
  sweeps?: Sweep[]
}

// Generate mock metric data based on run's loss history
function generateMetricData(run: ExperimentRun, metricPath: string, layer?: number) {
  if (!run.lossHistory || run.lossHistory.length === 0) return []

  return run.lossHistory.map((point, i) => {
    let value = 0
    const noise = (Math.random() - 0.5) * 0.1

    switch (metricPath) {
      case 'train/loss':
        value = point.trainLoss
        break
      case 'val/loss':
        value = point.valLoss || point.trainLoss * 1.1
        break
      case 'train/reward':
        value = 1 - point.trainLoss + noise
        break
      case 'train/loss_ema':
        value = point.trainLoss * 0.95 + noise * 0.1
        break
      case 'train/loss_slope':
        const prevLoss = i > 0 ? run.lossHistory![i - 1].trainLoss : point.trainLoss
        value = (point.trainLoss - prevLoss) * 10 + noise
        break
      case 'val/generalization_gap':
        value = (point.valLoss || point.trainLoss * 1.1) - point.trainLoss
        break
      case 'grad/global_norm':
        value = 0.5 + Math.sin(i * 0.2) * 0.3 + noise
        break
      case 'grad/global_norm_ema':
        value = 0.5 + Math.sin(i * 0.2) * 0.2 + noise * 0.5
        break
      case 'grad/norm/attn':
        value = 0.3 + (layer || 0) * 0.05 + Math.sin(i * 0.15) * 0.1 + noise
        break
      case 'grad/norm_ratio':
        value = 0.01 + noise * 0.005
        break
      case 'act/mean':
        value = (layer || 0) * 0.1 + Math.cos(i * 0.1) * 0.2 + noise
        break
      default:
        value = point.trainLoss + noise
    }

    return { step: point.step, value: Math.max(0, value) }
  })
}

// Single metric chart component with lazy loading
function MetricChart({
  metric,
  run,
  isExpanded,
  onToggle,
  selectedLayer
}: {
  metric: MetricVisualization
  run: ExperimentRun
  isExpanded: boolean
  onToggle: () => void
  selectedLayer?: number
}) {
  const data = useMemo(() => {
    if (!isExpanded) return []
    return generateMetricData(run, metric.path, selectedLayer)
  }, [run, metric.path, isExpanded, selectedLayer])

  const chartColor = run.color || '#4ade80'

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between py-2 px-3 rounded-lg hover:bg-secondary/50 transition-colors"
        >
          <span className="text-xs font-medium text-foreground">{metric.name}</span>
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="h-32 mt-1 mb-2">
          {data.length > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              {metric.type === 'area' ? (
                <AreaChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="step" tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} width={40} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '10px' }}
                  />
                  <Area type="monotone" dataKey="value" stroke={chartColor} fill={chartColor} fillOpacity={0.3} strokeWidth={1.5} />
                </AreaChart>
              ) : (
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="step" tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} width={40} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '10px' }}
                  />
                  <Line type="monotone" dataKey="value" stroke={chartColor} strokeWidth={1.5} dot={false} />
                </LineChart>
              )}
            </ResponsiveContainer>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function RunDetailView({ run, alerts = [], runs = [], onRunSelect, onUpdateRun, allTags, onCreateTag, onRefresh, onStartRun, onStopRun, sweeps = [] }: RunDetailViewProps) {
  const [copied, setCopied] = useState(false)
  const [copiedRunId, setCopiedRunId] = useState(false)
  const [copiedSweepId, setCopiedSweepId] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [aliasEditing, setAliasEditing] = useState(false)
  const [editedAlias, setEditedAlias] = useState(run.alias || '')
  const [notesOpen, setNotesOpen] = useState(false)
  const [editedNotes, setEditedNotes] = useState(run.notes || '')
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)

  // Charts state
  const [primaryChartsOpen, setPrimaryChartsOpen] = useState(false)
  const [secondaryChartsOpen, setSecondaryChartsOpen] = useState(false)
  const [expandedCharts, setExpandedCharts] = useState<Set<string>>(new Set())
  const [layerSelections, setLayerSelections] = useState<Record<string, number>>({})

  // Logs and Terminal state
  const [logsOpen, setLogsOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [logsFullPage, setLogsFullPage] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(true)
  const [sweepObjectOpen, setSweepObjectOpen] = useState(true)
  const alertsSectionRef = useRef<HTMLDivElement | null>(null)

  const primaryMetrics = defaultMetricVisualizations.filter(m => m.category === 'primary')
  const secondaryMetrics = defaultMetricVisualizations.filter(m => m.category === 'secondary')
  const linkedSweepFromList = useMemo(
    () => sweeps.find((sweep) => sweep.id === run.sweepId),
    [run.sweepId, sweeps]
  )
  const [linkedSweepFromApi, setLinkedSweepFromApi] = useState<Sweep | null>(null)
  const [isLoadingLinkedSweep, setIsLoadingLinkedSweep] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLinkedSweepFromApi(null)

    if (!run.sweepId || linkedSweepFromList) {
      setIsLoadingLinkedSweep(false)
      return
    }

    setIsLoadingLinkedSweep(true)
    getSweep(run.sweepId)
      .then((apiSweep) => {
        if (cancelled) return
        setLinkedSweepFromApi(mapApiSweepToUiSweep(apiSweep))
      })
      .catch(() => {
        if (cancelled) return
        setLinkedSweepFromApi(null)
      })
      .finally(() => {
        if (cancelled) return
        setIsLoadingLinkedSweep(false)
      })

    return () => {
      cancelled = true
    }
  }, [linkedSweepFromList, run.sweepId])

  const linkedSweep = linkedSweepFromList || linkedSweepFromApi

  const copyCommand = () => {
    navigator.clipboard.writeText(run.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyValue = async (value: string, setCopiedState: (copied: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedState(true)
      setTimeout(() => setCopiedState(false), 1500)
    } catch (error) {
      console.error('Failed to copy value:', error)
    }
  }

  const formatDuration = (start: Date, end?: Date) => {
    const endTime = end || new Date()
    const diff = endTime.getTime() - start.getTime()
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((diff % (1000 * 60)) / 1000)

    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  const getArtifactIcon = (type: string) => {
    switch (type) {
      case 'text': return <FileText className="h-3.5 w-3.5" />
      case 'image': return <ImageIcon className="h-3.5 w-3.5" />
      case 'model': return <Package className="h-3.5 w-3.5" />
      case 'log': return <FileCode className="h-3.5 w-3.5" />
      default: return <FileText className="h-3.5 w-3.5" />
    }
  }

  const handleToggleFavorite = () => {
    onUpdateRun?.({ ...run, isFavorite: !run.isFavorite })
  }

  const handleColorChange = (color: string) => {
    onUpdateRun?.({ ...run, color })
  }

  const handleArchive = () => {
    onUpdateRun?.({ ...run, isArchived: !run.isArchived })
  }

  const handleRefresh = async () => {
    if (!onRefresh) return
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleStartRun = async () => {
    if (!onStartRun) return
    setIsStarting(true)
    try {
      await onStartRun(run.id)
      onRefresh?.()
    } finally {
      setIsStarting(false)
    }
  }

  const handleStopRun = async () => {
    if (!onStopRun) return
    setIsStopping(true)
    try {
      await onStopRun(run.id)
      onRefresh?.()
    } finally {
      setIsStopping(false)
    }
  }

  const handleSaveNotes = () => {
    onUpdateRun?.({ ...run, notes: editedNotes })
    setNotesOpen(false)
  }

  const handleSaveAlias = () => {
    onUpdateRun?.({ ...run, alias: editedAlias.trim() || undefined })
    setAliasEditing(false)
  }

  const handleCancelAlias = () => {
    setEditedAlias(run.alias || '')
    setAliasEditing(false)
  }

  const toggleChart = (chartId: string) => {
    setExpandedCharts(prev => {
      const next = new Set(prev)
      if (next.has(chartId)) {
        next.delete(chartId)
      } else {
        next.add(chartId)
      }
      return next
    })
  }

  const toggleAllInCategory = (metrics: MetricVisualization[], expand: boolean) => {
    setExpandedCharts(prev => {
      const next = new Set(prev)
      metrics.forEach(m => {
        if (expand) {
          next.add(m.id)
        } else {
          next.delete(m.id)
        }
      })
      return next
    })
  }

  const allPrimaryExpanded = primaryMetrics.every(m => expandedCharts.has(m.id))
  const allSecondaryExpanded = secondaryMetrics.every(m => expandedCharts.has(m.id))

  const runAlerts = alerts
  const pendingAlertCount = runAlerts.filter((alert) => alert.status === 'pending').length

  const formatTimestamp = (value?: Date) => {
    if (!value) return '--'
    return value.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const formatAlertTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const getTerminalOutcome = (): {
    state: 'finished' | 'failed' | 'canceled' | null
    summary: string
    detail: string | null
    className: string
  } => {
    const exitCode = typeof run.exit_code === 'number' ? run.exit_code : null
    const errorText = run.error?.trim()

    if (run.status === 'failed') {
      return {
        state: 'failed',
        summary: 'Failed',
        detail: errorText || (exitCode !== null ? `Exit code ${exitCode}` : null),
        className: 'border-destructive/40 bg-destructive/10 text-destructive',
      }
    }

    if (run.status === 'completed') {
      return {
        state: 'finished',
        summary: 'Finished',
        detail: exitCode !== null ? `Exit code ${exitCode}` : null,
        className: 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400',
      }
    }

    if (run.status === 'canceled') {
      return {
        state: 'canceled',
        summary: 'Stopped',
        detail: errorText || null,
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      }
    }

    return {
      state: null,
      summary: '',
      detail: null,
      className: 'border-border bg-secondary/40 text-muted-foreground',
    }
  }

  const terminalOutcome = getTerminalOutcome()

  const handleCheckAlerts = () => {
    setAlertsOpen(true)
    requestAnimationFrame(() => {
      alertsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-3 space-y-3">
            <div className="rounded-lg border border-border bg-card p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Status</span>
                  <Badge variant="outline" className={`${getStatusBadgeClass(run.status)}`}>
                    <span className="text-[10px]">{getStatusText(run.status)}</span>
                  </Badge>
                </div>
                {run.endTime && (
                  <span className="text-[10px] text-muted-foreground">
                    Ended: {formatTimestamp(run.endTime)}
                  </span>
                )}
              </div>
              {terminalOutcome.state && (
                <div className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${terminalOutcome.className}`}>
                  <p className="font-medium">Outcome: {terminalOutcome.summary}</p>
                  {terminalOutcome.detail && (
                    <p className="mt-0.5 break-words">{terminalOutcome.detail}</p>
                  )}
                </div>
              )}
            </div>

            {/* Alias */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">Alias</span>
              {aliasEditing ? (
                <div className="flex items-center gap-1 flex-1">
                  <Input
                    value={editedAlias}
                    onChange={(e) => setEditedAlias(e.target.value)}
                    placeholder="Enter alias..."
                    className="h-7 text-xs flex-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveAlias()
                      if (e.key === 'Escape') handleCancelAlias()
                    }}
                  />
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSaveAlias}>
                    <Check className="h-3 w-3 text-green-500" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCancelAlias}>
                    <X className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  {run.alias ? (
                    <span className="text-sm font-medium truncate">{run.alias}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">No alias set</span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={() => setAliasEditing(true)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>

            {/* IDs */}
            <div className="rounded-lg border border-border bg-card p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Run ID</p>
                  <p className="text-xs font-mono text-foreground truncate">{run.id}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => copyValue(run.id, setCopiedRunId)}
                >
                  {copiedRunId ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sweep</p>
                  {(() => {
                    const sweep = linkedSweep
                    if (sweep) {
                      return (
                        <div className="mt-1 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground truncate">{sweep.config.name}</span>
                            <Badge variant="outline" className={`text-[9px] h-4 ${
                              sweep.status === 'draft' ? 'border-violet-500/50 bg-violet-500/10 text-violet-500' :
                              sweep.status === 'running' ? 'border-blue-400/50 bg-blue-400/10 text-blue-400' :
                              sweep.status === 'completed' ? 'border-green-400/50 bg-green-400/10 text-green-400' :
                              sweep.status === 'failed' ? 'border-destructive/50 bg-destructive/10 text-destructive' :
                              'border-muted-foreground/50 bg-muted/10 text-muted-foreground'
                            }`}>{sweep.status}</Badge>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span>{sweep.progress.completed}/{sweep.progress.total} runs</span>
                            {sweep.progress.failed > 0 && <span className="text-destructive">{sweep.progress.failed} failed</span>}
                            {sweep.bestMetricValue !== undefined && (
                              <span>Best: {sweep.bestMetricValue.toFixed(4)}</span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground line-clamp-1">
                            Goal: {(sweep.creationContext.goal || sweep.config.goal || '').trim() || 'Not provided'}
                          </p>
                          <p className="text-[10px] text-muted-foreground line-clamp-1">
                            Description: {(sweep.creationContext.description || sweep.config.description || '').trim() || 'Not provided'}
                          </p>
                        </div>
                      )
                    }
                    return <p className="text-xs font-mono text-foreground truncate">{run.sweepId || 'No sweep'}</p>
                  })()}
                </div>
                {run.sweepId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => copyValue(run.sweepId!, setCopiedSweepId)}
                  >
                    {copiedSweepId ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-1 rounded-md bg-secondary/35 px-2 py-2 text-[10px] text-muted-foreground sm:grid-cols-4">
                <div>
                  <p className="uppercase tracking-wide">Start</p>
                  <p className="text-foreground">
                    {(run.startedAt || run.status === 'running' || run.status === 'completed' || run.status === 'failed' || run.status === 'canceled')
                      ? formatTimestamp(run.startedAt || run.startTime)
                      : '--'}
                  </p>
                </div>
                <div>
                  <p className="uppercase tracking-wide">Created</p>
                  <p className="text-foreground">{formatTimestamp(run.createdAt)}</p>
                </div>
                <div>
                  <p className="uppercase tracking-wide">Running Time</p>
                  <p className="text-foreground">
                    {(run.startedAt || run.status === 'running' || run.status === 'completed' || run.status === 'failed' || run.status === 'canceled')
                      ? formatDuration(run.startedAt || run.startTime, run.endTime)
                      : '--'}
                  </p>
                </div>
                <div>
                  <p className="uppercase tracking-wide">Exit Code</p>
                  <p className="text-foreground">
                    {typeof run.exit_code === 'number' ? run.exit_code : '--'}
                  </p>
                </div>
              </div>
            </div>

            {/* Sweep Object */}
            <Collapsible open={sweepObjectOpen} onOpenChange={setSweepObjectOpen}>
              <div className={`rounded-lg border overflow-hidden ${linkedSweep ? 'border-border bg-card' : 'border-border border-dashed bg-card'}`}>
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-violet-500" />
                      <span className={`text-xs font-medium ${linkedSweep ? 'text-foreground' : 'text-muted-foreground'}`}>
                        Sweep Object
                      </span>
                    </div>
                    {sweepObjectOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border px-2 pb-2">
                    {linkedSweep ? (
                      <div className="pt-2">
                        {linkedSweep.status === 'draft' ? (
                          <SweepArtifact config={linkedSweep.config} sweep={linkedSweep} isCollapsed={false} />
                        ) : (
                          <SweepStatus sweep={linkedSweep} runs={runs} onRunClick={onRunSelect} isCollapsed={false} />
                        )}
                      </div>
                    ) : (
                      <div className="px-3 py-5 text-center">
                        <p className="text-xs text-muted-foreground">
                          {run.sweepId
                            ? (isLoadingLinkedSweep
                              ? `Loading sweep ${run.sweepId}...`
                              : `Sweep ${run.sweepId} was not found.`)
                            : 'This run is not attached to a sweep object.'}
                        </p>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Tags + Quick Actions Row */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
                {run.tags && run.tags.length > 0 ? (
                  run.tags.map((tagName) => {
                    const tag = allTags.find((t) => t.name === tagName)
                    return (
                      <span
                        key={tagName}
                        className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium"
                        style={{
                          backgroundColor: tag ? `${tag.color}20` : '#4ade8020',
                          color: tag?.color || '#4ade80',
                        }}
                      >
                        {tagName}
                      </span>
                    )
                  })
                ) : (
                  <span className="text-[10px] text-muted-foreground">No tags</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  onClick={() => setTagsDialogOpen(true)}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* Job Control Buttons */}
                {(run.status === 'ready' || run.status === 'queued') && onStartRun && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleStartRun}
                    disabled={isStarting}
                    className="h-7 w-7 text-green-500 hover:text-green-400"
                    title="Start Run"
                  >
                    <Play className={`h-4 w-4 ${isStarting ? 'animate-pulse' : ''}`} />
                  </Button>
                )}
                {run.status === 'running' && onStopRun && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleStopRun}
                    disabled={isStopping}
                    className="h-7 w-7 text-destructive hover:text-destructive/80"
                    title="Stop Run"
                  >
                    <Square className={`h-4 w-4 ${isStopping ? 'animate-pulse' : ''}`} />
                  </Button>
                )}

                {/* Refresh Button */}
                {onRefresh && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="h-7 w-7 text-muted-foreground"
                    title="Refresh"
                  >
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                  </Button>
                )}

                <Button
                  variant={pendingAlertCount > 0 ? 'default' : 'ghost'}
                  size="icon"
                  onClick={handleCheckAlerts}
                  className={`h-7 w-7 ${pendingAlertCount > 0 ? '' : 'text-muted-foreground'}`}
                  title={pendingAlertCount > 0 ? `Check alerts (${pendingAlertCount} pending)` : 'Check alerts'}
                >
                  <Bell className="h-4 w-4" />
                </Button>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleToggleFavorite}
                  className={`h-7 w-7 ${run.isFavorite ? 'text-yellow-500' : 'text-muted-foreground'}`}
                >
                  <Star className={`h-4 w-4 ${run.isFavorite ? 'fill-yellow-500' : ''}`} />
                </Button>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <div
                        className="h-4 w-4 rounded-full border border-border"
                        style={{ backgroundColor: run.color || '#4ade80' }}
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-40 p-2" align="end">
                    <div className="grid grid-cols-5 gap-1.5">
                      {DEFAULT_RUN_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => handleColorChange(color)}
                          className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${run.color === color ? 'border-foreground' : 'border-transparent'
                            }`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleArchive}
                  className={`h-7 w-7 ${run.isArchived ? 'text-muted-foreground' : ''}`}
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Notes Preview/Edit */}
            {notesOpen ? (
              <div className="rounded-lg border border-border bg-card p-2">
                <Textarea
                  placeholder="Add notes about this run..."
                  value={editedNotes}
                  onChange={(e) => setEditedNotes(e.target.value)}
                  className="min-h-[60px] text-xs resize-none border-0 p-0 focus-visible:ring-0"
                />
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setNotesOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" className="h-6 text-xs" onClick={handleSaveNotes}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNotesOpen(true)}
                className="w-full text-left rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground hover:bg-secondary transition-colors"
              >
                {run.notes ? (
                  <span className="line-clamp-1">{run.notes}</span>
                ) : (
                  <span className="italic">Add notes...</span>
                )}
              </button>
            )}

            {/* Status and Progress */}
            {run.status === 'running' && (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">Progress</span>
                    <span className="text-xs font-medium text-foreground">{run.progress}%</span>
                  </div>
                  <Progress value={run.progress} className="h-1.5" />
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground">Duration</p>
                  <p className="text-sm font-medium text-foreground">{formatDuration(run.startTime, run.endTime)}</p>
                </div>
              </div>
            )}

            {/* Metrics */}
            <Collapsible open={run.metrics !== undefined} disabled={!run.metrics}>
              <div className="grid grid-cols-3 gap-2">
                {run.metrics ? (
                  <>
                    <div className="text-center p-2 rounded-lg bg-card border border-border">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Loss</p>
                      <p className="text-sm font-semibold text-foreground">{run.metrics.loss.toFixed(3)}</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-card border border-border">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Accuracy</p>
                      <p className="text-sm font-semibold text-foreground">{run.metrics.accuracy.toFixed(1)}%</p>
                    </div>
                    <div className="text-center p-2 rounded-lg bg-card border border-border">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Epoch</p>
                      <p className="text-sm font-semibold text-foreground">
                        {run.metrics.epoch}{run.config?.maxEpochs && `/${run.config.maxEpochs}`}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="col-span-3 text-center p-3 rounded-lg bg-card border border-border border-dashed">
                    <p className="text-[10px] text-muted-foreground">No metrics collected yet</p>
                  </div>
                )}
              </div>
            </Collapsible>

            {/* Alerts */}
            <div ref={alertsSectionRef}>
              <Collapsible open={alertsOpen} onOpenChange={setAlertsOpen}>
                <div className={`rounded-lg border bg-card overflow-hidden ${runAlerts.length > 0 ? 'border-border' : 'border-border border-dashed'}`}>
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <span className={`text-xs font-medium ${runAlerts.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                        Alerts {runAlerts.length > 0 && `(${runAlerts.length})`}
                      </span>
                    </div>
                    {alertsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border px-3 pb-3">
                    {runAlerts.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {runAlerts.map((alert) => {
                          const severity = alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'
                          const badgeClass =
                            severity === 'error'
                              ? 'border-destructive/50 bg-destructive/10 text-destructive'
                              : severity === 'warning'
                              ? 'border-warning/50 bg-warning/10 text-warning'
                              : 'border-blue-400/50 bg-blue-400/10 text-blue-400'
                          return (
                            <div key={alert.id} className="rounded border border-border bg-secondary/40 p-2">
                              <div className="flex items-start gap-2">
                                <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 ${severity === 'error' ? 'text-destructive' : severity === 'warning' ? 'text-warning' : 'text-blue-400'}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <Badge variant="outline" className={`text-[9px] h-4 ${badgeClass}`}>
                                      {alert.severity}
                                    </Badge>
                                    <span className="text-[10px] text-muted-foreground">
                                      {formatAlertTime(alert.timestamp)}
                                    </span>
                                  </div>
                                  <p className="text-xs text-foreground mt-1 leading-relaxed">
                                    {alert.message}
                                  </p>
                                  {alert.response && (
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                      Response: {alert.response}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="mt-2 py-4 text-center">
                        <p className="text-xs text-muted-foreground">No alerts for this run</p>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
                </div>
              </Collapsible>
            </div>

            {/* Charts Section - Primary */}
            {run.lossHistory && run.lossHistory.length > 0 && (
              <Collapsible open={primaryChartsOpen} onOpenChange={setPrimaryChartsOpen}>
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <span className="text-xs font-medium text-foreground">Primary Metrics</span>
                      <div className="flex items-center gap-2">
                        {primaryChartsOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleAllInCategory(primaryMetrics, !allPrimaryExpanded)
                            }}
                          >
                            {allPrimaryExpanded ? 'Collapse All' : 'Expand All'}
                          </Button>
                        )}
                        {primaryChartsOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border px-2 pb-2">
                      {primaryMetrics.map((metric) => (
                        <MetricChart
                          key={metric.id}
                          metric={metric}
                          run={run}
                          isExpanded={expandedCharts.has(metric.id)}
                          onToggle={() => toggleChart(metric.id)}
                        />
                      ))}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}

            {/* Charts Section - Secondary */}
            {run.lossHistory && run.lossHistory.length > 0 && (
              <Collapsible open={secondaryChartsOpen} onOpenChange={setSecondaryChartsOpen}>
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <span className="text-xs font-medium text-foreground">Secondary Metrics</span>
                      <div className="flex items-center gap-2">
                        {secondaryChartsOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleAllInCategory(secondaryMetrics, !allSecondaryExpanded)
                            }}
                          >
                            {allSecondaryExpanded ? 'Collapse All' : 'Expand All'}
                          </Button>
                        )}
                        {secondaryChartsOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border px-2 pb-2">
                      {secondaryMetrics.map((metric) => (
                        <div key={metric.id}>
                          {metric.layerSelector && (
                            <div className="flex items-center gap-2 px-3 pt-2">
                              <span className="text-[10px] text-muted-foreground">Layer:</span>
                              <select
                                className="text-[10px] bg-secondary border-0 rounded px-1.5 py-0.5 text-foreground"
                                value={layerSelections[metric.id] || 0}
                                onChange={(e) => setLayerSelections(prev => ({ ...prev, [metric.id]: Number(e.target.value) }))}
                              >
                                {Array.from({ length: 12 }, (_, i) => (
                                  <option key={i} value={i}>Layer {i}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <MetricChart
                            metric={metric}
                            run={run}
                            isExpanded={expandedCharts.has(metric.id)}
                            onToggle={() => toggleChart(metric.id)}
                            selectedLayer={layerSelections[metric.id]}
                          />
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}

            {/* Charts Section - Empty State */}
            {(!run.lossHistory || run.lossHistory.length === 0) && (
              <Collapsible>
                <div className="rounded-lg border border-border border-dashed bg-card overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">Charts</span>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border px-3 py-6 text-center">
                      <p className="text-xs text-muted-foreground">No chart data available</p>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}


            {/* Logs Section */}
            <Collapsible open={logsOpen} onOpenChange={setLogsOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <FileCode className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">Logs</span>
                      {run.status === 'running' && (
                        <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      )}
                    </div>
                    {logsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border">
                    <LogViewer
                      runId={run.id}
                      isFullPage={logsFullPage}
                      onExpand={() => setLogsFullPage(true)}
                    />
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Terminal Section */}
            <Collapsible open={terminalOpen} onOpenChange={setTerminalOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">Terminal</span>
                      {(run as any).tmux_window && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                          {(run as any).tmux_window}
                        </span>
                      )}
                    </div>
                    {terminalOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border">
                    <TmuxTerminalPanel
                      runId={run.id}
                      tmuxWindow={(run as any).tmux_window}
                      tmuxPane={(run as any).tmux_pane}
                    />
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Command */}
            <Collapsible open={commandOpen} onOpenChange={setCommandOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">Command</span>
                    </div>
                    {commandOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border px-3 pb-3">
                    <div className="mt-2 relative">
                      <code className="text-[11px] font-mono text-green-400 bg-black/30 rounded overflow-hidden text-ellipsis ">
                        {/* {run.command} */}
                        {run.command}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={copyCommand}
                        className="absolute right-1 top-1 h-6 w-6"
                      >
                        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Hyperparameters */}
            <Collapsible open={configOpen} onOpenChange={setConfigOpen}>
              <div className={`rounded-lg border bg-card overflow-hidden ${run.config ? 'border-border' : 'border-border border-dashed'}`}>
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Settings className="h-4 w-4 text-muted-foreground" />
                      <span className={`text-xs font-medium ${run.config ? 'text-foreground' : 'text-muted-foreground'}`}>Hyperparameters</span>
                    </div>
                    {configOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border px-3 pb-3">
                    {run.config ? (
                      <div className="mt-2 space-y-1">
                        {Object.entries(run.config).map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                            <span className="text-[10px] text-muted-foreground capitalize">
                              {key.replace(/([A-Z])/g, ' $1').trim()}
                            </span>
                            <span className="text-[10px] font-mono text-foreground">
                              {typeof value === 'number' && value < 0.01 ? value.toExponential(1) : String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 py-4 text-center">
                        <p className="text-xs text-muted-foreground">No hyperparameters configured</p>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Artifacts */}
            <Collapsible open={artifactsOpen} onOpenChange={setArtifactsOpen}>
              <div className={`rounded-lg border bg-card overflow-hidden ${run.artifacts && run.artifacts.length > 0 ? 'border-border' : 'border-border border-dashed'}`}>
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-muted-foreground" />
                      <span className={`text-xs font-medium ${run.artifacts && run.artifacts.length > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                        Artifacts {run.artifacts && run.artifacts.length > 0 && `(${run.artifacts.length})`}
                      </span>
                    </div>
                    {artifactsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border px-3 pb-3">
                    {run.artifacts && run.artifacts.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {run.artifacts.map((artifact) => (
                          <div key={artifact.id} className="rounded border border-border bg-secondary/50 p-2">
                            <div className="flex items-center gap-1.5 mb-1">
                              {getArtifactIcon(artifact.type)}
                              <span className="text-[10px] font-medium text-foreground flex-1 truncate">{artifact.name}</span>
                              <Badge variant="outline" className="text-[8px] h-4">{artifact.type}</Badge>
                            </div>
                            {artifact.content && (
                              <pre className="text-[9px] text-muted-foreground whitespace-pre-wrap font-mono bg-background rounded p-1.5 max-h-20 overflow-y-auto">
                                {artifact.content}
                              </pre>
                            )}
                            {artifact.url && (
                              <a href={artifact.url} className="text-[10px] text-accent hover:underline">
                                Download
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 py-4 text-center">
                        <p className="text-xs text-muted-foreground">No artifacts saved</p>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        </ScrollArea>
      </div>

      <TagsDialog
        open={tagsDialogOpen}
        onOpenChange={setTagsDialogOpen}
        allTags={allTags}
        selectedTags={run.tags || []}
        onToggleTag={(tagName) => {
          const currentTags = run.tags || []
          if (currentTags.includes(tagName)) {
            onUpdateRun?.({ ...run, tags: currentTags.filter((t) => t !== tagName) })
          } else {
            onUpdateRun?.({ ...run, tags: [...currentTags, tagName] })
          }
        }}
        onCreateTag={onCreateTag}
      />
    </div>
  )
}
