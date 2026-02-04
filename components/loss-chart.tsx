'use client'

import {
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { LossDataPoint } from '@/lib/types'

interface LossChartProps {
  data: LossDataPoint[]
  title?: string
}

export function LossChart({ data, title = 'Training Loss' }: LossChartProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium text-foreground">{title}</h3>
      <ChartContainer
        config={{
          trainLoss: {
            label: 'Train Loss',
            color: '#4ade80',
          },
          valLoss: {
            label: 'Val Loss',
            color: '#60a5fa',
          },
        }}
        className="h-[180px] w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="step"
              tick={{ fill: '#888', fontSize: 10 }}
              tickLine={{ stroke: '#444' }}
              axisLine={{ stroke: '#444' }}
              tickFormatter={(value) => `${value / 1000}k`}
            />
            <YAxis
              tick={{ fill: '#888', fontSize: 10 }}
              tickLine={{ stroke: '#444' }}
              axisLine={{ stroke: '#444' }}
              domain={[0, 'auto']}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              iconSize={8}
            />
            <Line
              type="monotone"
              dataKey="trainLoss"
              stroke="#4ade80"
              strokeWidth={2}
              dot={false}
              name="Train Loss"
            />
            <Line
              type="monotone"
              dataKey="valLoss"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              name="Val Loss"
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  )
}
