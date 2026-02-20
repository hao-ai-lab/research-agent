'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createSweep,
  listSweeps,
  startSweep,
  updateSweep,
} from '@/lib/api-client'
import type { Sweep as ApiSweep } from '@/lib/api-client'
import type { Sweep, SweepConfig } from '@/lib/types'
import {
  mapApiSweepToUiSweep,
  sweepConfigToCreateRequest,
  sweepConfigToUpdateRequest,
} from '@/lib/sweep-mappers'

interface UseSweepsResult {
  sweeps: Sweep[]
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
  saveDraftSweep: (config: SweepConfig, chatSessionId?: string | null) => Promise<Sweep>
  launchSweepFromConfig: (config: SweepConfig, chatSessionId?: string | null) => Promise<Sweep>
}

function isSweepActive(status: Sweep['status']) {
  return status === 'running' || status === 'pending'
}

function findSweepForConfig(sweeps: Sweep[], config: SweepConfig): Sweep | null {
  return (
    sweeps.find((sweep) => sweep.id === config.id) ||
    sweeps.find((sweep) => sweep.config.id === config.id) ||
    null
  )
}

export function useSweeps(): UseSweepsResult {
  const [sweeps, setSweeps] = useState<Sweep[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const sweepsRef = useRef<Sweep[]>([])
  const inFlightFetchRef = useRef<Promise<void> | null>(null)
  const lastFetchedAtRef = useRef(0)
  const BASELINE_POLL_MS = 15000
  const ACTIVE_POLL_MS = 5000
  sweepsRef.current = sweeps

  const fetchSweeps = useCallback(async () => {
    if (inFlightFetchRef.current) {
      return inFlightFetchRef.current
    }
    const request = (async () => {
      try {
        const apiSweeps = await listSweeps()
        const mapped = apiSweeps.map(mapApiSweepToUiSweep)
        setSweeps(mapped)
        setError(null)
        lastFetchedAtRef.current = Date.now()
      } catch (e) {
        console.error('Failed to fetch sweeps:', e)
        setError(e instanceof Error ? e.message : 'Failed to fetch sweeps')
      } finally {
        setIsLoading(false)
      }
    })()
    inFlightFetchRef.current = request
    try {
      await request
    } finally {
      inFlightFetchRef.current = null
    }
  }, [])

  useEffect(() => {
    fetchSweeps()

    pollingRef.current = setInterval(() => {
      const hasActiveSweeps = sweepsRef.current.some((sweep) => isSweepActive(sweep.status))
      const msSinceLastFetch = Date.now() - lastFetchedAtRef.current
      const shouldBaselineRefresh = msSinceLastFetch >= BASELINE_POLL_MS
      if (hasActiveSweeps || shouldBaselineRefresh) {
        fetchSweeps()
      }
    }, ACTIVE_POLL_MS)

    const refreshOnFocus = () => {
      fetchSweeps()
    }
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchSweeps()
      }
    }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisible)

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
      }
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisible)
    }
  }, [fetchSweeps, ACTIVE_POLL_MS, BASELINE_POLL_MS])

  const saveDraftSweep = useCallback(async (config: SweepConfig, chatSessionId?: string | null): Promise<Sweep> => {
    const existing = findSweepForConfig(sweepsRef.current, config)

    let apiSweep: ApiSweep
    if (existing && (existing.status === 'draft' || existing.status === 'pending')) {
      try {
        apiSweep = await updateSweep(existing.id, sweepConfigToUpdateRequest(config, 'draft'))
      } catch {
        // If the server rejects in-place mutation (e.g. sweep already has runs), create a new draft revision.
        apiSweep = await createSweep(sweepConfigToCreateRequest(config, 'draft', chatSessionId))
      }
    } else {
      apiSweep = await createSweep(sweepConfigToCreateRequest(config, 'draft', chatSessionId))
    }

    await fetchSweeps()
    return mapApiSweepToUiSweep(apiSweep)
  }, [fetchSweeps])

  const launchSweepFromConfig = useCallback(async (config: SweepConfig, chatSessionId?: string | null): Promise<Sweep> => {
    const existing = findSweepForConfig(sweepsRef.current, config)
    const parallel = Math.max(1, config.parallelRuns || 1)

    let targetSweepId: string
    if (existing && existing.runIds.length > 0 && (existing.status === 'pending' || existing.status === 'running')) {
      targetSweepId = existing.id
    } else {
      const createdSweep = await createSweep(sweepConfigToCreateRequest(config, 'pending', chatSessionId))
      targetSweepId = createdSweep.id
    }

    await startSweep(targetSweepId, parallel)
    await fetchSweeps()

    const latest = sweepsRef.current.find((sweep) => sweep.id === targetSweepId)
    if (latest) return latest

    const latestFromApi = (await listSweeps()).find((sweep) => sweep.id === targetSweepId)
    if (!latestFromApi) {
      throw new Error(`Sweep not found after launch: ${targetSweepId}`)
    }
    return mapApiSweepToUiSweep(latestFromApi)
  }, [fetchSweeps])

  return {
    sweeps,
    isLoading,
    error,
    refetch: fetchSweeps,
    saveDraftSweep,
    launchSweepFromConfig,
  }
}
