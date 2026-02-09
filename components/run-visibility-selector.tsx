'use client'

import { Eye, EyeOff, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExperimentRun, VisibilityGroup } from '@/lib/types'

interface RunVisibilitySelectorProps {
  runs: ExperimentRun[]
  visibleRunIds: Set<string>
  onToggleVisibility: (runId: string) => void
  visibilityGroups?: VisibilityGroup[]
  activeGroupId?: string | null
  onSelectGroup?: (groupId: string | null) => void
  onOpenManage?: () => void
  compact?: boolean
}

export function RunVisibilitySelector({
  runs,
  visibleRunIds,
  onToggleVisibility,
  visibilityGroups = [],
  activeGroupId,
  onSelectGroup,
  onOpenManage,
  compact = false,
}: RunVisibilitySelectorProps) {
  const hasChartData = (run: ExperimentRun) => {
    const hasLossHistory = !!(run.lossHistory && run.lossHistory.length > 0)
    const hasMetricSeries = !!(
      run.metricSeries &&
      Object.values(run.metricSeries).some((points) => points && points.length > 0)
    )
    return hasLossHistory || hasMetricSeries
  }

  const runsWithHistory = runs.filter(
    (run) => hasChartData(run) && !run.isArchived
  )

  const handleGroupClick = (groupId: string) => {
    if (onSelectGroup) {
      // If clicking the already active group, show all runs
      if (activeGroupId === groupId) {
        onSelectGroup(null)
      } else {
        onSelectGroup(groupId)
      }
    }
  }

  return (
    <div className={`border-t border-border ${compact ? 'pt-2' : 'pt-3'}`}>

      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">Toggle visibility:</p>
        {onOpenManage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenManage}
                aria-label="Manage"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Visibility Groups */}
      {visibilityGroups.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {visibilityGroups.map((group) => {
            const isActive = activeGroupId === group.id
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => handleGroupClick(group.id)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all border ${isActive
                    ? 'border-accent bg-accent/20 text-accent'
                    : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:border-muted-foreground/50'
                  }`}
              >
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
                <span>{group.name}</span>
                <span className="text-[10px] opacity-60">({group.runIds.length})</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Individual Run Toggles */}
      <div className="flex flex-wrap gap-1.5">
        {runsWithHistory.map((run) => {
          const isVisible = visibleRunIds.has(run.id)
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => onToggleVisibility(run.id)}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all ${isVisible
                  ? 'bg-secondary text-foreground'
                  : 'bg-secondary/30 text-muted-foreground'
                }`}
            >
              <div
                className={`h-2 w-2 rounded-full ${!isVisible && 'opacity-40'}`}
                style={{ backgroundColor: run.color || '#4ade80' }}
              />
              <span className="max-w-[80px] truncate">{(run.alias || run.name).slice(0, 12)}</span>
              {isVisible ? (
                <Eye className="h-3 w-3 ml-0.5" />
              ) : (
                <EyeOff className="h-3 w-3 ml-0.5" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
