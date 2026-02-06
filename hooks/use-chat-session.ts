'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import {
    listSessions,
    createSession,
    getSession,
    deleteSession,
    streamChat,
    checkApiHealth,
    stopSession,
    type ChatSession,
    type ChatMessageData,
    type StreamEvent,
} from '@/lib/api-client'
import type { ChatMode } from '@/components/chat-input'

export interface ToolCallState {
    id: string
    name?: string
    description?: string
    state: 'pending' | 'running' | 'completed' | 'error'
}

// Represents a single part during streaming (thinking, tool, or text)
export interface StreamingPart {
    id: string
    type: 'thinking' | 'tool' | 'text'
    content: string
    toolName?: string
    toolDescription?: string
    toolState?: 'pending' | 'running' | 'completed' | 'error'
}

export interface StreamingState {
    isStreaming: boolean
    parts: StreamingPart[]  // NEW: ordered array of parts
    // Legacy fields for backward compat
    thinkingContent: string
    textContent: string
    toolCalls: ToolCallState[]
}

export interface UseChatSessionResult {
    // Connection state
    isConnected: boolean
    isLoading: boolean
    error: string | null

    // Session management
    sessions: ChatSession[]
    currentSessionId: string | null
    currentSession: ChatSession | null
    createNewSession: () => Promise<string | null>
    selectSession: (sessionId: string) => Promise<void>
    removeSession: (sessionId: string) => Promise<void>
    refreshSessions: () => Promise<void>

    // Messages
    messages: ChatMessageData[]

    // Streaming state for current response
    streamingState: StreamingState

    // Send message - optional sessionId override for newly created sessions
    sendMessage: (content: string, mode: ChatMode, sessionIdOverride?: string) => Promise<void>
    stopStreaming: () => Promise<void>

    // Message queue - for queuing messages during streaming
    messageQueue: string[]
    queueMessage: (content: string) => void
    removeFromQueue: (index: number) => void
    clearQueue: () => void
}

const initialStreamingState: StreamingState = {
    isStreaming: false,
    parts: [],
    thinkingContent: '',
    textContent: '',
    toolCalls: [],
}

export function useChatSession(): UseChatSessionResult {
    // Connection state
    const [isConnected, setIsConnected] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Session state
    const [sessions, setSessions] = useState<ChatSession[]>([])
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
    const [messages, setMessages] = useState<ChatMessageData[]>([])

    // Streaming state
    const [streamingState, setStreamingState] = useState<StreamingState>(initialStreamingState)

    // Message queue for queuing messages during streaming
    const [messageQueue, setMessageQueue] = useState<string[]>([])
    const currentModeRef = useRef<ChatMode>('agent')

    // Abort controller for cancelling streams
    const abortControllerRef = useRef<AbortController | null>(null)

    // Get current session object
    const currentSession = sessions.find(s => s.id === currentSessionId) || null

    // Check API connection on mount
    useEffect(() => {
        const checkConnection = async () => {
            const healthy = await checkApiHealth()
            setIsConnected(healthy)
            if (!healthy) {
                setError('Cannot connect to backend server at localhost:10000')
            }
            setIsLoading(false)
        }
        checkConnection()
    }, [])

    // Refresh sessions list
    const refreshSessions = useCallback(async () => {
        try {
            const sessionList = await listSessions()
            setSessions(sessionList)
        } catch (err) {
            console.error('Failed to refresh sessions:', err)
            setError(err instanceof Error ? err.message : 'Failed to load sessions')
        }
    }, [])

    // Load sessions on mount (after connection check)
    useEffect(() => {
        if (isConnected) {
            refreshSessions()
        }
    }, [isConnected, refreshSessions])

    // Create new session - returns the new session ID
    const createNewSession = useCallback(async (): Promise<string | null> => {
        try {
            setError(null)
            const newSession = await createSession()
            setSessions(prev => [newSession, ...prev])
            setCurrentSessionId(newSession.id)
            setMessages([])
            setStreamingState(initialStreamingState)
            return newSession.id
        } catch (err) {
            console.error('Failed to create session:', err)
            setError(err instanceof Error ? err.message : 'Failed to create session')
            return null
        }
    }, [])

    // Select a session
    const selectSession = useCallback(async (sessionId: string) => {
        try {
            setError(null)
            setIsLoading(true)

            // Cancel any ongoing stream
            if (abortControllerRef.current) {
                abortControllerRef.current.abort()
            }

            const sessionData = await getSession(sessionId)
            setCurrentSessionId(sessionId)
            setMessages(sessionData.messages)
            setStreamingState(initialStreamingState)
        } catch (err) {
            console.error('Failed to select session:', err)
            setError(err instanceof Error ? err.message : 'Failed to load session')
        } finally {
            setIsLoading(false)
        }
    }, [])

    // Delete a session
    const removeSession = useCallback(async (sessionId: string) => {
        try {
            setError(null)
            await deleteSession(sessionId)
            setSessions(prev => prev.filter(s => s.id !== sessionId))

            // If we deleted the current session, clear state
            if (sessionId === currentSessionId) {
                setCurrentSessionId(null)
                setMessages([])
                setStreamingState(initialStreamingState)
            }
        } catch (err) {
            console.error('Failed to delete session:', err)
            setError(err instanceof Error ? err.message : 'Failed to delete session')
        }
    }, [currentSessionId])

    // Send a message - accepts optional sessionIdOverride for newly created sessions
    const sendMessage = useCallback(async (content: string, mode: ChatMode, sessionIdOverride?: string) => {
        const targetSessionId = sessionIdOverride || currentSessionId
        if (!targetSessionId) {
            setError('No active session. Please create or select a chat.')
            return
        }

        if (streamingState.isStreaming) {
            return // Already streaming
        }

        // Track the current mode for queued messages
        currentModeRef.current = mode

        try {
            setError(null)

            // Add user message immediately
            const userMessage: ChatMessageData = {
                role: 'user',
                content,
                timestamp: Date.now() / 1000,
            }
            setMessages(prev => [...prev, userMessage])

            // Start streaming state
            setStreamingState({
                isStreaming: true,
                parts: [],
                thinkingContent: '',
                textContent: '',
                toolCalls: [],
            })

            // Create abort controller
            abortControllerRef.current = new AbortController()

            // Stream the response
            const wildMode = mode === 'wild'
            let finalText = ''
            let finalThinking = ''

            // Helper to parse tool state from event
            const parseToolState = (state: unknown): 'pending' | 'running' | 'completed' | 'error' => {
                if (typeof state === 'string') {
                    return state as 'pending' | 'running' | 'completed' | 'error'
                }
                if (state && typeof state === 'object' && 'status' in state) {
                    return (state as { status: string }).status as 'pending' | 'running' | 'completed' | 'error'
                }
                return 'pending'
            }

            for await (const event of streamChat(targetSessionId, content, wildMode, abortControllerRef.current.signal)) {
                const partId = event.id

                if (event.type === 'part_delta') {
                    const delta = event.delta || ''
                    const partType = event.ptype === 'reasoning' ? 'thinking' : 'text'

                    // Update legacy fields
                    if (event.ptype === 'text') {
                        finalText += delta
                    } else if (event.ptype === 'reasoning') {
                        finalThinking += delta
                    }

                    setStreamingState(prev => {
                        // Update legacy fields
                        const legacyUpdate = event.ptype === 'text'
                            ? { textContent: prev.textContent + delta }
                            : event.ptype === 'reasoning'
                            ? { thinkingContent: prev.thinkingContent + delta }
                            : {}

                        // Update parts array by ID
                        if (!partId) {
                            return { ...prev, ...legacyUpdate }
                        }

                        const existingIndex = prev.parts.findIndex(p => p.id === partId)
                        if (existingIndex >= 0) {
                            // Append to existing part
                            const updatedParts = [...prev.parts]
                            updatedParts[existingIndex] = {
                                ...updatedParts[existingIndex],
                                content: updatedParts[existingIndex].content + delta,
                            }
                            return { ...prev, ...legacyUpdate, parts: updatedParts }
                        } else {
                            // Create new part
                            return {
                                ...prev,
                                ...legacyUpdate,
                                parts: [...prev.parts, { id: partId, type: partType, content: delta }],
                            }
                        }
                    })
                } else if (event.type === 'part_update' && event.ptype === 'tool') {
                    const stateValue = parseToolState(event.state)
                    
                    // Extract description from event.state.input.description or event.state.title
                    let toolDescription: string | undefined
                    if (event.state && typeof event.state === 'object') {
                        const state = event.state as Record<string, unknown>
                        if (state.input && typeof state.input === 'object') {
                            const input = state.input as Record<string, unknown>
                            toolDescription = (input.description as string) || (input.title as string)
                        }
                        if (!toolDescription && state.title) {
                            toolDescription = state.title as string
                        }
                    }

                    setStreamingState(prev => {
                        // Update legacy toolCalls
                        const existingToolIndex = prev.toolCalls.findIndex(t => t.id === event.id)
                        const toolState: ToolCallState = {
                            id: event.id || '',
                            name: event.name,
                            description: toolDescription,
                            state: stateValue,
                        }
                        const newToolCalls = existingToolIndex >= 0
                            ? prev.toolCalls.map((t, i) => i === existingToolIndex ? toolState : t)
                            : [...prev.toolCalls, toolState]

                        // Update parts array
                        if (!partId) {
                            return { ...prev, toolCalls: newToolCalls }
                        }

                        const existingPartIndex = prev.parts.findIndex(p => p.id === partId)
                        if (existingPartIndex >= 0) {
                            // Update existing tool part
                            const updatedParts = [...prev.parts]
                            updatedParts[existingPartIndex] = {
                                ...updatedParts[existingPartIndex],
                                toolState: stateValue,
                                toolName: event.name || updatedParts[existingPartIndex].toolName,
                                toolDescription: toolDescription || updatedParts[existingPartIndex].toolDescription,
                            }
                            return { ...prev, toolCalls: newToolCalls, parts: updatedParts }
                        } else {
                            // Create new tool part
                            return {
                                ...prev,
                                toolCalls: newToolCalls,
                                parts: [...prev.parts, {
                                    id: partId,
                                    type: 'tool' as const,
                                    content: '',
                                    toolName: event.name,
                                    toolDescription: toolDescription,
                                    toolState: stateValue,
                                }],
                            }
                        }
                    })
                } else if (event.type === 'session_status' && event.status === 'idle') {
                    // Stream complete
                    break
                } else if (event.type === 'error') {
                    setError(event.message || 'Stream error')
                    break
                }
            }

            // Add assistant message to history
            if (finalText || finalThinking) {
                const assistantMessage: ChatMessageData = {
                    role: 'assistant',
                    content: finalText.trim(),
                    thinking: finalThinking.trim() || null,
                    timestamp: Date.now() / 1000,
                }
                setMessages(prev => [...prev, assistantMessage])

                // Update session in list (for message count, title may have changed)
                await refreshSessions()
            }

        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                // User-initiated stop
            } else {
                console.error('Failed to send message:', err)
                setError(err instanceof Error ? err.message : 'Failed to send message')
            }
        } finally {
            setStreamingState(initialStreamingState)
            abortControllerRef.current = null
        }
    }, [currentSessionId, streamingState.isStreaming, refreshSessions])

    const stopStreaming = useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }
        if (currentSessionId) {
            try {
                await stopSession(currentSessionId)
            } catch (err) {
                console.error('Failed to stop session:', err)
            }
        }
        setStreamingState(initialStreamingState)
    }, [currentSessionId])

    // Queue functions
    const queueMessage = useCallback((content: string) => {
        if (content.trim()) {
            setMessageQueue(prev => [...prev, content.trim()])
        }
    }, [])

    const clearQueue = useCallback(() => {
        setMessageQueue([])
    }, [])

    const removeFromQueue = useCallback((index: number) => {
        setMessageQueue(prev => prev.filter((_, i) => i !== index))
    }, [])

    // Process queue when streaming ends
    useEffect(() => {
        if (!streamingState.isStreaming && messageQueue.length > 0 && currentSessionId) {
            const nextMessage = messageQueue[0]
            setMessageQueue(prev => prev.slice(1))
            // Send the next queued message with the current mode
            sendMessage(nextMessage, currentModeRef.current, currentSessionId)
        }
    }, [streamingState.isStreaming, messageQueue, currentSessionId, sendMessage])

    return {
        isConnected,
        isLoading,
        error,
        sessions,
        currentSessionId,
        currentSession,
        createNewSession,
        selectSession,
        removeSession,
        refreshSessions,
        messages,
        streamingState,
        sendMessage,
        stopStreaming,
        messageQueue,
        queueMessage,
        removeFromQueue,
        clearQueue,
    }
}
