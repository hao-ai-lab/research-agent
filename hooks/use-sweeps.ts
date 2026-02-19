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
  sweepsRef.current = sweeps

  const fetchSweeps = useCallback(async () => {
    try {
      const apiSweeps = await listSweeps()
      const mapped = apiSweeps.map(mapApiSweepToUiSweep)
      setSweeps(mapped)
      setError(null)
    } catch (e) {
      console.error('Failed to fetch sweeps:', e)
      setError(e instanceof Error ? e.message : 'Failed to fetch sweeps')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSweeps()

    pollingRef.current = setInterval(() => {
      const hasActiveSweeps = sweepsRef.current.some((sweep) => isSweepActive(sweep.status))
      if (hasActiveSweeps) {
        fetchSweeps()
      }
    }, 5000)

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
      }
    }
  }, [fetchSweeps])

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
