'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import {
    listSessions,
    createSession,
    getSession,
    deleteSession,
    streamChat,
    streamSession,
    checkApiHealth,
    stopSession,
    type ChatSession,
    type ActiveSessionStream,
    type ChatMessageData,
    type StreamEvent,
} from '@/lib/api-client'
import type { MessagePartData } from '@/lib/api'
import type { ChatMode } from '@/components/chat-input'

export interface ToolCallState {
    id: string
    name?: string
    description?: string
    state: 'pending' | 'running' | 'completed' | 'error' | string
    input?: string
    output?: string
    startedAt?: number
    endedAt?: number
    durationMs?: number
}

// Represents a single part during streaming (thinking, tool, or text)
export interface StreamingPart {
    id: string
    sourceId?: string
    type: 'thinking' | 'tool' | 'text'
    content: string
    toolName?: string
    toolDescription?: string
    toolState?: 'pending' | 'running' | 'completed' | 'error' | string
    toolStateRaw?: unknown
    toolInput?: string
    toolOutput?: string
    toolStartedAt?: number
    toolEndedAt?: number
    toolDurationMs?: number
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
    savedSessionIds: string[]
    currentSessionId: string | null
    currentSession: ChatSession | null
    createNewSession: () => Promise<string | null>
    startNewChat: () => void  
    selectSession: (sessionId: string) => Promise<void>
    saveSession: (sessionId: string) => Promise<void>
    unsaveSession: (sessionId: string) => Promise<void>
    archiveSession: (sessionId: string) => Promise<void>
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

const STORAGE_KEY_ARCHIVED_CHAT_SESSIONS = 'archivedChatSessionIds'
const STORAGE_KEY_SAVED_CHAT_SESSIONS = 'savedChatSessionIds'

function readArchivedSessionIds(): string[] {
    if (typeof window === 'undefined') return []

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY_ARCHIVED_CHAT_SESSIONS)
        if (!raw) return []

        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []

        return parsed.filter((id): id is string => typeof id === 'string')
    } catch {
        return []
    }
}

function readSavedSessionIds(): string[] {
    if (typeof window === 'undefined') return []

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY_SAVED_CHAT_SESSIONS)
        if (!raw) return []

        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []

        return parsed.filter((id): id is string => typeof id === 'string')
    } catch {
        return []
    }
}

function parseDevelopCommand(content: string): string | null {
    const trimmed = content.trim()
    const match = trimmed.match(/^\/develop(?:ment)?(?:\s+([\s\S]*))?$/i)
    if (!match) return null

    const payload = (match[1] ?? '').trim()
    if (!payload) {
        return 'Usage: /develop <text>'
    }
    return payload
}

type ToolStatus = 'pending' | 'running' | 'completed' | 'error'

const TOOL_STATUS_SET = new Set<ToolStatus>(['pending', 'running', 'completed', 'error'])

function normalizeToolStatus(value: unknown): ToolStatus {
    if (typeof value === 'string') {
        const normalized = value.toLowerCase() as ToolStatus
        if (TOOL_STATUS_SET.has(normalized)) return normalized
    }
    if (value && typeof value === 'object' && 'status' in value) {
        return normalizeToolStatus((value as { status?: unknown }).status)
    }
    return 'pending'
}

function stringifyToolPayload(value: unknown): string | undefined {
    if (value == null) return undefined
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined
    return value
}

function extractToolDetails(source: {
    state?: unknown
    toolInput?: string
    toolOutput?: string
    toolStartedAt?: number
    toolEndedAt?: number
    toolDurationMs?: number
}) {
    const stateObj = source.state && typeof source.state === 'object'
        ? source.state as Record<string, unknown>
        : {}
    const inputObj = stateObj.input && typeof stateObj.input === 'object'
        ? stateObj.input as Record<string, unknown>
        : {}
    const metadataObj = stateObj.metadata && typeof stateObj.metadata === 'object'
        ? stateObj.metadata as Record<string, unknown>
        : {}
    const timeObj = stateObj.time && typeof stateObj.time === 'object'
        ? stateObj.time as Record<string, unknown>
        : {}

    const description = (
        (typeof inputObj.description === 'string' && inputObj.description) ||
        (typeof inputObj.title === 'string' && inputObj.title) ||
        (typeof stateObj.title === 'string' && stateObj.title) ||
        undefined
    )

    const toolInput = source.toolInput ?? stringifyToolPayload(Object.keys(inputObj).length > 0 ? inputObj : undefined)
    const outputCandidate = source.toolOutput ?? stringifyToolPayload(stateObj.output ?? metadataObj.output)
    const startedAt = source.toolStartedAt ?? normalizeTimestamp(timeObj.start)
    const endedAt = source.toolEndedAt ?? normalizeTimestamp(timeObj.end)
    const durationMs = source.toolDurationMs ?? (
        startedAt != null && endedAt != null && endedAt >= startedAt
            ? Math.round(endedAt - startedAt)
            : undefined
    )

    return {
        description,
        toolInput: toolInput || undefined,
        toolOutput: outputCandidate || undefined,
        toolStartedAt: startedAt,
        toolEndedAt: endedAt,
        toolDurationMs: durationMs,
    }
}

function normalizeToolPart(part: MessagePartData, index: number): MessagePartData {
    const rawState = (part as { tool_state_raw?: unknown }).tool_state_raw ??
        ((part as { tool_state?: unknown }).tool_state && typeof (part as { tool_state?: unknown }).tool_state === 'object'
            ? (part as { tool_state?: unknown }).tool_state
            : undefined)
    const details = extractToolDetails({
        state: rawState,
        toolInput: part.tool_input,
        toolOutput: part.tool_output,
        toolStartedAt: part.tool_started_at,
        toolEndedAt: part.tool_ended_at,
        toolDurationMs: part.tool_duration_ms,
    })

    const id = typeof part.id === 'string' && part.id ? part.id : `tool-${index}`
    return {
        ...part,
        id,
        tool_state: normalizeToolStatus(part.tool_state ?? rawState),
        tool_state_raw: rawState,
        tool_input: details.toolInput,
        tool_output: details.toolOutput,
        tool_started_at: details.toolStartedAt,
        tool_ended_at: details.toolEndedAt,
        tool_duration_ms: details.toolDurationMs,
    }
}

function normalizeMessage(message: ChatMessageData): ChatMessageData {
    if (!message.parts || message.parts.length === 0) return message

    const seenIds = new Map<string, number>()
    const normalizedParts = message.parts.map((part: MessagePartData, index) => {
        const basePart = part.type === 'tool' ? normalizeToolPart(part, index) : {
            ...part,
            id: typeof part.id === 'string' && part.id ? part.id : `${part.type}-${index}`,
            content: part.content ?? '',
        }
        const count = seenIds.get(basePart.id) ?? 0
        seenIds.set(basePart.id, count + 1)
        if (count === 0) {
            return basePart
        }
        return {
            ...basePart,
            id: `${basePart.id}#${count}`,
        }
    })

    return {
        ...message,
        parts: normalizedParts,
    }
}

function upsertStreamingDeltaPart(
    parts: StreamingPart[],
    partId: string | undefined,
    type: 'thinking' | 'text',
    delta: string
): StreamingPart[] {
    if (!delta) return parts
    const sourceId = partId || `${type}-${parts.length}`
    const last = parts[parts.length - 1]
    if (last && last.type === type && (last.sourceId ?? last.id) === sourceId) {
        const updated = [...parts]
        updated[updated.length - 1] = {
            ...last,
            content: last.content + delta,
        }
        return updated
    }

    const segmentCount = parts.filter((p) => (p.sourceId ?? p.id) === sourceId && p.type === type).length
    const id = segmentCount === 0 ? sourceId : `${sourceId}#${segmentCount}`
    return [...parts, { id, sourceId, type, content: delta }]
}

function baseSourceId(partId: string): string {
    const hashIndex = partId.indexOf('#')
    return hashIndex >= 0 ? partId.slice(0, hashIndex) : partId
}

function normalizeActiveStreamParts(parts: MessagePartData[] | null | undefined): MessagePartData[] {
    if (!parts || parts.length === 0) return []
    const normalized = normalizeMessage({
        role: 'assistant',
        content: '',
        timestamp: 0,
        parts,
    })
    return normalized.parts || []
}

function messagePartToStreamingPart(part: MessagePartData): StreamingPart {
    const sourceId = baseSourceId(part.id)
    if (part.type === 'tool') {
        const details = extractToolDetails({
            state: part.tool_state_raw,
            toolInput: part.tool_input,
            toolOutput: part.tool_output,
            toolStartedAt: part.tool_started_at,
            toolEndedAt: part.tool_ended_at,
            toolDurationMs: part.tool_duration_ms,
        })
        return {
            id: part.id,
            sourceId,
            type: 'tool',
            content: '',
            toolName: part.tool_name,
            toolState: normalizeToolStatus(part.tool_state ?? part.tool_state_raw),
            toolStateRaw: part.tool_state_raw,
            toolInput: details.toolInput,
            toolOutput: details.toolOutput,
            toolStartedAt: details.toolStartedAt,
            toolEndedAt: details.toolEndedAt,
            toolDurationMs: details.toolDurationMs,
            toolDescription: details.description,
        }
    }

    return {
        id: part.id,
        sourceId,
        type: part.type === 'thinking' ? 'thinking' : 'text',
        content: part.content || '',
    }
}

function buildToolCallsFromStreamingParts(parts: StreamingPart[]): ToolCallState[] {
    const byId = new Map<string, ToolCallState>()
    for (const part of parts) {
        if (part.type !== 'tool') continue
        const toolId = part.sourceId || part.id
        byId.set(toolId, {
            id: toolId,
            name: part.toolName,
            description: part.toolDescription,
            state: part.toolState || 'pending',
            input: part.toolInput,
            output: part.toolOutput,
            startedAt: part.toolStartedAt,
            endedAt: part.toolEndedAt,
            durationMs: part.toolDurationMs,
        })
    }
    return Array.from(byId.values())
}

function buildStreamingStateFromActiveStream(activeStream: ActiveSessionStream): StreamingState {
    const normalizedParts = normalizeActiveStreamParts(activeStream.parts)
    const parts = normalizedParts.map(messagePartToStreamingPart)
    const textContent = typeof activeStream.text === 'string' ? activeStream.text : ''
    const thinkingContent = typeof activeStream.thinking === 'string' ? activeStream.thinking : ''

    if (parts.length === 0) {
        if (thinkingContent) {
            parts.push({
                id: 'thinking-replay',
                sourceId: 'thinking-replay',
                type: 'thinking',
                content: thinkingContent,
            })
        }
        if (textContent) {
            parts.push({
                id: 'text-replay',
                sourceId: 'text-replay',
                type: 'text',
                content: textContent,
            })
        }
    }

    return {
        isStreaming: activeStream.status === 'running',
        parts,
        thinkingContent,
        textContent,
        toolCalls: buildToolCallsFromStreamingParts(parts),
    }
}

export function useChatSession(): UseChatSessionResult {
    // Connection state
    const [isConnected, setIsConnected] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Session state
    const [sessions, setSessions] = useState<ChatSession[]>([])
    const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>(() => readArchivedSessionIds())
    const [savedSessionIds, setSavedSessionIds] = useState<string[]>(() => readSavedSessionIds())
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

    const processStreamEvent = useCallback((event: StreamEvent) => {
        const partId = event.id

        if (event.type === 'part_delta') {
            const delta = event.delta || ''
            if (!delta) {
                return { textDelta: '', thinkingDelta: '', sawToolPart: false, done: false }
            }
            const partType = event.ptype === 'reasoning' ? 'thinking' : 'text'

            setStreamingState(prev => {
                const legacyUpdate = event.ptype === 'text'
                    ? { textContent: prev.textContent + delta }
                    : event.ptype === 'reasoning'
                    ? { thinkingContent: prev.thinkingContent + delta }
                    : {}

                return {
                    ...prev,
                    ...legacyUpdate,
                    parts: upsertStreamingDeltaPart(prev.parts, partId, partType, delta),
                }
            })

            return {
                textDelta: event.ptype === 'text' ? delta : '',
                thinkingDelta: event.ptype === 'reasoning' ? delta : '',
                sawToolPart: false,
                done: false,
            }
        }

        if (event.type === 'part_update' && event.ptype === 'tool') {
            const stateValue = normalizeToolStatus(event.tool_status ?? event.state)
            const details = extractToolDetails({
                state: event.state,
                toolInput: event.tool_input,
                toolOutput: event.tool_output,
                toolStartedAt: event.tool_started_at,
                toolEndedAt: event.tool_ended_at,
                toolDurationMs: event.tool_duration_ms,
            })

            setStreamingState(prev => {
                const toolId = event.id || `tool-${prev.toolCalls.length}`
                const existingToolIndex = prev.toolCalls.findIndex(t => t.id === toolId)
                const toolState: ToolCallState = {
                    id: toolId,
                    name: event.name,
                    description: details.description,
                    state: stateValue,
                    input: details.toolInput,
                    output: details.toolOutput,
                    startedAt: details.toolStartedAt,
                    endedAt: details.toolEndedAt,
                    durationMs: details.toolDurationMs,
                }
                const newToolCalls = existingToolIndex >= 0
                    ? prev.toolCalls.map((t, i) => i === existingToolIndex ? toolState : t)
                    : [...prev.toolCalls, toolState]

                const sourceId = partId || toolId
                const existingPartIndex = prev.parts.findIndex(p => p.type === 'tool' && (p.sourceId ?? p.id) === sourceId)
                if (existingPartIndex >= 0) {
                    const updatedParts = [...prev.parts]
                    updatedParts[existingPartIndex] = {
                        ...updatedParts[existingPartIndex],
                        toolState: stateValue,
                        toolStateRaw: event.state,
                        toolName: event.name || updatedParts[existingPartIndex].toolName,
                        toolDescription: details.description || updatedParts[existingPartIndex].toolDescription,
                        toolInput: details.toolInput,
                        toolOutput: details.toolOutput,
                        toolStartedAt: details.toolStartedAt,
                        toolEndedAt: details.toolEndedAt,
                        toolDurationMs: details.toolDurationMs,
                    }
                    return { ...prev, toolCalls: newToolCalls, parts: updatedParts }
                }

                const segmentCount = prev.parts.filter((p) => (p.sourceId ?? p.id) === sourceId && p.type === 'tool').length
                const partSegmentId = segmentCount === 0 ? sourceId : `${sourceId}#${segmentCount}`
                return {
                    ...prev,
                    toolCalls: newToolCalls,
                    parts: [...prev.parts, {
                        id: partSegmentId,
                        sourceId,
                        type: 'tool' as const,
                        content: '',
                        toolName: event.name,
                        toolDescription: details.description,
                        toolState: stateValue,
                        toolStateRaw: event.state,
                        toolInput: details.toolInput,
                        toolOutput: details.toolOutput,
                        toolStartedAt: details.toolStartedAt,
                        toolEndedAt: details.toolEndedAt,
                        toolDurationMs: details.toolDurationMs,
                    }],
                }
            })

            return { textDelta: '', thinkingDelta: '', sawToolPart: true, done: false }
        }

        if (event.type === 'error') {
            setError(event.message || 'Stream error')
            return { textDelta: '', thinkingDelta: '', sawToolPart: false, done: true }
        }

        if (event.type === 'session_status' && event.status === 'idle') {
            return { textDelta: '', thinkingDelta: '', sawToolPart: false, done: true }
        }

        return { textDelta: '', thinkingDelta: '', sawToolPart: false, done: false }
    }, [])

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
            const archivedSet = new Set(archivedSessionIds)
            setSessions(sessionList.filter((session) => !archivedSet.has(session.id)))
        } catch (err) {
            console.error('Failed to refresh sessions:', err)
            setError(err instanceof Error ? err.message : 'Failed to load sessions')
        }
    }, [archivedSessionIds])

    const attachToExistingStream = useCallback((sessionId: string, activeStream: ActiveSessionStream) => {
        if (activeStream.status !== 'running') {
            return
        }

        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }

        const snapshotState = buildStreamingStateFromActiveStream(activeStream)
        setStreamingState(snapshotState)

        const controller = new AbortController()
        abortControllerRef.current = controller

        void (async () => {
            let finalText = snapshotState.textContent
            let finalThinking = snapshotState.thinkingContent
            let sawToolPart = snapshotState.toolCalls.length > 0

            try {
                const fromSeq = Math.max(1, Math.floor((activeStream.sequence || 0) + 1))
                for await (const event of streamSession(sessionId, fromSeq, controller.signal, activeStream.run_id)) {
                    const update = processStreamEvent(event)
                    finalText += update.textDelta
                    finalThinking += update.thinkingDelta
                    if (update.sawToolPart) sawToolPart = true
                    if (update.done) break
                }

                if (finalText || finalThinking || sawToolPart) {
                    const sessionData = await getSession(sessionId)
                    setMessages(sessionData.messages.map(normalizeMessage))
                    await refreshSessions()
                }
            } catch (err) {
                if (!(err instanceof DOMException && err.name === 'AbortError')) {
                    console.error('Failed to resume session stream:', err)
                    setError(err instanceof Error ? err.message : 'Failed to resume session stream')
                }
            } finally {
                if (abortControllerRef.current === controller) {
                    abortControllerRef.current = null
                    setStreamingState(initialStreamingState)
                }
            }
        })()
    }, [processStreamEvent, refreshSessions])

    // Load sessions on mount (after connection check)
    useEffect(() => {
        if (isConnected) {
            refreshSessions()
        }
    }, [isConnected, refreshSessions])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            STORAGE_KEY_ARCHIVED_CHAT_SESSIONS,
            JSON.stringify(archivedSessionIds)
        )
    }, [archivedSessionIds])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(
            STORAGE_KEY_SAVED_CHAT_SESSIONS,
            JSON.stringify(savedSessionIds)
        )
    }, [savedSessionIds])

    // Create new session - returns the new session ID
    const createNewSession = useCallback(async (): Promise<string | null> => {
        try {
            setError(null)
            const newSession = await createSession()
            setArchivedSessionIds((prev) => prev.filter((id) => id !== newSession.id))
            setSessions(prev => [newSession, ...prev.filter((session) => session.id !== newSession.id)])
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

    // Start new chat - clears current session without creating backend session
    // Session will be created when user sends first message
    const startNewChat = useCallback(() => {
        // Cancel any ongoing stream
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
        }
        setError(null)
        setCurrentSessionId(null)
        setMessages([])
        setStreamingState(initialStreamingState)
    }, [])

    // Select a session
    const selectSession = useCallback(async (sessionId: string) => {
        if (archivedSessionIds.includes(sessionId)) {
            setError('This chat is archived.')
            return
        }

        try {
            setError(null)
            setIsLoading(true)

            // Cancel any ongoing stream
            if (abortControllerRef.current) {
                abortControllerRef.current.abort()
            }

            const sessionData = await getSession(sessionId)
            setCurrentSessionId(sessionId)
            setMessages(sessionData.messages.map(normalizeMessage))
            const activeStream = sessionData.active_stream
            if (activeStream && activeStream.status === 'running') {
                attachToExistingStream(sessionId, activeStream)
            } else {
                setStreamingState(initialStreamingState)
            }
        } catch (err) {
            console.error('Failed to select session:', err)
            setError(err instanceof Error ? err.message : 'Failed to load session')
        } finally {
            setIsLoading(false)
        }
    }, [archivedSessionIds, attachToExistingStream])

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

    // Archive a session client-side (keeps backend data intact)
    const archiveSession = useCallback(async (sessionId: string) => {
        setError(null)

        if (sessionId === currentSessionId && abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
        }

        setArchivedSessionIds((prev) => (
            prev.includes(sessionId) ? prev : [...prev, sessionId]
        ))
        setSavedSessionIds((prev) => prev.filter((id) => id !== sessionId))
        setSessions((prev) => prev.filter((session) => session.id !== sessionId))

        if (sessionId === currentSessionId) {
            setCurrentSessionId(null)
            setMessages([])
            setStreamingState(initialStreamingState)
        }
    }, [currentSessionId])

    const saveSession = useCallback(async (sessionId: string) => {
        setError(null)
        setSavedSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]))
    }, [])

    const unsaveSession = useCallback(async (sessionId: string) => {
        setError(null)
        setSavedSessionIds((prev) => prev.filter((id) => id !== sessionId))
    }, [])

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

        const developEcho = parseDevelopCommand(content)
        if (developEcho !== null) {
            setError(null)
            const timestamp = Date.now() / 1000

            const userMessage: ChatMessageData = {
                role: 'user',
                content,
                timestamp,
            }

            const assistantMessage: ChatMessageData = {
                role: 'assistant',
                content: developEcho,
                timestamp: Date.now() / 1000,
            }

            setMessages(prev => [...prev, userMessage, assistantMessage])
            return
        }

        // Track accumulated text/thinking outside try so catch can access them
        let finalText = ''
        let finalThinking = ''
        let sawToolPart = false
        let streamController: AbortController | null = null

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
            streamController = new AbortController()
            abortControllerRef.current = streamController

            // Stream inactivity timeout: abort if no events for 60s (prevents stuck streams)
            // Note: OpenCode can take 30-40s to start responding, so 60s is the minimum safe value
            let lastEventTime = Date.now()
            const streamTimeoutId = setInterval(() => {
                const elapsed = Date.now() - lastEventTime
                if (elapsed > 60_000) {
                    console.warn(`[chat-session] Stream inactivity timeout (${Math.round(elapsed/1000)}s), aborting`)
                    streamController?.abort()
                }
            }, 5_000)

            try {
            for await (const event of streamChat(targetSessionId, content, mode, streamController!.signal)) {
                lastEventTime = Date.now()

                // Debug logging for stream events
                if (event.type === 'session_status' || event.type === 'error') {
                    console.log(`[chat-session] Stream event: ${event.type}`, event)
                }

                const update = processStreamEvent(event)
                finalText += update.textDelta
                finalThinking += update.thinkingDelta
                if (update.sawToolPart) {
                    sawToolPart = true
                }
                if (update.done) {
                    break
                }
            }
            } finally {
                clearInterval(streamTimeoutId)
            }

            // Sync from backend so persisted ordered parts are reflected exactly
            if (finalText || finalThinking || sawToolPart) {
                const sessionData = await getSession(targetSessionId)
                setMessages(sessionData.messages.map(normalizeMessage))
                await refreshSessions()
            }

        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                // User-initiated stop: reload from backend to capture any partial persisted assistant message.
                try {
                    const sessionData = await getSession(targetSessionId)
                    setMessages(sessionData.messages.map(normalizeMessage))
                } catch (syncErr) {
                    console.warn('Failed to sync session after abort:', syncErr)
                }
            } else {
                console.error('Failed to send message:', err)
                setError(err instanceof Error ? err.message : 'Failed to send message')
            }
        } finally {
            if (streamController && abortControllerRef.current === streamController) {
                abortControllerRef.current = null
                setStreamingState(initialStreamingState)
            }
        }
    }, [currentSessionId, streamingState.isStreaming, refreshSessions, processStreamEvent])

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
        savedSessionIds,
        currentSessionId,
        currentSession,
        createNewSession,
        startNewChat,
        selectSession,
        saveSession,
        unsaveSession,
        archiveSession,
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
