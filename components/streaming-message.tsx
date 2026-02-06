'use client'

import React from 'react'
import { Brain, Loader2, Wrench, Check, AlertCircle } from 'lucide-react'
import type { StreamingState, ToolCallState, StreamingPart } from '@/hooks/use-chat-session'

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
        return (
            <ToolCallIndicator
                tool={{
                    id: part.id,
                    name: part.toolName,
                    state: part.toolState || 'pending',
                }}
            />
        )
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

function ToolCallIndicator({ tool }: { tool: ToolCallState }) {
    const getStatusIcon = () => {
        switch (tool.state) {
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
        switch (tool.state) {
            case 'pending':
                return 'Pending'
            case 'running':
                return 'Running'
            case 'completed':
                return 'Done'
            case 'error':
                return 'Error'
            default:
                return tool.state
        }
    }

    return (
        <div className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground w-fit">
            {getStatusIcon()}
            <Wrench className="h-3 w-3" />
            <span>{tool.name || 'Tool'}</span>
            <span className="text-muted-foreground/60">•</span>
            <span className={tool.state === 'completed' ? 'text-green-500' : tool.state === 'error' ? 'text-red-500' : ''}>
                {getStatusText()}
            </span>
        </div>
    )
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
