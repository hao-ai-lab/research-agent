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

// Convert API Run to ExperimentRun for UI compatibility
function apiRunToExperimentRun(run: Run): ExperimentRun {
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

    return {
        id: run.id,
        name: run.name,
        command: run.command,
        status: statusMap[run.status],
        progress: run.progress ?? (run.status === 'running' ? 50 : run.status === 'finished' ? 100 : 0),
        startTime: new Date(run.created_at * 1000),
        endTime: run.ended_at ? new Date(run.ended_at * 1000) : undefined,
        isArchived: run.is_archived,
        parentRunId: run.parent_run_id || undefined,
        originAlertId: run.origin_alert_id || undefined,
        isFavorite: false,
        tags: [],
        notes: '',
        color: run.color || '#4ade80',
        // Pass through metrics/charts from API (mock or real)
        lossHistory: run.lossHistory,
        metrics: run.metrics,
        config: run.config as ExperimentRun['config'],
        // Include API-specific fields for terminal panel
        tmux_window: run.tmux_window,
        tmux_pane: run.tmux_pane,
        run_dir: run.run_dir,
        exit_code: run.exit_code,
        error: run.error,
        wandb_dir: run.wandb_dir,
    } as ExperimentRun & {
        tmux_window?: string
        tmux_pane?: string
        run_dir?: string
        exit_code?: number | null
        error?: string | null
        wandb_dir?: string | null
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
            const experimentRuns = apiRuns.map(apiRunToExperimentRun)
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
        const experimentRun = apiRunToExperimentRun(apiRun)
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
    }, [])

    // Update a run locally (for UI changes like favorites, notes, etc.)
    const updateRun = useCallback((updatedRun: ExperimentRun) => {
        setRuns(prev => prev.map(r =>
            r.id === updatedRun.id ? updatedRun : r
        ))
    }, [])

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
