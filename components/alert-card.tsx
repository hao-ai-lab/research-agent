'use client'

import { AlertCircle, AlertTriangle, Info, X, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { RunEvent, EventStatus } from '@/lib/types'

interface AlertCardProps {
  event: RunEvent
  onNavigateToRun?: (runId: string) => void
  onUpdateStatus?: (eventId: string, status: EventStatus) => void
  onDismiss?: (eventId: string) => void
}

export function AlertCard({
  event,
  onNavigateToRun,
  onUpdateStatus,
  onDismiss,
}: AlertCardProps) {
  const getEventIcon = (type: 'error' | 'warning' | 'info') => {
    switch (type) {
      case 'error':
        return <AlertCircle className="h-5 w-5 text-destructive" />
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-warning" />
      case 'info':
        return <Info className="h-5 w-5 text-blue-400" />
    }
  }

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'critical':
        return <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive text-[10px]">Critical</Badge>
      case 'high':
        return <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning text-[10px]">High</Badge>
      case 'medium':
        return <Badge variant="outline" className="border-accent/50 bg-accent/10 text-accent text-[10px]">Medium</Badge>
      default:
        return <Badge variant="outline" className="text-[10px]">Low</Badge>
    }
  }

  const getStatusBadge = (status: EventStatus) => {
    switch (status) {
      case 'new':
        return <Badge className="bg-destructive text-destructive-foreground text-[10px]">New</Badge>
      case 'acknowledged':
        return <Badge variant="outline" className="text-[10px]">Acknowledged</Badge>
      case 'resolved':
        return <Badge variant="outline" className="border-accent/50 text-accent text-[10px]">Resolved</Badge>
      case 'dismissed':
        return <Badge variant="secondary" className="text-[10px]">Dismissed</Badge>
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 my-2">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{getEventIcon(event.type)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{event.title}</span>
            {getPriorityBadge(event.priority)}
            {getStatusBadge(event.status)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {event.runAlias || event.runName}
          </p>
        </div>
        {onDismiss && event.status !== 'dismissed' && event.status !== 'resolved' && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDismiss(event.id)}
            className="h-7 w-7 shrink-0 -mr-1 -mt-1"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Summary */}
      <p className="text-sm text-foreground mt-3">{event.summary}</p>

      {/* Suggested Actions */}
      {event.suggestedActions && event.suggestedActions.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Suggested Actions:</p>
          {event.suggestedActions.map((action, idx) => (
            <div key={idx} className="flex items-center gap-2 text-xs text-foreground pl-2">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              {action}
            </div>
          ))}
        </div>
      )}

      {/* Related Metrics */}
      {event.relatedMetrics && event.relatedMetrics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {event.relatedMetrics.map((metric, idx) => (
            <Badge key={idx} variant="secondary" className="text-[10px]">
              {metric.name}: {metric.value}
            </Badge>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-4">
        {onNavigateToRun && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigateToRun(event.runId)}
            className="h-8 text-xs"
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            View Run
          </Button>
        )}
        {onUpdateStatus && event.status === 'new' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUpdateStatus(event.id, 'acknowledged')}
            className="h-8 text-xs"
          >
            Acknowledge
          </Button>
        )}
        {onUpdateStatus && (event.status === 'new' || event.status === 'acknowledged') && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUpdateStatus(event.id, 'resolved')}
            className="h-8 text-xs"
          >
            Mark Resolved
          </Button>
        )}
      </div>
    </div>
  )
}
