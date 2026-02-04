'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { RunVisibilitySelector } from './run-visibility-selector'
import type { ExperimentRun, VisibilityGroup } from '@/lib/types'

interface AllRunsChartProps {
  runs: ExperimentRun[]
  visibleRunIds?: Set<string>
  onToggleVisibility?: (runId: string) => void
  visibilityGroups?: VisibilityGroup[]
  activeGroupId?: string | null
  onSelectGroup?: (groupId: string | null) => void
  onOpenManage?: () => void
  hideVisibilityControls?: boolean
}

export function AllRunsChart({ 
  runs, 
  visibleRunIds, 
  onToggleVisibility,
  visibilityGroups,
  activeGroupId,
  onSelectGroup,
  onOpenManage,
  hideVisibilityControls = false,
}: AllRunsChartProps) {
  const runsWithHistory = runs.filter(
    (run) => run.lossHistory && run.lossHistory.length > 0
  )

  if (runsWithHistory.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">
          Loss Curves
        </h3>
        <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
          No loss data available
        </div>
      </div>
    )
  }

  const visibleRuns = visibleRunIds 
    ? runsWithHistory.filter((run) => visibleRunIds.has(run.id))
    : runsWithHistory

  // Create unified data points
  const stepValues = Array.from(
    new Set(
      visibleRuns.flatMap((run) => run.lossHistory?.map((d) => d.step) || [])
    )
  ).sort((a, b) => a - b)

  const chartData = stepValues.map((step) => {
    const point: Record<string, number> = { step }
    visibleRuns.forEach((run) => {
      const historyPoint = run.lossHistory?.find((d) => d.step === step)
      if (historyPoint) {
        point[run.id] = historyPoint.trainLoss
      }
    })
    return point
  })

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">
        Loss Curves
      </h3>
      
      <div className="h-56 mb-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.1)"
            />
            <XAxis
              dataKey="step"
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              axisLine={{ stroke: '#374151' }}
              label={{
                value: 'Steps',
                position: 'insideBottom',
                offset: -5,
                fill: '#9ca3af',
                fontSize: 10,
              }}
            />
            <YAxis
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              axisLine={{ stroke: '#374151' }}
              label={{
                value: 'Loss',
                angle: -90,
                position: 'insideLeft',
                fill: '#9ca3af',
                fontSize: 10,
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '8px',
                fontSize: '11px',
              }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value: number, name: string) => {
                const run = visibleRuns.find((r) => r.id === name)
                return [value.toFixed(4), run?.name || name]
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }}
              formatter={(value: string) => {
                const run = visibleRuns.find((r) => r.id === value)
                return run?.name.slice(0, 15) || value
              }}
            />
            {visibleRuns.map((run) => (
              <Line
                key={run.id}
                type="monotone"
                dataKey={run.id}
                stroke={run.color || '#4ade80'}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Visibility toggles */}
      {!hideVisibilityControls && onToggleVisibility && visibleRunIds && (
        <RunVisibilitySelector
          runs={runsWithHistory}
          visibleRunIds={visibleRunIds}
          onToggleVisibility={onToggleVisibility}
          visibilityGroups={visibilityGroups}
          activeGroupId={activeGroupId}
          onSelectGroup={onSelectGroup}
          onOpenManage={onOpenManage}
        />
      )}
    </div>
  )
}
