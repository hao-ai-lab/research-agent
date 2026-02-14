'use client'

import { useState } from 'react'
import {
  Lightbulb,
  ToggleLeft,
  ToggleRight,
  Plus,
  PanelLeftOpen,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { MemoryRule } from '@/lib/types'

interface InsightsViewProps {
  rules: MemoryRule[]
  onToggleRule?: (ruleId: string) => void
  onAddRule?: () => void
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

export function InsightsView({
  rules,
  onToggleRule,
  onAddRule,
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: InsightsViewProps) {
  const formatDate = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days} days ago`
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-4">
            {/* Header with Add button */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {showDesktopSidebarToggle && onDesktopSidebarToggle && (
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={onDesktopSidebarToggle}
                    className="hidden h-9 w-9 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
                    title="Show sidebar"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                    <span className="sr-only">Show sidebar</span>
                  </Button>
                )}
                <Lightbulb className="h-4 w-4 text-accent" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Active Rules ({rules.filter(r => r.isActive).length})
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onAddRule}
                className="h-8 bg-transparent"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </div>

            {/* Rules List */}
            <div className="space-y-3">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`rounded-xl border p-4 transition-colors ${
                    rule.isActive 
                      ? 'border-border bg-card' 
                      : 'border-border/50 bg-card/50 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-medium text-sm text-foreground truncate">
                          {rule.title}
                        </h4>
                        <Badge
                          variant="outline"
                          className={
                            rule.source === 'user'
                              ? 'border-accent/50 bg-accent/10 text-accent text-[10px]'
                              : 'border-blue-500/50 bg-blue-500/10 text-blue-400 text-[10px]'
                          }
                        >
                          {rule.source === 'user' ? 'User' : 'Agent'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {rule.description}
                      </p>
                      <p className="text-[10px] text-muted-foreground/70 mt-2">
                        Created {formatDate(rule.createdAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggleRule?.(rule.id)}
                      className="shrink-0 p-1 rounded-md hover:bg-secondary transition-colors"
                    >
                      {rule.isActive ? (
                        <ToggleRight className="h-6 w-6 text-accent" />
                      ) : (
                        <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
