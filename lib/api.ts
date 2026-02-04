'use client'

import { getApiUrl } from './api-config'

// Get API URL dynamically at runtime (supports localStorage override)
const API_URL = () => getApiUrl()

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
    const response = await fetch(`${API_URL()}/sessions`)
    if (!response.ok) {
        throw new Error(`Failed to list sessions: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new chat session
 */
export async function createSession(title?: string): Promise<ChatSession> {
    const response = await fetch(`${API_URL()}/sessions`, {
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
    const response = await fetch(`${API_URL()}/sessions/${sessionId}`)
    if (!response.ok) {
        throw new Error(`Failed to get session: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Delete a chat session
 */
export async function deleteSession(sessionId: string): Promise<void> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}`, {
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
    const response = await fetch(`${API_URL()}/chat`, {
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
        const response = await fetch(`${API_URL()}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        })
        return response.ok
    } catch {
        return false
    }
}

// =============================================================================
// Run Management Types
// =============================================================================

export type RunStatus = 'ready' | 'queued' | 'launching' | 'running' | 'finished' | 'failed' | 'stopped'

export interface Run {
    id: string
    name: string
    command: string
    workdir?: string
    status: RunStatus
    is_archived: boolean
    created_at: number
    queued_at?: number
    launched_at?: number
    started_at?: number
    ended_at?: number
    stopped_at?: number
    tmux_window?: string
    tmux_pane?: string
    run_dir?: string
    exit_code?: number | null
    error?: string | null
    wandb_dir?: string | null
    sweep_id?: string | null
    sweep_params?: Record<string, unknown> | null
}

export interface CreateRunRequest {
    name: string
    command: string
    workdir?: string
    sweep_id?: string
    auto_start?: boolean
}

export interface LogResponse {
    content: string
    offset: number
    total_size: number
    has_more_before: boolean
    has_more_after: boolean
}

export interface Artifact {
    name: string
    path: string
    type: 'checkpoint' | 'metrics' | 'wandb' | 'other'
}

// =============================================================================
// Run Management Functions
// =============================================================================

/**
 * List all runs
 */
export async function listRuns(includeArchived: boolean = false): Promise<Run[]> {
    const response = await fetch(`${API_URL()}/runs?archived=${includeArchived}`)
    if (!response.ok) {
        throw new Error(`Failed to list runs: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new run (in queued state)
 */
export async function createRun(request: CreateRunRequest): Promise<Run> {
    const response = await fetch(`${API_URL()}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to create run: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get a single run by ID
 */
export async function getRun(runId: string): Promise<Run> {
    const response = await fetch(`${API_URL()}/runs/${runId}`)
    if (!response.ok) {
        throw new Error(`Failed to get run: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Start a queued run
 */
export async function startRun(runId: string): Promise<{ message: string; tmux_window: string }> {
    const response = await fetch(`${API_URL()}/runs/${runId}/start`, {
        method: 'POST',
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to start run: ${error}`)
    }
    return response.json()
}

/**
 * Stop a running job
 */
export async function stopRun(runId: string): Promise<void> {
    const response = await fetch(`${API_URL()}/runs/${runId}/stop`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(`Failed to stop run: ${response.statusText}`)
    }
}

/**
 * Archive a run
 */
export async function archiveRun(runId: string): Promise<void> {
    const response = await fetch(`${API_URL()}/runs/${runId}/archive`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(`Failed to archive run: ${response.statusText}`)
    }
}

/**
 * Unarchive a run
 */
export async function unarchiveRun(runId: string): Promise<void> {
    const response = await fetch(`${API_URL()}/runs/${runId}/unarchive`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(`Failed to unarchive run: ${response.statusText}`)
    }
}

/**
 * Get run logs with byte-offset pagination
 * @param runId - Run ID
 * @param offset - Byte offset (negative = from end, default -10000)
 * @param limit - Max bytes to return (default 10000, max 100KB)
 */
export async function getRunLogs(
    runId: string,
    offset: number = -10000,
    limit: number = 10000
): Promise<LogResponse> {
    const response = await fetch(
        `${API_URL()}/runs/${runId}/logs?offset=${offset}&limit=${limit}`
    )
    if (!response.ok) {
        throw new Error(`Failed to get run logs: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Stream run logs via SSE
 * Returns an async generator of log events
 */
export async function* streamRunLogs(runId: string): AsyncGenerator<{
    type: 'initial' | 'delta' | 'done' | 'error'
    content?: string
    status?: string
    error?: string
}> {
    const response = await fetch(`${API_URL()}/runs/${runId}/logs/stream`)

    if (!response.ok) {
        throw new Error(`Failed to stream logs: ${response.statusText}`)
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

            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Process SSE format: data: {...}\n\n
            const events = buffer.split('\n\n')
            buffer = events.pop() || ''

            for (const event of events) {
                if (event.startsWith('data: ')) {
                    try {
                        yield JSON.parse(event.slice(6))
                    } catch {
                        console.warn('Failed to parse SSE event:', event)
                    }
                }
            }
        }
    } finally {
        reader.releaseLock()
    }
}

/**
 * Get run artifacts
 */
export async function getRunArtifacts(runId: string): Promise<Artifact[]> {
    const response = await fetch(`${API_URL()}/runs/${runId}/artifacts`)
    if (!response.ok) {
        throw new Error(`Failed to get artifacts: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Queue a ready run
 */
export async function queueRun(runId: string): Promise<Run> {
    const response = await fetch(`${API_URL()}/runs/${runId}/queue`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(`Failed to queue run: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Sweep Management Types
// =============================================================================

export interface Sweep {
    id: string
    name: string
    base_command: string
    workdir?: string
    parameters: Record<string, unknown[]>
    run_ids: string[]
    status: 'ready' | 'running' | 'completed' | 'failed'
    created_at: number
    progress: {
        total: number
        completed: number
        failed: number
        running: number
        ready?: number
        queued?: number
    }
}

export interface CreateSweepRequest {
    name: string
    base_command: string
    workdir?: string
    parameters: Record<string, unknown[]>
    max_runs?: number
    auto_start?: boolean
}

// =============================================================================
// Sweep Management Functions
// =============================================================================

/**
 * List all sweeps
 */
export async function listSweeps(): Promise<Sweep[]> {
    const response = await fetch(`${API_URL()}/sweeps`)
    if (!response.ok) {
        throw new Error(`Failed to list sweeps: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new sweep with child runs
 */
export async function createSweep(request: CreateSweepRequest): Promise<Sweep> {
    const response = await fetch(`${API_URL()}/sweeps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to create sweep: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get sweep details
 */
export async function getSweep(sweepId: string): Promise<Sweep> {
    const response = await fetch(`${API_URL()}/sweeps/${sweepId}`)
    if (!response.ok) {
        throw new Error(`Failed to get sweep: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Start all ready/queued runs in a sweep
 */
export async function startSweep(sweepId: string, parallel: number = 1): Promise<{ message: string }> {
    const response = await fetch(`${API_URL()}/sweeps/${sweepId}/start?parallel=${parallel}`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(`Failed to start sweep: ${response.statusText}`)
    }
    return response.json()
}
