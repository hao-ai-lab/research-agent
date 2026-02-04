'use client'

import React from 'react'
import { useState } from 'react'
import {
  TrendingUp,
  Star,
  Pin,
  Layers,
  BarChart3,
  ArrowLeft,
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
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
} from 'recharts'
import { RunVisibilitySelector } from './run-visibility-selector'
import { VisibilityManageView } from './visibility-manage-view'
import type { InsightChart, MetricVisualization, ExperimentRun, VisibilityGroup } from '@/lib/types'
import { defaultMetricVisualizations } from '@/lib/mock-data'

interface ChartsViewProps {
  runs: ExperimentRun[]
  customCharts: InsightChart[]
  onTogglePin?: (id: string) => void
  onToggleOverview?: (id: string) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onShowVisibilityManageChange?: (show: boolean) => void
}

// Generate mock metric data
const generateMetricData = (metricId: string, runs: ExperimentRun[], visibleRunIds: Set<string>) => {
  const data: { step: number; [key: string]: number }[] = []
  const visibleRuns = runs.filter(r => visibleRunIds.has(r.id))
  
  for (let i = 0; i <= 100; i += 5) {
    const point: { step: number; [key: string]: number } = { step: i * 100 }
    visibleRuns.forEach((run) => {
      if (!run.isArchived && run.lossHistory) {
        const baseValue = metricId.includes('loss') 
          ? 2.5 * Math.exp(-i / 30) + 0.1 
          : metricId.includes('grad') 
          ? 1.5 * Math.exp(-i / 50) + 0.5 + Math.random() * 0.2
          : Math.random() * 0.5 + 0.3
        point[run.name] = Number(baseValue.toFixed(4))
      }
    })
    data.push(point)
  }
  return data
}

export function ChartsView({ runs, customCharts, onTogglePin, onToggleOverview, onUpdateRun, onShowVisibilityManageChange }: ChartsViewProps) {
  const [activeSection, setActiveSection] = useState<'standard' | 'custom'>('standard')
  const [metrics, setMetrics] = useState<MetricVisualization[]>(defaultMetricVisualizations)
  const [selectedLayer, setSelectedLayer] = useState<Record<string, number>>({})
  const [showVisibilityManage, setShowVisibilityManageInternal] = useState(false)
  
  const setShowVisibilityManage = (show: boolean) => {
    setShowVisibilityManageInternal(show)
    onShowVisibilityManageChange?.(show)
  }
  
  // Visibility state
  const activeRuns = runs.filter(r => !r.isArchived && r.lossHistory && r.lossHistory.length > 0)
  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(activeRuns.map((r) => r.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  const visibleRuns = runs.filter(r => !r.isArchived && visibleRunIds.has(r.id))
  const primaryMetrics = metrics.filter(m => m.category === 'primary')
  const secondaryMetrics = metrics.filter(m => m.category === 'secondary')
  const pinnedMetrics = metrics.filter(m => m.isPinned)

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
      const group = visibilityGroups.find(g => g.id === groupId)
      if (group) {
        setVisibleRunIds(new Set(group.runIds))
      }
    } else {
      // Show all runs
      setVisibleRunIds(new Set(activeRuns.map(r => r.id)))
    }
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups(prev => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups(prev => prev.filter(g => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(activeRuns.map(r => r.id)))
    }
  }

  const handleToggleMetricPin = (metricId: string) => {
    setMetrics(prev => prev.map(m => 
      m.id === metricId ? { ...m, isPinned: !m.isPinned } : m
    ))
  }

  const handleToggleMetricOverview = (metricId: string) => {
    setMetrics(prev => prev.map(m => 
      m.id === metricId ? { ...m, isInOverview: !m.isInOverview } : m
    ))
  }

  const renderMetricChart = (metric: MetricVisualization) => {
    const data = generateMetricData(metric.id, runs, visibleRunIds)
    
    const ChartComponent = metric.type === 'area' ? AreaChart : LineChart
    const DataComponent = metric.type === 'area' ? Area : Line

    return (
      <div key={metric.id} className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <h4 className="font-medium text-sm text-foreground truncate">{metric.name}</h4>
            <Badge variant="outline" className="text-[10px] shrink-0">
              {metric.path}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {metric.layerSelector && (
              <Select
                value={String(selectedLayer[metric.id] || 0)}
                onValueChange={(v) => setSelectedLayer(prev => ({ ...prev, [metric.id]: Number(v) }))}
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
              <Star className={`h-4 w-4 ${metric.isInOverview ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleToggleMetricPin(metric.id)}
            >
              <Pin className={`h-4 w-4 ${metric.isPinned ? 'fill-accent text-accent' : 'text-muted-foreground'}`} />
            </Button>
          </div>
        </div>
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <ChartComponent data={data}>
              <XAxis 
                dataKey="step" 
                tick={{ fontSize: 10, fill: '#888' }}
                axisLine={{ stroke: '#333' }}
                tickLine={false}
              />
              <YAxis 
                tick={{ fontSize: 10, fill: '#888' }}
                axisLine={{ stroke: '#333' }}
                tickLine={false}
                width={35}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: '#1a1a1a', 
                  border: '1px solid #333',
                  borderRadius: '8px',
                  fontSize: '11px'
                }}
              />
              {visibleRuns.map((run) => (
                <DataComponent
                  key={run.id}
                  type="monotone"
                  dataKey={run.name}
                  stroke={run.color || '#4ade80'}
                  fill={metric.type === 'area' ? `${run.color || '#4ade80'}33` : undefined}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </ChartComponent>
          </ResponsiveContainer>
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
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={data}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} width={30} />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', fontSize: '12px' }} />
              <Line type="monotone" dataKey="value" stroke="#4ade80" strokeWidth={2} dot={{ fill: '#4ade80', r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )
        break
      case 'bar':
        chartElement = (
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={data}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} width={30} />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', fontSize: '12px' }} />
              <Bar dataKey="value" fill="#4ade80" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )
        break
      case 'area':
        chartElement = (
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={data}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} width={30} />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', fontSize: '12px' }} />
              <Area type="monotone" dataKey="value" stroke="#4ade80" fill="#4ade8033" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )
        break
      case 'scatter':
        chartElement = (
          <ResponsiveContainer width="100%" height={120}>
            <ScatterChart>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} type="category" allowDuplicatedCategory={false} />
              <YAxis dataKey="value" tick={{ fontSize: 10, fill: '#888' }} axisLine={{ stroke: '#333' }} tickLine={false} width={30} />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', fontSize: '12px' }} />
              <Scatter data={data} fill="#4ade80" />
            </ScatterChart>
          </ResponsiveContainer>
        )
        break
    }

    return (
      <div key={chart.id} className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-sm text-foreground truncate">{chart.title}</h4>
            {chart.description && (
              <p className="text-xs text-muted-foreground truncate">{chart.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
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
        <div className="rounded-lg bg-secondary/50 p-2">
          {chartElement}
        </div>
      </div>
    )
  }

  // Show visibility manage view
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Section Tabs */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg bg-secondary p-1">
          <button
            type="button"
            onClick={() => setActiveSection('standard')}
            className={`flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeSection === 'standard'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Layers className="h-4 w-4" />
            Standard
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('custom')}
            className={`flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeSection === 'custom'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BarChart3 className="h-4 w-4" />
            Custom
          </button>
        </div>
      </div>

      {/* Run Visibility Selector - Sticky */}
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

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-6">
            {activeSection === 'standard' ? (
              <>
                {/* Pinned Metrics */}
                {pinnedMetrics.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Pin className="h-4 w-4 text-accent" />
                      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Pinned
                      </h3>
                    </div>
                    <div className="space-y-4">
                      {pinnedMetrics.map(renderMetricChart)}
                    </div>
                  </div>
                )}

                {/* Primary Metrics */}
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Primary Metrics
                  </h3>
                  <div className="space-y-4">
                    {primaryMetrics.filter(m => !m.isPinned).map(renderMetricChart)}
                  </div>
                </div>

                {/* Secondary Metrics */}
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                    Secondary Metrics
                  </h3>
                  <div className="space-y-4">
                    {secondaryMetrics.filter(m => !m.isPinned).map(renderMetricChart)}
                  </div>
                </div>
              </>
            ) : (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 border border-accent/30">
                    <TrendingUp className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-foreground">Custom Visualizations</h3>
                    <p className="text-xs text-muted-foreground">
                      {customCharts.length} saved charts
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  {customCharts.map(renderCustomChart)}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
