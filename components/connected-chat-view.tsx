'use client'

import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input'
import { StreamingMessage } from './streaming-message'
import { WildLoopBanner } from './wild-loop-banner'
import { WildTerminationDialog } from './wild-termination-dialog'
import { AlertCircle, Loader2, WifiOff } from 'lucide-react'
import { ChatStarterCards } from '@/components/chat-starter-cards'
import { useAppSettings } from '@/lib/app-settings'
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
    collapseChats?: boolean
    collapseArtifactsInChat?: boolean
    // Expose session state for sidebar integration
    onSessionChange?: (sessionId: string | null) => void
    // Optional: pass chat session state from parent (for shared state)
    chatSession?: ReturnType<typeof useChatSession>
    // Wild loop integration
    wildLoop?: UseWildLoopResult
    webNotificationsEnabled?: boolean
    onOpenSettings?: () => void
    insertDraft?: { id: number; text: string } | null
    injectedMessages?: ChatMessageType[]
    onUserMessage?: (message: string) => void
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
    collapseChats = false,
    collapseArtifactsInChat = false,
    onSessionChange,
    chatSession: externalChatSession,
    wildLoop,
    webNotificationsEnabled = true,
    onOpenSettings,
    insertDraft,
    injectedMessages = [],
    onUserMessage,
}: ConnectedChatViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [showTerminationDialog, setShowTerminationDialog] = useState(false)
    const [starterDraftInsert, setStarterDraftInsert] = useState<{ id: number; text: string } | null>(null)
    const { settings, setSettings } = useAppSettings()
    const showStarterCards = settings.appearance.showStarterCards !== false
    const customTemplates = settings.appearance.starterCardTemplates ?? {}
    const handleEditTemplate = useCallback((cardId: string, template: string | null) => {
        setSettings({
            ...settings,
            appearance: {
                ...settings.appearance,
                starterCardTemplates: (() => {
                    const next = { ...settings.appearance.starterCardTemplates }
                    if (template === null) {
                        delete next[cardId]
                    } else {
                        next[cardId] = template
                    }
                    return next
                })(),
            },
        })
    }, [settings, setSettings])
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
        messages,
        streamingState,
        sendMessage,
        createNewSession,
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
    const apiDisplayMessages: ChatMessageType[] = useMemo(() => {
        return messages.map((msg, idx) => ({
            id: `${currentSessionId}-${idx}`,
            role: msg.role,
            content: msg.content,
            thinking: msg.thinking || undefined,
            parts: msg.parts?.map((part, pIdx) => ({
                id: part.id || `${part.type}-${pIdx}`,
                type: part.type,
                content: part.content ?? '',
                toolName: part.tool_name,
                toolState: part.tool_state,
                toolStateRaw: part.tool_state_raw,
                toolInput: part.tool_input,
                toolOutput: part.tool_output,
                toolStartedAt: part.tool_started_at,
                toolEndedAt: part.tool_ended_at,
                toolDurationMs: part.tool_duration_ms,
            })),
            timestamp: new Date(msg.timestamp * 1000),
            source: wildMessageIndices.has(idx) ? ('agent_wild' as const) : undefined,
        }))
    }, [messages, currentSessionId, wildMessageIndices])

    const displayMessages: ChatMessageType[] = useMemo(() => {
        if (injectedMessages.length === 0) {
            return apiDisplayMessages
        }
        return [...apiDisplayMessages, ...injectedMessages].sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
        )
    }, [apiDisplayMessages, injectedMessages])

    const messagePairs = useMemo(() => {
        const pairs: { user: ChatMessageType; assistant?: ChatMessageType }[] = []
        for (let idx = 0; idx < displayMessages.length; idx += 1) {
            const message = displayMessages[idx]
            if (message.role === 'user') {
                const next = displayMessages[idx + 1]
                if (next?.role === 'assistant') {
                    pairs.push({ user: message, assistant: next })
                    idx += 1
                } else {
                    pairs.push({ user: message })
                }
                continue
            }

            if (message.role === 'assistant' && pairs.length === 0) {
                pairs.push({
                    user: {
                        id: `system-${idx}`,
                        role: 'user',
                        content: '',
                        timestamp: message.timestamp,
                    },
                    assistant: message,
                })
            }
        }
        return pairs
    }, [displayMessages])

    const effectiveInsertDraft = useMemo(() => {
        if (!starterDraftInsert) return insertDraft
        if (!insertDraft) return starterDraftInsert
        return starterDraftInsert.id >= insertDraft.id ? starterDraftInsert : insertDraft
    }, [starterDraftInsert, insertDraft])

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
    const handleSend = useCallback(async (message: string, _attachments?: File[], msgMode?: ChatMode) => {
        let sessionId = currentSessionId
        if (!sessionId) {
            // Auto-create a session on first message
            sessionId = await createNewSession()
            if (!sessionId) {
                return // Session creation failed
            }
        }

        const effectiveMode = msgMode || mode
        onUserMessage?.(message)

        // If in wild mode and loop isn't active, start the loop on first message
        if (effectiveMode === 'wild' && wildLoop && !wildLoop.isActive) {
            wildLoop.start(message, sessionId)
        }

        await sendMessage(message, effectiveMode, sessionId)
    }, [currentSessionId, createNewSession, sendMessage, mode, wildLoop, onUserMessage])

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

    const hasConversation = displayMessages.length > 0 || streamingState.isStreaming

    const renderChatInput = (layout: 'docked' | 'centered') => (
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
            sweeps={sweeps}
            charts={charts}
            messages={displayMessages}
            isStreaming={streamingState.isStreaming}
            onQueue={queueMessage}
            queueCount={messageQueue.length}
            queue={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            insertDraft={effectiveInsertDraft}
            layout={layout}
        />
    )

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

            {!hasConversation ? (
                <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                    <div className="flex flex-1 min-h-0 flex-col items-center justify-center px-3 lg:px-6">
                        <div className="w-full max-w-3xl">
                            {renderChatInput('centered')}
                        </div>
                        {showStarterCards && (
                            <div className="mt-4 lg:mt-5 w-full max-w-6xl">
                                <ChatStarterCards
                                    runs={runs}
                                    sweeps={sweeps}
                                    alerts={alerts}
                                    customTemplates={customTemplates}
                                    onEditTemplate={handleEditTemplate}
                                    onPromptSelect={(prompt) => {
                                        setStarterDraftInsert({
                                            id: Date.now(),
                                            text: prompt,
                                        })
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <>
                    {/* Scrollable Chat Area */}
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <ScrollArea className="h-full" ref={scrollRef}>
                            <div className="pb-4">
                                <div className="mt-4 space-y-1 px-2.5">
                                    {collapseChats
                                        ? messagePairs.map((pair, index) => (
                                            <CollapsedChatPair
                                                key={`${pair.user.id}-${index}`}
                                                pair={pair}
                                                collapseArtifacts={collapseArtifactsInChat}
                                                sweeps={sweeps}
                                                runs={runs}
                                                alerts={alerts}
                                                onEditSweep={onEditSweep}
                                                onLaunchSweep={onLaunchSweep}
                                                onRunClick={onRunClick}
                                            />
                                        ))
                                        : displayMessages.map((message, index) => {
                                            // Find the previous user message for context extraction
                                            let prevUserContent: string | undefined
                                            if (message.role === 'assistant') {
                                                for (let i = index - 1; i >= 0; i--) {
                                                    if (displayMessages[i].role === 'user') {
                                                        prevUserContent = displayMessages[i].content
                                                        break
                                                    }
                                                }
                                            }
                                            return (
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
                                                    alerts={alerts}
                                                    onEditSweep={onEditSweep}
                                                    onLaunchSweep={onLaunchSweep}
                                                    onRunClick={onRunClick}
                                                    previousUserContent={prevUserContent}
                                                />
                                            </div>
                                        )})}

                                    {/* Streaming message */}
                                    {streamingState.isStreaming && (
                                        <StreamingMessage streamingState={streamingState} />
                                    )}
                                </div>
                            </div>
                        </ScrollArea>
                    </div>

                    {/* Chat Input - Fixed at bottom once conversation starts */}
                    <div className="shrink-0">
                        {renderChatInput('docked')}
                    </div>
                </>
            )}

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

function CollapsedChatPair({
    pair,
    collapseArtifacts,
    sweeps,
    runs,
    alerts,
    onEditSweep,
    onLaunchSweep,
    onRunClick,
}: {
    pair: { user: ChatMessageType; assistant?: ChatMessageType }
    collapseArtifacts: boolean
    sweeps: Sweep[]
    runs: ExperimentRun[]
    alerts?: Alert[]
    onEditSweep?: (config: SweepConfig) => void
    onLaunchSweep?: (config: SweepConfig) => void
    onRunClick: (run: ExperimentRun) => void
}) {
    const [expanded, setExpanded] = useState(false)

    if (!pair.user.content) return null

    const preview = pair.user.content.length > 72
        ? `${pair.user.content.slice(0, 72)}...`
        : pair.user.content

    const formatDateTime = (date: Date) => {
        const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return `${dateStr}, ${timeStr}`
    }

    return (
        <div className="border-b border-border/50">
            <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-secondary/50"
            >
                <span className={`text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{preview}</span>
                <span className="shrink-0 text-xs text-muted-foreground/70" suppressHydrationWarning>
                    {formatDateTime(new Date(pair.user.timestamp))}
                </span>
            </button>
            {expanded && (
                <div className="pb-2">
                    <ChatMessage
                        message={pair.user}
                        collapseArtifacts={collapseArtifacts}
                        sweeps={sweeps}
                        runs={runs}
                        alerts={alerts}
                        onEditSweep={onEditSweep}
                        onLaunchSweep={onLaunchSweep}
                        onRunClick={onRunClick}
                    />
                    {pair.assistant && (
                        <ChatMessage
                            message={pair.assistant}
                            collapseArtifacts={collapseArtifacts}
                            sweeps={sweeps}
                            runs={runs}
                            alerts={alerts}
                            onEditSweep={onEditSweep}
                            onLaunchSweep={onLaunchSweep}
                            onRunClick={onRunClick}
                            previousUserContent={pair.user.content}
                        />
                    )}
                </div>
            )}
        </div>
    )
}
