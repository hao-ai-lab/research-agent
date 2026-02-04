'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import {
    listSessions,
    createSession,
    getSession,
    deleteSession,
    streamChat,
    checkApiHealth,
    type ChatSession,
    type ChatMessageData,
    type StreamEvent,
} from '@/lib/api'
import type { ChatMode } from '@/components/chat-input'

export interface ToolCallState {
    id: string
    name?: string
    state: 'pending' | 'running' | 'completed' | 'error'
}

export interface StreamingState {
    isStreaming: boolean
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
    createNewSession: () => Promise<void>
    selectSession: (sessionId: string) => Promise<void>
    removeSession: (sessionId: string) => Promise<void>
    refreshSessions: () => Promise<void>

    // Messages
    messages: ChatMessageData[]

    // Streaming state for current response
    streamingState: StreamingState

    // Send message
    sendMessage: (content: string, mode: ChatMode) => Promise<void>
}

const initialStreamingState: StreamingState = {
    isStreaming: false,
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

    // Create new session
    const createNewSession = useCallback(async () => {
        try {
            setError(null)
            const newSession = await createSession()
            setSessions(prev => [newSession, ...prev])
            setCurrentSessionId(newSession.id)
            setMessages([])
            setStreamingState(initialStreamingState)
        } catch (err) {
            console.error('Failed to create session:', err)
            setError(err instanceof Error ? err.message : 'Failed to create session')
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

    // Send a message
    const sendMessage = useCallback(async (content: string, mode: ChatMode) => {
        if (!currentSessionId) {
            setError('No active session. Please create or select a chat.')
            return
        }

        if (streamingState.isStreaming) {
            return // Already streaming
        }

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

            for await (const event of streamChat(currentSessionId, content, wildMode)) {
                if (event.type === 'part_delta') {
                    if (event.ptype === 'text') {
                        finalText += event.delta || ''
                        setStreamingState(prev => ({
                            ...prev,
                            textContent: prev.textContent + (event.delta || ''),
                        }))
                    } else if (event.ptype === 'reasoning') {
                        finalThinking += event.delta || ''
                        setStreamingState(prev => ({
                            ...prev,
                            thinkingContent: prev.thinkingContent + (event.delta || ''),
                        }))
                    }
                } else if (event.type === 'part_update' && event.ptype === 'tool') {
                    setStreamingState(prev => {
                        const existingIndex = prev.toolCalls.findIndex(t => t.id === event.id)
                        // Handle event.state being either a string or an object with a status property
                        let stateValue: 'pending' | 'running' | 'completed' | 'error' = 'pending'
                        if (typeof event.state === 'string') {
                            stateValue = event.state as 'pending' | 'running' | 'completed' | 'error'
                        } else if (event.state && typeof event.state === 'object' && 'status' in event.state) {
                            stateValue = (event.state as { status: string }).status as 'pending' | 'running' | 'completed' | 'error'
                        }
                        const toolState: ToolCallState = {
                            id: event.id || '',
                            name: event.name,
                            state: stateValue,
                        }
                        if (existingIndex >= 0) {
                            const newCalls = [...prev.toolCalls]
                            newCalls[existingIndex] = toolState
                            return { ...prev, toolCalls: newCalls }
                        }
                        return { ...prev, toolCalls: [...prev.toolCalls, toolState] }
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
            console.error('Failed to send message:', err)
            setError(err instanceof Error ? err.message : 'Failed to send message')
        } finally {
            setStreamingState(initialStreamingState)
            abortControllerRef.current = null
        }
    }, [currentSessionId, streamingState.isStreaming, refreshSessions])

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
    }
}
