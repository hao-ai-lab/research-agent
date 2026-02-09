'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Layers,
  Pin,
  Settings,
  Star,
  TrendingUp,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { RunVisibilitySelector } from './run-visibility-selector'
import { VisibilityManageView } from './visibility-manage-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useIsMobile } from '@/hooks/use-mobile'
import { defaultMetricVisualizations } from '@/lib/mock-data'
import type {
  ExperimentRun,
  InsightChart,
  MetricVisualization,
  VisibilityGroup,
} from '@/lib/types'

interface ChartsViewProps {
  runs: ExperimentRun[]
  customCharts: InsightChart[]
  onTogglePin?: (id: string) => void
  onToggleOverview?: (id: string) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onShowVisibilityManageChange?: (show: boolean) => void
}

type LayoutMode = 'fixed-grid' | 'flex'

interface ChartsViewSettings {
  showVisibilitySection: boolean
  layoutMode: LayoutMode
  chartsPerRow: number
  multiColumnThresholdPx: number
  minChartWidth: number
  maxChartWidth: number
  chartHeight: number
  xAxisFontSize: number
  yAxisFontSize: number
  xAxisTickCount: number
  yAxisTickCount: number
  yAxisWidth: number
}

const CHART_SETTINGS_STORAGE_KEY = 'research-agent-charts-view-settings-v1'

const DEFAULT_CHART_SETTINGS: ChartsViewSettings = {
  showVisibilitySection: false,
  layoutMode: 'fixed-grid',
  chartsPerRow: 2,
  multiColumnThresholdPx: 980,
  minChartWidth: 280,
  maxChartWidth: 560,
  chartHeight: 180,
  xAxisFontSize: 10,
  yAxisFontSize: 10,
  xAxisTickCount: 5,
  yAxisTickCount: 5,
  yAxisWidth: 40,
}

interface StandardMetricDataset {
  rows: Array<Record<string, number>>
  runIdsWithData: Set<string>
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sanitizeSettings(partial?: Partial<ChartsViewSettings>): ChartsViewSettings {
  const source = { ...DEFAULT_CHART_SETTINGS, ...(partial || {}) }
  return {
    showVisibilitySection: Boolean(source.showVisibilitySection),
    layoutMode: source.layoutMode === 'flex' ? 'flex' : 'fixed-grid',
    chartsPerRow: clampInt(source.chartsPerRow, 1, 6),
    multiColumnThresholdPx: clampInt(source.multiColumnThresholdPx, 640, 2400),
    minChartWidth: clampInt(source.minChartWidth, 180, 1200),
    maxChartWidth: clampInt(source.maxChartWidth, 200, 1400),
    chartHeight: clampInt(source.chartHeight, 120, 520),
    xAxisFontSize: clampInt(source.xAxisFontSize, 8, 20),
    yAxisFontSize: clampInt(source.yAxisFontSize, 8, 20),
    xAxisTickCount: clampInt(source.xAxisTickCount, 2, 16),
    yAxisTickCount: clampInt(source.yAxisTickCount, 2, 16),
    yAxisWidth: clampInt(source.yAxisWidth, 24, 120),
  }
}

function loadStoredSettings(): ChartsViewSettings {
  if (typeof window === 'undefined') return DEFAULT_CHART_SETTINGS
  try {
    const raw = window.localStorage.getItem(CHART_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_CHART_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ChartsViewSettings>
    return sanitizeSettings(parsed)
  } catch {
    return DEFAULT_CHART_SETTINGS
  }
}

function hasRunSeries(data: StandardMetricDataset, runId: string): boolean {
  return data.runIdsWithData.has(runId)
}

function getValueForMetric(
  metricPath: string,
  currentPoint: { step: number; trainLoss: number; valLoss?: number },
  previousPoint: { step: number; trainLoss: number; valLoss?: number } | undefined,
  previousEma: number | null,
): { value: number | null; ema: number | null } {
  switch (metricPath) {
    case 'train/loss':
      return { value: currentPoint.trainLoss, ema: previousEma }
    case 'val/loss':
      return {
        value: typeof currentPoint.valLoss === 'number' ? currentPoint.valLoss : null,
        ema: previousEma,
      }
    case 'train/loss_ema': {
      const nextEma = previousEma == null
        ? currentPoint.trainLoss
        : (0.2 * currentPoint.trainLoss + 0.8 * previousEma)
      return { value: nextEma, ema: nextEma }
    }
    case 'train/loss_slope':
      return {
        value: previousPoint ? (currentPoint.trainLoss - previousPoint.trainLoss) : null,
        ema: previousEma,
      }
    case 'val/generalization_gap':
      return {
        value: typeof currentPoint.valLoss === 'number'
          ? (currentPoint.valLoss - currentPoint.trainLoss)
          : null,
        ema: previousEma,
      }
    default:
      // No true source data for these metrics yet.
      return { value: null, ema: previousEma }
  }
}

function buildMetricDataset(metricPath: string, runs: ExperimentRun[]): StandardMetricDataset {
  const stepMap = new Map<number, Record<string, number>>()
  const runIdsWithData = new Set<string>()

  runs.forEach((run) => {
    if (!run.lossHistory || run.lossHistory.length === 0) return

    let previousEma: number | null = null
    let previousPoint: { step: number; trainLoss: number; valLoss?: number } | undefined

    run.lossHistory.forEach((point) => {
      const { value, ema } = getValueForMetric(metricPath, point, previousPoint, previousEma)
      previousEma = ema
      previousPoint = point

      if (typeof value !== 'number' || Number.isNaN(value)) return

      const rounded = Number(value.toFixed(6))
      const row = stepMap.get(point.step) || { step: point.step }
      row[run.id] = rounded
      stepMap.set(point.step, row)
      runIdsWithData.add(run.id)
    })
  })

  const rows = Array.from(stepMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row)

  return { rows, runIdsWithData }
}

function CustomChartCard({
  chart,
  chartHeight,
  chartSettings,
  onTogglePin,
  onToggleOverview,
}: {
  chart: InsightChart
  chartHeight: number
  chartSettings: ChartsViewSettings
  onTogglePin?: (id: string) => void
  onToggleOverview?: (id: string) => void
}) {
  const data = chart.data.map((item) => ({ label: item.label, value: item.value, secondary: item.secondary }))

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{chart.title}</p>
          {chart.description && (
            <p className="truncate text-[11px] text-muted-foreground">{chart.description}</p>
          )}
        </div>
        <div className="ml-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggleOverview?.(chart.id)}
          >
            <Star className={`h-4 w-4 ${chart.isInOverview ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onTogglePin?.(chart.id)}
          >
            <Pin className={`h-4 w-4 ${chart.isPinned ? 'fill-accent text-accent' : 'text-muted-foreground'}`} />
          </Button>
        </div>
      </div>
      <div className="px-2 pb-2 pt-2" style={{ height: chartHeight }}>
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.22)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#94a3b8' }}
                axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                tickLine={false}
                tickCount={chartSettings.xAxisTickCount}
              />
              <YAxis
                tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#94a3b8' }}
                axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                tickLine={false}
                width={chartSettings.yAxisWidth}
                tickCount={chartSettings.yAxisTickCount}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  border: '1px solid rgba(148, 163, 184, 0.4)',
                  borderRadius: '8px',
                  fontSize: '11px',
                }}
              />
              <Line type="monotone" dataKey="value" stroke="#4ade80" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
            No chart data available.
          </div>
        )}
      </div>
    </div>
  )
}

function StandardMetricCard({
  metric,
  visibleRuns,
  dataset,
  chartSettings,
  chartHeight,
  onToggleMetricPin,
  onToggleMetricOverview,
}: {
  metric: MetricVisualization
  visibleRuns: ExperimentRun[]
  dataset: StandardMetricDataset
  chartSettings: ChartsViewSettings
  chartHeight: number
  onToggleMetricPin: (metricId: string) => void
  onToggleMetricOverview: (metricId: string) => void
}) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{metric.name}</p>
          <p className="truncate text-[10px] text-muted-foreground">{metric.path}</p>
        </div>
        <div className="ml-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggleMetricOverview(metric.id)}
          >
            <Star className={`h-4 w-4 ${metric.isInOverview ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggleMetricPin(metric.id)}
          >
            <Pin className={`h-4 w-4 ${metric.isPinned ? 'fill-accent text-accent' : 'text-muted-foreground'}`} />
          </Button>
        </div>
      </div>

      <div className="px-2 pb-2 pt-2" style={{ height: chartHeight }}>
        {dataset.rows.length > 0 && visibleRuns.some((run) => hasRunSeries(dataset, run.id)) ? (
          <ResponsiveContainer width="100%" height="100%">
            {metric.type === 'area' ? (
              <AreaChart data={dataset.rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.22)" />
                <XAxis
                  dataKey="step"
                  tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#94a3b8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                  tickLine={false}
                  tickCount={chartSettings.xAxisTickCount}
                />
                <YAxis
                  tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#94a3b8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                  tickLine={false}
                  width={chartSettings.yAxisWidth}
                  tickCount={chartSettings.yAxisTickCount}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    border: '1px solid rgba(148, 163, 184, 0.4)',
                    borderRadius: '8px',
                    fontSize: '11px',
                  }}
                />
                {visibleRuns.map((run) => (
                  <Area
                    key={run.id}
                    type="monotone"
                    dataKey={run.id}
                    name={run.alias || run.name}
                    stroke={run.color || '#4ade80'}
                    fill={`${run.color || '#4ade80'}33`}
                    strokeWidth={1.8}
                    connectNulls
                  />
                ))}
              </AreaChart>
            ) : (
              <LineChart data={dataset.rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.22)" />
                <XAxis
                  dataKey="step"
                  tick={{ fontSize: chartSettings.xAxisFontSize, fill: '#94a3b8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                  tickLine={false}
                  tickCount={chartSettings.xAxisTickCount}
                />
                <YAxis
                  tick={{ fontSize: chartSettings.yAxisFontSize, fill: '#94a3b8' }}
                  axisLine={{ stroke: 'rgba(148, 163, 184, 0.4)' }}
                  tickLine={false}
                  width={chartSettings.yAxisWidth}
                  tickCount={chartSettings.yAxisTickCount}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    border: '1px solid rgba(148, 163, 184, 0.4)',
                    borderRadius: '8px',
                    fontSize: '11px',
                  }}
                />
                {visibleRuns.map((run) => (
                  <Line
                    key={run.id}
                    type="monotone"
                    dataKey={run.id}
                    name={run.alias || run.name}
                    stroke={run.color || '#4ade80'}
                    strokeWidth={1.8}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
            No source data for this metric in visible runs.
          </div>
        )}
      </div>
    </div>
  )
}

export function ChartsView({
  runs,
  customCharts,
  onTogglePin,
  onToggleOverview,
  onUpdateRun,
  onShowVisibilityManageChange,
}: ChartsViewProps) {
  const isMobile = useIsMobile()

  const [metrics, setMetrics] = useState<MetricVisualization[]>(defaultMetricVisualizations)
  const [showVisibilityManage, setShowVisibilityManageInternal] = useState(false)
  const [chartSettings, setChartSettings] = useState<ChartsViewSettings>(DEFAULT_CHART_SETTINGS)
  const [draftSettings, setDraftSettings] = useState<ChartsViewSettings>(DEFAULT_CHART_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsHydrated, setSettingsHydrated] = useState(false)

  const [viewportWidth, setViewportWidth] = useState(1440)

  const [overviewOpen, setOverviewOpen] = useState(true)
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [primaryOpen, setPrimaryOpen] = useState(true)
  const [secondaryOpen, setSecondaryOpen] = useState(true)
  const [customOpen, setCustomOpen] = useState(true)

  const activeRuns = useMemo(
    () => runs.filter((run) => !run.isArchived && run.lossHistory && run.lossHistory.length > 0),
    [runs]
  )

  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(activeRuns.map((run) => run.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  useEffect(() => {
    const loaded = loadStoredSettings()
    setChartSettings(loaded)
    setDraftSettings(loaded)
    setSettingsHydrated(true)
  }, [])

  useEffect(() => {
    if (!settingsHydrated) return
    window.localStorage.setItem(CHART_SETTINGS_STORAGE_KEY, JSON.stringify(chartSettings))
  }, [chartSettings, settingsHydrated])

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth)
    updateWidth()
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [])

  useEffect(() => {
    setVisibleRunIds((prev) => {
      const activeIds = new Set(activeRuns.map((run) => run.id))
      const next = new Set<string>()
      prev.forEach((runId) => {
        if (activeIds.has(runId)) next.add(runId)
      })
      if (next.size === 0) {
        activeRuns.forEach((run) => next.add(run.id))
      }
      return next
    })
  }, [activeRuns])

  const setShowVisibilityManage = (show: boolean) => {
    setShowVisibilityManageInternal(show)
    onShowVisibilityManageChange?.(show)
  }

  const visibleRuns = useMemo(
    () => activeRuns.filter((run) => visibleRunIds.has(run.id)),
    [activeRuns, visibleRunIds]
  )

  const metricDatasets = useMemo(() => {
    const map = new Map<string, StandardMetricDataset>()
    metrics.forEach((metric) => {
      map.set(metric.id, buildMetricDataset(metric.path, visibleRuns))
    })
    return map
  }, [metrics, visibleRuns])

  const overviewMetrics = metrics.filter((metric) => metric.isInOverview)
  const pinnedMetrics = metrics.filter((metric) => metric.isPinned)
  const primaryMetrics = metrics.filter((metric) => metric.category === 'primary')
  const secondaryMetrics = metrics.filter((metric) => metric.category === 'secondary')

  const overviewCustomCharts = customCharts.filter((chart) => chart.isInOverview)

  const canUseMultiColumn = !isMobile && viewportWidth >= chartSettings.multiColumnThresholdPx
  const safeMinWidth = Math.max(180, Math.min(chartSettings.minChartWidth, chartSettings.maxChartWidth))
  const safeMaxWidth = Math.max(safeMinWidth, chartSettings.maxChartWidth)
  const effectiveColumns = canUseMultiColumn ? clampInt(chartSettings.chartsPerRow, 1, 6) : 1

  const wrapForLayout = (items: React.ReactNode[]) => {
    if (items.length === 0) {
      return (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No charts in this section.
        </div>
      )
    }

    if (chartSettings.layoutMode === 'fixed-grid') {
      return (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${effectiveColumns}, minmax(${safeMinWidth}px, 1fr))`,
          }}
        >
          {items.map((item, index) => (
            <div key={`grid-${index}`} style={{ width: '100%', maxWidth: canUseMultiColumn ? `${safeMaxWidth}px` : '100%' }}>
              {item}
            </div>
          ))}
        </div>
      )
    }

    return (
      <div className="flex flex-wrap gap-3">
        {items.map((item, index) => (
          <div
            key={`flex-${index}`}
            style={canUseMultiColumn
              ? {
                  flex: `1 1 ${safeMinWidth}px`,
                  minWidth: `${safeMinWidth}px`,
                  maxWidth: `${safeMaxWidth}px`,
                }
              : {
                  flexBasis: '100%',
                  minWidth: '100%',
                  maxWidth: '100%',
                }}
          >
            {item}
          </div>
        ))}
      </div>
    )
  }

  const handleOpenSettings = (open: boolean) => {
    if (open) {
      setDraftSettings({ ...chartSettings })
    }
    setSettingsOpen(open)
  }

  const handleSaveSettings = () => {
    setChartSettings(sanitizeSettings(draftSettings))
    setSettingsOpen(false)
  }

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
      const group = visibilityGroups.find((item) => item.id === groupId)
      if (group) {
        setVisibleRunIds(new Set(group.runIds))
      }
      return
    }
    setVisibleRunIds(new Set(activeRuns.map((run) => run.id)))
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups((prev) => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups((prev) => prev.filter((group) => group.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(activeRuns.map((run) => run.id)))
    }
  }

  const handleToggleMetricPin = (metricId: string) => {
    setMetrics((prev) => prev.map((metric) => (
      metric.id === metricId ? { ...metric, isPinned: !metric.isPinned } : metric
    )))
  }

  const handleToggleMetricOverview = (metricId: string) => {
    setMetrics((prev) => prev.map((metric) => (
      metric.id === metricId ? { ...metric, isInOverview: !metric.isInOverview } : metric
    )))
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
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">Charts</h3>
            <p className="truncate text-xs text-muted-foreground">
              Run-detail charting style, aggregated across all visible runs.
            </p>
          </div>
          <Popover open={settingsOpen} onOpenChange={handleOpenSettings}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <Settings className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[320px]">
              <div className="space-y-4">
                <h4 className="text-sm font-medium">Charts Settings</h4>

                <div className="space-y-2 border-b border-border pb-3">
                  <p className="text-xs font-medium text-muted-foreground">Visibility</p>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-visibility" className="text-xs">Show run visibility selector</Label>
                    <Switch
                      id="show-visibility"
                      checked={draftSettings.showVisibilitySection}
                      onCheckedChange={(checked) => setDraftSettings((prev) => ({ ...prev, showVisibilitySection: checked }))}
                    />
                  </div>
                </div>

                <div className="space-y-3 border-b border-border pb-3">
                  <p className="text-xs font-medium text-muted-foreground">Layout</p>

                  <div className="grid gap-1.5">
                    <Label className="text-xs">Layout Mode</Label>
                    <Select
                      value={draftSettings.layoutMode}
                      onValueChange={(value) => setDraftSettings((prev) => ({ ...prev, layoutMode: value as LayoutMode }))}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fixed-grid">Fixed grid</SelectItem>
                        <SelectItem value="flex">Flex wrap</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Charts / row</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.chartsPerRow}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, chartsPerRow: Number(e.target.value) }))}
                        min={1}
                        max={6}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Multi-col threshold</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.multiColumnThresholdPx}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, multiColumnThresholdPx: Number(e.target.value) }))}
                        min={640}
                        max={2400}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Min chart width</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.minChartWidth}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, minChartWidth: Number(e.target.value) }))}
                        min={180}
                        max={1200}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Max chart width</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.maxChartWidth}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, maxChartWidth: Number(e.target.value) }))}
                        min={200}
                        max={1400}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Chart height</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.chartHeight}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, chartHeight: Number(e.target.value) }))}
                        min={120}
                        max={520}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">Axis</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">X font</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.xAxisFontSize}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, xAxisFontSize: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Y font</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.yAxisFontSize}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisFontSize: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">X ticks</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.xAxisTickCount}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, xAxisTickCount: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Y ticks</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.yAxisTickCount}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisTickCount: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Y axis width</Label>
                      <Input
                        type="number"
                        className="h-8 text-xs"
                        value={draftSettings.yAxisWidth}
                        onChange={(e) => setDraftSettings((prev) => ({ ...prev, yAxisWidth: Number(e.target.value) }))}
                      />
                    </div>
                  </div>
                </div>

                <Button size="sm" className="h-8 w-full text-xs" onClick={handleSaveSettings}>
                  Save settings
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {chartSettings.showVisibilitySection && (
        <div className="shrink-0 border-b border-border bg-background px-4 py-3">
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

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <Collapsible open={overviewOpen} onOpenChange={setOverviewOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs font-medium text-foreground">Overview (Favorites)</span>
                      <Badge variant="outline" className="h-4 text-[10px]">
                        {overviewMetrics.length + overviewCustomCharts.length}
                      </Badge>
                    </div>
                    {overviewOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3">
                    {wrapForLayout([
                      ...overviewMetrics.map((metric) => (
                        <StandardMetricCard
                          key={`overview-${metric.id}`}
                          metric={metric}
                          visibleRuns={visibleRuns}
                          dataset={metricDatasets.get(metric.id) || { rows: [], runIdsWithData: new Set() }}
                          chartSettings={chartSettings}
                          chartHeight={chartSettings.chartHeight}
                          onToggleMetricPin={handleToggleMetricPin}
                          onToggleMetricOverview={handleToggleMetricOverview}
                        />
                      )),
                      ...overviewCustomCharts.map((chart) => (
                        <CustomChartCard
                          key={`overview-custom-${chart.id}`}
                          chart={chart}
                          chartHeight={chartSettings.chartHeight}
                          chartSettings={chartSettings}
                          onTogglePin={onTogglePin}
                          onToggleOverview={onToggleOverview}
                        />
                      )),
                    ])}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={pinnedOpen} onOpenChange={setPinnedOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Pin className="h-4 w-4 text-accent" />
                      <span className="text-xs font-medium text-foreground">Pinned</span>
                      <Badge variant="outline" className="h-4 text-[10px]">{pinnedMetrics.length}</Badge>
                    </div>
                    {pinnedOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3">
                    {wrapForLayout(
                      pinnedMetrics.map((metric) => (
                        <StandardMetricCard
                          key={`pinned-${metric.id}`}
                          metric={metric}
                          visibleRuns={visibleRuns}
                          dataset={metricDatasets.get(metric.id) || { rows: [], runIdsWithData: new Set() }}
                          chartSettings={chartSettings}
                          chartHeight={chartSettings.chartHeight}
                          onToggleMetricPin={handleToggleMetricPin}
                          onToggleMetricOverview={handleToggleMetricOverview}
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={primaryOpen} onOpenChange={setPrimaryOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">Primary Metrics</span>
                      <Badge variant="outline" className="h-4 text-[10px]">{primaryMetrics.length}</Badge>
                    </div>
                    {primaryOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3">
                    {wrapForLayout(
                      primaryMetrics.map((metric) => (
                        <StandardMetricCard
                          key={`primary-${metric.id}`}
                          metric={metric}
                          visibleRuns={visibleRuns}
                          dataset={metricDatasets.get(metric.id) || { rows: [], runIdsWithData: new Set() }}
                          chartSettings={chartSettings}
                          chartHeight={chartSettings.chartHeight}
                          onToggleMetricPin={handleToggleMetricPin}
                          onToggleMetricOverview={handleToggleMetricOverview}
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={secondaryOpen} onOpenChange={setSecondaryOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-foreground">Secondary Metrics</span>
                      <Badge variant="outline" className="h-4 text-[10px]">{secondaryMetrics.length}</Badge>
                    </div>
                    {secondaryOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3">
                    {wrapForLayout(
                      secondaryMetrics.map((metric) => (
                        <StandardMetricCard
                          key={`secondary-${metric.id}`}
                          metric={metric}
                          visibleRuns={visibleRuns}
                          dataset={metricDatasets.get(metric.id) || { rows: [], runIdsWithData: new Set() }}
                          chartSettings={chartSettings}
                          chartHeight={chartSettings.chartHeight}
                          onToggleMetricPin={handleToggleMetricPin}
                          onToggleMetricOverview={handleToggleMetricOverview}
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={customOpen} onOpenChange={setCustomOpen}>
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex w-full items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-accent" />
                      <span className="text-xs font-medium text-foreground">Custom Visualizations</span>
                      <Badge variant="outline" className="h-4 text-[10px]">{customCharts.length}</Badge>
                    </div>
                    {customOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3">
                    {wrapForLayout(
                      customCharts.map((chart) => (
                        <CustomChartCard
                          key={chart.id}
                          chart={chart}
                          chartHeight={chartSettings.chartHeight}
                          chartSettings={chartSettings}
                          onTogglePin={onTogglePin}
                          onToggleOverview={onToggleOverview}
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
