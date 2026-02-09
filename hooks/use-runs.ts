'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
    listRuns,
    createRun,
    startRun,
    stopRun,
    archiveRun,
    unarchiveRun,
    type Run,
    type CreateRunRequest
} from '@/lib/api-client'
import type { ExperimentRun } from '@/lib/types'

const RUN_METADATA_STORAGE_KEY = 'research-agent-run-metadata-v1'

interface RunMetadata {
    isFavorite?: boolean
    tags?: string[]
    notes?: string
    color?: string
    alias?: string
}

type RunMetadataMap = Record<string, RunMetadata>

function loadRunMetadata(): RunMetadataMap {
    if (typeof window === 'undefined') return {}
    try {
        const raw = window.localStorage.getItem(RUN_METADATA_STORAGE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as RunMetadataMap
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function saveRunMetadataMap(metadata: RunMetadataMap) {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(RUN_METADATA_STORAGE_KEY, JSON.stringify(metadata))
}

function persistRunMetadata(run: ExperimentRun) {
    const metadata = loadRunMetadata()
    metadata[run.id] = {
        isFavorite: !!run.isFavorite,
        tags: run.tags || [],
        notes: run.notes || '',
        color: run.color || '#4ade80',
        alias: run.alias,
    }
    saveRunMetadataMap(metadata)
}

// Convert API Run to ExperimentRun for UI compatibility
function apiRunToExperimentRun(run: Run, metadata?: RunMetadata): ExperimentRun {
    // Map API status to UI status
    const statusMap: Record<Run['status'], ExperimentRun['status']> = {
        'ready': 'ready',
        'queued': 'queued',
        'launching': 'running',
        'running': 'running',
        'finished': 'completed',
        'failed': 'failed',
        'stopped': 'canceled',
    }

    const createdAt = new Date(run.created_at * 1000)
    const queuedAt = run.queued_at ? new Date(run.queued_at * 1000) : undefined
    const launchedAt = run.launched_at ? new Date(run.launched_at * 1000) : undefined
    const startedAt = run.started_at ? new Date(run.started_at * 1000) : undefined
    const stoppedAt = run.stopped_at ? new Date(run.stopped_at * 1000) : undefined
    const endTime = run.ended_at
        ? new Date(run.ended_at * 1000)
        : (run.stopped_at ? new Date(run.stopped_at * 1000) : undefined)

    const mappedStatus = statusMap[run.status]
    const normalizedExitCode = typeof run.exit_code === 'number' ? run.exit_code : null
    const status = mappedStatus === 'completed' && ((normalizedExitCode !== null && normalizedExitCode !== 0) || Boolean(run.error))
        ? 'failed'
        : mappedStatus

    return {
        id: run.id,
        name: run.name,
        sweepId: run.sweep_id ?? undefined,
        sweepParams: run.sweep_params ?? null,
        alias: metadata?.alias,
        command: run.command,
        status,
        progress: run.progress ?? (status === 'running' ? 50 : status === 'completed' ? 100 : 0),
        createdAt,
        queuedAt,
        launchedAt,
        startedAt,
        stoppedAt,
        startTime: startedAt || launchedAt || createdAt,
        endTime,
        isArchived: run.is_archived,
        parentRunId: run.parent_run_id || undefined,
        originAlertId: run.origin_alert_id || undefined,
        isFavorite: metadata?.isFavorite ?? false,
        tags: metadata?.tags || [],
        notes: metadata?.notes || '',
        color: metadata?.color || run.color || '#4ade80',
        // Pass through metrics/charts from API (mock or real)
        lossHistory: run.lossHistory,
        metricSeries: run.metricSeries,
        metricKeys: run.metricKeys,
        metrics: run.metrics,
        config: run.config as ExperimentRun['config'],
        // Include API-specific fields for terminal panel
        tmux_window: run.tmux_window,
        tmux_pane: run.tmux_pane,
        run_dir: run.run_dir,
        exit_code: normalizedExitCode,
        error: run.error,
        wandb_dir: run.wandb_dir,
    }
}

interface UseRunsResult {
    runs: ExperimentRun[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<void>
    createNewRun: (request: CreateRunRequest) => Promise<ExperimentRun>
    startExistingRun: (runId: string) => Promise<void>
    stopExistingRun: (runId: string) => Promise<void>
    archiveExistingRun: (runId: string) => Promise<void>
    unarchiveExistingRun: (runId: string) => Promise<void>
    updateRun: (run: ExperimentRun) => void
}

export function useRuns(): UseRunsResult {
    const [runs, setRuns] = useState<ExperimentRun[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const pollingRef = useRef<NodeJS.Timeout | null>(null)

    // Fetch runs from API
    const fetchRuns = useCallback(async () => {
        try {
            const apiRuns = await listRuns(true) // include archived
            const metadata = loadRunMetadata()
            const experimentRuns = apiRuns.map(apiRun => apiRunToExperimentRun(apiRun, metadata[apiRun.id]))
            setRuns(experimentRuns)
            setError(null)
        } catch (e) {
            console.error('Failed to fetch runs:', e)
            setError(e instanceof Error ? e.message : 'Failed to fetch runs')
        } finally {
            setIsLoading(false)
        }
    }, [])

    // Ref to track current runs for polling check (avoids dependency cycle)
    const runsRef = useRef<ExperimentRun[]>([])
    runsRef.current = runs

    // Initial fetch and polling setup
    useEffect(() => {
        fetchRuns()

        // Poll every 5 seconds for active runs
        pollingRef.current = setInterval(() => {
            const hasActiveRuns = runsRef.current.some(r =>
                r.status === 'running' || r.status === 'queued'
            )
            if (hasActiveRuns) {
                fetchRuns()
            }
        }, 5000)

        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current)
            }
        }
    }, [fetchRuns])

    // Create a new run
    const createNewRun = useCallback(async (request: CreateRunRequest): Promise<ExperimentRun> => {
        const apiRun = await createRun(request)
        const metadata = loadRunMetadata()
        const experimentRun = apiRunToExperimentRun(apiRun, metadata[apiRun.id])
        setRuns(prev => [experimentRun, ...prev])
        return experimentRun
    }, [])

    // Start a run
    const startExistingRun = useCallback(async (runId: string): Promise<void> => {
        await startRun(runId)
        // Refetch to get updated status
        await fetchRuns()
    }, [fetchRuns])

    // Stop a run
    const stopExistingRun = useCallback(async (runId: string): Promise<void> => {
        await stopRun(runId)
        await fetchRuns()
    }, [fetchRuns])

    // Archive a run
    const archiveExistingRun = useCallback(async (runId: string): Promise<void> => {
        await archiveRun(runId)
        await fetchRuns()
    }, [fetchRuns])

    // Unarchive a run
    const unarchiveExistingRun = useCallback(async (runId: string): Promise<void> => {
        await unarchiveRun(runId)
        await fetchRuns()
    }, [fetchRuns])

    // Update a run locally (for UI changes like favorites, notes, etc.)
    const updateRun = useCallback((updatedRun: ExperimentRun) => {
        const previousRun = runsRef.current.find((run) => run.id === updatedRun.id)
        persistRunMetadata(updatedRun)
        setRuns(prev => prev.map(r =>
            r.id === updatedRun.id ? updatedRun : r
        ))

        if (previousRun && previousRun.isArchived !== updatedRun.isArchived) {
            const persistArchiveState = async () => {
                try {
                    if (updatedRun.isArchived) {
                        await archiveRun(updatedRun.id)
                    } else {
                        await unarchiveRun(updatedRun.id)
                    }
                    await fetchRuns()
                } catch (error) {
                    console.error('Failed to persist archive state:', error)
                }
            }
            void persistArchiveState()
        }
    }, [fetchRuns])

    return {
        runs,
        isLoading,
        error,
        refetch: fetchRuns,
        createNewRun,
        startExistingRun,
        stopExistingRun,
        archiveExistingRun,
        unarchiveExistingRun,
        updateRun,
    }
}
