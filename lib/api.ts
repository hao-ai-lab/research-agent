'use client'

// API Configuration
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:10000'

// Types
export interface ChatSession {
    id: string
    title: string
    created_at: number
    message_count: number
}

export interface ChatMessageData {
    role: 'user' | 'assistant'
    content: string
    thinking?: string | null
    timestamp: number
}

export interface SessionWithMessages extends ChatSession {
    messages: ChatMessageData[]
}

export type StreamEventType = 'part_delta' | 'part_update' | 'session_status' | 'error'

export interface StreamEvent {
    type: StreamEventType
    id?: string
    ptype?: 'text' | 'reasoning' | 'tool'
    delta?: string
    state?: string
    name?: string
    status?: string
    message?: string
}

// API Functions

/**
 * List all chat sessions
 */
export async function listSessions(): Promise<ChatSession[]> {
    const response = await fetch(`${API_URL}/sessions`)
    if (!response.ok) {
        throw new Error(`Failed to list sessions: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new chat session
 */
export async function createSession(title?: string): Promise<ChatSession> {
    const response = await fetch(`${API_URL}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(title ? { title } : {}),
    })
    if (!response.ok) {
        throw new Error(`Failed to create session: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get a session with all messages
 */
export async function getSession(sessionId: string): Promise<SessionWithMessages> {
    const response = await fetch(`${API_URL}/sessions/${sessionId}`)
    if (!response.ok) {
        throw new Error(`Failed to get session: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Delete a chat session
 */
export async function deleteSession(sessionId: string): Promise<void> {
    const response = await fetch(`${API_URL}/sessions/${sessionId}`, {
        method: 'DELETE',
    })
    if (!response.ok) {
        throw new Error(`Failed to delete session: ${response.statusText}`)
    }
}

/**
 * Stream chat response
 * Returns an async generator that yields stream events
 */
export async function* streamChat(
    sessionId: string,
    message: string,
    wildMode: boolean = false
): AsyncGenerator<StreamEvent, void, unknown> {
    const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: sessionId,
            message,
            wild_mode: wildMode,
        }),
    })

    if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`)
    }

    if (!response.body) {
        throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
        while (true) {
            const { done, value } = await reader.read()

            if (done) {
                // Process any remaining buffer
                if (buffer.trim()) {
                    try {
                        yield JSON.parse(buffer.trim()) as StreamEvent
                    } catch {
                        console.warn('Failed to parse remaining buffer:', buffer)
                    }
                }
                break
            }

            buffer += decoder.decode(value, { stream: true })

            // Process complete lines (NDJSON format)
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        yield JSON.parse(line) as StreamEvent
                    } catch {
                        console.warn('Failed to parse line:', line)
                    }
                }
            }
        }
    } finally {
        reader.releaseLock()
    }
}

/**
 * Helper to check if API is available
 */
export async function checkApiHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${API_URL}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        })
        return response.ok
    } catch {
        return false
    }
}
