'use client'

import { getApiUrl, getAuthToken } from './api-config'
import type { PromptProvenance } from '@/lib/types'

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
export type ChatSessionStatus =
    | 'running'
    | 'completed'
    | 'failed'
    | 'questionable'
    | 'awaiting_human'
    | 'idle'

export interface ChatSession {
    id: string
    title: string
    created_at: number
    message_count: number
    model_provider?: string
    model_id?: string
    status?: ChatSessionStatus
}

export interface SessionModelSelection {
    provider_id: string
    model_id: string
}

export interface ChatModelOption extends SessionModelSelection {
    name: string
    context_limit?: number | null
    output_limit?: number | null
    is_default?: boolean
}

export interface ChatMessageData {
    role: 'user' | 'assistant'
    content: string
    thinking?: string | null
    parts?: MessagePartData[] | null  // NEW: ordered parts array
    timestamp: number
}

export interface ActiveSessionStream {
    run_id: string
    status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | string
    sequence: number
    text: string
    thinking: string
    parts?: MessagePartData[] | null
    error?: string | null
    started_at: number
    updated_at: number
}

export interface MessagePartData {
    id: string
    type: 'thinking' | 'tool' | 'text'
    content: string
    tool_name?: string
    tool_state?: 'pending' | 'running' | 'completed' | 'error' | string
    tool_state_raw?: unknown
    tool_input?: string
    tool_output?: string
    tool_started_at?: number
    tool_ended_at?: number
    tool_duration_ms?: number
}

export interface SessionWithMessages extends ChatSession {
    messages: ChatMessageData[]
    system_prompt?: string
    active_stream?: ActiveSessionStream | null
}

export type StreamEventType = 'part_delta' | 'part_update' | 'session_status' | 'error' | 'provenance'

export interface StreamEvent {
    type: StreamEventType
    seq?: number
    id?: string
    ptype?: 'text' | 'reasoning' | 'tool'
    delta?: string
    state?: unknown
    name?: string
    tool_status?: 'pending' | 'running' | 'completed' | 'error' | string
    tool_input?: string
    tool_output?: string
    tool_started_at?: number
    tool_ended_at?: number
    tool_duration_ms?: number
    status?: string
    message?: string
    // Provenance event fields (type === 'provenance')
    rendered?: string
    user_input?: string
    skill_id?: string | null
    skill_name?: string | null
    template?: string | null
    variables?: Record<string, string>
    prompt_type?: string
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
export async function createSession(title?: string, model?: SessionModelSelection): Promise<ChatSession> {
    const body: Record<string, unknown> = {}
    if (title) {
        body.title = title
    }
    if (model) {
        body.model_provider = model.provider_id
        body.model_id = model.model_id
    }
    const response = await fetch(`${API_URL()}/sessions`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(body),
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
 * Rename a chat session
 */
export async function renameSession(sessionId: string, title: string): Promise<ChatSession> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: getHeaders(true),
        body: JSON.stringify({ title }),
    })
    if (!response.ok) {
        throw new Error(`Failed to rename session: ${response.statusText}`)
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
 * List available chat models.
 */
export async function listModels(): Promise<ChatModelOption[]> {
    const response = await fetch(`${API_URL()}/models`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to list models: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get currently configured session model.
 */
export async function getSessionModel(sessionId: string): Promise<SessionModelSelection> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}/model`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get session model: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update provider/model for a chat session.
 */
export async function setSessionModel(sessionId: string, model: SessionModelSelection): Promise<SessionModelSelection> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}/model`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify(model),
    })
    if (!response.ok) {
        throw new Error(`Failed to set session model: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Stream chat response
 * Returns an async generator that yields stream events
 */
export async function* streamChat(
    sessionId: string,
    message: string,
    mode: string = 'agent',
    signal?: AbortSignal,
    promptOverride?: string,
): AsyncGenerator<StreamEvent, void, unknown> {
    const body: Record<string, unknown> = {
        session_id: sessionId,
        message,
        mode,
    }
    if (promptOverride) {
        body.prompt_override = promptOverride
    }
    const response = await fetch(`${API_URL()}/chat`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(body),
        signal,
    })

    if (!response.ok) {
        if (response.status === 409) {
            throw new Error(`Session busy: ${response.statusText}`)
        }
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
 * Stream an existing in-flight session response with catch-up replay.
 */
export async function* streamSession(
    sessionId: string,
    fromSeq: number = 1,
    signal?: AbortSignal,
    runId?: string
): AsyncGenerator<StreamEvent, void, unknown> {
    const params = new URLSearchParams()
    params.set('from_seq', String(Math.max(1, Math.floor(fromSeq))))
    if (runId) {
        params.set('run_id', runId)
    }

    const response = await fetch(`${API_URL()}/sessions/${sessionId}/stream?${params.toString()}`, {
        method: 'GET',
        headers: getHeaders(),
        signal,
    })

    if (!response.ok) {
        throw new Error(`Failed to stream session: ${response.statusText}`)
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
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    yield JSON.parse(line) as StreamEvent
                } catch {
                    console.warn('Failed to parse line:', line)
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
    metricSeries?: Record<string, { step: number; value: number }[]>
    metricKeys?: string[]
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

export interface RunUpdateRequest {
    name?: string
    command?: string
    workdir?: string
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
    is_active: boolean
    stage: string
    sweep_id: string | null
    termination: {
        max_iterations: number | null
        max_time_seconds: number | null
        max_tokens: number | null
        custom_condition: string | null
    }
    // Enriched fields from engine
    queue_size: number
    queue_events: WildEventQueueItem[]
    run_stats: {
        total: number
        running: number
        completed: number
        failed: number
        queued: number
    }
    active_alerts: Alert[]
    has_pending_prompt: boolean
    pending_event_id: string | null
    plan_autonomy: string
    created_sweeps: { id: string; name: string; status: string; run_count: number }[]
    created_runs: { id: string; name: string; status: string }[]
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

export type RepoDiffFileStatus = 'modified' | 'added' | 'deleted'
export type RepoDiffLineType = 'context' | 'add' | 'remove' | 'hunk'

export interface RepoDiffLine {
    type: RepoDiffLineType
    text: string
    oldLine: number | null
    newLine: number | null
}

export interface RepoDiffFile {
    path: string
    status: RepoDiffFileStatus
    additions: number
    deletions: number
    lines: RepoDiffLine[]
}

export interface RepoDiffResponse {
    repo_path: string
    head: string | null
    files: RepoDiffFile[]
}

export interface RepoFilesResponse {
    repo_path: string
    files: string[]
}

export interface RepoFileResponse {
    path: string
    content: string
    binary: boolean
    truncated: boolean
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
 * Update mutable run fields
 */
export async function updateRun(runId: string, request: RunUpdateRequest): Promise<Run> {
    const response = await fetch(`${API_URL()}/runs/${runId}`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to update run: ${error}`)
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
 * Get the system prompt for a chat session
 */
export async function getSystemPrompt(sessionId: string): Promise<{ system_prompt: string }> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}/system-prompt`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get system prompt: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update the system prompt for a chat session
 */
export async function setSystemPrompt(sessionId: string, systemPrompt: string): Promise<{ system_prompt: string }> {
    const response = await fetch(`${API_URL()}/sessions/${sessionId}/system-prompt`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify({ system_prompt: systemPrompt }),
    })
    if (!response.ok) {
        throw new Error(`Failed to set system prompt: ${response.statusText}`)
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
    is_active?: boolean
    stage?: string
}): Promise<WildLoopStatus> {
    const params = new URLSearchParams()
    if (update.phase !== undefined) params.set('phase', update.phase)
    if (update.iteration !== undefined) params.set('iteration', String(update.iteration))
    if (update.goal !== undefined) params.set('goal', update.goal)
    if (update.session_id !== undefined) params.set('session_id', update.session_id)
    if (update.is_paused !== undefined) params.set('is_paused', String(update.is_paused))
    if (update.is_active !== undefined) params.set('is_active', String(update.is_active))
    if (update.stage !== undefined) params.set('stage', update.stage)

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
    autonomy_level?: string
    queue_modify_enabled?: boolean
    plan_autonomy?: string
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

// =============================================================================
// Wild Event Queue Functions
// =============================================================================

export interface WildEventQueueItem {
    id: string
    priority: number
    title: string
    prompt: string
    type: string
    created_at: number
}

/**
 * Enqueue a wild event with priority
 */
export async function enqueueWildEvent(event: {
    priority?: number
    title: string
    prompt: string
    type?: string
}): Promise<{ added: boolean; event: WildEventQueueItem; queue_size: number }> {
    const response = await fetch(`${API_URL()}/wild/events/enqueue`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(event),
    })
    if (!response.ok) {
        throw new Error(`Failed to enqueue wild event: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Dequeue the highest-priority wild event
 */
export async function dequeueWildEvent(): Promise<{ event: WildEventQueueItem | null; queue_size: number }> {
    const response = await fetch(`${API_URL()}/wild/events/next`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to dequeue wild event: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get the current wild event queue state
 */
export async function getWildEventQueue(): Promise<{ queue_size: number; events: WildEventQueueItem[] }> {
    const response = await fetch(`${API_URL()}/wild/events/queue`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get wild event queue: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Wild Prompt Builder (server-side construction with transparency)
// =============================================================================

export interface BuildWildPromptRequest {
    prompt_type: 'exploring' | 'run_event' | 'alert' | 'analysis'
    goal?: string
    iteration?: number
    max_iterations?: number
    // run_event
    run_id?: string
    run_name?: string
    run_status?: string
    run_command?: string
    log_tail?: string
    sweep_summary?: string
    // alert
    alert_id?: string
    alert_severity?: string
    alert_message?: string
    alert_choices?: string[]
    // analysis
    sweep_name?: string
    total_runs?: number
    passed_runs?: number
    failed_runs?: number
    run_summaries?: string
}

// Re-export from canonical location
export type { PromptProvenance } from '@/lib/types'

/**
 * Build a wild loop prompt server-side with full provenance metadata.
 * Returns the rendered prompt, template used, variables applied, and user input.
 */
export async function buildWildPrompt(req: BuildWildPromptRequest): Promise<PromptProvenance> {
    const response = await fetch(`${API_URL()}/wild/build-prompt`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(req),
    })
    if (!response.ok) {
        throw new Error(`Failed to build wild prompt: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Backend-Driven Wild Loop Engine (v5) API Functions
// =============================================================================

export interface WildNextPrompt {
    has_prompt: boolean
    event_id?: string | null
    prompt?: string | null
    display_message?: string | null
    title?: string | null
    event_type?: string | null
    priority?: number | null
    provenance?: PromptProvenance | null
}

/**
 * Start the wild loop with a goal and session.
 */
export async function startWildLoop(params: {
    goal: string
    session_id: string
    max_iterations?: number
    max_time_seconds?: number
    max_tokens?: number
    custom_condition?: string
}): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/start`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(params),
    })
    if (!response.ok) {
        throw new Error(`Failed to start wild loop: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Stop the wild loop.
 */
export async function stopWildLoop(): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/stop`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to stop wild loop: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Pause the wild loop.
 */
export async function pauseWildLoop(): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/pause`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to pause wild loop: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Resume the wild loop.
 */
export async function resumeWildLoop(): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/resume`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to resume wild loop: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Notify the backend that the agent finished responding.
 */
export async function wildResponseComplete(responseText: string): Promise<WildLoopStatus> {
    const response = await fetch(`${API_URL()}/wild/response-complete`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ response_text: responseText }),
    })
    if (!response.ok) {
        throw new Error(`Failed to submit wild response: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get the next prompt the frontend should send to the agent.
 */
export async function getWildNextPrompt(): Promise<WildNextPrompt> {
    const response = await fetch(`${API_URL()}/wild/next-prompt`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get wild next prompt: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Mark the current pending prompt as consumed/sent.
 */
export async function consumeWildPrompt(): Promise<{ consumed: boolean; queue_size: number }> {
    const response = await fetch(`${API_URL()}/wild/next-prompt/consume`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to consume wild prompt: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Insert a user steer message into the wild loop queue.
 */
export async function steerWildLoop(message: string, priority: number = 10): Promise<{ added: boolean; queue_size: number }> {
    const response = await fetch(`${API_URL()}/wild/steer`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ message, priority }),
    })
    if (!response.ok) {
        throw new Error(`Failed to steer wild loop: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Wild Loop V2 (Ralph-style) API Functions
// =============================================================================

export interface WildV2IterationHistory {
    iteration: number
    summary: string
    started_at: number
    finished_at: number
    duration_s: number
    opencode_session_id: string
    promise: string | null
    files_modified: string[]
    error_count: number
    errors: string[]
}

export interface WildV2Status {
    active: boolean
    session_id?: string
    goal?: string
    status?: string  // running | paused | done | failed
    iteration?: number
    max_iterations?: number
    plan?: string
    iteration_log?: string
    session_dir?: string
    workdir?: string
    opencode_pwd?: string | null
    opencode_pwd_note?: string
    history?: WildV2IterationHistory[]
    started_at?: number
    finished_at?: number | null
    pending_events_count?: number
    pending_events?: Array<{ id: string; type: string; title: string; detail: string }>
    steer_context?: string
    no_progress_streak?: number
    short_iteration_count?: number
    system_health?: {
        running: number
        queued: number
        completed: number
        failed: number
        total: number
        max_concurrent: number
    }
}

/**
 * Start a V2 wild session (ralph-style loop).
 */
export async function startWildV2(params: {
    goal: string
    chat_session_id?: string
    max_iterations?: number
    wait_seconds?: number
}): Promise<WildV2Status> {
    const response = await fetch(`${API_URL()}/wild/v2/start`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(params),
    })
    if (!response.ok) {
        throw new Error(`Failed to start wild v2: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Stop the active V2 wild session.
 */
export async function stopWildV2(): Promise<WildV2Status> {
    const response = await fetch(`${API_URL()}/wild/v2/stop`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to stop wild v2: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get V2 wild session status.
 */
export async function getWildV2Status(): Promise<WildV2Status> {
    const response = await fetch(`${API_URL()}/wild/v2/status`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get wild v2 status: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Pause the V2 wild session.
 */
export async function pauseWildV2(): Promise<WildV2Status> {
    const response = await fetch(`${API_URL()}/wild/v2/pause`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to pause wild v2: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Resume the V2 wild session.
 */
export async function resumeWildV2(): Promise<WildV2Status> {
    const response = await fetch(`${API_URL()}/wild/v2/resume`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to resume wild v2: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Inject user context for the next V2 iteration.
 */
export async function steerWildV2(context: string): Promise<{ ok: boolean }> {
    const response = await fetch(`${API_URL()}/wild/v2/steer`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify({ context }),
    })
    if (!response.ok) {
        throw new Error(`Failed to steer wild v2: ${response.statusText}`)
    }
    return response.json()
}

// =============================================================================
// Prompt Skill Functions  
// =============================================================================

export interface PromptSkill {
    id: string
    name: string
    description: string
    template: string
    variables: string[]
    category: 'prompt' | 'skill'  // "prompt" = template only, "skill" = has logic/tools
    built_in: boolean
    internal: boolean  // true for wild_* and ra_mode_plan — cannot be deleted
    _score?: number    // present in search results
}

export interface CreateSkillRequest {
    name: string
    description?: string
    template?: string
    category?: string
    variables?: string[]
}

export interface InstallSkillRequest {
    source: 'git'
    url: string
    name?: string
}

export interface SkillFileEntry {
    name: string
    path: string
    type: 'file' | 'directory'
    size?: number
}

/**
 * List all available prompt skills
 */
export async function listPromptSkills(): Promise<PromptSkill[]> {
    const response = await fetch(`${API_URL()}/prompt-skills`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to list prompt skills: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get a single prompt skill by ID
 */
export async function getPromptSkill(id: string): Promise<PromptSkill> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get prompt skill: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update a prompt skill's template
 */
export async function updatePromptSkill(id: string, template: string): Promise<PromptSkill> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify({ template }),
    })
    if (!response.ok) {
        throw new Error(`Failed to update prompt skill: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Reload all prompt skills from disk
 */
export async function reloadPromptSkills(): Promise<{ message: string; count: number }> {
    const response = await fetch(`${API_URL()}/prompt-skills/reload`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to reload prompt skills: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new prompt skill
 */
export async function createSkill(req: CreateSkillRequest): Promise<PromptSkill> {
    const response = await fetch(`${API_URL()}/prompt-skills`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(req),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to create skill: ${error}`)
    }
    return response.json()
}

/**
 * Delete a user-created skill (internal skills return 403)
 */
export async function deleteSkill(id: string): Promise<{ message: string }> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}`, {
        method: 'DELETE',
        headers: getHeaders()
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to delete skill: ${error}`)
    }
    return response.json()
}

/**
 * Install a skill from an external source (git clone)
 */
export async function installSkill(req: InstallSkillRequest): Promise<PromptSkill> {
    const response = await fetch(`${API_URL()}/prompt-skills/install`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(req),
    })
    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to install skill: ${error}`)
    }
    return response.json()
}

/**
 * Search skills by name, description, or template content
 */
export async function searchSkills(query: string, limit: number = 20): Promise<PromptSkill[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const response = await fetch(`${API_URL()}/prompt-skills/search?${params}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to search skills: ${response.statusText}`)
    }
    return response.json()
}

/**
 * List all files in a skill's folder
 */
export async function listSkillFiles(id: string): Promise<SkillFileEntry[]> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}/files`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to list skill files: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Read a file from a skill's folder
 */
export async function readSkillFile(id: string, path: string): Promise<{ path: string; content: string }> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}/files/${encodeURIComponent(path)}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to read skill file: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Write a file in a skill's folder
 */
export async function writeSkillFile(id: string, path: string, content: string): Promise<{ message: string; path: string }> {
    const response = await fetch(`${API_URL()}/prompt-skills/${id}/files/${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: getHeaders(true),
        body: JSON.stringify({ content }),
    })
    if (!response.ok) {
        throw new Error(`Failed to write skill file: ${response.statusText}`)
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
 * Get sidecar logs with byte-offset pagination
 */
export async function getSidecarLogs(
    runId: string,
    offset: number = -10000,
    limit: number = 10000
): Promise<LogResponse> {
    const response = await fetch(
        `${API_URL()}/runs/${runId}/sidecar-logs?offset=${offset}&limit=${limit}`,
        { headers: getHeaders() }
    )
    if (!response.ok) {
        throw new Error(`Failed to get sidecar logs: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Stream sidecar logs via SSE
 */
export async function* streamSidecarLogs(runId: string): AsyncGenerator<{
    type: 'initial' | 'delta' | 'done' | 'error'
    content?: string
    status?: string
    error?: string
}> {
    const response = await fetch(`${API_URL()}/runs/${runId}/sidecar-logs/stream`, {
        headers: getHeaders()
    })

    if (!response.ok) {
        throw new Error(`Failed to stream sidecar logs: ${response.statusText}`)
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

/**
 * Get repository diff for changed files in the active workdir
 */
export async function getRepoDiff(unified: number = 3): Promise<RepoDiffResponse> {
    const response = await fetch(`${API_URL()}/git/diff?unified=${unified}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get repository diff: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get repository file list for file explorer mode
 */
export async function getRepoFiles(limit: number = 5000): Promise<RepoFilesResponse> {
    const response = await fetch(`${API_URL()}/git/files?limit=${limit}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get repository files: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Read a repository file for file explorer mode
 */
export async function getRepoFile(path: string, maxBytes: number = 120000): Promise<RepoFileResponse> {
    const params = new URLSearchParams({
        path,
        max_bytes: String(maxBytes),
    })
    const response = await fetch(`${API_URL()}/git/file?${params.toString()}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to read repository file: ${response.statusText}`)
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
    creation_context?: {
        name?: string | null
        goal?: string | null
        description?: string | null
        command?: string | null
        notes?: string | null
        max_runs?: number | null
        parallel_runs?: number | null
        early_stopping_enabled?: boolean | null
        early_stopping_patience?: number | null
        hyperparameter_count?: number | null
        metric_count?: number | null
        insight_count?: number | null
        created_at?: number | null
        ui_config_snapshot?: Record<string, unknown> | null
    } | null
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
export async function listSweeps(limit: number = 200): Promise<Sweep[]> {
    const response = await fetch(`${API_URL()}/sweeps?limit=${limit}`, {
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

// =============================================================================
// Plan Management Types & Functions
// =============================================================================

export type PlanStatus = 'draft' | 'approved' | 'executing' | 'completed' | 'archived'

export interface Plan {
    id: string
    title: string
    goal: string
    session_id: string | null
    status: PlanStatus
    sections: Record<string, unknown>
    raw_markdown: string
    created_at: number
    updated_at: number
}

export interface CreatePlanRequest {
    title: string
    goal: string
    session_id?: string
    sections?: Record<string, unknown>
    raw_markdown?: string
}

export interface UpdatePlanRequest {
    title?: string
    status?: PlanStatus
    sections?: Record<string, unknown>
    raw_markdown?: string
}

/**
 * List all plans, optionally filtered by status or session
 */
export async function listPlans(status?: PlanStatus, sessionId?: string): Promise<Plan[]> {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (sessionId) params.set('session_id', sessionId)
    const qs = params.toString()
    const response = await fetch(`${API_URL()}/plans${qs ? `?${qs}` : ''}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to list plans: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Get a single plan by ID
 */
export async function getPlan(planId: string): Promise<Plan> {
    const response = await fetch(`${API_URL()}/plans/${planId}`, {
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to get plan: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Create a new plan
 */
export async function createPlan(request: CreatePlanRequest): Promise<Plan> {
    const response = await fetch(`${API_URL()}/plans`, {
        method: 'POST',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to create plan: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Update a plan's fields
 */
export async function updatePlan(planId: string, request: UpdatePlanRequest): Promise<Plan> {
    const response = await fetch(`${API_URL()}/plans/${planId}`, {
        method: 'PATCH',
        headers: getHeaders(true),
        body: JSON.stringify(request),
    })
    if (!response.ok) {
        throw new Error(`Failed to update plan: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Approve a draft plan
 */
export async function approvePlan(planId: string): Promise<Plan> {
    const response = await fetch(`${API_URL()}/plans/${planId}/approve`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to approve plan: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Mark an approved plan as executing
 */
export async function executePlan(planId: string): Promise<Plan> {
    const response = await fetch(`${API_URL()}/plans/${planId}/execute`, {
        method: 'POST',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to execute plan: ${response.statusText}`)
    }
    return response.json()
}

/**
 * Delete a plan
 */
export async function deletePlan(planId: string): Promise<{ deleted: boolean; id: string }> {
    const response = await fetch(`${API_URL()}/plans/${planId}`, {
        method: 'DELETE',
        headers: getHeaders()
    })
    if (!response.ok) {
        throw new Error(`Failed to delete plan: ${response.statusText}`)
    }
    return response.json()
}
