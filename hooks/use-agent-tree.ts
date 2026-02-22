'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchAgentTree, type AgentTreeNode, type AgentTreeResponse } from '@/lib/api'

const POLL_INTERVAL = 5000 // 5 seconds

export interface UseAgentTreeResult {
    nodes: AgentTreeNode[]
    sweepNodes: AgentTreeNode[]
    runNodes: AgentTreeNode[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<void>
}

/**
 * Hook that fetches the agent hierarchy tree and polls when any node is active.
 *
 * Returns typed AgentTreeNode[] organized by type (sweeps and runs).
 */
export function useAgentTree(): UseAgentTreeResult {
    const [nodes, setNodes] = useState<AgentTreeNode[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes

    const fetchData = useCallback(async () => {
        try {
            const data: AgentTreeResponse = await fetchAgentTree()
            setNodes(data.nodes || [])
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to fetch agent tree')
        } finally {
            setIsLoading(false)
        }
    }, [])

    // Initial fetch
    useEffect(() => {
        fetchData()
    }, [fetchData])

    // Poll when any node is running
    useEffect(() => {
        const hasActive = nodesRef.current.some(
            (n) => n.status === 'running' || n.status === 'idle'
        )
        if (!hasActive && !isLoading) return

        const interval = setInterval(fetchData, POLL_INTERVAL)
        return () => clearInterval(interval)
    }, [nodes, isLoading, fetchData])

    // Derived lists
    const sweepNodes = nodes.filter((n) => n.type === 'sweep')
    const runNodes = nodes.filter((n) => n.type === 'run')

    return {
        nodes,
        sweepNodes,
        runNodes,
        isLoading,
        error,
        refetch: fetchData,
    }
}
