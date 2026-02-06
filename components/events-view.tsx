'use client'

import React from "react"

import { useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  CheckCircle2,
  Clock,
  FileText,
  Lightbulb,
  ExternalLink,
  Filter,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import type { RunEvent, EventStatus } from '@/lib/types'
import { RunName } from './run-name'

interface EventsViewProps {
  events: RunEvent[]
  onNavigateToRun: (runId: string) => void
  onResolveByChat: (event: RunEvent) => void
  onUpdateEventStatus: (eventId: string, status: EventStatus) => void
  onRespondToAlert?: (event: RunEvent, choice: string) => void
}

export function EventsView({ 
  events, 
  onNavigateToRun, 
  onResolveByChat,
  onUpdateEventStatus,
  onRespondToAlert,
}: EventsViewProps) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())
  const [filterTypes, setFilterTypes] = useState<Set<'error' | 'warning' | 'info'>>(
    new Set(['error', 'warning', 'info'])
  )
  const [filterStatuses, setFilterStatuses] = useState<Set<EventStatus>>(
    new Set(['new', 'acknowledged'])
  )

  const toggleExpanded = (eventId: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) {
        next.delete(eventId)
      } else {
        next.add(eventId)
      }
      return next
    })
  }

  const toggleFilterType = (type: 'error' | 'warning' | 'info') => {
    setFilterTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }

  const toggleFilterStatus = (status: EventStatus) => {
    setFilterStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }

  const filteredEvents = events.filter(
    e => filterTypes.has(e.type) && filterStatuses.has(e.status)
  )

  const errorEvents = filteredEvents.filter(e => e.type === 'error')
  const warningEvents = filteredEvents.filter(e => e.type === 'warning')
  const infoEvents = filteredEvents.filter(e => e.type === 'info')

  const getEventIcon = (type: 'error' | 'warning' | 'info', size = 'h-4 w-4') => {
    switch (type) {
      case 'error':
        return <AlertCircle className={`${size} text-destructive`} />
      case 'warning':
        return <AlertTriangle className={`${size} text-warning`} />
      case 'info':
        return <Info className={`${size} text-blue-400`} />
    }
  }

  const getPriorityStyle = (priority: string) => {
    switch (priority) {
      case 'critical':
        return 'border-destructive/50 bg-destructive/5'
      case 'high':
        return 'border-warning/50 bg-warning/5'
      case 'medium':
        return 'border-blue-400/30 bg-blue-400/5'
      default:
        return 'border-border bg-card/50'
    }
  }

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'critical':
        return <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive text-[10px]">Critical</Badge>
      case 'high':
        return <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning text-[10px]">High</Badge>
      case 'medium':
        return <Badge variant="outline" className="border-blue-400/50 bg-blue-400/10 text-blue-400 text-[10px]">Medium</Badge>
      default:
        return <Badge variant="outline" className="border-muted-foreground/50 text-muted-foreground text-[10px]">Low</Badge>
    }
  }

  const getStatusBadge = (status: EventStatus) => {
    switch (status) {
      case 'new':
        return <Badge variant="outline" className="border-accent/50 bg-accent/10 text-accent text-[10px]">New</Badge>
      case 'acknowledged':
        return <Badge variant="outline" className="border-blue-400/50 bg-blue-400/10 text-blue-400 text-[10px]">Acknowledged</Badge>
      case 'resolved':
        return <Badge variant="outline" className="border-green-500/50 bg-green-500/10 text-green-400 text-[10px]">Resolved</Badge>
      case 'dismissed':
        return <Badge variant="outline" className="border-muted-foreground/50 text-muted-foreground text-[10px]">Dismissed</Badge>
    }
  }

  const formatTimestamp = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  const renderEventCard = (event: RunEvent) => {
    const isExpanded = expandedEvents.has(event.id)
    
    return (
      <Collapsible key={event.id} open={isExpanded} onOpenChange={() => toggleExpanded(event.id)}>
        <div className={`rounded-lg border ${getPriorityStyle(event.priority)} overflow-hidden`}>
          {/* Event Header */}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-start gap-3 p-3 text-left hover:bg-secondary/30 transition-colors"
            >
              <div className="mt-0.5">{getEventIcon(event.type)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-foreground">{event.title}</span>
                  {getPriorityBadge(event.priority)}
                  {getStatusBadge(event.status)}
                </div>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {event.summary}
                </p>
                <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatTimestamp(event.timestamp)}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      onNavigateToRun(event.runId)
                    }}
                    className="flex items-center gap-1 hover:text-foreground cursor-pointer"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {event.runAlias || event.runName}
                  </span>
                </div>
              </div>
              <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </button>
          </CollapsibleTrigger>

          {/* Expanded Content */}
          <CollapsibleContent>
            <div className="border-t border-border/50 p-3 space-y-4 bg-background/50">
              {/* Description */}
              <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                  <FileText className="h-3 w-3" />
                  Description
                </h4>
                <p className="text-sm text-foreground leading-relaxed">
                  {event.description}
                </p>
              </div>

              {/* Related Metrics */}
              {event.relatedMetrics && event.relatedMetrics.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                    Related Metrics
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {event.relatedMetrics.map((metric, i) => (
                      <div key={i} className="flex items-center gap-1.5 rounded-md bg-secondary/50 px-2 py-1">
                        <span className="text-[10px] text-muted-foreground">{metric.name}:</span>
                        <span className="text-xs font-medium text-foreground">{metric.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggested Actions */}
              {event.suggestedActions && event.suggestedActions.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                    <Lightbulb className="h-3 w-3" />
                    Suggested Actions
                  </h4>
                  <ul className="space-y-1">
                    {event.suggestedActions.map((action, i) => (
                      <li key={i} className="text-xs text-foreground flex items-start gap-2">
                        <span className="text-accent mt-0.5">{'•'}</span>
                        {action}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Logs */}
              {event.logs && event.logs.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                    Logs
                  </h4>
                  <div className="rounded-md bg-card border border-border p-2 font-mono text-[10px] text-muted-foreground overflow-x-auto">
                    {event.logs.map((log, i) => (
                      <div key={i} className={log.includes('ERROR') ? 'text-destructive' : ''}>
                        {log}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="pt-2 border-t border-border/50 space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onResolveByChat(event)}
                    className="h-8 w-full sm:w-auto text-xs gap-1.5 justify-start sm:justify-center"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span className="truncate">Resolve by Chat</span>
                  </Button>
                  {event.alertId && event.choices && event.choices.length > 0 && onRespondToAlert && (
                    <>
                      {event.choices.map((choice) => {
                        const normalized = choice.toLowerCase()
                        const isStopAction = normalized.includes('stop') || normalized.includes('kill') || normalized.includes('terminate')
                        return (
                          <Button
                            key={`${event.id}-${choice}`}
                            variant={isStopAction ? 'destructive' : 'outline'}
                            size="sm"
                            onClick={() => onRespondToAlert(event, choice)}
                            className="h-8 w-full sm:w-auto text-xs justify-start sm:justify-center"
                          >
                            <span className="max-w-full truncate">{choice}</span>
                          </Button>
                        )
                      })}
                    </>
                  )}
                  {event.status === 'new' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onUpdateEventStatus(event.id, 'acknowledged')}
                      className="h-8 w-full sm:w-auto text-xs justify-start sm:justify-center"
                    >
                      <span className="truncate">Acknowledge</span>
                    </Button>
                  )}
                  {event.status !== 'resolved' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onUpdateEventStatus(event.id, 'resolved')}
                      className="h-8 w-full sm:w-auto text-xs gap-1.5 justify-start sm:justify-center"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="truncate">Mark Resolved</span>
                    </Button>
                  )}
                </div>
                <div className="flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onNavigateToRun(event.runId)}
                    className="h-8 w-full sm:w-auto sm:ml-auto text-xs gap-1.5 justify-center"
                  >
                    <span className="truncate">View Run</span>
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    )
  }

  const renderSection = (title: string, icon: React.ReactNode, sectionEvents: RunEvent[]) => {
    if (sectionEvents.length === 0) return null
    
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          {icon}
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {sectionEvents.length}
          </Badge>
        </div>
        <div className="space-y-2">
          {sectionEvents.map(renderEventCard)}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Events</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''} requiring attention
            </p>
          </div>
          
          {/* Filters */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 bg-transparent">
                <Filter className="h-3.5 w-3.5" />
                Filter
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Type</div>
              <DropdownMenuCheckboxItem
                checked={filterTypes.has('error')}
                onCheckedChange={() => toggleFilterType('error')}
              >
                <AlertCircle className="h-3.5 w-3.5 text-destructive mr-2" />
                Errors
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterTypes.has('warning')}
                onCheckedChange={() => toggleFilterType('warning')}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-warning mr-2" />
                Warnings
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterTypes.has('info')}
                onCheckedChange={() => toggleFilterType('info')}
              >
                <Info className="h-3.5 w-3.5 text-blue-400 mr-2" />
                Info
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Status</div>
              <DropdownMenuCheckboxItem
                checked={filterStatuses.has('new')}
                onCheckedChange={() => toggleFilterStatus('new')}
              >
                New
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterStatuses.has('acknowledged')}
                onCheckedChange={() => toggleFilterStatus('acknowledged')}
              >
                Acknowledged
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filterStatuses.has('resolved')}
                onCheckedChange={() => toggleFilterStatus('resolved')}
              >
                Resolved
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3 overflow-x-auto">
          <div className="flex min-w-max items-center gap-1">
            {([
              { type: 'error' as const, label: 'Errors' },
              { type: 'warning' as const, label: 'Warnings' },
              { type: 'info' as const, label: 'Info' },
            ]).map((item) => {
              const isActive = filterTypes.has(item.type)
              return (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => toggleFilterType(item.type)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    isActive
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border bg-secondary/40 text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {getEventIcon(item.type, 'h-3.5 w-3.5')}
                  <span className="max-w-[88px] truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Events List */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-6">
            {filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <CheckCircle2 className="h-12 w-12 text-accent mb-3" />
                <h3 className="font-medium text-foreground">All Clear</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  No events match your current filters
                </p>
              </div>
            ) : (
              <>
                {renderSection('Errors', <AlertCircle className="h-4 w-4 text-destructive" />, errorEvents)}
                {renderSection('Warnings', <AlertTriangle className="h-4 w-4 text-warning" />, warningEvents)}
                {renderSection('Information', <Info className="h-4 w-4 text-blue-400" />, infoEvents)}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
