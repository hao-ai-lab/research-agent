'use client'

import React, { useMemo, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { defaultMetricVisualizations } from '@/lib/mock-data'
import type {
  ExperimentRun,
  InsightChart,
  MetricVisualization,
} from '@/lib/types'

type MetricRow = { step: number; [runId: string]: number }

interface ChartsViewProps {
  runs: ExperimentRun[]
  customCharts: InsightChart[]
  onTogglePin?: (id: string) => void
  onToggleOverview?: (id: string) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onShowVisibilityManageChange?: (show: boolean) => void
}

function toNumber(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return value
}

function pickValueByPath(source: Record<string, unknown>, path: string, layer?: number): number | null {
  const direct = toNumber(source[path])
  if (direct !== null) return direct

  const walk = (delimiter: '/' | '.') => {
    const segments = path.split(delimiter).filter(Boolean)
    let current: unknown = source
    for (const segment of segments) {
      if (!current || typeof current !== 'object') return null
      current = (current as Record<string, unknown>)[segment]
    }

    if (Array.isArray(current) && typeof layer === 'number') {
      return toNumber(current[layer])
    }

    return toNumber(current)
  }

  return walk('/') ?? walk('.')
}

function getMetricValue(
  metricPath: string,
  point: Record<string, unknown>,
  previousPoint: Record<string, unknown> | null,
  previousEma: number | null,
  layer?: number,
): { value: number | null; nextEma: number | null } {
  const trainLoss = toNumber(point.trainLoss)
  const valLoss = toNumber(point.valLoss)

  switch (metricPath) {
    case 'train/loss':
      return { value: trainLoss, nextEma: previousEma }
    case 'val/loss':
      return { value: valLoss, nextEma: previousEma }
    case 'train/reward': {
      const explicitReward = pickValueByPath(point, metricPath, layer)
      if (explicitReward !== null) return { value: explicitReward, nextEma: previousEma }
      return {
        value: trainLoss !== null ? Math.max(0, 1 - trainLoss) : null,
        nextEma: previousEma,
      }
    }
    case 'train/loss_ema': {
      if (trainLoss === null) return { value: null, nextEma: previousEma }
      const nextEma = previousEma == null ? trainLoss : (0.2 * trainLoss + 0.8 * previousEma)
      return { value: Number(nextEma.toFixed(6)), nextEma }
    }
    case 'train/loss_slope': {
      if (!previousPoint) return { value: null, nextEma: previousEma }
      const prevTrainLoss = toNumber(previousPoint.trainLoss)
      if (trainLoss === null || prevTrainLoss === null) return { value: null, nextEma: previousEma }
      return { value: Number((trainLoss - prevTrainLoss).toFixed(6)), nextEma: previousEma }
    }
    case 'val/generalization_gap': {
      if (trainLoss === null || valLoss === null) return { value: null, nextEma: previousEma }
      return { value: Number((valLoss - trainLoss).toFixed(6)), nextEma: previousEma }
    }
    default:
      return { value: pickValueByPath(point, metricPath, layer), nextEma: previousEma }
  }
}

function buildDataset(
  runs: ExperimentRun[],
  metricPath: string,
  layer?: number,
): MetricRow[] {
  const rowsByStep = new Map<number, MetricRow>()

  runs.forEach((run) => {
    const history = run.lossHistory as Array<Record<string, unknown>> | undefined
    if (!history || history.length === 0) return

    let previousPoint: Record<string, unknown> | null = null
    let previousEma: number | null = null

    history.forEach((point) => {
      const step = toNumber(point.step)
      if (step === null) return

      const { value, nextEma } = getMetricValue(metricPath, point, previousPoint, previousEma, layer)
      previousEma = nextEma
      previousPoint = point

      if (value === null) return

      const existing = rowsByStep.get(step) || { step }
      existing[run.id] = Number(value.toFixed(6))
      rowsByStep.set(step, existing)
    })
  })

  return Array.from(rowsByStep.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row)
}

function MetricChartAllRuns({
  metric,
  runs,
  isExpanded,
  onToggle,
  selectedLayer,
}: {
  metric: MetricVisualization
  runs: ExperimentRun[]
  isExpanded: boolean
  onToggle: () => void
  selectedLayer?: number
}) {
  const data = useMemo(() => {
    if (!isExpanded) return [] as MetricRow[]
    return buildDataset(runs, metric.path, selectedLayer)
  }, [runs, metric.path, isExpanded, selectedLayer])

  const hasData = data.length > 0 && runs.some((run) => data.some((row) => typeof row[run.id] === 'number'))

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-secondary/50"
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
        <div className="mb-2 mt-1 h-36 px-1">
          {hasData ? (
            <ResponsiveContainer width="100%" height="100%">
              {metric.type === 'area' ? (
                <AreaChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="step" tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} width={40} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '6px',
                      fontSize: '10px',
                    }}
                  />
                  {runs.map((run) => (
                    <Area
                      key={`${metric.id}:${run.id}`}
                      type="monotone"
                      dataKey={run.id}
                      name={run.alias || run.name}
                      stroke={run.color || '#4ade80'}
                      fill={`${run.color || '#4ade80'}33`}
                      strokeWidth={1.4}
                      connectNulls
                    />
                  ))}
                </AreaChart>
              ) : (
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="step" tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} axisLine={{ stroke: '#374151' }} width={40} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '6px',
                      fontSize: '10px',
                    }}
                  />
                  {runs.map((run) => (
                    <Line
                      key={`${metric.id}:${run.id}`}
                      type="monotone"
                      dataKey={run.id}
                      name={run.alias || run.name}
                      stroke={run.color || '#4ade80'}
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
              No source data for this metric in available runs.
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ChartsView({ runs }: ChartsViewProps) {
  const runsWithHistory = useMemo(
    () => runs.filter((run) => !run.isArchived && Array.isArray(run.lossHistory) && run.lossHistory.length > 0),
    [runs],
  )

  const primaryMetrics = useMemo(
    () => defaultMetricVisualizations.filter((metric) => metric.category === 'primary'),
    [],
  )
  const secondaryMetrics = useMemo(
    () => defaultMetricVisualizations.filter((metric) => metric.category === 'secondary'),
    [],
  )

  const [primaryChartsOpen, setPrimaryChartsOpen] = useState(true)
  const [secondaryChartsOpen, setSecondaryChartsOpen] = useState(true)
  const [expandedCharts, setExpandedCharts] = useState<Set<string>>(new Set())
  const [layerSelections, setLayerSelections] = useState<Record<string, number>>({})

  const toggleChart = (chartId: string) => {
    setExpandedCharts((prev) => {
      const next = new Set(prev)
      if (next.has(chartId)) {
        next.delete(chartId)
      } else {
        next.add(chartId)
      }
      return next
    })
  }

  const toggleAllInCategory = (metricIds: string[], expand: boolean) => {
    setExpandedCharts((prev) => {
      const next = new Set(prev)
      metricIds.forEach((metricId) => {
        if (expand) {
          next.add(metricId)
        } else {
          next.delete(metricId)
        }
      })
      return next
    })
  }

  const allPrimaryExpanded = primaryMetrics.every((metric) => expandedCharts.has(metric.id))
  const allSecondaryExpanded = secondaryMetrics.every((metric) => expandedCharts.has(metric.id))

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Charts</h3>
        <p className="truncate text-xs text-muted-foreground">
          Same metric view as Run Detail, aggregated across all runs.
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-3 p-3">
          {runsWithHistory.length > 0 ? (
            <>
              <Collapsible open={primaryChartsOpen} onOpenChange={setPrimaryChartsOpen}>
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <span className="text-xs font-medium text-foreground">Primary Metrics</span>
                      <div className="flex items-center gap-2">
                        {primaryChartsOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleAllInCategory(primaryMetrics.map((metric) => metric.id), !allPrimaryExpanded)
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
                        <MetricChartAllRuns
                          key={metric.id}
                          metric={metric}
                          runs={runsWithHistory}
                          isExpanded={expandedCharts.has(metric.id)}
                          onToggle={() => toggleChart(metric.id)}
                        />
                      ))}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>

              <Collapsible open={secondaryChartsOpen} onOpenChange={setSecondaryChartsOpen}>
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center justify-between p-3">
                      <span className="text-xs font-medium text-foreground">Secondary Metrics</span>
                      <div className="flex items-center gap-2">
                        {secondaryChartsOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleAllInCategory(secondaryMetrics.map((metric) => metric.id), !allSecondaryExpanded)
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
                                className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-foreground"
                                value={layerSelections[metric.id] || 0}
                                onChange={(event) => {
                                  setLayerSelections((prev) => ({
                                    ...prev,
                                    [metric.id]: Number(event.target.value),
                                  }))
                                }}
                              >
                                {Array.from({ length: 12 }, (_, index) => (
                                  <option key={index} value={index}>Layer {index}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <MetricChartAllRuns
                            metric={metric}
                            runs={runsWithHistory}
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
            </>
          ) : (
            <div className="overflow-hidden rounded-lg border border-dashed border-border bg-card">
              <div className="flex w-full items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Charts</span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="border-t border-border px-3 py-6 text-center">
                <p className="text-xs text-muted-foreground">No run metric history available yet.</p>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
