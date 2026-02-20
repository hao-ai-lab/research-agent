'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Terminal,
  FileText,
  ImageIcon,
  Package,
  FileCode,
  Copy,
  Eye,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Pencil,
  X,
  BarChart3,
  AlertTriangle,
  ScrollText,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { getStatusText, getStatusBadgeClass } from '@/lib/status-utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts'
import { TagsDialog } from './tags-dialog'
import { LogViewer } from './log-viewer'
import { TmuxTerminalPanel } from './tmux-terminal-panel'
import type { ExperimentRun, TagDefinition, MetricVisualization, Sweep } from '@/lib/types'
import { getSweep, type Alert } from '@/lib/api-client'
import { mapApiSweepToUiSweep } from '@/lib/sweep-mappers'

interface RunDetailViewProps {
  run: ExperimentRun
  alerts?: Alert[]
  onSweepSelect?: (sweep: Sweep) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onOpenEditRun?: (run: ExperimentRun) => void
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
  sweeps?: Sweep[]
}

type RunDetailFieldKey =
  | 'aliasNotes'
  | 'tags'
  | 'chat'
  | 'summary'
  | 'gpuwrap'
  | 'outcome'
  | 'metrics'
  | 'alerts'
  | 'charts'
  | 'logs'
  | 'sidecarLogs'
  | 'terminal'
  | 'command'
  | 'artifacts'

type RunDetailFieldVisibility = Record<RunDetailFieldKey, boolean>

const RUN_DETAIL_FIELD_VISIBILITY_STORAGE_KEY = 'run-detail-field-visibility-v1'

const DEFAULT_FIELD_VISIBILITY: RunDetailFieldVisibility = {
  aliasNotes: true,
  tags: true,
  chat: false,
  summary: true,
  gpuwrap: true,
  outcome: true,
  metrics: true,
  alerts: true,
  charts: true,
  logs: true,
  sidecarLogs: true,
  terminal: false,
  command: true,
  artifacts: false,
}

// Generate chart data from metricSeries (real data) with lossHistory fallback
function generateMetricData(run: ExperimentRun, metricPath: string, _layer?: number) {
  // Priority 1: real metricSeries data from the server
  const series = run.metricSeries?.[metricPath]
  if (series && series.length > 0) {
    return series.map((point) => ({ step: point.step, value: point.value }))
  }

  // Priority 2: derive from lossHistory for backward compat
  if (!run.lossHistory || run.lossHistory.length === 0) return []

  if (metricPath === 'train/loss') {
    return run.lossHistory.map((point) => ({ step: point.step, value: point.trainLoss }))
  }
  if (metricPath === 'val/loss') {
    return run.lossHistory.map((point) => ({ step: point.step, value: point.valLoss ?? point.trainLoss * 1.1 }))
  }

  return []
}

// Helper functions for dynamic metric detection
function metricCategoryFromPath(_path: string): 'primary' | 'secondary' {
  return 'primary'
}

function metricTypeFromPath(path: string): 'line' | 'area' | 'bar' {
  const key = path.toLowerCase()
  if (key.includes('slope') || key.includes('gap') || key.includes('delta')) return 'area'
  return 'line'
}

function metricDisplayName(path: string): string {
  const clean = path.replace(/^metrics\//, '')
  const parts = clean.split('/').filter(Boolean)
  const last = parts.length > 0 ? parts[parts.length - 1] : clean
  const name = last.replace(/[_\-]+/g, ' ').trim()
  return name.charAt(0).toUpperCase() + name.slice(1) || clean
}

function hasChartData(run: ExperimentRun): boolean {
  const hasLossHistory = !!(run.lossHistory && run.lossHistory.length > 0)
  const hasMetricSeries = !!(
    run.metricSeries &&
    Object.values(run.metricSeries).some((points) => points && points.length > 0)
  )
  return hasLossHistory || hasMetricSeries
}

function buildMetricVisualizations(run: ExperimentRun): MetricVisualization[] {
  const metricKeys = new Set<string>()

  // Collect from metricSeries
  if (run.metricSeries) {
    Object.entries(run.metricSeries).forEach(([key, points]) => {
      if (points && points.length > 0) metricKeys.add(key)
    })
  }

  // Collect from lossHistory as fallback
  if (metricKeys.size === 0 && run.lossHistory && run.lossHistory.length > 0) {
    metricKeys.add('train/loss')
    if (run.lossHistory.some((p) => p.valLoss !== undefined)) {
      metricKeys.add('val/loss')
    }
  }

  return Array.from(metricKeys)
    .sort((a, b) => a.localeCompare(b))
    .map((metricPath) => ({
      id: `metric:${metricPath.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      name: metricDisplayName(metricPath),
      path: metricPath,
      category: metricCategoryFromPath(metricPath),
      type: metricTypeFromPath(metricPath),
    }))
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

export function RunDetailView({ run, alerts = [], onSweepSelect, onUpdateRun, onOpenEditRun, allTags, onCreateTag, sweeps = [] }: RunDetailViewProps) {
  const [copied, setCopied] = useState(false)
  const [copiedRunId, setCopiedRunId] = useState(false)
  const [copiedSweepId, setCopiedSweepId] = useState(false)
  const [commandEditing, setCommandEditing] = useState(false)
  const [editedCommand, setEditedCommand] = useState(run.command)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [aliasEditing, setAliasEditing] = useState(false)
  const [editedAlias, setEditedAlias] = useState(run.alias || '')
  const [notesOpen, setNotesOpen] = useState(false)
  const [editedNotes, setEditedNotes] = useState(run.notes || '')
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false)
  const [fieldsPopoverOpen, setFieldsPopoverOpen] = useState(false)
  const [fieldVisibility, setFieldVisibility] = useState<RunDetailFieldVisibility>(DEFAULT_FIELD_VISIBILITY)

  // Charts state
  const [chartsOpen, setChartsOpen] = useState(false)
  const [expandedCharts, setExpandedCharts] = useState<Set<string>>(new Set())
  const [layerSelections, setLayerSelections] = useState<Record<string, number>>({})

  // Logs and Terminal state
  const [logsOpen, setLogsOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [sidecarLogsOpen, setSidecarLogsOpen] = useState(false)
  const [logsFullPage, setLogsFullPage] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(true)

  const allMetrics = useMemo(() => buildMetricVisualizations(run), [run])
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(RUN_DETAIL_FIELD_VISIBILITY_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<RunDetailFieldVisibility>
      setFieldVisibility((prev) => ({ ...prev, ...parsed }))
    } catch {
      // Ignore invalid persisted values.
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      RUN_DETAIL_FIELD_VISIBILITY_STORAGE_KEY,
      JSON.stringify(fieldVisibility)
    )
  }, [fieldVisibility])

  useEffect(() => {
    setEditedCommand(run.command)
    setCommandEditing(false)
  }, [run.id, run.command])

  const copyCommand = () => {
    navigator.clipboard.writeText(commandEditing ? editedCommand : run.command)
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

  const handleSaveNotes = () => {
    onUpdateRun?.({ ...run, notes: editedNotes })
    setNotesOpen(false)
  }

  const handleSaveAlias = () => {
    onUpdateRun?.({ ...run, alias: editedAlias.trim() || undefined })
    setAliasEditing(false)
  }

  const handleSaveCommand = () => {
    const nextCommand = editedCommand.trim()
    if (!nextCommand) return
    onUpdateRun?.({ ...run, command: nextCommand })
    setCommandEditing(false)
  }

  const handleCancelCommand = () => {
    setEditedCommand(run.command)
    setCommandEditing(false)
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

  const allChartsExpanded = allMetrics.every(m => expandedCharts.has(m.id))

  const runAlerts = alerts

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
  const metricEntries = run.metrics
    ? Object.entries(run.metrics).filter(([key, val]) => typeof val === 'number' && !key.startsWith('_'))
    : []
  const gpuwrapEnabled = run.gpuwrap_config?.enabled === true

  const toggleFieldVisibility = (field: RunDetailFieldKey) => {
    setFieldVisibility((prev) => ({ ...prev, [field]: !prev[field] }))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-3 space-y-3">
            <div className="flex items-center justify-end gap-2">
              {onOpenEditRun && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => onOpenEditRun(run)}
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </Button>
              )}
              <Popover open={fieldsPopoverOpen} onOpenChange={setFieldsPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                    <Eye className="h-3 w-3" />
                    Fields
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56 p-2">
                  <div className="space-y-1">
                    {([
                      ['aliasNotes', 'Alias & notes'],
                      ['tags', 'Tags'],
                      ['chat', 'Chat'],
                      ['summary', 'Summary'],
                      ['gpuwrap', 'GPU wrap'],
                      ['outcome', 'Outcome'],
                      ['metrics', 'Metrics'],
                      ['alerts', 'Alerts'],
                      ['charts', 'Charts'],
                      ['logs', 'Logs'],
                      ['sidecarLogs', 'Sidecar logs'],
                      ['terminal', 'Terminal'],
                      ['command', 'Command'],
                      ['artifacts', 'Artifacts'],
                    ] as Array<[RunDetailFieldKey, string]>).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary"
                        onClick={() => toggleFieldVisibility(key)}
                      >
                        <span>{label}</span>
                        {fieldVisibility[key] ? <Check className="h-3.5 w-3.5 text-green-500" /> : <X className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {fieldVisibility.aliasNotes && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Alias</div>
                  {aliasEditing ? (
                    <div className="flex items-center gap-1">
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
                    <div className="flex items-center gap-1 min-w-0">
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

                <div className="rounded-lg border border-border bg-card p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Notes</div>
                  {notesOpen ? (
                    <>
                      <Textarea
                        placeholder="Add notes about this run..."
                        value={editedNotes}
                        onChange={(e) => setEditedNotes(e.target.value)}
                        className="min-h-[60px] text-xs resize-none"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setNotesOpen(false)}>
                          Cancel
                        </Button>
                        <Button size="sm" className="h-6 text-xs" onClick={handleSaveNotes}>
                          Save
                        </Button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setNotesOpen(true)}
                      className="w-full text-left rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground hover:bg-secondary transition-colors"
                    >
                      {run.notes ? (
                        <span className="line-clamp-2">{run.notes}</span>
                      ) : (
                        <span className="italic">Add notes...</span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            )}

            {fieldVisibility.tags && (
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto rounded-lg border border-border bg-card px-2 py-1.5">
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
            )}

            {fieldVisibility.chat && (
              <div className="rounded-lg border border-border bg-card p-2 text-xs">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Chat Session</p>
                <p className="mt-1 font-mono text-foreground">{run.chatSessionId || 'Not linked'}</p>
              </div>
            )}

            {fieldVisibility.summary && (
              <div className="rounded-lg border border-border bg-card p-2 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-border/60 bg-secondary/25 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Run ID</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyValue(run.id, setCopiedRunId)}
                      >
                        {copiedRunId ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    <p className="text-xs font-mono text-foreground truncate">{run.id}</p>
                  </div>

                  <div className="rounded-md border border-border/60 bg-secondary/25 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sweep</p>
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
                    {linkedSweep ? (
                      <button
                        type="button"
                        onClick={() => onSweepSelect?.(linkedSweep)}
                        className="mt-1 flex w-full items-center justify-between rounded-md border border-border/50 bg-secondary/35 px-2 py-1.5 text-left transition-colors hover:bg-secondary/60 disabled:cursor-default disabled:hover:bg-secondary/35"
                        disabled={!onSweepSelect}
                      >
                        <span className="truncate text-xs font-medium text-foreground">
                          {linkedSweep.config.name || linkedSweep.id}
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    ) : (
                      <p className="mt-1 text-xs font-mono text-foreground truncate">
                        {run.sweepId
                          ? (isLoadingLinkedSweep ? `Loading ${run.sweepId}...` : run.sweepId)
                          : 'No sweep'}
                      </p>
                    )}
                    {linkedSweep && (
                      <div className="mt-1 flex items-center gap-2">
                        <span className="truncate text-[10px] font-mono text-muted-foreground">{linkedSweep.id}</span>
                        <Badge variant="outline" className="h-4 text-[9px] capitalize">
                          {linkedSweep.status}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>

                {fieldVisibility.command && (
                  <div className="rounded-md border border-border/60 bg-secondary/25 p-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Command</p>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 text-[10px]"
                          onClick={copyCommand}
                        >
                          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                          Copy
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 text-[10px]"
                          onClick={() => setCommandEditing((prev) => !prev)}
                          disabled={!onUpdateRun || run.status === 'running'}
                        >
                          <Pencil className="h-3 w-3" />
                          {commandEditing ? 'Close' : 'Edit'}
                        </Button>
                      </div>
                    </div>
                    {commandEditing ? (
                      <>
                        <Textarea
                          value={editedCommand}
                          onChange={(e) => setEditedCommand(e.target.value)}
                          className="min-h-[96px] resize-y font-mono text-xs"
                          placeholder="Enter run command..."
                        />
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={handleCancelCommand}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            onClick={handleSaveCommand}
                            disabled={!editedCommand.trim()}
                          >
                            Save
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="rounded bg-muted/50 px-2 py-1.5">
                        <code className="whitespace-pre-wrap break-all text-[11px] font-mono text-foreground">
                          {run.command}
                        </code>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 px-2 py-2 text-[10px] text-muted-foreground sm:grid-cols-5">
                  <div>
                    <p className="uppercase tracking-wide">Status</p>
                    <Badge variant="outline" className={`mt-1 h-5 text-[9px] ${getStatusBadgeClass(run.status)}`}>
                      {getStatusText(run.status)}
                    </Badge>
                  </div>
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
            )}

            {fieldVisibility.gpuwrap && (
              <div className={`rounded-md border px-2 py-1.5 text-[11px] ${gpuwrapEnabled ? 'border-blue-500/40 bg-blue-500/10 text-blue-300' : 'border-border bg-secondary/40 text-muted-foreground'}`}>
                <p className="font-medium">GPU Wrap: {gpuwrapEnabled ? 'Enabled' : 'Disabled'}</p>
                {gpuwrapEnabled && (
                  <p className="mt-0.5">
                    Retries: {run.gpuwrap_config?.retries == null ? 'Unlimited' : run.gpuwrap_config?.retries} · Retry delay: {run.gpuwrap_config?.retry_delay_seconds ?? 5}s
                  </p>
                )}
              </div>
            )}

            {fieldVisibility.outcome && terminalOutcome.state && (
              <div className={`rounded-md border px-2 py-1.5 text-[11px] ${terminalOutcome.className}`}>
                <p className="font-medium">Outcome: {terminalOutcome.summary}</p>
                {terminalOutcome.detail && (
                  <p className="mt-0.5 break-words">{terminalOutcome.detail}</p>
                )}
              </div>
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
            {fieldVisibility.metrics && metricEntries.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {metricEntries.slice(0, 6).map(([key, val]) => (
                  <div key={key} className="text-center p-2 rounded-lg bg-card border border-border">
                    <p className="text-[10px] text-muted-foreground mb-0.5 truncate" title={key}>{key}</p>
                    <p className="text-sm font-semibold text-foreground">
                      {typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(4)) : String(val)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Alerts */}
            {fieldVisibility.alerts && (
            <div id={`run-alerts-${run.id}`}>
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
            )}

            {/* Charts Section */}
            {fieldVisibility.charts && hasChartData(run) && allMetrics.length > 0 && (
              <Collapsible open={chartsOpen} onOpenChange={setChartsOpen}>
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <span className="text-xs font-medium text-foreground">Charts</span>
                      <div className="flex items-center gap-2">
                        {chartsOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleAllInCategory(allMetrics, !allChartsExpanded)
                            }}
                          >
                            {allChartsExpanded ? 'Collapse All' : 'Expand All'}
                          </Button>
                        )}
                        {chartsOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border px-2 pb-2">
                      {allMetrics.map((metric) => (
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
            {fieldVisibility.charts && !hasChartData(run) && (
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

            {(fieldVisibility.logs || fieldVisibility.sidecarLogs) && (
              <div className="grid gap-3 lg:grid-cols-2">
                {fieldVisibility.logs && (
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
                            showHeader={false}
                            className="rounded-none border-0 bg-transparent"
                          />
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {fieldVisibility.sidecarLogs && (
                  <Collapsible open={sidecarLogsOpen} onOpenChange={setSidecarLogsOpen}>
                    <div className="rounded-lg border border-border bg-card overflow-hidden">
                      <CollapsibleTrigger asChild>
                        <button type="button" className="flex w-full items-center justify-between p-3">
                          <div className="flex items-center gap-2">
                            <ScrollText className="h-4 w-4 text-muted-foreground" />
                            <span className="text-xs font-medium text-foreground">Sidecar Logs</span>
                            {run.status === 'running' && (
                              <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                            )}
                          </div>
                          {sidecarLogsOpen ? (
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
                            logSource="sidecar"
                            showHeader={false}
                            className="rounded-none border-0 bg-transparent"
                          />
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}
              </div>
            )}

            {fieldVisibility.terminal && (
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
                        showHeader={false}
                        className="rounded-none border-0 bg-transparent"
                      />
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}

            {/* Artifacts */}
            {fieldVisibility.artifacts && (
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
            )}
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
