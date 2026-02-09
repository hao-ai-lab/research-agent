'use client'

import React from "react"

import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Brain, Wrench, Check, AlertCircle, Loader2 } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { LossChart } from './loss-chart'
import type { ChatMessage as ChatMessageType, Sweep, SweepConfig, MessagePart } from '@/lib/types'
import { SweepArtifact } from './sweep-artifact'
import { SweepStatus } from './sweep-status'
import type { ExperimentRun } from '@/lib/types'
import type { Alert } from '@/lib/api-client'
import {
  REFERENCE_TYPE_BACKGROUND_MAP,
  REFERENCE_TYPE_COLOR_MAP,
  type ReferenceTokenType,
} from '@/lib/reference-token-colors'
import { extractContextReferences } from '@/lib/extract-context-references'
import { ContextReferencesBar } from './context-references-bar'

interface ChatMessageProps {
  message: ChatMessageType
  collapseArtifacts?: boolean
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  alerts?: Alert[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
  /** Content of the user message that prompted this assistant response (for context extraction) */
  previousUserContent?: string
}

export function ChatMessage({ 
  message, 
  collapseArtifacts = false,
  sweeps = [],
  runs = [],
  alerts = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
  previousUserContent,
}: ChatMessageProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false)
  const [isChartOpen, setIsChartOpen] = useState(true)
  const isUser = message.role === 'user'

  // Extract context references from the current round (user question + assistant answer)
  const contextReferences = useMemo(() => {
    if (isUser) return []
    // Gather text from all parts, plus the main content
    const partTexts = (message.parts || []).filter(p => p.type === 'text').map(p => p.content)
    return extractContextReferences(
      previousUserContent,
      message.content,
      ...partTexts,
    )
  }, [isUser, message.content, message.parts, previousUserContent])

  const formatDateTime = (date: Date) => {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `${dateStr}, ${timeStr}`
  }

  const renderReferenceToken = (reference: string, key: string) => {
    const [type, ...idParts] = reference.split(':')
    const itemId = idParts.join(':')
    const tokenType = (type in REFERENCE_TYPE_COLOR_MAP ? type : 'chat') as ReferenceTokenType
    const color = REFERENCE_TYPE_COLOR_MAP[tokenType]
    const backgroundColor = REFERENCE_TYPE_BACKGROUND_MAP[tokenType]
    const tokenStyle = {
      color,
      backgroundColor,
      ['--reference-border' as string]: `${color}66`,
    } as React.CSSProperties

    if (type === 'sweep') {
      const sweep = sweeps.find((candidate) => candidate.id === itemId)

      if (sweep) {
        return (
          <Popover key={key}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="mx-0.5 inline-flex items-center align-middle rounded-sm border border-[color:var(--reference-border)] px-2.5 py-1.5 text-base leading-none outline-none transition-colors hover:border-transparent focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
                style={tokenStyle}
              >
                @{reference}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[min(94vw,430px)] p-0">
              <div className="p-2">
                {sweep.status === 'draft' ? (
                  <SweepArtifact
                    config={sweep.config}
                    sweep={sweep}
                    onEdit={onEditSweep}
                    onLaunch={onLaunchSweep}
                    isCollapsed={false}
                  />
                ) : (
                  <SweepStatus
                    sweep={sweep}
                    runs={runs}
                    onRunClick={onRunClick}
                    isCollapsed={false}
                  />
                )}
              </div>
            </PopoverContent>
          </Popover>
        )
      }
    }

    return (
      <span
        key={key}
        className="mx-0.5 inline-flex items-center align-middle rounded-sm border border-[color:var(--reference-border)] px-2.5 py-1.5 text-base leading-none"
        style={tokenStyle}
      >
        @{reference}
      </span>
    )
  }

  const renderReferences = (text: string, keyPrefix: string) => {
    const output: React.ReactNode[] = []
    const referenceRegex = /@((?:run|sweep|artifact|alert|chart|chat):[A-Za-z0-9:._-]+)(?=$|[\s,.;!?)\]])/g
    let cursor = 0
    let match: RegExpExecArray | null
    let partIndex = 0

    while ((match = referenceRegex.exec(text)) !== null) {
      const tokenStart = match.index
      const tokenEnd = tokenStart + match[0].length
      if (tokenStart > cursor) {
        output.push(
          <span key={`${keyPrefix}-txt-${partIndex++}`}>
            {text.slice(cursor, tokenStart)}
          </span>
        )
      }

      output.push(renderReferenceToken(match[1], `${keyPrefix}-ref-${tokenStart}`))
      cursor = tokenEnd
    }

    if (cursor < text.length) {
      output.push(
        <span key={`${keyPrefix}-txt-${partIndex++}`}>
          {text.slice(cursor)}
        </span>
      )
    }

    if (output.length === 0) {
      output.push(
        <span key={`${keyPrefix}-txt-empty`}>
          {text}
        </span>
      )
    }

    return output
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
              className="my-2 overflow-hidden whitespace-pre-wrap break-all rounded-lg bg-background p-3 text-sm"
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
            className="rounded border border-orange-300/70 bg-orange-100/85 px-1.5 py-0.5 font-mono text-sm text-orange-700 dark:border-[#39ff14]/35 dark:bg-[#0b1a0f] dark:text-[#39ff14]"
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
              {renderReferences(bp.slice(2, -2), `bold-${i}-${j}`)}
            </strong>
          )
        }
        return (
          <React.Fragment key={`${i}-${j}`}>
            {renderReferences(bp, `text-${i}-${j}`)}
          </React.Fragment>
        )
      })
    })
  }

  if (isUser) {
    return (
      <div className="px-0.5 py-2 min-w-0 overflow-hidden">
        <div className="border-l-4 border-primary px-3 py-1">
          <p className="text-base leading-relaxed text-foreground break-words">{renderInlineMarkdown(message.content)}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-0.5 py-2 min-w-0 overflow-hidden">
      <div className="space-y-2 min-w-0">
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
                <CollapsibleTrigger className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                  {isThinkingOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <Brain className="h-3 w-3" />
                  <span>Thinking process</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
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

          <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
            {renderMarkdown(message.content)}
          </div>

          {/* Context references bar */}
          {contextReferences.length > 0 && (
            <ContextReferencesBar
              references={contextReferences}
              sweeps={sweeps}
              runs={runs}
              alerts={alerts}
              onEditSweep={onEditSweep}
              onLaunchSweep={onLaunchSweep}
              onRunClick={onRunClick}
            />
          )}

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
        <CollapsibleTrigger className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Brain className="h-3 w-3" />
          <span>Thinking process</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
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
    const durationLabel = formatToolDuration(part.toolDurationMs, part.toolStartedAt, part.toolEndedAt)

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
        <CollapsibleTrigger className="flex w-full items-center justify-start gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {getStatusIcon()}
          <Wrench className="h-3 w-3" />
          <span>{part.toolName || 'Tool'}</span>
          <span className="text-muted-foreground/60">•</span>
          <span className={part.toolState === 'completed' ? 'text-green-500' : part.toolState === 'error' ? 'text-red-500' : ''}>
            {getStatusText()}
          </span>
          {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          {(part.toolInput || part.toolOutput || part.content) && (
            <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground space-y-2">
              {part.toolInput && (
                <div>
                  <span className="font-medium text-foreground/70">Input:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all overflow-hidden">{part.toolInput}</pre>
                </div>
              )}
              {part.toolOutput && (
                <div>
                  <span className="font-medium text-foreground/70">Output:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all overflow-hidden">{part.toolOutput}</pre>
                </div>
              )}
              {part.content && !part.toolInput && !part.toolOutput && (
                <pre className="whitespace-pre-wrap break-all overflow-hidden">{part.content}</pre>
              )}
              {(part.toolStartedAt || part.toolEndedAt) && (
                <div className="text-muted-foreground/80">
                  {part.toolStartedAt && <div>Start: {formatToolTimestamp(part.toolStartedAt)}</div>}
                  {part.toolEndedAt && <div>End: {formatToolTimestamp(part.toolEndedAt)}</div>}
                </div>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (part.type === 'text') {
    return (
      <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
        {renderMarkdown(part.content)}
      </div>
    )
  }

  return null
}

function formatToolTimestamp(value: number): string {
  const ms = value > 1e12 ? value : value * 1000
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatToolDuration(durationMs?: number, startedAt?: number, endedAt?: number): string | null {
  const derived = durationMs ?? (
    startedAt != null && endedAt != null
      ? Math.max(0, Math.round((endedAt > 1e12 ? endedAt : endedAt * 1000) - (startedAt > 1e12 ? startedAt : startedAt * 1000)))
      : undefined
  )
  if (derived == null) return null
  if (derived < 1000) return `${derived}ms`
  return `${(derived / 1000).toFixed(2)}s`
}
