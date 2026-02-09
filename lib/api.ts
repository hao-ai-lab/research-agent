'use client'

import { getApiUrl, getAuthToken } from './api-config'

// Get API URL dynamically at runtime (supports localStorage override)
const API_URL = () => getApiUrl()

// Get headers with optional auth token
function getHeaders(includeContentType: boolean = false): HeadersInit {
    const headers: HeadersInit = {}
    
    if (includeContentType) {
        headers['Content-Type'] = 'application/json'
    }
    
    const authToken = getAuthToken()
    if (authToken) {
        headers['X-Auth-Token'] = authToken
    }
    
    return headers
}

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
    parts?: MessagePartData[] | null  // NEW: ordered parts array
    timestamp: number
}

export interface MessagePartData {
    id: string
    type: 'thinking' | 'tool' | 'text'
    content: string
    tool_name?: string
    tool_state?: 'pending' | 'running' | 'completed' | 'error'
    tool_input?: string
    tool_output?: string
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
    const response = await fetch(`${API_URL()}/sessions`, {
        headers: getHeaders()
    })
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
        headers: getHeaders(true),
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
    const response = await fetch(`${API_URL()}/sessions/${sessionId}`, {
        headers: getHeaders()
    })
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
        headers: getHeaders()
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
    wildMode: boolean = false,
    signal?: AbortSignal
): AsyncGenerator<StreamEvent, void, unknown> {
    const response = await fetch(`${API_URL()}/chat`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({
            session_id: sessionId,
            message,
            wild_mode: wildMode,
        }),
        signal,
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
            signal: AbortSignal.timeout(15000)
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
    parent_run_id?: string | null
    origin_alert_id?: string | null
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
    // Optional fields for metrics/charts (from mock or W&B)
    progress?: number
    config?: Record<string, unknown>
    metrics?: { loss: number; accuracy: number; epoch: number }
    lossHistory?: { step: number; trainLoss: number; valLoss?: number }[]
    color?: string
}

export interface Alert {
    id: string
    run_id: string
    timestamp: number
    severity: 'info' | 'warning' | 'critical'
    message: string
    choices: string[]
    status: 'pending' | 'resolved'
    response?: string | null
    responded_at?: number | null
    session_id?: string | null
    auto_session?: boolean
}

export interface CreateRunRequest {
    name: string
    command: string
    workdir?: string
    sweep_id?: string
    parent_run_id?: string
    origin_alert_id?: string
    auto_start?: boolean
}

export interface RunRerunRequest {
    command?: string
    auto_start?: boolean
    origin_alert_id?: string
}

export interface WildModeState {
    enabled: boolean
}

export interface WildLoopStatus {
    phase: string
    iteration: number
    goal: string | null
    session_id: string | null
    started_at: number | null
    is_paused: boolean
    termination: {
        max_iterations: number | null
        max_time_seconds: number | null
        max_tokens: number | null
        custom_condition: string | null
    }
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
    const response = await fetch(`${API_URL()}/runs?archived=${includeArchived}`, {
        headers: getHeaders()
    })
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
        headers: getHeaders(true),
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
    const response = await fetch(`${API_URL()}/runs/${runId}`, {
        headers: getHeaders()
    })
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
        headers: getHeaders()
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
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to stop run: ${response.statusText}`)
    }
}

/**
 * Rerun a run (creates a new run with parent linkage)
 */
export async function rerunRun(runId: string, request: RunRerunRequest = {}): Promise<Run> {
    const response = await fetch(`${API_URL()}/runs/${runId}/rerun`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to rerun run: ${error}`)
    }
    return response.json()
}

/**
 * Archive a run
 */
export async function archiveRun(runId: string): Promise<void> {
    const response = await fetch(`${API_URL()}/runs/${runId}/archive`, {
        method: 'POST',
        headers: getHeaders()
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
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to unarchive run: ${response.statusText}`)
    }
}

/**
 * List all alerts
 */
export async function listAlerts(): Promise<Alert[]> {
    const response = await fetch(`${API_URL()}/alerts`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to list alerts: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Respond to an alert choice
 */
export async function respondToAlert(alertId: string, choice: string): Promise<{ message: string }> {
    const response = await fetch(`${API_URL()}/alerts/${alertId}/respond`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ choice }),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to respond to alert: ${error}`)
    }
    return response.json()
}

/**
 * Stop a chat session stream (including auto-alert sessions)
 */
export async function stopSession(sessionId: string): Promise<{ message: string }> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to stop session: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get wild mode state
 */
export async function getWildMode(): Promise<WildModeState> {
    const response = await fetch(`${API_URL()}/wild-mode`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get wild mode: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Set wild mode state
 */
export async function setWildMode(enabled: boolean): Promise<WildModeState> {
    const response = await fetch(`${API_URL()}/wild-mode`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ enabled }),
    })
    if (!response.ok) {
        throw new Error(`Failed to set wild mode: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get wild loop status
 */
export async function getWildLoopStatus(): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/status`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get wild loop status: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update wild loop status from frontend
 */
export async function updateWildLoopStatus(update: {
    phase?: string
    iteration?: number
    goal?: string
    session_id?: string
    is_paused?: boolean
}): Promise<WildLoopStatus> {
    const params = new URLSearchParams()
    if (update.phase !== undefined) params.set('phase', update.phase)
    if (update.iteration !== undefined) params.set('iteration', String(update.iteration))
    if (update.goal !== undefined) params.set('goal', update.goal)
    if (update.session_id !== undefined) params.set('session_id', update.session_id)
    if (update.is_paused !== undefined) params.set('is_paused', String(update.is_paused))
    
    const response = await fetch(`${API_URL()}/wild/status?${params}`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to update wild loop status: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Configure wild loop termination conditions
 */
export async function configureWildLoop(config: {
    goal?: string
    session_id?: string
    max_iterations?: number
    max_time_seconds?: number
    max_tokens?: number
    custom_condition?: string
}): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/configure`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(config),
    })
    if (!response.ok) {
        throw new Error(`Failed to configure wild loop: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Add a standalone run to an existing sweep
 */
export async function addRunToSweep(runId: string, sweepId: string): Promise<{ message: string }> {
    const response = await fetch(`${API_URL()}/runs/${runId}/add-to-sweep?sweep_id=${sweepId}`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to add run to sweep: ${response.statusText}`)
    }
    return response.json()
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
        `${API_URL()}/runs/${runId}/logs?offset=${offset}&limit=${limit}`,
        { headers: getHeaders() }
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
    const response = await fetch(`${API_URL()}/runs/${runId}/logs/stream`, {
        headers: getHeaders()
    })

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
    const response = await fetch(`${API_URL()}/runs/${runId}/artifacts`, {
        headers: getHeaders()
    })
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
        headers: getHeaders()
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
    status: 'draft' | 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'canceled'
    created_at: number
    started_at?: number
    completed_at?: number
    max_runs?: number
    goal?: string
    is_wild?: boolean
    ui_config?: Record<string, unknown> | null
    progress: {
        total: number
        completed: number
        failed: number
        running: number
        launching?: number
        ready?: number
        queued?: number
        canceled?: number
    }
}

export interface CreateSweepRequest {
    name: string
    base_command: string
    workdir?: string
    parameters: Record<string, unknown[]>
    max_runs?: number
    auto_start?: boolean
    goal?: string
    status?: 'draft' | 'pending' | 'running'
    ui_config?: Record<string, unknown>
}

export interface UpdateSweepRequest {
    name?: string
    base_command?: string
    workdir?: string
    parameters?: Record<string, unknown[]>
    max_runs?: number
    goal?: string
    status?: 'draft' | 'pending' | 'running' | 'completed' | 'failed' | 'canceled'
    ui_config?: Record<string, unknown>
}

// =============================================================================
// Sweep Management Functions
// =============================================================================

/**
 * List all sweeps
 */
export async function listSweeps(): Promise<Sweep[]> {
    const response = await fetch(`${API_URL()}/sweeps`, {
        headers: getHeaders()
    })
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
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to create sweep: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update an existing sweep
 */
export async function updateSweep(sweepId: string, request: UpdateSweepRequest): Promise<Sweep> {
    const response = await fetch(`${API_URL()}/sweeps/${sweepId}`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to update sweep: ${error}`)
    }
    return response.json()
}

/**
 * Get sweep details
 */
export async function getSweep(sweepId: string): Promise<Sweep> {
    const response = await fetch(`${API_URL()}/sweeps/${sweepId}`, {
        headers: getHeaders()
    })
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
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to start sweep: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create an empty sweep container for wild loop job tracking
 */
export async function createWildSweep(name: string, goal: string): Promise<Sweep> {
    const response = await fetch(`${API_URL()}/sweeps/wild`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ name, goal }),
    })
    if (!response.ok) {
        throw new Error(`Failed to create wild sweep: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Cluster Management Types
// =============================================================================

export type ClusterType = 'unknown' | 'slurm' | 'local_gpu' | 'kubernetes' | 'ray' | 'shared_head_node'
export type ClusterHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'offline'
export type ClusterSource = 'unset' | 'manual' | 'detected'

export interface ClusterState {
    type: ClusterType
    status: ClusterHealthStatus
    source: ClusterSource
    label: string
    description: string
    head_node?: string | null
    node_count?: number | null
    gpu_count?: number | null
    notes?: string | null
    confidence?: number | null
    details?: Record<string, unknown>
    last_detected_at?: number | null
    updated_at?: number | null
}

export interface ClusterStatusResponse {
    cluster: ClusterState
    run_summary: {
        total: number
        running: number
        launching: number
        queued: number
        ready: number
        failed: number
        finished: number
    }
}

export interface ClusterUpdateRequest {
    type?: ClusterType
    status?: ClusterHealthStatus
    source?: ClusterSource
    head_node?: string | null
    node_count?: number | null
    gpu_count?: number | null
    notes?: string | null
    details?: Record<string, unknown>
}

export interface ClusterDetectRequest {
    preferred_type?: ClusterType
}

// =============================================================================
// Cluster Management Functions
// =============================================================================

export async function getClusterStatus(): Promise<ClusterStatusResponse> {
    const response = await fetch(`${API_URL()}/cluster`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get cluster status: ${response.statusText}`)
    }
    return response.json()
}

export async function detectCluster(request?: ClusterDetectRequest): Promise<ClusterStatusResponse> {
    const response = await fetch(`${API_URL()}/cluster/detect`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(request || {}),
    })
    if (!response.ok) {
        throw new Error(`Failed to detect cluster: ${response.statusText}`)
    }
    return response.json()
}

export async function updateCluster(request: ClusterUpdateRequest): Promise<ClusterStatusResponse> {
    const response = await fetch(`${API_URL()}/cluster`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to update cluster: ${response.statusText}`)
    }
    return response.json()
}
