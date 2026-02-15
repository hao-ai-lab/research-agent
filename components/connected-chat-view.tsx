'use client'

import { Fragment, useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input'
import { StreamingMessage } from './streaming-message'
import { EventQueuePanel } from './event-queue-panel'
import { WildTerminationDialog } from './wild-termination-dialog'
import { AlertCircle, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { ChatStarterCards } from '@/components/chat-starter-cards'
import { WildModeSetupPanel } from '@/components/wild-mode-setup-panel'
import { WildLoopDebugPanel } from '@/components/wild-loop-debug-panel'
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet'
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
    PromptProvenance,
    WildModeSetup,
} from '@/lib/types'
import type { Alert } from '@/lib/api-client'
import type { PromptSkill } from '@/lib/api'

const SCROLL_BOTTOM_THRESHOLD_PX = 64

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
    skills?: PromptSkill[]
    contextTokenCount?: number
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
    skills = [],
    contextTokenCount = 0,
}: ConnectedChatViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const autoScrollEnabledRef = useRef(true)
    const [showTerminationDialog, setShowTerminationDialog] = useState(false)
    const [starterDraftInsert, setStarterDraftInsert] = useState<{ id: number; text: string } | null>(null)
    const [starterReplyExcerptInsert, setStarterReplyExcerptInsert] = useState<{
        id: number
        text: string
        fileName?: string
        sessionId: string
    } | null>(null)
    const [excerptPreview, setExcerptPreview] = useState<{ fileName: string; text: string } | null>(null)
    const [isExcerptPreviewOpen, setIsExcerptPreviewOpen] = useState(false)
    const { settings, setSettings } = useAppSettings()
    const showStarterCards = settings.appearance.showStarterCards !== false
    const starterCardFlavor = settings.appearance.starterCardFlavor || 'expert'
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
    // Counter to force re-render when provenance is added (ref alone won't trigger)
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
        currentSession,
        messages,
        streamingState,
        availableModels,
        selectedModel,
        isModelUpdating,
        setSelectedModel,
        sendMessage,
        createNewSession,
        selectSession,
        stopStreaming,
        queueMessage,
        messageQueue,
        removeFromQueue,
    } = externalChatSession || internalChatSession

    // Always-current messages ref so streaming-end effect reads latest without re-triggering
    const messagesRef = useRef(messages)
    messagesRef.current = messages

    // Notify parent of session changes
    useEffect(() => {
        onSessionChange?.(currentSessionId)
    }, [currentSessionId, onSessionChange])

    const getScrollViewport = useCallback((): HTMLDivElement | null => {
        if (!scrollRef.current) return null
        return scrollRef.current.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')
    }, [])

    // Reset to sticky auto-scroll when opening/switching sessions.
    useEffect(() => {
        autoScrollEnabledRef.current = true
    }, [currentSessionId])

    // Track whether user is near bottom. If not, pause auto-scroll.
    useEffect(() => {
        const viewport = getScrollViewport()
        if (!viewport) return

        const updateAutoScrollState = () => {
            const distanceFromBottom =
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            autoScrollEnabledRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX
        }

        viewport.addEventListener('scroll', updateAutoScrollState, { passive: true })
        return () => {
            viewport.removeEventListener('scroll', updateAutoScrollState)
        }
    }, [getScrollViewport, messages.length, injectedMessages.length, streamingState.isStreaming, collapseChats])

    // Auto-scroll only while sticky mode is enabled.
    useEffect(() => {
        if (!autoScrollEnabledRef.current) return

        const viewport = getScrollViewport()
        if (!viewport) return

        const frame = requestAnimationFrame(() => {
            viewport.scrollTop = viewport.scrollHeight
        })

        return () => cancelAnimationFrame(frame)
    }, [
        currentSessionId,
        getScrollViewport,
        messages,
        streamingState.textContent,
        streamingState.thinkingContent,
        streamingState.parts,
        collapseChats,
    ])

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
            source: undefined,
            provenance: undefined,
        }))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, currentSessionId])

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

    // When streaming finishes, send a web notification
    useEffect(() => {
        if (prevStreamingRef.current && !streamingState.isStreaming) {
            const msgs = messagesRef.current
            const lastMsg = msgs[msgs.length - 1]
            if (lastMsg?.role === 'assistant') {
                const chatName = currentSession?.title?.trim() || 'Untitled Chat'
                const title = `[Research Agent] ${chatName}`
                const body = lastMsg.content.trim() || 'Bot finished responding'
                notify(title, body)
            }
        }
        prevStreamingRef.current = streamingState.isStreaming
    }, [streamingState.isStreaming, currentSession?.title, notify])

    // Auto-reconnect to the next iteration's stream when wild loop is active.
    // When the V2 backend finishes one iteration, it sends `session_status: idle`,
    // causing the frontend's SSE stream to disconnect. The backend then starts the
    // next iteration with a new ChatStreamRuntime. This effect polls for a new
    // active_stream and re-attaches when one appears.
    const wildReconnectRef = useRef(false)
    useEffect(() => {
        // Track streaming transitions for reconnect logic
        if (streamingState.isStreaming) {
            wildReconnectRef.current = true  // mark that we were streaming
            return
        }
        if (!wildReconnectRef.current) return  // wasn't streaming before
        wildReconnectRef.current = false  // reset

        if (!wildLoop?.isActive) return  // not in wild mode
        if (!currentSessionId) return

        let cancelled = false
        const sessionId = currentSessionId

        const pollForNextStream = async () => {
            // Give the backend a moment to start the next iteration
            await new Promise(r => setTimeout(r, 2000))

            for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
                try {
                    const { getSession } = await import('@/lib/api')
                    const sessionData = await getSession(sessionId)
                    if (sessionData.active_stream?.status === 'running') {
                        // New iteration stream found — re-attach
                        console.log('[wild-reconnect] Found new active stream, re-attaching (attempt %d)', attempt)
                        await selectSession(sessionId)
                        break
                    }
                } catch {
                    // Request failed, retry
                }
                await new Promise(r => setTimeout(r, 1500))
            }
        }

        pollForNextStream()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streamingState.isStreaming, wildLoop?.isActive, currentSessionId, selectSession])

    // Handle send - create session if needed, start wild loop if in wild mode
    const handleSend = useCallback(async (message: string, _attachments?: File[], msgMode?: ChatMode) => {
        let sessionId = currentSessionId
        if (!sessionId) {
            sessionId = await createNewSession()
            if (!sessionId) {
                return
            }
        }

        const effectiveMode = msgMode || mode
        onUserMessage?.(message)

        // If in wild mode and loop isn't active, start the V2 loop.
        // V2 handles ALL iterations (including the first) through its own chat callback,
        // so we do NOT send the message via sendMessage — that would create a conflicting
        // chat worker on the same session and cause a 409.
        if (effectiveMode === 'wild' && wildLoop && !wildLoop.isActive) {
            wildLoop.start(message, sessionId)

            // Auto-name the session since wild mode bypasses sendMessage
            const title = `🚀 ${message.slice(0, 60)}${message.length > 60 ? '...' : ''}`
            import('@/lib/api').then(({ renameSession }) =>
                renameSession(sessionId, title).catch(() => { })
            )

            // V2 starts asynchronously — poll selectSession to attach to the stream
            // once the backend starts the first iteration's chat worker
            const pollForStream = async () => {
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 1000))
                    try {
                        await selectSession(sessionId)
                        break  // attached to stream
                    } catch {
                        // stream not ready yet, retry
                    }
                }
            }
            pollForStream()
            return  // V2 takes over from here
        }

        // Send the message normally — in wild mode (already running), the V2 backend
        // handles all subsequent iterations autonomously
        await sendMessage(message, effectiveMode, sessionId)
    }, [currentSessionId, createNewSession, sendMessage, mode, wildLoop, onUserMessage, selectSession])

    const handleReplyToSelection = useCallback((selectedText: string) => {
        if (!currentSessionId) return
        setStarterReplyExcerptInsert({
            id: Date.now(),
            text: selectedText,
            fileName: 'excerpt_from_previous_message.txt',
            sessionId: currentSessionId,
        })
    }, [currentSessionId])

    const handleOpenReplyExcerpt = useCallback((excerpt: { fileName: string; text: string }) => {
        setExcerptPreview(excerpt)
        setIsExcerptPreviewOpen(true)
    }, [])

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
                        onClick={() => window.location.reload()}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
                    >
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            onOpenSettings?.()
                        }}
                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                        Configure Server URL
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
        <>
            {wildLoop?.isActive && wildLoop.eventQueue.length > 0 && (
                <EventQueuePanel
                    events={wildLoop.eventQueue}
                    onReorder={wildLoop.reorderQueue}
                    onRemove={wildLoop.removeFromQueue}
                    onInsert={wildLoop.insertIntoQueue}
                />
            )}
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
                insertReplyExcerpt={
                    starterReplyExcerptInsert && starterReplyExcerptInsert.sessionId === currentSessionId
                        ? {
                            id: starterReplyExcerptInsert.id,
                            text: starterReplyExcerptInsert.text,
                            fileName: starterReplyExcerptInsert.fileName,
                        }
                        : null
                }
                conversationKey={currentSessionId || 'new'}
                layout={layout}
                skills={skills}
                isWildLoopActive={wildLoop?.isActive ?? false}
                onSteer={wildLoop ? (msg, priority) => {
                    wildLoop.insertIntoQueue({
                        id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        priority,
                        title: msg.length > 50 ? msg.slice(0, 47) + '...' : msg,
                        prompt: msg,
                        type: 'steer',
                        createdAt: Date.now(),
                    }, 0) // Insert at front of queue
                } : undefined}
                onOpenReplyExcerpt={handleOpenReplyExcerpt}
                contextTokenCount={contextTokenCount}
                modelOptions={availableModels}
                selectedModel={selectedModel}
                isModelUpdating={isModelUpdating}
                onModelChange={setSelectedModel}
            />
        </>
    )

    // Find the closing of the chat view to add debug panel
    const showDebugPanel = settings.developer?.showWildLoopState === true
    const debugPanelElement = showDebugPanel ? (
        <WildLoopDebugPanel onClose={() => {
            setSettings({
                ...settings,
                developer: { ...settings.developer, showWildLoopState: false },
            })
        }} />
    ) : null

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
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
                            {/* Welcome message for new chat */}
                            <div className="mb-6 text-center">
                                <h2 className="text-2xl font-semibold text-foreground mb-2">
                                    What can I help you with?
                                </h2>
                            </div>
                            <div className="w-full max-w-3xl">
                                {renderChatInput('centered')}
                            </div>
                            {showStarterCards && mode !== 'wild' && (
                                <div className="mt-4 lg:mt-5 w-full max-w-6xl">
                                <ChatStarterCards
                                    runs={runs}
                                    sweeps={sweeps}
                                    alerts={alerts}
                                    flavor={starterCardFlavor}
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
                            {mode === 'wild' && wildLoop && (
                                <div className="mt-4 lg:mt-5 w-full max-w-3xl">
                                    <WildModeSetupPanel
                                        onLaunch={(setup: WildModeSetup) => {
                                            wildLoop.applySetup(setup)
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
                                    <div className="mt-4 space-y-1 px-2.5 min-w-0">
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
                                                    onReplyToSelection={handleReplyToSelection}
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
                                                        className={message.role === 'user'
                                                            ? 'sticky top-0 z-20 -mx-2.5 mb-1 border-b border-border/60 bg-background/95 px-2.5 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/85'
                                                            : undefined}
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
                                                            onReplyToSelection={handleReplyToSelection}
                                                            previousUserContent={prevUserContent}
                                                        />
                                                    </div>
                                                )
                                            })}

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

                <Sheet open={isExcerptPreviewOpen} onOpenChange={setIsExcerptPreviewOpen}>
                    <SheetContent side="right" className="w-[92vw] p-0 sm:max-w-2xl">
                        <SheetHeader className="border-b border-border/60 px-4 py-3">
                            <SheetTitle className="truncate text-xl font-semibold">
                                {excerptPreview?.fileName || 'excerpt_from_previous_message.txt'}
                            </SheetTitle>
                            <SheetDescription className="text-xs">
                                {(() => {
                                    const text = excerptPreview?.text ?? ''
                                    const bytes = new TextEncoder().encode(text).length
                                    const lineCount = text ? text.split('\n').length : 0
                                    const kb = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(2)} KB`
                                    const linesLabel = `${lineCount} line${lineCount === 1 ? '' : 's'}`
                                    return `${kb} • ${linesLabel} • Formatting may be inconsistent from source`
                                })()}
                            </SheetDescription>
                        </SheetHeader>
                        <div className="h-[calc(100vh-84px)] overflow-auto p-3">
                            <div className="overflow-hidden rounded-lg border border-border/70 bg-card/60">
                                <div className="grid grid-cols-[auto_minmax(0,1fr)] text-sm font-mono leading-6">
                                    {(excerptPreview?.text || '').split('\n').map((line, index) => (
                                        <Fragment key={`excerpt-line-${index + 1}`}>
                                            <span className="select-none border-r border-border/40 bg-background/70 px-3 text-right text-[11px] text-muted-foreground">
                                                {index + 1}
                                            </span>
                                            <span className="border-b border-border/30 px-3 whitespace-pre-wrap break-words text-foreground/90">
                                                {line || ' '}
                                            </span>
                                        </Fragment>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </SheetContent>
                </Sheet>
            </div>
            {debugPanelElement}
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
    onReplyToSelection,
}: {
    pair: { user: ChatMessageType; assistant?: ChatMessageType }
    collapseArtifacts: boolean
    sweeps: Sweep[]
    runs: ExperimentRun[]
    alerts?: Alert[]
    onEditSweep?: (config: SweepConfig) => void
    onLaunchSweep?: (config: SweepConfig) => void
    onRunClick: (run: ExperimentRun) => void
    onReplyToSelection?: (text: string) => void
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
                            onReplyToSelection={onReplyToSelection}
                            previousUserContent={pair.user.content}
                        />
                    )}
                </div>
            )}
        </div>
    )
}
