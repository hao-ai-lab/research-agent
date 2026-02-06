'use client'

import React from "react"

import { useState } from 'react'
import { ChevronDown, ChevronRight, Brain, Wrench, Check, AlertCircle, Loader2 } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { LossChart } from './loss-chart'
import type { ChatMessage as ChatMessageType, Sweep, SweepConfig, MessagePart } from '@/lib/types'
import { SweepArtifact } from './sweep-artifact'
import { SweepStatus } from './sweep-status'
import type { ExperimentRun } from '@/lib/types'

interface ChatMessageProps {
  message: ChatMessageType
  collapseArtifacts?: boolean
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
}

export function ChatMessage({ 
  message, 
  collapseArtifacts = false,
  sweeps = [],
  runs = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
}: ChatMessageProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false)
  const [isChartOpen, setIsChartOpen] = useState(true)
  const isUser = message.role === 'user'

  const formatDateTime = (date: Date) => {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `${dateStr}, ${timeStr}`
  }

  const renderMarkdown = (content: string) => {
    // Simple markdown rendering
    const lines = content.split('\n')
    const elements: React.ReactNode[] = []
    let inCodeBlock = false
    let codeContent = ''
    let codeKey = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre
              key={`code-${codeKey++}`}
              className="my-2 overflow-x-auto rounded-lg bg-background p-3 text-xs"
            >
              <code>{codeContent.trim()}</code>
            </pre>
          )
          codeContent = ''
          inCodeBlock = false
        } else {
          inCodeBlock = true
        }
        continue
      }

      if (inCodeBlock) {
        codeContent += line + '\n'
        continue
      }

      if (line.startsWith('**') && line.endsWith('**')) {
        elements.push(
          <p key={i} className="mt-3 mb-1 font-semibold text-foreground">
            {line.slice(2, -2)}
          </p>
        )
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        elements.push(
          <li key={i} className="ml-4 text-foreground/90">
            {renderInlineMarkdown(line.slice(2))}
          </li>
        )
      } else if (line.match(/^\d+\. /)) {
        elements.push(
          <li key={i} className="ml-4 list-decimal text-foreground/90">
            {renderInlineMarkdown(line.replace(/^\d+\. /, ''))}
          </li>
        )
      } else if (line.trim() === '') {
        elements.push(<br key={i} />)
      } else {
        elements.push(
          <p key={i} className="text-foreground/90">
            {renderInlineMarkdown(line)}
          </p>
        )
      }
    }

    return elements
  }

  const renderInlineMarkdown = (text: string) => {
    // Handle inline code
    const parts = text.split(/(`[^`]+`)/)
    return parts.map((part, i) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code
            key={i}
            className="rounded bg-background px-1.5 py-0.5 text-xs text-accent"
          >
            {part.slice(1, -1)}
          </code>
        )
      }
      // Handle bold
      const boldParts = part.split(/(\*\*[^*]+\*\*)/)
      return boldParts.map((bp, j) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          return (
            <strong key={`${i}-${j}`} className="font-semibold">
              {bp.slice(2, -2)}
            </strong>
          )
        }
        return <span key={`${i}-${j}`}>{bp}</span>
      })
    })
  }

  if (isUser) {
    return (
      <div className="px-0.5 py-2">
        <div className="rounded-2xl bg-emerald-600 px-4 py-2.5 text-white">
          <p className="text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-0.5 py-2">
      <div className="space-y-2">
          {/* Parts-based rendering (new) vs legacy thinking field */}
          {message.parts && message.parts.length > 0 ? (
            // NEW: Render each part in order for correct interleaving
            message.parts.map((part) => (
              <SavedPartRenderer 
                key={part.id} 
                part={part} 
                renderMarkdown={renderMarkdown}
              />
            ))
          ) : (
            // Legacy: single thinking block
            message.thinking && (
              <Collapsible open={isThinkingOpen} onOpenChange={setIsThinkingOpen}>
                <CollapsibleTrigger className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                  {isThinkingOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Brain className="h-3 w-3" />
                  <span>Thinking process</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl">
                    {message.thinking.split('\n').map((line, i) => (
                      <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                        {line}
                      </p>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          )}

          {/* Embedded Chart - rendered before text content */}
          {message.chart && (
            <Collapsible open={!collapseArtifacts && isChartOpen} onOpenChange={setIsChartOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground mb-2">
                {(!collapseArtifacts && isChartOpen) ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <span>{message.chart.title}</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mb-3">
                <LossChart data={message.chart.data} title={message.chart.title} />
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Sweep Config Artifact */}
          {message.sweepConfig && (
            <div className="mb-2">
              {(() => {
                const sweep = message.sweepId 
                  ? sweeps.find(s => s.id === message.sweepId)
                  : undefined
                
                if (sweep && sweep.status !== 'draft') {
                  // Show sweep status if the sweep is running/completed
                  return (
                    <SweepStatus
                      sweep={sweep}
                      runs={runs}
                      onRunClick={onRunClick}
                      isCollapsed={collapseArtifacts}
                    />
                  )
                }
                
                // Show sweep artifact (config) if draft or no sweep yet
                return (
                  <SweepArtifact
                    config={message.sweepConfig}
                    sweep={sweep}
                    onEdit={onEditSweep}
                    onLaunch={onLaunchSweep}
                    isCollapsed={collapseArtifacts}
                  />
                )
              })()}
            </div>
          )}

          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-relaxed">
            {renderMarkdown(message.content)}
          </div>

          <span className="text-[10px] text-muted-foreground" suppressHydrationWarning>
            {formatDateTime(message.timestamp)}
          </span>
      </div>
    </div>
  )
}

/**
 * Renders a saved message part (thinking, tool, or text) with collapsible behavior
 */
function SavedPartRenderer({ 
  part, 
  renderMarkdown 
}: { 
  part: MessagePart
  renderMarkdown: (content: string) => React.ReactNode 
}) {
  const [isOpen, setIsOpen] = useState(false) // Default collapsed per user preference

  if (part.type === 'thinking') {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Brain className="h-3 w-3" />
          <span>Thinking process</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl">
            {part.content.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                {line}
              </p>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (part.type === 'tool') {
    const getStatusIcon = () => {
      switch (part.toolState) {
        case 'pending':
        case 'running':
          return <Loader2 className="h-3 w-3 animate-spin" />
        case 'completed':
          return <Check className="h-3 w-3 text-green-500" />
        case 'error':
          return <AlertCircle className="h-3 w-3 text-red-500" />
        default:
          return <Wrench className="h-3 w-3" />
      }
    }

    const getStatusText = () => {
      switch (part.toolState) {
        case 'pending': return 'Pending'
        case 'running': return 'Running'
        case 'completed': return 'Done'
        case 'error': return 'Error'
        default: return part.toolState || ''
      }
    }

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground w-fit transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {getStatusIcon()}
          <Wrench className="h-3 w-3" />
          <span>{part.toolName || 'Tool'}</span>
          <span className="text-muted-foreground/60">•</span>
          <span className={part.toolState === 'completed' ? 'text-green-500' : part.toolState === 'error' ? 'text-red-500' : ''}>
            {getStatusText()}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          {(part.toolInput || part.toolOutput || part.content) && (
            <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl space-y-2">
              {part.toolInput && (
                <div>
                  <span className="font-medium text-foreground/70">Input:</span>
                  <pre className="mt-1 overflow-x-auto">{part.toolInput}</pre>
                </div>
              )}
              {part.toolOutput && (
                <div>
                  <span className="font-medium text-foreground/70">Output:</span>
                  <pre className="mt-1 overflow-x-auto">{part.toolOutput}</pre>
                </div>
              )}
              {part.content && !part.toolInput && !part.toolOutput && (
                <pre className="overflow-x-auto">{part.content}</pre>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (part.type === 'text') {
    return (
      <div className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-relaxed">
        {renderMarkdown(part.content)}
      </div>
    )
  }

  return null
}
