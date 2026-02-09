'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detectCluster,
  getClusterStatus,
  updateCluster,
  type ClusterState,
  type ClusterStatusResponse,
  type ClusterType,
  type ClusterUpdateRequest,
} from '@/lib/api-client'

interface UseClusterResult {
  cluster: ClusterState | null
  runSummary: ClusterStatusResponse['run_summary'] | null
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
  autoDetect: (preferredType?: ClusterType) => Promise<void>
  saveCluster: (request: ClusterUpdateRequest) => Promise<void>
}

export function useCluster(): UseClusterResult {
  const [cluster, setCluster] = useState<ClusterState | null>(null)
  const [runSummary, setRunSummary] = useState<ClusterStatusResponse['run_summary'] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const fetchCluster = useCallback(async () => {
    try {
      const response = await getClusterStatus()
      setCluster(response.cluster)
      setRunSummary(response.run_summary)
      setError(null)
    } catch (e) {
      console.error('Failed to fetch cluster status:', e)
      setError(e instanceof Error ? e.message : 'Failed to fetch cluster status')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchCluster()

    pollingRef.current = setInterval(() => {
      void fetchCluster()
    }, 15000)

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
      }
    }
  }, [fetchCluster])

  const autoDetect = useCallback(async (preferredType?: ClusterType) => {
    const response = await detectCluster(preferredType ? { preferred_type: preferredType } : undefined)
    setCluster(response.cluster)
    setRunSummary(response.run_summary)
    setError(null)
  }, [])

  const saveCluster = useCallback(async (request: ClusterUpdateRequest) => {
    const response = await updateCluster(request)
    setCluster(response.cluster)
    setRunSummary(response.run_summary)
    setError(null)
  }, [])

  return {
    cluster,
    runSummary,
    isLoading,
    error,
    refetch: fetchCluster,
    autoDetect,
    saveCluster,
  }
}
