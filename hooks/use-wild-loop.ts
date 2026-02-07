'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  WildLoopPhase,
  WildLoopState,
  WildSystemEvent,
  TerminationCondition,
  ExperimentRun,
} from '@/lib/types'
import type { ChatMode } from '@/components/chat-input'
import type { UseChatSessionResult } from '@/hooks/use-chat-session'
import type { Alert, ChatMessageData } from '@/lib/api-client'
import { streamWildEvents } from '@/lib/api-client'
import { getApiUrl, getAuthToken } from '@/lib/api-config'

export interface UseWildLoopResult {
  state: WildLoopState | null
  systemEvents: WildSystemEvent[]
  isActive: boolean
  isPaused: boolean
  startLoop: (goal: string, conditions: TerminationCondition) => void
  pauseLoop: () => void
  resumeLoop: () => void
  stopLoop: () => void
}

interface UseWildLoopParams {
  chatSession: UseChatSessionResult
  runs: ExperimentRun[]
  alerts: Alert[]
  mode: ChatMode
}

export function useWildLoop({
  chatSession,
  runs,
  alerts,
  mode,
}: UseWildLoopParams): UseWildLoopResult {
  const [state, setState] = useState<WildLoopState | null>(null)
  const [systemEvents, setSystemEvents] = useState<WildSystemEvent[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const getHeaders = useCallback(() => {
    const headers: HeadersInit = { 'Content-Type': 'application/json' }
    const token = getAuthToken()
    if (token) headers['X-Auth-Token'] = token
    return headers
  }, [])
  
  // Polling for status (phase, iteration, logs)
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const headers = { 'Content-Type': 'application/json' } as any
        const token = getAuthToken()
        if (token) headers['X-Auth-Token'] = token

        const res = await fetch(`${getApiUrl()}/wild/status`, { headers })
        if (res.ok) {
           const data = await res.json()
           if (mounted) {
             setState(data)
           }
        } else {
             if (mounted) setState(null)
        }
      } catch (e) {
        console.error("Failed to poll wild status", e)
      }
    }

    const interval = setInterval(poll, 2000)
    poll() // Initial call

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  // SSE subscription for real-time wild mode chat events
  useEffect(() => {
    const isActive = state !== null && state.phase !== 'idle'
    
    if (!isActive) {
      // Clean up if loop is no longer active
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      return
    }

    // Already connected
    if (abortRef.current) return

    const controller = new AbortController()
    abortRef.current = controller

    const subscribe = async () => {
      let retries = 0
      const maxRetries = 5
      
      while (retries < maxRetries && !controller.signal.aborted) {
        try {
          console.log(`[wild-loop] Connecting to /wild/events SSE... (attempt ${retries + 1})`)
          for await (const event of streamWildEvents(controller.signal)) {
            retries = 0 // Reset on successful event
            
            if (event.type === 'wild_stopped') {
              console.log('[wild-loop] Wild loop stopped signal received')
              return
            }

            if (event.type === 'wild_chat' && !event.hidden && event.content) {
              const msg: ChatMessageData = {
                role: (event.role as 'user' | 'assistant') || 'assistant',
                content: event.content,
                timestamp: event.timestamp || Date.now() / 1000,
              }
              chatSession.injectMessage(msg)
            }
          }
          // Stream ended normally
          break
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return // Expected on cleanup
          }
          retries++
          console.warn(`[wild-loop] SSE connection failed (attempt ${retries}/${maxRetries}):`, err instanceof Error ? err.message : err)
          if (retries < maxRetries && !controller.signal.aborted) {
            // Backoff: 1s, 2s, 4s, 8s, 16s
            await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, retries - 1), 16000)))
          }
        }
      }
    }

    subscribe().finally(() => {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    })

    return () => {
      controller.abort()
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }, [state, chatSession])

  const isActive = state !== null && state.phase !== 'idle'
  const isPaused = state?.isPaused ?? false

  const startLoop = useCallback(async (goal: string, conditions: TerminationCondition) => {
    try {
        const url = `${getApiUrl()}/wild/start`;
        console.log("Wild Loop Start URL:", url);
        await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ goal, conditions }),
        })
    } catch (e) {
        console.error("Failed to start loop", e)
    }
  }, [])

  const stopLoop = useCallback(async () => {
    try {
        await fetch(`${getApiUrl()}/wild/stop`, { 
            method: 'POST',
            headers: getHeaders()
        })
        setState(null)
        // Clean up SSE connection
        if (abortRef.current) {
          abortRef.current.abort()
          abortRef.current = null
        }
    } catch (e) {
        console.error("Failed to stop loop", e)
    }
  }, [])
  
  const pauseLoop = useCallback(async () => {
      console.warn("Pause not yet implemented in backend")
  }, [])

  const resumeLoop = useCallback(async () => {
      console.warn("Resume not yet implemented in backend")
  }, [])


  return {
    state,
    systemEvents,
    isActive,
    isPaused,
    startLoop,
    pauseLoop,
    resumeLoop,
    stopLoop,
  }
}
