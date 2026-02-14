'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  Layers,
  PanelLeftOpen,
  Pin,
  Search,
  Settings,
  Square,
  Star,
  TrendingUp,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RunVisibilitySelector } from './run-visibility-selector'
import { VisibilityManageView } from './visibility-manage-view'
import { cn } from '@/lib/utils'
import type { InsightChart, MetricVisualization, ExperimentRun, VisibilityGroup } from '@/lib/types'
import { defaultMetricVisualizations } from '@/lib/mock-data'
import { VisualComparisonGrid } from '@/components/visual-comparison-grid'

interface ChartsViewProps {
  runs: ExperimentRun[]
  customCharts: InsightChart[]
  onTogglePin?: (id: string) => void
  onToggleOverview?: (id: string) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onShowVisibilityManageChange?: (show: boolean) => void
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

type MetricSectionId = 'pinned' | 'primary' | 'secondary'
type MetricSeriesPoint = { step: number; value: number }

const chartStrokeFallback = '#8fd0ff'

const smoothingOptions = [
  { label: '0.00', value: '0.00' },
  { label: '0.25', value: '0.25' },
  { label: '0.50', value: '0.50' },
  { label: '0.75', value: '0.75' },
  { label: '0.90', value: '0.90' },
]

function smoothSeries(values: number[], factor: number): number[] {
  if (values.length <= 1 || factor <= 0) {
    return values
  }

  const out = new Array(values.length)
  out[0] = values[0]
  for (let i = 1; i < values.length; i += 1) {
    out[i] = out[i - 1] * factor + values[i] * (1 - factor)
  }
  return out
}

function deterministicNoise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

function toMetricId(path: string): string {
  return `metric:${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

function titleCaseWord(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function metricDisplayName(path: string): string {
  const clean = path.replace(/^metrics\//, '')
  const parts = clean.split('/').filter(Boolean)
  const last = parts.length > 0 ? parts[parts.length - 1] : clean
  const name = last.replace(/[_\-]+/g, ' ').trim()
  return titleCaseWord(name || clean)
}

function metricCategoryFromPath(path: string): 'primary' | 'secondary' {
  const key = path.toLowerCase()
  if (
    key.includes('loss') ||
    key.includes('accuracy') ||
    key.includes('reward') ||
    key.includes('score') ||
    key.includes('f1') ||
    key.includes('bleu') ||
    key.includes('rouge') ||
    key.includes('perplexity')
  ) {
    return 'primary'
  }
  return 'secondary'
}

function metricTypeFromPath(path: string): 'line' | 'area' | 'bar' {
  const key = path.toLowerCase()
  if (key.includes('slope') || key.includes('gap') || key.includes('delta')) {
    return 'area'
  }
  return 'line'
}

function metricSortWeight(path: string): number {
  const key = path.toLowerCase()
  if (key === 'train/loss' || key === 'loss') return 0
  if (key === 'val/loss' || key === 'validation/loss') return 1
  if (key.includes('loss')) return 2
  if (key.includes('accuracy') || key.includes('reward') || key.includes('score')) return 3
  if (key.includes('grad')) return 4
  return 10
}

function hasRunChartData(run: ExperimentRun): boolean {
  const hasLossHistory = !!(run.lossHistory && run.lossHistory.length > 0)
  const hasMetricSeries = !!(
    run.metricSeries &&
    Object.values(run.metricSeries).some((points) => points && points.length > 0)
  )
  return hasLossHistory || hasMetricSeries
}

function metricValueAt(metricPath: string, history: { step: number; trainLoss: number; valLoss?: number }[], index: number): number {
  const point = history[index]
  const trainLoss = Math.max(point.trainLoss, 0.0001)
  const valLoss = Math.max(point.valLoss ?? trainLoss * 1.1, 0.0001)
  const prevTrainLoss = index > 0 ? history[index - 1].trainLoss : trainLoss

  switch (metricPath) {
    case 'train/loss':
      return trainLoss
    case 'val/loss':
      return valLoss
    case 'train/reward':
      return Math.max(0, 1.35 - trainLoss * 0.55)
    case 'train/loss_ema':
      return trainLoss * 0.92 + valLoss * 0.08
    case 'train/loss_slope':
      return trainLoss - prevTrainLoss
    case 'val/generalization_gap':
      return valLoss - trainLoss
    case 'grad/global_norm':
      return 0.12 + trainLoss * 0.25 + deterministicNoise(index + point.step) * 0.03
    case 'grad/global_norm_ema':
      return 0.08 + trainLoss * 0.2
    case 'grad/norm/attn':
      return 0.06 + trainLoss * 0.12 + deterministicNoise(index + point.step * 0.3) * 0.02
    case 'grad/norm_ratio':
      return 0.025 + trainLoss * 0.04
    case 'act/mean':
      return 0.2 + deterministicNoise(index + point.step * 0.1) * 0.06
    default:
      return trainLoss
  }
}

function fallbackMetricData(metricPath: string, runs: ExperimentRun[], visibleRunIds: Set<string>) {
  const visibleRuns = runs.filter((r) => visibleRunIds.has(r.id))
  const data: { step: number; [key: string]: number }[] = []

  for (let i = 0; i <= 100; i += 5) {
    const step = i * 100
    const point: { step: number; [key: string]: number } = { step }
    visibleRuns.forEach((run, runIdx) => {
      const seed = i + runIdx * 7
      const baseValue = metricPath.includes('loss')
        ? 2.3 * Math.exp(-i / 32) + 0.08
        : metricPath.includes('grad')
          ? 0.35 + 0.16 * Math.exp(-i / 40)
          : 0.35 + 0.2 * deterministicNoise(seed)
      point[run.id] = Number(baseValue.toFixed(5))
    })
    data.push(point)
  }

  return data
}

function getRunMetricSeries(run: ExperimentRun, metricPath: string): MetricSeriesPoint[] {
  const directSeries = run.metricSeries?.[metricPath]
  if (directSeries && directSeries.length > 0) {
    return directSeries
  }

  if (!run.lossHistory || run.lossHistory.length === 0) {
    return []
  }

  return run.lossHistory.map((point, index, history) => ({
    step: point.step,
    value: Math.max(0, metricValueAt(metricPath, history, index)),
  }))
}

function buildMetricData(
  metricPath: string,
  runs: ExperimentRun[],
  visibleRunIds: Set<string>,
  smoothing: number
): { step: number; [key: string]: number }[] {
  const stepRows = new Map<number, { step: number; [key: string]: number }>()

  runs.forEach((run) => {
    if (!visibleRunIds.has(run.id) || run.isArchived) {
      return
    }

    const series = getRunMetricSeries(run, metricPath)
    if (series.length === 0) {
      return
    }

    const raw = series.map((point) => point.value)
    const smoothed = smoothSeries(raw, smoothing)

    series.forEach((point, i) => {
      const row = stepRows.get(point.step) || { step: point.step }
      row[run.id] = Number(smoothed[i].toFixed(6))
      stepRows.set(point.step, row)
    })
  })

  if (stepRows.size === 0) {
    return fallbackMetricData(metricPath, runs, visibleRunIds)
  }

  return Array.from(stepRows.values()).sort((a, b) => a.step - b.step)
}

export function ChartsView({
  runs,
  customCharts,
  onTogglePin,
  onToggleOverview,
  onUpdateRun,
  onShowVisibilityManageChange,
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: ChartsViewProps) {
  const [activeSection, setActiveSection] = useState<'standard' | 'custom' | 'videoCompare'>('standard')
  const [metrics, setMetrics] = useState<MetricVisualization[]>(defaultMetricVisualizations)
  const [selectedLayer, setSelectedLayer] = useState<Record<string, number>>({})
  const [showVisibilityManage, setShowVisibilityManageInternal] = useState(false)
  const [showVisibilitySection, setShowVisibilitySection] = useState(false)
  const [metricSearchQuery, setMetricSearchQuery] = useState('')
  const [isMetricFilterOpen, setIsMetricFilterOpen] = useState(false)
  const [selectedMetricIds, setSelectedMetricIds] = useState<Set<string>>(new Set())
  const [metricSelectionInitialized, setMetricSelectionInitialized] = useState(false)
  const [smoothing, setSmoothing] = useState('0.50')
  const [sectionOpen, setSectionOpen] = useState<Record<MetricSectionId, boolean>>({
    pinned: true,
    primary: true,
    secondary: true,
  })

  const [chartSettings, setChartSettings] = useState({
    xAxisFontSize: 10,
    yAxisFontSize: 10,
    xAxisTickCount: 5,
    yAxisTickCount: 5,
    yAxisWidth: 34,
  })
  const [draftSettings, setDraftSettings] = useState({ ...chartSettings })
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleSaveSettings = () => {
    setChartSettings({ ...draftSettings })
    setSettingsOpen(false)
  }

  const handleOpenSettings = (open: boolean) => {
    if (open) {
      setDraftSettings({ ...chartSettings })
    }
    setSettingsOpen(open)
  }

  const setShowVisibilityManage = (show: boolean) => {
    setShowVisibilityManageInternal(show)
    onShowVisibilityManageChange?.(show)
  }

  const activeRuns = useMemo(
    () => runs.filter((r) => !r.isArchived && hasRunChartData(r)),
    [runs]
  )

  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(activeRuns.map((r) => r.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  const dynamicMetricVisualizations = useMemo<MetricVisualization[]>(() => {
    const metricKeys = new Set<string>()
    runs.forEach((run) => {
      if (!run.metricSeries) return
      Object.entries(run.metricSeries).forEach(([metricKey, points]) => {
        if (points && points.length > 0) {
          metricKeys.add(metricKey)
        }
      })
    })

    if (metricKeys.size === 0) {
      return []
    }

    return Array.from(metricKeys)
      .sort((a, b) => {
        const sortDiff = metricSortWeight(a) - metricSortWeight(b)
        if (sortDiff !== 0) return sortDiff
        return a.localeCompare(b)
      })
      .map((metricPath) => {
        const normalized = metricPath.toLowerCase()
        const defaultPinned =
          normalized === 'train/loss' ||
          normalized === 'loss' ||
          normalized === 'val/loss' ||
          normalized === 'validation/loss'

        return {
          id: toMetricId(metricPath),
          name: metricDisplayName(metricPath),
          path: metricPath,
          category: metricCategoryFromPath(metricPath),
          type: metricTypeFromPath(metricPath),
          isPinned: defaultPinned,
          isInOverview: defaultPinned,
          layerSelector: false,
        }
      })
  }, [runs])

  useEffect(() => {
    if (dynamicMetricVisualizations.length === 0) {
      setMetrics((prev) => {
        const hasDynamicMetrics = prev.some((metric) => metric.id.startsWith('metric:'))
        return hasDynamicMetrics ? defaultMetricVisualizations : prev
      })
      return
    }

    setMetrics((prev) => {
      const previousByPath = new Map(prev.map((metric) => [metric.path, metric]))
      return dynamicMetricVisualizations.map((metric) => {
        const previous = previousByPath.get(metric.path)
        if (!previous) {
          return metric
        }
        return {
          ...metric,
          isPinned: previous.isPinned ?? metric.isPinned,
          isInOverview: previous.isInOverview ?? metric.isInOverview,
          layerSelector: previous.layerSelector ?? metric.layerSelector,
        }
      })
    })
  }, [dynamicMetricVisualizations])

  useEffect(() => {
    if (metrics.length === 0) return

    setSelectedMetricIds((prev) => {
      if (!metricSelectionInitialized || prev.size === 0) {
        return new Set(metrics.map((metric) => metric.id))
      }

      const validIds = new Set(metrics.map((metric) => metric.id))
      const next = new Set<string>()
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id)
      })
      metrics.forEach((metric) => {
        if (!next.has(metric.id)) {
          next.add(metric.id)
        }
      })
      return next
    })

    if (!metricSelectionInitialized) {
      setMetricSelectionInitialized(true)
    }
  }, [metricSelectionInitialized, metrics])

  useEffect(() => {
    const activeIdSet = new Set(activeRuns.map((r) => r.id))
    setVisibleRunIds((prev) => {
      const filtered = new Set(Array.from(prev).filter((id) => activeIdSet.has(id)))
      if (filtered.size > 0 || activeRuns.length === 0) {
        return filtered
      }
      return new Set(activeRuns.map((r) => r.id))
    })
  }, [activeRuns])

  const visibleRuns = useMemo(
    () => runs.filter((r) => !r.isArchived && visibleRunIds.has(r.id) && hasRunChartData(r)),
    [runs, visibleRunIds]
  )

  const filterQuery = metricSearchQuery.trim().toLowerCase()
  const matchesFilter = (m: MetricVisualization) => {
    return selectedMetricIds.has(m.id)
  }

  const metricFilterOptions = useMemo(
    () => metrics
      .filter((metric) => (
        !filterQuery
        || metric.name.toLowerCase().includes(filterQuery)
        || metric.path.toLowerCase().includes(filterQuery)
      ))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [filterQuery, metrics]
  )

  const selectedMetricCount = selectedMetricIds.size
  const totalMetricCount = metrics.length

  const toggleMetricSelection = (metricId: string) => {
    setSelectedMetricIds((prev) => {
      const next = new Set(prev)
      if (next.has(metricId)) {
        next.delete(metricId)
      } else {
        next.add(metricId)
      }
      return next
    })
  }

  const selectAllMetrics = () => {
    setSelectedMetricIds(new Set(metrics.map((metric) => metric.id)))
  }

  const clearMetricSelection = () => {
    setSelectedMetricIds(new Set())
  }

  const primaryMetrics = metrics.filter((m) => m.category === 'primary' && matchesFilter(m))
  const secondaryMetrics = metrics.filter((m) => m.category === 'secondary' && matchesFilter(m))
  const pinnedMetrics = metrics.filter((m) => m.isPinned && matchesFilter(m))

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
      const group = visibilityGroups.find((g) => g.id === groupId)
      if (group) {
        setVisibleRunIds(new Set(group.runIds))
      }
      return
    }

    setVisibleRunIds(new Set(activeRuns.map((r) => r.id)))
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups((prev) => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups((prev) => prev.filter((g) => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(activeRuns.map((r) => r.id)))
    }
  }

  const handleToggleMetricPin = (metricId: string) => {
    setMetrics((prev) => prev.map((m) => (m.id === metricId ? { ...m, isPinned: !m.isPinned } : m)))
  }

  const handleToggleMetricOverview = (metricId: string) => {
    setMetrics((prev) => prev.map((m) => (m.id === metricId ? { ...m, isInOverview: !m.isInOverview } : m)))
  }

  const renderMetricChart = (metric: MetricVisualization) => {
    const data = buildMetricData(metric.path, runs, visibleRunIds, Number(smoothing))
    const isArea = metric.type === 'area'

    return (
      <div key={metric.id} className="rounded-lg bg-card/40 px-1 py-2 sm:px-2">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
              <h4 className="truncate text-sm font-semibold text-foreground">{metric.name}</h4>
              <Badge variant="outline" className="h-5 shrink-0 rounded px-1.5 font-mono text-[10px] text-muted-foreground">
                {metric.path}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {visibleRuns.length} run{visibleRuns.length !== 1 ? 's' : ''} visible
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {metric.layerSelector && (
              <Select
                value={String(selectedLayer[metric.id] || 0)}
                onValueChange={(v) => setSelectedLayer((prev) => ({ ...prev, [metric.id]: Number(v) }))}
              >
                <SelectTrigger className="h-7 w-20 text-xs">
                  <SelectValue placeholder="Layer" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>
                      Layer {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleToggleMetricOverview(metric.id)}
            >
              <Star className={cn('h-4 w-4', metric.isInOverview ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleToggleMetricPin(metric.id)}
            >
              <Pin className={cn('h-4 w-4', metric.isPinned ? 'fill-accent text-accent' : 'text-muted-foreground')} />
            </Button>
          </div>
        </div>

        <div className="h-44 w-full rounded-md bg-background/50 p-0.5">
          <ResponsiveContainer width="100%" height="100%">
            {isArea ? (
              <AreaChart data={data}>
                <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="step"
                  tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#404040' }}
                  tickLine={false}
                  tickCount={chartSettings.xAxisTickCount}
                />
                <YAxis
                  tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#404040' }}
                  tickLine={false}
                  width={chartSettings.yAxisWidth}
                  tickCount={chartSettings.yAxisTickCount}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f1115',
                    border: '1px solid #2f2f2f',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#e5e7eb',
                  }}
                  labelStyle={{ color: '#d1d5db' }}
                />
                {visibleRuns.map((run) => (
                  <Area
                    key={run.id}
                    name={run.alias || run.name}
                    type="monotone"
                    dataKey={run.id}
                    stroke={run.color || chartStrokeFallback}
                    fill={`${run.color || chartStrokeFallback}26`}
                    strokeWidth={1.8}
                    isAnimationActive={false}
                    dot={false}
                    connectNulls
                  />
                ))}
              </AreaChart>
            ) : (
              <LineChart data={data}>
                <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="step"
                  tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#404040' }}
                  tickLine={false}
                  tickCount={chartSettings.xAxisTickCount}
                />
                <YAxis
                  tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#404040' }}
                  tickLine={false}
                  width={chartSettings.yAxisWidth}
                  tickCount={chartSettings.yAxisTickCount}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f1115',
                    border: '1px solid #2f2f2f',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#e5e7eb',
                  }}
                  labelStyle={{ color: '#d1d5db' }}
                />
                {visibleRuns.map((run) => (
                  <Line
                    key={run.id}
                    name={run.alias || run.name}
                    type="monotone"
                    dataKey={run.id}
                    stroke={run.color || chartStrokeFallback}
                    strokeWidth={1.8}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {visibleRuns.map((run) => (
            <div key={run.id} className="inline-flex items-center gap-1 rounded border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: run.color || chartStrokeFallback }} />
              <span className="max-w-[96px] truncate">{run.alias || run.name}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderCustomChart = (chart: InsightChart) => {
    const data = chart.data.map((d) => ({
      name: d.label,
      value: d.value,
      secondary: d.secondary,
    }))

    let chartElement: React.ReactNode = null

    switch (chart.type) {
      case 'line':
        chartElement = (
          <ResponsiveContainer width="100%" height={128}>
            <LineChart data={data}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} tickCount={chartSettings.xAxisTickCount} />
              <YAxis tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} width={chartSettings.yAxisWidth} tickCount={chartSettings.yAxisTickCount} />
              <Tooltip contentStyle={{ backgroundColor: '#0f1115', border: '1px solid #2f2f2f', borderRadius: '8px', fontSize: '11px' }} />
              <Line type="monotone" dataKey="value" stroke="#4ade80" strokeWidth={2} dot={{ fill: '#4ade80', r: 2.6 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )
        break
      case 'bar':
        chartElement = (
          <ResponsiveContainer width="100%" height={128}>
            <BarChart data={data}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} tickCount={chartSettings.xAxisTickCount} />
              <YAxis tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} width={chartSettings.yAxisWidth} tickCount={chartSettings.yAxisTickCount} />
              <Tooltip contentStyle={{ backgroundColor: '#0f1115', border: '1px solid #2f2f2f', borderRadius: '8px', fontSize: '11px' }} />
              <Bar dataKey="value" fill="#4ade80" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )
        break
      case 'area':
        chartElement = (
          <ResponsiveContainer width="100%" height={128}>
            <AreaChart data={data}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} tickCount={chartSettings.xAxisTickCount} />
              <YAxis tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} width={chartSettings.yAxisWidth} tickCount={chartSettings.yAxisTickCount} />
              <Tooltip contentStyle={{ backgroundColor: '#0f1115', border: '1px solid #2f2f2f', borderRadius: '8px', fontSize: '11px' }} />
              <Area type="monotone" dataKey="value" stroke="#4ade80" fill="#4ade8033" strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )
        break
      case 'scatter':
        chartElement = (
          <ResponsiveContainer width="100%" height={128}>
            <ScatterChart>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} type="category" allowDuplicatedCategory={false} tickCount={chartSettings.xAxisTickCount} />
              <YAxis dataKey="value" tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#9ca3af' }} axisLine={{ stroke: '#404040' }} tickLine={false} width={chartSettings.yAxisWidth} tickCount={chartSettings.yAxisTickCount} />
              <Tooltip contentStyle={{ backgroundColor: '#0f1115', border: '1px solid #2f2f2f', borderRadius: '8px', fontSize: '11px' }} />
              <Scatter data={data} fill="#4ade80" />
            </ScatterChart>
          </ResponsiveContainer>
        )
        break
    }

    return (
      <div key={chart.id} className="rounded-lg bg-card/40 p-2 sm:p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-sm font-semibold text-foreground">{chart.title}</h4>
            {chart.description && <p className="truncate text-xs text-muted-foreground">{chart.description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onToggleOverview?.(chart.id)}>
              <Star className={cn('h-4 w-4', chart.isInOverview ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onTogglePin?.(chart.id)}>
              <Pin className={cn('h-4 w-4', chart.isPinned ? 'fill-accent text-accent' : 'text-muted-foreground')} />
            </Button>
          </div>
        </div>
        <div className="rounded-md bg-background/50 p-0.5">{chartElement}</div>
      </div>
    )
  }

  const renderMetricSection = (id: MetricSectionId, title: string, sectionMetrics: MetricVisualization[], badgeLabel?: string) => {
    if (sectionMetrics.length === 0) {
      return null
    }

    const open = sectionOpen[id]

    return (
      <Collapsible key={id} open={open} onOpenChange={(next) => setSectionOpen((prev) => ({ ...prev, [id]: next }))}>
        <div className="rounded-lg bg-transparent">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-secondary/40"
            >
              <div className="flex min-w-0 items-center gap-2">
                {open ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="truncate text-sm font-semibold text-foreground">{title}</span>
                <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px] text-muted-foreground">
                  {sectionMetrics.length}
                </Badge>
              </div>
              {badgeLabel && (
                <Badge variant="outline" className="h-5 rounded border-accent/40 bg-accent/10 px-1.5 text-[10px] text-accent">
                  {badgeLabel}
                </Badge>
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-1">
              {sectionMetrics.map(renderMetricChart)}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    )
  }

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
        onBack={() => setShowVisibilityManage(false)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-3 py-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {showDesktopSidebarToggle && onDesktopSidebarToggle && (
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onDesktopSidebarToggle}
                className="hidden h-8 w-8 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
                title="Show sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
                <span className="sr-only">Show sidebar</span>
              </Button>
            )}
            <Select value={activeSection} onValueChange={(value) => setActiveSection(value as 'standard' | 'custom' | 'videoCompare')}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">
                  <span className="inline-flex items-center gap-2">
                    <Layers className="h-3.5 w-3.5" />
                    Workspace
                  </span>
                </SelectItem>
                <SelectItem value="custom">
                  <span className="inline-flex items-center gap-2">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Custom
                  </span>
                </SelectItem>
                <SelectItem value="videoCompare">
                  <span className="inline-flex items-center gap-2">
                    <Eye className="h-3.5 w-3.5" />
                    Video Compare
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>

            {activeSection === 'standard' && (
              <>
                <Popover open={isMetricFilterOpen} onOpenChange={setIsMetricFilterOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2 text-xs">
                      <Search className="h-3.5 w-3.5" />
                      <span>Filter metrics</span>
                      <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
                        {selectedMetricCount}/{totalMetricCount}
                      </Badge>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[min(92vw,320px)] p-2">
                    <div className="space-y-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          value={metricSearchQuery}
                          onChange={(e) => setMetricSearchQuery(e.target.value)}
                          placeholder="Search metrics"
                          className="h-8 pl-7 text-xs"
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={selectAllMetrics}>
                          Select all
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={clearMetricSelection}>
                          Clear
                        </Button>
                      </div>
                      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/70 p-1">
                        {metricFilterOptions.length > 0 ? (
                          metricFilterOptions.map((metric) => {
                            const selected = selectedMetricIds.has(metric.id)
                            return (
                              <button
                                key={metric.id}
                                type="button"
                                onClick={() => toggleMetricSelection(metric.id)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                                  selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50'
                                )}
                              >
                                {selected ? <CheckSquare className="h-3.5 w-3.5 shrink-0" /> : <Square className="h-3.5 w-3.5 shrink-0" />}
                                <span className="min-w-0 flex-1 truncate">{metric.name}</span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">{metric.path}</span>
                              </button>
                            )
                          })
                        ) : (
                          <p className="px-2 py-2 text-xs text-muted-foreground">No metrics found.</p>
                        )}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            )}
            <Popover open={settingsOpen} onOpenChange={handleOpenSettings}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8">
                  <Settings className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64">
                <div className="space-y-4">
                  <h4 className="text-sm font-medium">Chart Settings</h4>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-visibility" className="text-xs">
                      Show visibility toggle
                    </Label>
                    <Switch
                      id="show-visibility"
                      checked={showVisibilitySection}
                      onCheckedChange={setShowVisibilitySection}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Smoothness</Label>
                    <Select value={smoothing} onValueChange={setSmoothing}>
                      <SelectTrigger className="h-7 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {smoothingOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground">Axis Settings</p>

                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">X-Axis Font</Label>
                      <Input
                        type="number"
                        value={draftSettings.xAxisFontSize}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, xAxisFontSize: Number(e.target.value) }))}
                        className="h-7 w-16 text-xs"
                        min={0}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">Y-Axis Font</Label>
                      <Input
                        type="number"
                        value={draftSettings.yAxisFontSize}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisFontSize: Number(e.target.value) }))}
                        className="h-7 w-16 text-xs"
                        min={0}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">X-Axis Ticks</Label>
                      <Input
                        type="number"
                        value={draftSettings.xAxisTickCount}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, xAxisTickCount: Number(e.target.value) }))}
                        className="h-7 w-16 text-xs"
                        min={0}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">Y-Axis Ticks</Label>
                      <Input
                        type="number"
                        value={draftSettings.yAxisTickCount}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisTickCount: Number(e.target.value) }))}
                        className="h-7 w-16 text-xs"
                        min={0}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">Y-Axis Width</Label>
                      <Input
                        type="number"
                        value={draftSettings.yAxisWidth}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisWidth: Number(e.target.value) }))}
                        className="h-7 w-16 text-xs"
                        min={0}
                      />
                    </div>
                  </div>

                  <Button size="sm" className="h-8 w-full text-xs" onClick={handleSaveSettings}>
                    Save Settings
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          {activeSection === 'standard' && (
            <div className="text-[11px] text-muted-foreground">
              {visibleRuns.length} visible run{visibleRuns.length !== 1 ? 's' : ''} in workspace
            </div>
          )}
        </div>
      </div>

      {showVisibilitySection && (
        <div className="shrink-0 border-b border-border bg-background px-3 py-2">
          <RunVisibilitySelector
            runs={activeRuns}
            visibleRunIds={visibleRunIds}
            onToggleVisibility={toggleRunVisibility}
            visibilityGroups={visibilityGroups}
            activeGroupId={activeGroupId}
            onSelectGroup={handleSelectGroup}
            onOpenManage={() => setShowVisibilityManage(true)}
          />
        </div>
      )}

      {activeSection !== 'videoCompare' && (
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-3 px-1 py-2 sm:px-3">
            {activeSection === 'standard' ? (
              <>
                {renderMetricSection('pinned', 'Pinned', pinnedMetrics, 'Pinned')}
                {renderMetricSection('primary', 'Primary Metrics', primaryMetrics.filter((m) => !m.isPinned))}
                {renderMetricSection('secondary', 'Secondary Metrics', secondaryMetrics.filter((m) => !m.isPinned))}

                {pinnedMetrics.length === 0 && primaryMetrics.length === 0 && secondaryMetrics.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    No metrics match your filter.
                  </div>
                )}
              </>
            ) : activeSection === 'custom' ? (
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/10">
                    <TrendingUp className="h-4 w-4 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-foreground">Custom Visualizations</h3>
                    <p className="text-xs text-muted-foreground">{customCharts.length} saved charts</p>
                  </div>
                </div>
                <div className="space-y-3">
                  {customCharts.map(renderCustomChart)}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      )}

      {/* Video Compare (full-height, outside ScrollArea) */}
      {activeSection === 'videoCompare' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <VisualComparisonGrid runs={runs} />
        </div>
      )}
    </div>
  )
}
