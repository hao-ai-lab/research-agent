'use client'

import React, { useState, useEffect, useRef } from 'react'
import { Brain, Loader2, Wrench, Check, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import type { StreamingState, ToolCallState, StreamingPart } from '@/hooks/use-chat-session'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CodeOutputBox } from '@/components/code-output-box'
import { useAppSettings } from '@/lib/app-settings'

interface StreamingMessageProps {
    streamingState: StreamingState
}

/**
 * Displays a message that is currently being streamed.
 * Renders parts in order (thinking→tool→thinking→text) to show correct interleaving.
 */
export function StreamingMessage({ streamingState }: StreamingMessageProps) {
    const { settings } = useAppSettings()
    const thinkingMode = settings.appearance.thinkingDisplayMode || 'inline'
    const { isStreaming, parts, thinkingContent, textContent, toolCalls } = streamingState

    if (!isStreaming) {
        return null
    }

    // Use parts-based rendering if available, otherwise fall back to legacy
    const hasParts = parts && parts.length > 0

    return (
        <div className="px-0.5 py-2 min-w-0 overflow-hidden">
            <div className="space-y-2 min-w-0">
                {hasParts ? (
                    // NEW: Render parts in order for correct interleaving
                    parts.map((part) => (
                        <StreamingPartRenderer key={part.id} part={part} />
                    ))
                ) : (
                    // Legacy fallback: grouped thinking, tools, text
                    <>
                        {thinkingContent && (
                            thinkingMode === 'inline' ? (
                                <div className="space-y-1">
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Brain className="h-3 w-3 animate-pulse" />
                                        <span>Thinking...</span>
                                    </div>
                                    <div className="px-1 py-1 leading-relaxed text-muted-foreground" style={{ fontSize: 'var(--app-thinking-tool-font-size, 14px)' }}>
                                        {thinkingContent.split('\n').map((line, i) => (
                                            <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                                                {line}
                                            </p>
                                        ))}
                                        <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-start gap-2">
                                        <div className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground">
                                            <Brain className="h-3 w-3 animate-pulse" />
                                            <span>Thinking...</span>
                                        </div>
                                    </div>
                                    <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-h-[var(--app-streaming-tool-box-height,7.5rem)] overflow-y-auto">
                                        {thinkingContent.split('\n').map((line, i) => (
                                            <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                                                {line}
                                            </p>
                                        ))}
                                        <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />
                                    </div>
                                </>
                            )
                        )}
                        {toolCalls.length > 0 && (
                            <div className="space-y-1">
                                {toolCalls.map((tool) => (
                                    <ToolCallIndicator key={tool.id} tool={tool} />
                                ))}
                            </div>
                        )}
                        {textContent && (
                            <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
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
        return <StreamingThinkingPart part={part} />
    }

    if (part.type === 'tool') {
        return <StreamingToolPart part={part} />
    }

    if (part.type === 'text') {
        return (
            <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
                {renderStreamingText(part.content)}
                <span className="inline-block w-1.5 h-4 bg-foreground/50 animate-pulse ml-0.5" />
            </div>
        )
    }

    return null
}

/**
 * Streaming thinking part — expanded while actively streaming, auto-collapses when done.
 * Detects "done" by checking if content has stopped changing.
 */
function StreamingThinkingPart({ part }: { part: StreamingPart }) {
    const { settings } = useAppSettings()
    const thinkingMode = settings.appearance.thinkingDisplayMode || 'inline'
    const [isOpen, setIsOpen] = useState(thinkingMode !== 'collapse')
    const [isDone, setIsDone] = useState(false)
    const prevContentRef = useRef(part.content)
    const length_to_show = 150

    // Detect when thinking stops (content unchanged for 400ms)
    useEffect(() => {
        if (isDone) return
        prevContentRef.current = part.content
        const timer = setTimeout(() => {
            if (prevContentRef.current === part.content && part.content.length > 0) {
                setIsDone(true)
                if (thinkingMode !== 'inline') setIsOpen(false)
            }
        }, 400)
        return () => clearTimeout(timer)
    }, [part.content, isDone, thinkingMode])

    if (thinkingMode === 'inline') {
        return (
            <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Brain className={`h-3 w-3 ${!isDone ? 'animate-pulse' : ''}`} />
                    <span>{isDone ? 'Thought' : 'Thinking...'}</span>
                </div>
                <div className="px-1 py-1 leading-relaxed text-muted-foreground" style={{ fontSize: 'var(--app-thinking-tool-font-size, 14px)' }}>
                    {part.content.split('\n').map((line, i) => (
                        <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                            {line}
                        </p>
                    ))}
                    {!isDone && <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />}
                </div>
            </div>
        )
    }

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Brain className={`h-3 w-3 ${!isDone ? 'animate-pulse' : ''}`} />
                <span>{isDone ? 'Thought' : 'Thinking...'}</span>
                {!isOpen && isDone && part.content && (
                    <span className="ml-1 truncate text-muted-foreground/50 max-w-[200px]" title={part.content.split('\n')[0]}>
                        — {part.content.split('\n')[0].slice(0, length_to_show)}{part.content.split('\n')[0].length > length_to_show ? '…' : ''}
                    </span>
                )}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 leading-relaxed text-muted-foreground max-h-[var(--app-streaming-tool-box-height,7.5rem)] overflow-y-auto" style={{ fontSize: 'var(--app-thinking-tool-font-size, 14px)' }}>
                    {part.content.split('\n').map((line, i) => (
                        <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                            {line}
                        </p>
                    ))}
                    {!isDone && <span className="inline-block w-1.5 h-3 bg-muted-foreground/50 animate-pulse ml-0.5" />}
                </div>
            </CollapsibleContent>
        </Collapsible>
    )
}

function StreamingToolPart({ part }: { part: StreamingPart }) {
    const { settings } = useAppSettings()
    const toolMode = settings.appearance.toolDisplayMode || 'expand'
    const [isOpen, setIsOpen] = useState(toolMode !== 'collapse')
    const state = part.toolState || 'pending'
    const durationLabel = formatDuration(part.toolDurationMs, part.toolStartedAt, part.toolEndedAt)
    const length_to_show = 150

    // Auto-collapse when tool finishes (completed or error) — only if in collapse/expand mode
    useEffect(() => {
        if (toolMode === 'inline') return
        if (state === 'completed' || state === 'error') {
            // Small delay so user can briefly see the final state
            const timer = setTimeout(() => setIsOpen(false), 300)
            return () => clearTimeout(timer)
        }
    }, [state, toolMode])

    const toolContentBlock = (
        <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 leading-relaxed text-muted-foreground space-y-2 max-h-[var(--app-streaming-tool-box-height,7.5rem)] overflow-y-auto" style={{ fontSize: 'var(--app-thinking-tool-font-size, 14px)' }}>
            {part.toolDescription && (
                <div>
                    <span className="font-medium text-foreground/70">Description:</span>{' '}
                    <span>{part.toolDescription}</span>
                </div>
            )}
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
            {(part.toolStartedAt || part.toolEndedAt) && (
                <div className="text-muted-foreground/80">
                    {part.toolStartedAt && <div>Start: {formatTimestamp(part.toolStartedAt)}</div>}
                    {part.toolEndedAt && <div>End: {formatTimestamp(part.toolEndedAt)}</div>}
                </div>
            )}
        </div>
    )

    if (toolMode === 'inline') {
        return (
            <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ToolStateIcon state={state} />
                    <Wrench className="h-3 w-3" />
                    <span>{part.toolName || 'Tool'}</span>
                    <span className="text-muted-foreground/60">•</span>
                    <span className={state === 'completed' ? 'text-green-500' : state === 'error' ? 'text-red-500' : ''}>
                        {getToolStateLabel(state)}
                    </span>
                    {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
                </div>
                {toolContentBlock}
            </div>
        )
    }

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-start gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <ToolStateIcon state={state} />
                <Wrench className="h-3 w-3" />
                <span>{part.toolName || 'Tool'}</span>
                <span className="text-muted-foreground/60">•</span>
                <span className={state === 'completed' ? 'text-green-500' : state === 'error' ? 'text-red-500' : ''}>
                    {getToolStateLabel(state)}
                </span>
                {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
                {!isOpen && (part.toolDescription || part.toolInput) && (
                    <span className="ml-1 truncate text-muted-foreground/50 max-w-[200px]" title={part.toolDescription || part.toolInput}>
                        — {(part.toolDescription || part.toolInput || '').slice(0, length_to_show)}{(part.toolDescription || part.toolInput || '').length > length_to_show ? '…' : ''}
                    </span>
                )}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                {toolContentBlock}
            </CollapsibleContent>
        </Collapsible>
    )
}

function ToolCallIndicator({ tool }: { tool: ToolCallState }) {
    const durationLabel = formatDuration(tool.durationMs, tool.startedAt, tool.endedAt)

    return (
        <div className="w-full rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
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

function parseTaggedCodeBlock(content: string): { language: string; code: string } | null {
    const trimmed = content.trim()
    const match = trimmed.match(/^<(backend|frontend)(?:\s+lang=["']?([A-Za-z0-9_+-]+)["']?)?>\n?([\s\S]*?)\n?<\/\1>$/i)
    if (!match) return null

    return {
        language: (match[2] || match[1]).toLowerCase(),
        code: match[3],
    }
}

function detectStandaloneCode(content: string): { language: string; code: string } | null {
    const trimmed = content.trim()
    if (!trimmed || trimmed.includes('```')) return null

    const lines = trimmed.split('\n')
    if (lines.length < 2) return null

    const htmlLike = /^<(?:!doctype|html|head|body|main|section|article|div|script|style|template)\b/i.test(trimmed) && /<\/[a-z]/i.test(trimmed)
    if (htmlLike) {
        return { language: 'html', code: trimmed }
    }

    const jsPattern = /^\s*(?:const|let|var|function|import|export|if|for|while|return|class)\b|=>|[{};]/
    const pyPattern = /^\s*(?:def|class|import|from|if|for|while|return|with|try|except)\b|:\s*$/
    const jsonLike = /^[\[{][\s\S]*[\]}]$/.test(trimmed) && /":\s*/.test(trimmed)

    const jsLines = lines.filter((line) => jsPattern.test(line)).length
    const pyLines = lines.filter((line) => pyPattern.test(line)).length
    const threshold = Math.max(2, Math.floor(lines.length * 0.6))

    if (jsonLike) return { language: 'json', code: trimmed }
    if (jsLines >= threshold) return { language: 'javascript', code: trimmed }
    if (pyLines >= threshold) return { language: 'python', code: trimmed }

    return null
}

/**
 * Streaming text renderer for markdown-like assistant output.
 */
function renderStreamingText(text: string): React.ReactNode {
    const taggedCode = parseTaggedCodeBlock(text)
    if (taggedCode) {
        return <CodeOutputBox language={taggedCode.language} code={taggedCode.code} />
    }

    const standaloneCode = detectStandaloneCode(text)
    if (standaloneCode) {
        return <CodeOutputBox language={standaloneCode.language} code={standaloneCode.code} />
    }

    const lines = text.split('\n')
    const elements: React.ReactNode[] = []
    let inCodeBlock = false
    let codeContent = ''
    let codeLanguage = ''
    let codeKey = 0
    let listType: 'ul' | 'ol' | null = null
    let listItems: string[] = []

    const flushList = (listKey: string) => {
        if (!listType || listItems.length === 0) return
        const ListTag = listType
        elements.push(
            <ListTag
                key={listKey}
                className={listType === 'ul' ? 'list-disc pl-6 space-y-1 text-foreground/90' : 'list-decimal pl-6 space-y-1 text-foreground/90'}
            >
                {listItems.map((item, itemIndex) => (
                    <li key={`${listKey}-item-${itemIndex}`}>
                        {renderStreamingInlineMarkdown(item, `${listKey}-item-${itemIndex}`)}
                    </li>
                ))}
            </ListTag>
        )
        listType = null
        listItems = []
    }

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]

        if (line.startsWith('```')) {
            flushList(`list-before-code-${i}`)
            if (inCodeBlock) {
                const key = `code-${codeKey++}`
                elements.push(
                    <CodeOutputBox
                        key={key}
                        language={codeLanguage}
                        code={codeContent.replace(/\n$/, '')}
                    />
                )
                inCodeBlock = false
                codeContent = ''
                codeLanguage = ''
            } else {
                inCodeBlock = true
                codeLanguage = line.slice(3).trim()
            }
            continue
        }

        if (inCodeBlock) {
            codeContent += `${line}\n`
            continue
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
        const orderedItemMatch = line.match(/^\d+\.\s+(.+)$/)
        const unorderedItemMatch = line.match(/^[-*+]\s+(.+)$/)
        const blockquoteMatch = line.match(/^>\s?(.*)$/)

        if (unorderedItemMatch) {
            if (listType !== 'ul') {
                flushList(`list-switch-${i}`)
                listType = 'ul'
            }
            listItems.push(unorderedItemMatch[1])
            continue
        }

        if (orderedItemMatch) {
            if (listType !== 'ol') {
                flushList(`list-switch-${i}`)
                listType = 'ol'
            }
            listItems.push(orderedItemMatch[1])
            continue
        }

        flushList(`list-${i}`)

        if (headingMatch) {
            const level = headingMatch[1].length
            const HeadingTag = `h${Math.min(level, 6)}` as keyof React.JSX.IntrinsicElements
            elements.push(
                <HeadingTag key={`heading-${i}`} className="mt-3 mb-1 font-semibold text-foreground">
                    {renderStreamingInlineMarkdown(headingMatch[2], `heading-${i}`)}
                </HeadingTag>
            )
            continue
        }
        if (blockquoteMatch) {
            const quoteLines = [blockquoteMatch[1]]
            while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
                i += 1
                quoteLines.push(lines[i].replace(/^>\s?/, ''))
            }
            elements.push(
                <blockquote key={`quote-${i}`} className="border-l-2 border-border/70 pl-3 text-foreground/80">
                    {quoteLines.map((quoteLine, quoteIndex) => (
                        <p key={`quote-${i}-${quoteIndex}`}>
                            {renderStreamingInlineMarkdown(quoteLine, `quote-${i}-${quoteIndex}`)}
                        </p>
                    ))}
                </blockquote>
            )
            continue
        }
        if (line.startsWith('**') && line.endsWith('**')) {
            elements.push(
                <p key={i} className="mt-3 mb-1 font-semibold text-foreground">
                    {renderStreamingInlineMarkdown(line.slice(2, -2), `strong-line-${i}`)}
                </p>
            )
            continue
        }
        if (line.trim() === '') {
            elements.push(<div key={`spacer-${i}`} className="h-2" />)
            continue
        }
        elements.push(
            <p key={i} className="text-foreground/90">
                {renderStreamingInlineMarkdown(line, `line-${i}`)}
            </p>
        )
    }

    flushList('list-end')

    if (inCodeBlock && codeContent) {
        const key = `code-${codeKey++}`
        elements.push(
            <CodeOutputBox
                key={key}
                language={codeLanguage}
                code={codeContent.replace(/\n$/, '')}
            />
        )
    }

    return elements
}

function renderStreamingInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
    const elements: React.ReactNode[] = []
    const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\((?:[^()\s]+)\)|\*[^*\n]+\*|_[^_\n]+_)/g
    let cursor = 0
    let tokenIndex = 0
    let match: RegExpExecArray | null

    while ((match = tokenRegex.exec(text)) !== null) {
        if (match.index > cursor) {
            elements.push(
                <React.Fragment key={`${keyPrefix}-plain-${tokenIndex++}`}>
                    {text.slice(cursor, match.index)}
                </React.Fragment>
            )
        }

        const token = match[0]
        const tokenKey = `${keyPrefix}-token-${tokenIndex++}`

        if (token.startsWith('`') && token.endsWith('`')) {
            elements.push(
                <code
                    key={tokenKey}
                    className="rounded border border-orange-300/70 bg-orange-100/85 px-1.5 py-0.5 font-mono text-sm text-orange-700 dark:border-[#39ff14]/35 dark:bg-[#0b1a0f] dark:text-[#39ff14]"
                >
                    {token.slice(1, -1)}
                </code>
            )
        } else if (token.startsWith('**') && token.endsWith('**')) {
            elements.push(
                <strong key={tokenKey} className="font-semibold">
                    {token.slice(2, -2)}
                </strong>
            )
        } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
            elements.push(
                <em key={tokenKey} className="italic">
                    {token.slice(1, -1)}
                </em>
            )
        } else if (token.startsWith('~~') && token.endsWith('~~')) {
            elements.push(
                <span key={tokenKey} className="line-through">
                    {token.slice(2, -2)}
                </span>
            )
        } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
            const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
            if (linkMatch) {
                const href = linkMatch[2]
                const isExternal = /^https?:\/\//i.test(href)
                elements.push(
                    <a
                        key={tokenKey}
                        href={href}
                        target={isExternal ? '_blank' : undefined}
                        rel={isExternal ? 'noreferrer noopener' : undefined}
                        className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
                    >
                        {linkMatch[1]}
                    </a>
                )
            } else {
                elements.push(<React.Fragment key={tokenKey}>{token}</React.Fragment>)
            }
        } else {
            elements.push(<React.Fragment key={tokenKey}>{token}</React.Fragment>)
        }

        cursor = tokenRegex.lastIndex
    }

    if (cursor < text.length) {
        elements.push(
            <React.Fragment key={`${keyPrefix}-tail`}>
                {text.slice(cursor)}
            </React.Fragment>
        )
    }

    if (elements.length === 0) {
        elements.push(<React.Fragment key={`${keyPrefix}-empty`}>{text}</React.Fragment>)
    }

    return elements
}
