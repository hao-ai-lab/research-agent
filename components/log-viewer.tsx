'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
    FileText,
    Maximize2,
    Radio,
    ChevronUp,
    Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getRunLogs, streamRunLogs, type LogResponse } from '@/lib/api-client'

interface LogViewerProps {
    runId: string
    isFullPage?: boolean
    onExpand?: () => void
    showHeader?: boolean
    className?: string
}

export function LogViewer({ runId, isFullPage = false, onExpand, showHeader = true, className = '' }: LogViewerProps) {
    const [logs, setLogs] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [isStreaming, setIsStreaming] = useState(false)
    const [logInfo, setLogInfo] = useState<{ totalSize: number; hasMoreBefore: boolean }>({
        totalSize: 0,
        hasMoreBefore: false
    })
    const [error, setError] = useState<string | null>(null)

    const scrollRef = useRef<HTMLDivElement>(null)
    const logContainerRef = useRef<HTMLPreElement>(null)
    const streamAbortRef = useRef<AbortController | null>(null)
    const currentOffsetRef = useRef<number>(0)

    // Load initial logs (last 10KB)
    const loadInitialLogs = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const response = await getRunLogs(runId, -10000, 10000)
            setLogs(response.content)
            setLogInfo({
                totalSize: response.total_size,
                hasMoreBefore: response.has_more_before
            })
            currentOffsetRef.current = response.offset

            // Scroll to bottom after content loads
            setTimeout(() => {
                if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                }
            }, 50)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load logs')
        } finally {
            setIsLoading(false)
        }
    }, [runId])

    // Load more logs (when scrolling up)
    const loadMoreLogs = useCallback(async () => {
        if (!logInfo.hasMoreBefore || isLoading || currentOffsetRef.current <= 0) return

        setIsLoading(true)
        try {
            // Load 10KB before current offset
            const newOffset = Math.max(0, currentOffsetRef.current - 10000)
            const limit = currentOffsetRef.current - newOffset

            const response = await getRunLogs(runId, newOffset, limit)

            // Prepend new content
            setLogs(prev => response.content + prev)
            setLogInfo({
                totalSize: response.total_size,
                hasMoreBefore: response.has_more_before
            })
            currentOffsetRef.current = newOffset
        } catch (e) {
            console.error('Failed to load more logs:', e)
        } finally {
            setIsLoading(false)
        }
    }, [runId, logInfo.hasMoreBefore, isLoading])

    // Handle scroll to detect when user scrolls to top
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.target as HTMLDivElement
        if (target.scrollTop < 100 && logInfo.hasMoreBefore && !isLoading) {
            loadMoreLogs()
        }
    }, [loadMoreLogs, logInfo.hasMoreBefore, isLoading])

    // Start streaming logs
    const startStreaming = useCallback(async () => {
        setIsStreaming(true)
        setError(null)
        streamAbortRef.current = new AbortController()

        try {
            for await (const event of streamRunLogs(runId)) {
                if (streamAbortRef.current?.signal.aborted) break

                if (event.type === 'initial') {
                    setLogs(event.content || '')
                } else if (event.type === 'delta') {
                    setLogs(prev => prev + (event.content || ''))
                    // Auto-scroll to bottom on new content
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                    }
                } else if (event.type === 'done') {
                    break
                } else if (event.type === 'error') {
                    setError(event.error || 'Streaming error')
                    break
                }
            }
        } catch (e) {
            if (!streamAbortRef.current?.signal.aborted) {
                setError(e instanceof Error ? e.message : 'Streaming failed')
            }
        } finally {
            setIsStreaming(false)
        }
    }, [runId])

    // Stop streaming
    const stopStreaming = useCallback(() => {
        streamAbortRef.current?.abort()
        setIsStreaming(false)
    }, [])

    // Load initial logs on mount
    useEffect(() => {
        loadInitialLogs()
        return () => {
            streamAbortRef.current?.abort()
        }
    }, [loadInitialLogs])

    // Refresh logs periodically when not streaming
    useEffect(() => {
        if (isStreaming) return

        const interval = setInterval(() => {
            // Just reload if we're at the bottom
            if (scrollRef.current) {
                const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
                const isAtBottom = scrollHeight - scrollTop - clientHeight < 100
                if (isAtBottom) {
                    loadInitialLogs()
                }
            }
        }, 5000)

        return () => clearInterval(interval)
    }, [isStreaming, loadInitialLogs])

    const containerHeight = isFullPage ? 'h-full' : 'h-64'

    return (
        <div className={`flex flex-col rounded-lg border border-border bg-card overflow-hidden ${className}`}>
            {showHeader && (
                <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
                    <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-medium">Logs</span>
                        {logInfo.totalSize > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                                ({(logInfo.totalSize / 1024).toFixed(1)} KB)
                            </span>
                        )}
                        {isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                    </div>

                    <div className="flex items-center gap-1">
                        <Button
                            variant={isStreaming ? "destructive" : "ghost"}
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={isStreaming ? stopStreaming : startStreaming}
                        >
                            <Radio className={`h-3 w-3 mr-1 ${isStreaming ? 'animate-pulse' : ''}`} />
                            {isStreaming ? 'Stop' : 'Stream'}
                        </Button>

                        {!isFullPage && onExpand && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px]"
                                onClick={onExpand}
                            >
                                <Maximize2 className="h-3 w-3 mr-1" />
                                Expand
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {/* Log content */}
            <div
                ref={scrollRef}
                className={`${containerHeight} overflow-auto font-mono text-[11px] bg-black/50`}
                onScroll={handleScroll}
            >
                {/* Load more indicator */}
                {logInfo.hasMoreBefore && (
                    <div className="flex items-center justify-center py-2 text-[10px] text-muted-foreground">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-2 text-[10px]"
                            onClick={loadMoreLogs}
                            disabled={isLoading}
                        >
                            <ChevronUp className="h-3 w-3 mr-1" />
                            Load more
                        </Button>
                    </div>
                )}

                {error ? (
                    <div className="p-3 text-red-400">{error}</div>
                ) : logs ? (
                    <pre
                        ref={logContainerRef}
                        className="p-3 whitespace-pre-wrap break-all text-gray-300 leading-relaxed"
                    >
                        {logs}
                    </pre>
                ) : (
                    <div className="p-3 text-muted-foreground italic">
                        {isLoading ? 'Loading logs...' : 'No logs available yet'}
                    </div>
                )}
            </div>
        </div>
    )
}
