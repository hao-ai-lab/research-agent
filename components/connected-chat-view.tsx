'use client'

import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input'
import { StreamingMessage } from './streaming-message'
import { WildLoopBanner } from './wild-loop-banner'
import { WildTerminationDialog } from './wild-termination-dialog'
import { AlertCircle, Loader2, WifiOff } from 'lucide-react'
import { useChatSession } from '@/hooks/use-chat-session'
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
}: ConnectedChatViewProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [showTerminationDialog, setShowTerminationDialog] = useState(false)
    // Track which messages were auto-sent by wild loop
    const [wildMessageIndices, setWildMessageIndices] = useState<Set<number>>(new Set())
    // Track the previous streaming state to detect when streaming finishes
    const prevStreamingRef = useRef(false)

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
        prevStreamingRef.current = streamingState.isStreaming
    }, [streamingState.isStreaming, messages, wildLoop])

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

            await sendMessage(wildLoop.pendingPrompt!, mode, sessionId)
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

        // If in wild mode and loop isn't active, start the loop on first message
        if (effectiveMode === 'wild' && wildLoop && !wildLoop.isActive) {
            wildLoop.start(message, sessionId)
        }

        await sendMessage(message, effectiveMode, sessionId)
    }, [currentSessionId, createNewSession, sendMessage, mode, wildLoop])

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
                            // Open settings dialog - uses the global settings trigger
                            const settingsBtn = document.querySelector('[data-settings-trigger]') as HTMLButtonElement
                            settingsBtn?.click()
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
                            <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                                    <span className="text-2xl">{mode === 'wild' ? '🚀' : '🔬'}</span>
                                </div>
                                <h3 className="text-lg font-semibold text-foreground">
                                    {mode === 'wild' ? 'Wild Mode' : 'Research Assistant'}
                                </h3>
                                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                                    {mode === 'wild'
                                        ? 'Describe your research goal and the agent will autonomously design experiments, create sweeps, and iterate.'
                                        : 'Ask me anything about your experiments, training runs, or ML research. I can help analyze loss curves, debug issues, and suggest improvements.'}
                                </p>
                                <div className="mt-6 flex flex-wrap justify-center gap-2">
                                    {(mode === 'wild' ? [
                                        'Sweep learning rates from 1e-4 to 1e-2',
                                        'Train model and tune hyperparams',
                                        'Debug failing training run',
                                    ] : [
                                        'Analyze my latest run',
                                        'Why did training fail?',
                                        'Compare model configs',
                                    ]).map((suggestion) => (
                                        <button
                                            key={suggestion}
                                            type="button"
                                            onClick={() => handleSend(suggestion)}
                                            className={`rounded-full border px-4 py-2 text-sm transition-colors active:scale-95 ${
                                                mode === 'wild'
                                                    ? 'border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20'
                                                    : 'border-border bg-secondary text-foreground hover:bg-secondary/80'
                                            }`}
                                        >
                                            {suggestion}
                                        </button>
                                    ))}
                                </div>
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
