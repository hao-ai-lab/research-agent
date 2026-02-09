'use client'

import React, { useState } from 'react'
import { Brain, Loader2, Wrench, Check, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import type { StreamingState, ToolCallState, StreamingPart } from '@/hooks/use-chat-session'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

interface StreamingMessageProps {
    streamingState: StreamingState
}

/**
 * Displays a message that is currently being streamed.
 * Renders parts in order (thinking→tool→thinking→text) to show correct interleaving.
 */
export function StreamingMessage({ streamingState }: StreamingMessageProps) {
    const { isStreaming, parts, thinkingContent, textContent, toolCalls } = streamingState

    if (!isStreaming) {
        return null
    }

    // Use parts-based rendering if available, otherwise fall back to legacy
    const hasParts = parts && parts.length > 0

    return (
        <div className="px-0.5 py-2">
            <div className="space-y-2">
                {hasParts ? (
                    // NEW: Render parts in order for correct interleaving
                    parts.map((part) => (
                        <StreamingPartRenderer key={part.id} part={part} />
                    ))
                ) : (
                    // Legacy fallback: grouped thinking, tools, text
                    <>
                        {thinkingContent && (
                            <>
                                <div className="flex items-start gap-2">
                                    <div className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground">
                                        <Brain className="h-3 w-3 animate-pulse" />
                                        <span>Thinking...</span>
                                    </div>
                                </div>
                                <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl">
                                    {thinkingContent.split('\n').map((line, i) => (
                                        <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                                            {line}
                                        </p>
                                    ))}
                                    <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />
                                </div>
                            </>
                        )}
                        {toolCalls.length > 0 && (
                            <div className="space-y-1">
                                {toolCalls.map((tool) => (
                                    <ToolCallIndicator key={tool.id} tool={tool} />
                                ))}
                            </div>
                        )}
                        {textContent && (
                            <div className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-relaxed">
                                {renderStreamingText(textContent)}
                                <span className="inline-block w-1.5 h-4 bg-foreground/50 animate-pulse ml-0.5" />
                            </div>
                        )}
                    </>
                )}

                {/* Loading indicator when no content yet */}
                {!hasParts && !thinkingContent && !textContent && toolCalls.length === 0 && (
                    <div className="flex items-center gap-2 px-4 py-3">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">Thinking...</span>
                    </div>
                )}
            </div>
        </div>
    )
}

/**
 * Renders a single streaming part (thinking, tool, or text)
 */
function StreamingPartRenderer({ part }: { part: StreamingPart }) {
    if (part.type === 'thinking') {
        return (
            <>
                <div className="flex items-start gap-2">
                    <div className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground">
                        <Brain className="h-3 w-3 animate-pulse" />
                        <span>Thinking...</span>
                    </div>
                </div>
                <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl">
                    {part.content.split('\n').map((line, i) => (
                        <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                            {line}
                        </p>
                    ))}
                    <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />
                </div>
            </>
        )
    }

    if (part.type === 'tool') {
        return <StreamingToolPart part={part} />
    }

    if (part.type === 'text') {
        return (
            <div className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-relaxed">
                {renderStreamingText(part.content)}
                <span className="inline-block w-1.5 h-4 bg-foreground/50 animate-pulse ml-0.5" />
            </div>
        )
    }

    return null
}

function StreamingToolPart({ part }: { part: StreamingPart }) {
    const [isOpen, setIsOpen] = useState(true)
    const state = part.toolState || 'pending'
    const durationLabel = formatDuration(part.toolDurationMs, part.toolStartedAt, part.toolEndedAt)

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground w-fit transition-colors hover:bg-secondary hover:text-foreground">
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <ToolStateIcon state={state} />
                <Wrench className="h-3 w-3" />
                <span>{part.toolName || 'Tool'}</span>
                <span className="text-muted-foreground/60">•</span>
                <span className={state === 'completed' ? 'text-green-500' : state === 'error' ? 'text-red-500' : ''}>
                    {getToolStateLabel(state)}
                </span>
                {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl space-y-2">
                    {part.toolDescription && (
                        <div>
                            <span className="font-medium text-foreground/70">Description:</span>{' '}
                            <span>{part.toolDescription}</span>
                        </div>
                    )}
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
                    {(part.toolStartedAt || part.toolEndedAt) && (
                        <div className="text-muted-foreground/80">
                            {part.toolStartedAt && <div>Start: {formatTimestamp(part.toolStartedAt)}</div>}
                            {part.toolEndedAt && <div>End: {formatTimestamp(part.toolEndedAt)}</div>}
                        </div>
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
    )
}

function ToolCallIndicator({ tool }: { tool: ToolCallState }) {
    const durationLabel = formatDuration(tool.durationMs, tool.startedAt, tool.endedAt)

    return (
        <div className="rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground w-fit max-w-md">
            <div className="flex items-center gap-2">
                <ToolStateIcon state={tool.state} />
                <Wrench className="h-3 w-3" />
                <span>{tool.name || 'Tool'}</span>
                <span className="text-muted-foreground/60">•</span>
                <span className={tool.state === 'completed' ? 'text-green-500' : tool.state === 'error' ? 'text-red-500' : ''}>
                    {getToolStateLabel(tool.state)}
                </span>
                {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
            </div>
            {tool.description && (
                <div className="mt-1 pl-5 text-muted-foreground/80 italic truncate">
                    {tool.description}
                </div>
            )}
            {tool.output && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border/50 bg-background/40 p-2 text-[11px] leading-relaxed">
                    {tool.output}
                </pre>
            )}
        </div>
    )
}

function ToolStateIcon({ state }: { state: string }) {
    switch (state) {
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

function getToolStateLabel(state: string): string {
    switch (state) {
        case 'pending':
            return 'Pending'
        case 'running':
            return 'Running'
        case 'completed':
            return 'Done'
        case 'error':
            return 'Error'
        default:
            return state || 'Unknown'
    }
}

function formatTimestamp(value: number): string {
    const ms = value > 1e12 ? value : value * 1000
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(durationMs?: number, startedAt?: number, endedAt?: number): string | null {
    const derived = durationMs ?? (
        startedAt != null && endedAt != null
            ? Math.max(0, Math.round((endedAt > 1e12 ? endedAt : endedAt * 1000) - (startedAt > 1e12 ? startedAt : startedAt * 1000)))
            : undefined
    )
    if (derived == null) return null
    if (derived < 1000) return `${derived}ms`
    return `${(derived / 1000).toFixed(2)}s`
}

/**
 * Simple streaming text renderer - handles basic markdown
 */
function renderStreamingText(text: string): React.ReactNode {
    const lines = text.split('\n')
    return lines.map((line, i) => {
        if (line.startsWith('**') && line.endsWith('**')) {
            return (
                <p key={i} className="mt-3 mb-1 font-semibold text-foreground">
                    {line.slice(2, -2)}
                </p>
            )
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
            return (
                <li key={i} className="ml-4 text-foreground/90">
                    {line.slice(2)}
                </li>
            )
        }
        if (line.trim() === '') {
            return <br key={i} />
        }
        return (
            <span key={i}>
                {line}
                {i < lines.length - 1 && <br />}
            </span>
        )
    })
}
