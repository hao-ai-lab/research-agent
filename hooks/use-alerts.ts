'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
    listAlerts,
    respondToAlert,
    type Alert,
} from '@/lib/api-client'

interface UseAlertsResult {
    alerts: Alert[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<void>
    respond: (alertId: string, choice: string) => Promise<void>
}

export function useAlerts(): UseAlertsResult {
    const [alerts, setAlerts] = useState<Alert[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const pollingRef = useRef<NodeJS.Timeout | null>(null)

    const fetchAlerts = useCallback(async () => {
        try {
            const nextAlerts = await listAlerts()
            setAlerts(nextAlerts)
            setError(null)
        } catch (e) {
            console.error('Failed to fetch alerts:', e)
            setError(e instanceof Error ? e.message : 'Failed to fetch alerts')
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchAlerts()

        pollingRef.current = setInterval(() => {
            fetchAlerts()
        }, 5000)

        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current)
            }
        }
    }, [fetchAlerts])

    const respond = useCallback(async (alertId: string, choice: string) => {
        await respondToAlert(alertId, choice)
        await fetchAlerts()
    }, [fetchAlerts])

    return {
        alerts,
        isLoading,
        error,
        refetch: fetchAlerts,
        respond,
    }
}
