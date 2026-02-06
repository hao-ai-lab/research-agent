'use client'

import { useState } from 'react'
import {
  Bell,
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  TrendingUp,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { RunEvent } from '@/lib/types'

interface AlertBarProps {
  events: RunEvent[]
  onNavigateToEvents: () => void
  onNavigateToRun: (runId: string) => void
  onDismissEvent: (eventId: string) => void
}

export function AlertBar({ 
  events, 
  onNavigateToEvents, 
  onNavigateToRun,
  onDismissEvent,
}: AlertBarProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const activeEvents = events.filter(e => e.status !== 'dismissed' && e.status !== 'resolved')
  const errorCount = activeEvents.filter(e => e.type === 'error').length
  const warningCount = activeEvents.filter(e => e.type === 'warning').length
  const totalCount = activeEvents.length

  const getEventIcon = (type: 'error' | 'warning' | 'info') => {
    switch (type) {
      case 'error':
        return <AlertCircle className="h-3.5 w-3.5 text-destructive" />
      case 'warning':
        return <AlertTriangle className="h-3.5 w-3.5 text-warning" />
      case 'info':
        return <Info className="h-3.5 w-3.5 text-blue-400" />
    }
  }

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'critical':
        return <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive text-[9px] px-1 py-0">Critical</Badge>
      case 'high':
        return <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning text-[9px] px-1 py-0">High</Badge>
      default:
        return null
    }
  }

  if (totalCount === 0) {
    return (
      <div className="border-b border-border bg-card/30 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5 text-accent" />
          <span>All systems running smoothly</span>
        </div>
      </div>
    )
  }

  const topEvents = activeEvents.slice(0, 3)

  return (
    <div className="border-b border-border bg-card/30">
      {/* Collapsed Header */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          {/* Bell with count */}
          <button
            type="button"
            onClick={onNavigateToEvents}
            className="flex min-w-0 items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <div className="relative">
              <Bell className="h-4 w-4 text-muted-foreground" />
              {totalCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-destructive text-[9px] font-medium text-destructive-foreground">
                  {totalCount > 9 ? '9+' : totalCount}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
              {errorCount > 0 && (
                <Badge variant="outline" className="shrink-0 border-destructive/50 bg-destructive/10 text-destructive px-1.5 py-0 text-[10px] h-5">
                  <span className="max-w-[84px] truncate">
                    {errorCount} error{errorCount > 1 ? 's' : ''}
                  </span>
                </Badge>
              )}
              {warningCount > 0 && (
                <Badge variant="outline" className="shrink-0 border-warning/50 bg-warning/10 text-warning px-1.5 py-0 text-[10px] h-5">
                  <span className="max-w-[84px] truncate">
                    {warningCount} warning{warningCount > 1 ? 's' : ''}
                  </span>
                </Badge>
              )}
            </div>
          </button>

          {/* Top event summary */}
          {!isExpanded && topEvents[0] && (
            <button
              type="button"
              onClick={() => onNavigateToRun(topEvents[0].runId)}
              className="flex-1 flex items-center gap-2 min-w-0 px-2 py-1 rounded hover:bg-secondary/50 transition-colors"
            >
              {getEventIcon(topEvents[0].type)}
              <span className="text-xs text-foreground truncate flex-1 text-left">
                {topEvents[0].summary}
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {topEvents[0].runAlias || topEvents[0].runName.slice(0, 12)}
              </span>
            </button>
          )}

          {/* Expand/View All */}
          <div className="flex items-center gap-1 shrink-0">
            {totalCount > 1 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsExpanded(!isExpanded)}
                className="h-7 w-7"
              >
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onNavigateToEvents}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              View All
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {/* Expanded Event List */}
      {isExpanded && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5 max-h-40 overflow-y-auto">
          {topEvents.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 bg-secondary/30 hover:bg-secondary/50 transition-colors"
            >
              <div className="mt-0.5">{getEventIcon(event.type)}</div>
              <button
                type="button"
                onClick={() => onNavigateToRun(event.runId)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-foreground truncate">
                    {event.title}
                  </span>
                  {getPriorityBadge(event.priority)}
                </div>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {event.summary}
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {event.runAlias || event.runName}
                </p>
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDismissEvent(event.id)}
                className="h-6 w-6 shrink-0"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
          {activeEvents.length > 3 && (
            <button
              type="button"
              onClick={onNavigateToEvents}
              className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1"
            >
              +{activeEvents.length - 3} more events
            </button>
          )}
        </div>
      )}
    </div>
  )
}
