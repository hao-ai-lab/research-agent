'use client'

import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input'
import { StreamingMessage } from './streaming-message'
import { WildLoopBanner } from './wild-loop-banner'
import { WildTerminationDialog } from './wild-termination-dialog'
import { AlertCircle, Loader2, WifiOff } from 'lucide-react'
import { ChatEntryCards, type ChatEntryPromptOptions } from './chat-entry-cards'
import { useChatSession } from '@/hooks/use-chat-session'
import { useWebNotification } from '@/hooks/use-web-notification'
import type { UseWildLoopResult } from '@/hooks/use-wild-loop'
import type {
    ChatMessage as ChatMessageType,
    ExperimentRun,
    Sweep,
    SweepConfig,
    InsightChart,
} from '@/lib/types'
import type { Alert } from '@/lib/api-client'

interface ConnectedChatViewProps {
    runs: ExperimentRun[]
    alerts?: Alert[]
    sweeps?: Sweep[]
    charts?: InsightChart[]
    onRunClick: (run: ExperimentRun) => void
    onEditSweep?: (config: SweepConfig) => void
    onLaunchSweep?: (config: SweepConfig) => void
    mode: ChatMode
    onModeChange: (mode: ChatMode) => void
    collapseArtifactsInChat?: boolean
    // Expose session state for sidebar integration
    onSessionChange?: (sessionId: string | null) => void
    // Optional: pass chat session state from parent (for shared state)
    chatSession?: ReturnType<typeof useChatSession>
    // Wild loop integration
    wildLoop?: UseWildLoopResult
    webNotificationsEnabled?: boolean
    onOpenSettings?: () => void
    onDraftSweepFromPrompt?: (prompt: string) => void
}

/**
 * Chat view connected to the backend API.
 * Handles session management, message streaming, and real-time updates.
 */
export function ConnectedChatView({
    runs,
    alerts = [],
    sweeps = [],
    charts = [],
    onRunClick,
    onEditSweep,
    onLaunchSweep,
    mode,
    onModeChange,
    collapseArtifactsInChat = false,
    onSessionChange,
    chatSession: externalChatSession,
    wildLoop,
    webNotificationsEnabled = true,
    onOpenSettings,
    onDraftSweepFromPrompt,
}: ConnectedChatViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [showTerminationDialog, setShowTerminationDialog] = useState(false)
    // Track which messages were auto-sent by wild loop
    const [wildMessageIndices, setWildMessageIndices] = useState<Set<number>>(new Set())
    // Track the previous streaming state to detect when streaming finishes
    const prevStreamingRef = useRef(false)

    // Web notification hook
    const { notify } = useWebNotification(webNotificationsEnabled)

    // Use external chat session if provided (for shared state), otherwise use own hook
    const internalChatSession = useChatSession()
    const {
        isConnected,
        isLoading,
        error,
        currentSessionId,
        sessions,
        messages,
        streamingState,
        sendMessage,
        createNewSession,
        selectSession,
        stopStreaming,
        queueMessage,
        messageQueue,
        removeFromQueue,
    } = externalChatSession || internalChatSession

    // Notify parent of session changes
    useEffect(() => {
        onSessionChange?.(currentSessionId)
    }, [currentSessionId, onSessionChange])

    // Auto-scroll when messages or streaming content changes
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages, streamingState.textContent, streamingState.thinkingContent])

    // Convert API messages to the ChatMessage type expected by components
    const displayMessages: ChatMessageType[] = useMemo(() => {
        return messages.map((msg, idx) => ({
            id: `${currentSessionId}-${idx}`,
            role: msg.role,
            content: msg.content,
            thinking: msg.thinking || undefined,
            timestamp: new Date(msg.timestamp * 1000),
            source: wildMessageIndices.has(idx) ? ('agent_wild' as const) : undefined,
        }))
    }, [messages, currentSessionId, wildMessageIndices])

    // ========== Wild Loop Integration ==========

    // When streaming finishes, notify the wild loop to decide next action
    useEffect(() => {
        if (prevStreamingRef.current && !streamingState.isStreaming && wildLoop?.isActive) {
            // Small delay to ensure messages state has settled (assistant message added)
            const timer = setTimeout(() => {
                const lastMsg = messages[messages.length - 1]
                if (lastMsg?.role === 'assistant') {
                    console.log('[wild-loop] Stream finished, calling onResponseComplete, msg length:', lastMsg.content.length)
                    wildLoop.onResponseComplete(lastMsg.content)

                    // Send web notification for wild loop response
                    const preview = lastMsg.content.slice(0, 120).replace(/\n/g, ' ')
                    notify('🚀 Wild Mode Response', preview || 'Bot finished responding')
                } else {
                    // No assistant message — OpenCode timed out or never responded
                    // Treat as CONTINUE (retry with same goal)
                    console.warn('[wild-loop] Stream ended with no assistant response, retrying...')
                    wildLoop.onResponseComplete('')
                }
            }, 200)
            prevStreamingRef.current = streamingState.isStreaming
            return () => clearTimeout(timer)
        }

        // Non-wild-loop: send notification when streaming ends with a response
        if (prevStreamingRef.current && !streamingState.isStreaming && !wildLoop?.isActive) {
            const lastMsg = messages[messages.length - 1]
            if (lastMsg?.role === 'assistant') {
                const preview = lastMsg.content.slice(0, 120).replace(/\n/g, ' ')
                notify('🔬 Bot Response', preview || 'Bot finished responding')
            }
        }

        prevStreamingRef.current = streamingState.isStreaming
    }, [streamingState.isStreaming, messages, wildLoop, notify])

    // When wild loop has a pending prompt, auto-send it
    useEffect(() => {
        if (!wildLoop?.pendingPrompt || streamingState.isStreaming) return

        const autoSend = async () => {
            let sessionId = currentSessionId
            if (!sessionId) {
                sessionId = await createNewSession()
                if (!sessionId) return
            }

            // Mark this message index as wild-generated
            const nextIdx = messages.length
            setWildMessageIndices(prev => new Set(prev).add(nextIdx))

            // Send as 'agent' mode — frontend now constructs the full prompt,
            // so we skip backend's wild_mode prompt injection
            await sendMessage(wildLoop.pendingPrompt!, 'agent', sessionId)
            wildLoop.consumePrompt()
        }

        // Small delay to prevent UI flash
        const timer = setTimeout(autoSend, 500)
        return () => clearTimeout(timer)
    }, [wildLoop?.pendingPrompt, streamingState.isStreaming, currentSessionId, messages.length, sendMessage, mode, createNewSession, wildLoop])

    // Handle send - create session if needed, start wild loop if in wild mode
    const buildUiContext = useCallback(() => {
        const activeRuns = runs
            .filter(run => run.status === 'running' || run.status === 'queued')
            .slice(0, 4)

        const pendingAlerts = alerts
            .filter(alert => alert.status === 'pending')
            .slice(0, 4)

        const activeSweeps = sweeps
            .filter(sweep => sweep.status === 'running' || sweep.status === 'pending')
            .slice(0, 3)

        const latestCompletedRun = runs
            .filter(run => run.status === 'completed')
            .sort((a, b) => {
                const aTime = a.endTime?.getTime() || a.startTime.getTime()
                const bTime = b.endTime?.getTime() || b.startTime.getTime()
                return bTime - aTime
            })[0]

        const lines: string[] = ['UI context snapshot:']
        lines.push(
            activeRuns.length > 0
                ? `- Active runs: ${activeRuns.map(run => `${run.alias || run.name} (${run.status}, ${run.progress}%)`).join('; ')}`
                : '- Active runs: none'
        )
        lines.push(
            pendingAlerts.length > 0
                ? `- Pending alerts: ${pendingAlerts.map(alert => `${alert.severity} ${alert.id}: ${alert.message}`).join('; ')}`
                : '- Pending alerts: none'
        )
        lines.push(
            activeSweeps.length > 0
                ? `- Active sweeps: ${activeSweeps.map(sweep => `${sweep.id} (${sweep.status}, ${sweep.progress.completed}/${sweep.progress.total})`).join('; ')}`
                : '- Active sweeps: none'
        )
        if (latestCompletedRun) {
            lines.push(`- Latest completed run: ${latestCompletedRun.alias || latestCompletedRun.name} (${latestCompletedRun.id})`)
        }
        return lines.join('\n')
    }, [runs, alerts, sweeps])

    const runPromptAction = useCallback(async (prompt: string, options?: ChatEntryPromptOptions) => {
        let sessionId = currentSessionId
        if (options?.newSession || !sessionId) {
            sessionId = await createNewSession()
            if (!sessionId) return
        }

        const effectiveMode = options?.mode || mode
        await sendMessage(prompt, effectiveMode, sessionId, buildUiContext())
    }, [currentSessionId, createNewSession, mode, sendMessage, buildUiContext])

    const openSessionFromCard = useCallback(async (sessionId: string) => {
        await selectSession(sessionId)
    }, [selectSession])

    const handleSend = useCallback(async (message: string, _attachments?: File[], msgMode?: ChatMode) => {
        const effectiveMode = msgMode || mode

        if (effectiveMode === 'sweep' && onDraftSweepFromPrompt) {
            onDraftSweepFromPrompt(message)
            return
        }

        let sessionId = currentSessionId
        if (!sessionId) {
            // Auto-create a session on first message
            sessionId = await createNewSession()
            if (!sessionId) {
                return // Session creation failed
            }
        }

        // If in wild mode and loop isn't active, start the loop on first message
        if (effectiveMode === 'wild' && wildLoop && !wildLoop.isActive) {
            wildLoop.start(message, sessionId)
        }

        await sendMessage(message, effectiveMode, sessionId, buildUiContext())
    }, [currentSessionId, createNewSession, sendMessage, mode, wildLoop, onDraftSweepFromPrompt, buildUiContext])

    // Connection error state
    if (!isConnected && !isLoading) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
                <WifiOff className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-foreground">Cannot Connect to Backend</h3>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                    Make sure the backend server is running, or try Demo Mode to explore the app.
                </p>
                <code className="mt-4 rounded bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    python server.py --workdir /your/project/root
                </code>

                <div className="mt-6 flex flex-col gap-3">
                    <button
                        type="button"
                        onClick={() => {
                            onOpenSettings?.()
                        }}
                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                        Enable Demo Mode
                    </button>
                    <p className="text-xs text-muted-foreground">
                        You can also change the server URL in Settings
                    </p>
                </div>
            </div>
        )
    }

    // Loading state
    if (isLoading && messages.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="mt-4 text-sm text-muted-foreground">Connecting...</p>
            </div>
        )
    }

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Wild Loop Banner */}
            {wildLoop?.isActive && (
                <WildLoopBanner
                    phase={wildLoop.phase}
                    iteration={wildLoop.iteration}
                    goal={wildLoop.goal}
                    startedAt={wildLoop.startedAt}
                    isPaused={wildLoop.isPaused}
                    terminationConditions={wildLoop.terminationConditions}
                    onPause={wildLoop.pause}
                    onResume={wildLoop.resume}
                    onStop={wildLoop.stop}
                    onConfigureTermination={() => setShowTerminationDialog(true)}
                    runStats={wildLoop.runStats}
                    activeAlerts={wildLoop.activeAlerts}
                />
            )}

            {/* Error banner */}
            {error && (
                <div className="shrink-0 bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    {error}
                </div>
            )}

            {/* Scrollable Chat Area */}
            <div className="flex-1 min-h-0 overflow-hidden">
                <ScrollArea className="h-full" ref={scrollRef}>
                    <div className="pb-4">
                        <div className="mt-4 space-y-1">
                            {displayMessages.map((message) => (
                                <div
                                    key={message.id}
                                    style={message.source === 'agent_wild' ? {
                                        borderLeft: '3px solid #a855f7',
                                        paddingLeft: '8px',
                                        marginLeft: '4px',
                                    } : undefined}
                                >
                                    <ChatMessage
                                        message={message}
                                        collapseArtifacts={collapseArtifactsInChat}
                                        sweeps={sweeps}
                                        runs={runs}
                                        onEditSweep={onEditSweep}
                                        onLaunchSweep={onLaunchSweep}
                                        onRunClick={onRunClick}
                                    />
                                </div>
                            ))}

                            {/* Streaming message */}
                            {streamingState.isStreaming && (
                                <StreamingMessage streamingState={streamingState} />
                            )}
                        </div>

                        {/* Empty state */}
                        {messages.length === 0 && !streamingState.isStreaming && (
                            <div className="flex flex-col items-center justify-center px-4 py-8">
                                <ChatEntryCards
                                    mode={mode}
                                    runs={runs}
                                    alerts={alerts}
                                    sweeps={sweeps}
                                    sessions={sessions}
                                    onPrompt={runPromptAction}
                                    onDraftSweep={onDraftSweepFromPrompt || (() => {})}
                                    onOpenSession={openSessionFromCard}
                                />
                            </div>
                        )}
                    </div>
                </ScrollArea>
            </div>

            {/* Chat Input - Fixed at bottom */}
            <div className="shrink-0">
                <ChatInput
                    onSend={handleSend}
                    onStop={() => {
                        stopStreaming()
                        // Also pause wild loop if active
                        if (wildLoop?.isActive && !wildLoop.isPaused) {
                            wildLoop.pause()
                        }
                    }}
                    mode={mode}
                    onModeChange={onModeChange}
                    runs={runs}
                    alerts={alerts}
                    charts={charts}
                    messages={displayMessages}
                    isStreaming={streamingState.isStreaming}
                    onQueue={queueMessage}
                    queueCount={messageQueue.length}
                    queue={messageQueue}
                    onRemoveFromQueue={removeFromQueue}
                />
            </div>

            {/* Termination config dialog */}
            {wildLoop && (
                <WildTerminationDialog
                    open={showTerminationDialog}
                    onClose={() => setShowTerminationDialog(false)}
                    currentConditions={wildLoop.terminationConditions}
                    onSave={wildLoop.setTerminationConditions}
                />
            )}
        </div>
    )
}

// Export the hook for use by other components (like nav-page)
export { useChatSession } from '@/hooks/use-chat-session'
