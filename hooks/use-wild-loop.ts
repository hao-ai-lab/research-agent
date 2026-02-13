'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import type { PromptProvenance, WildModeSetup } from '@/lib/types'
import {
  getWildLoopStatus,
  startWildLoop, stopWildLoop, pauseWildLoop, resumeWildLoop,
  wildResponseComplete,
  getWildNextPrompt, consumeWildPrompt,
  steerWildLoop,
  configureWildLoop,
  enqueueWildEvent,
  getWildEventQueue,
} from '@/lib/api'
import type { WildLoopStatus, WildNextPrompt, Alert } from '@/lib/api'
import type { QueuedEvent } from '@/lib/event-queue'

export interface WildLoopSignal {
  type: 'CONTINUE' | 'COMPLETE' | 'NEEDS_HUMAN'
}

export type WildLoopStage = 'exploring' | 'running' | 'analyzing'

export interface RunStats {
  total: number
  running: number
  completed: number
  failed: number
  queued: number
}

export interface UseWildLoopResult {
  isActive: boolean
  isPaused: boolean
  phase: WildLoopPhase
  stage: WildLoopStage
  iteration: number
  goal: string | null
  startedAt: number | null
  terminationConditions: TerminationConditions
  sweepId: string | null
  runStats: RunStats
  activeAlerts: Alert[]
  start: (goal: string, sessionId: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setTerminationConditions: (conditions: TerminationConditions) => void
  applySetup: (setup: WildModeSetup) => void
  onResponseComplete: (responseText: string) => void
  pendingPrompt: string | null
  pendingProvenance: PromptProvenance | null
  pendingDisplayMessage: string | null
  consumePrompt: () => void
  // Queue API
  eventQueue: QueuedEvent[]
  reorderQueue: (orderedIds: string[]) => void
  removeFromQueue: (id: string) => void
  insertIntoQueue: (event: QueuedEvent, index?: number) => void
}

const DEFAULT_RUN_STATS: RunStats = { total: 0, running: 0, completed: 0, failed: 0, queued: 0 }

/**
 * useWildLoop — Thin polling client for the backend-driven Wild Loop engine.
 *
 * All state is owned by the backend (WildLoopEngine in wild_loop.py).
 * This hook:
 *   1. Polls GET /wild/status every 1.5s to read backend state
 *   2. Polls GET /wild/next-prompt every 1s while active & not streaming
 *   3. Exposes lifecycle methods as thin API wrappers
 *   4. Bridges response completion: frontend calls onResponseComplete(text)
 *      which hits POST /wild/response-complete
 */
export function useWildLoop(): UseWildLoopResult {
  // ---- State (derived from backend polling) ----
  const [status, setStatus] = useState<WildLoopStatus | null>(null)
  const [nextPrompt, setNextPrompt] = useState<WildNextPrompt | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status

  // ---- Poll backend status every 1.5s ----
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const s = await getWildLoopStatus()
        if (!cancelled) setStatus(s)
      } catch (err) {
        console.warn('[wild-loop] Status poll failed:', err)
      }
    }

    poll() // immediate first poll
    const id = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // ---- Poll next prompt every 1s while active ----
  useEffect(() => {
    if (!status?.is_active || status?.is_paused) {
      setNextPrompt(null)
      return
    }

    let cancelled = false

    const pollPrompt = async () => {
      try {
        const np = await getWildNextPrompt()
        if (!cancelled) setNextPrompt(np)
      } catch (err) {
        console.warn('[wild-loop] Next prompt poll failed:', err)
      }
    }

    pollPrompt() // immediate first poll
    const id = setInterval(pollPrompt, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [status?.is_active, status?.is_paused])

  // ---- Lifecycle actions ----

  const start = useCallback(async (goal: string, sessionId: string) => {
    try {
      console.log('[wild-loop] Starting: goal=%s session=%s', goal, sessionId)
      const s = await startWildLoop({ goal, session_id: sessionId })
      setStatus(s as WildLoopStatus)
    } catch (err) {
      console.error('[wild-loop] Start failed:', err)
    }
  }, [])

  const stop = useCallback(async () => {
    try {
      console.log('[wild-loop] Stopping')
      const s = await stopWildLoop()
      setStatus(s as WildLoopStatus)
      setNextPrompt(null)
    } catch (err) {
      console.error('[wild-loop] Stop failed:', err)
    }
  }, [])

  const pause = useCallback(async () => {
    try {
      console.log('[wild-loop] Pausing')
      const s = await pauseWildLoop()
      setStatus(s as WildLoopStatus)
    } catch (err) {
      console.error('[wild-loop] Pause failed:', err)
    }
  }, [])

  const resume = useCallback(async () => {
    try {
      console.log('[wild-loop] Resuming')
      const s = await resumeWildLoop()
      setStatus(s as WildLoopStatus)
    } catch (err) {
      console.error('[wild-loop] Resume failed:', err)
    }
  }, [])

  // ---- Response completion bridge ----

  const onResponseComplete = useCallback(async (responseText: string) => {
    try {
      console.log('[wild-loop] Response complete, text length:', responseText.length)
      const s = await wildResponseComplete(responseText)
      setStatus(s as WildLoopStatus)
      // Clear next prompt so we fetch the new one
      setNextPrompt(null)
    } catch (err) {
      console.error('[wild-loop] Response complete failed:', err)
    }
  }, [])

  // ---- Prompt consumption ----

  const consumePromptFn = useCallback(async () => {
    try {
      await consumeWildPrompt()
      setNextPrompt(null)
    } catch (err) {
      console.error('[wild-loop] Consume prompt failed:', err)
    }
  }, [])

  // ---- Termination conditions ----

  const setTerminationConditions = useCallback(async (conditions: TerminationConditions) => {
    try {
      await configureWildLoop({
        max_iterations: conditions.maxIterations ?? undefined,
        max_time_seconds: conditions.maxTimeSeconds ?? undefined,
        max_tokens: conditions.maxTokens ?? undefined,
        custom_condition: conditions.customCondition ?? undefined,
      })
    } catch (err) {
      console.error('[wild-loop] Configure termination failed:', err)
    }
  }, [])

  // ---- Queue operations (delegate to backend) ----

  const reorderQueue = useCallback((_orderedIds: string[]) => {
    // TODO: Backend reorder endpoint not yet implemented
    console.warn('[wild-loop] Queue reorder not yet implemented in backend')
  }, [])

  const removeFromQueue = useCallback((_id: string) => {
    // TODO: Backend remove-from-queue endpoint
    console.warn('[wild-loop] Queue remove not yet implemented in backend')
  }, [])

  const insertIntoQueue = useCallback(async (event: QueuedEvent, _index?: number) => {
    try {
      await enqueueWildEvent({
        priority: event.priority,
        title: event.title,
        prompt: event.prompt,
        type: event.type,
      })
    } catch (err) {
      console.error('[wild-loop] Insert into queue failed:', err)
    }
  }, [])

  // ---- Derive return values from backend state ----

  const isActive = status?.is_active ?? false
  const isPaused = status?.is_paused ?? false
  const phase = (status?.phase ?? 'idle') as WildLoopPhase
  const stage = (status?.stage ?? 'exploring') as WildLoopStage
  const iteration = status?.iteration ?? 0
  const goal = status?.goal ?? null
  const startedAt = status?.started_at ?? null
  const sweepId = status?.sweep_id ?? null
  const runStats: RunStats = status?.run_stats ?? DEFAULT_RUN_STATS
  const activeAlerts: Alert[] = status?.active_alerts ?? []

  const termination = status?.termination
  const terminationConditions: TerminationConditions = {
    maxIterations: termination?.max_iterations ?? null,
    maxTimeSeconds: termination?.max_time_seconds ?? null,
    maxTokens: termination?.max_tokens ?? null,
    customCondition: termination?.custom_condition ?? null,
  }

  // Map backend queue events to frontend QueuedEvent type, excluding the active/pending item
  const pendingEventId = status?.pending_event_id ?? null
  const eventQueue: QueuedEvent[] = (status?.queue_events ?? [])
    .filter((e) => e.id !== pendingEventId)
    .map((e) => ({
      id: e.id,
      priority: e.priority,
      title: e.title,
      prompt: e.prompt,
      type: e.type as QueuedEvent['type'],
      createdAt: e.created_at,
    }))

  // ---- Apply setup from WildModeSetupPanel ----

  const applySetup = useCallback(async (setup: WildModeSetup) => {
    try {
      await configureWildLoop({
        max_time_seconds: setup.awayDurationMinutes * 60,
        autonomy_level: setup.autonomyLevel,
        queue_modify_enabled: setup.queueModifyEnabled,
      })
    } catch (err) {
      console.error('[wild-loop] Apply setup failed:', err)
    }
  }, [])

  // Derive pending prompt from the next-prompt poll
  const pendingPrompt = nextPrompt?.has_prompt ? (nextPrompt.prompt ?? null) : null
  const pendingDisplayMessage = nextPrompt?.has_prompt ? (nextPrompt.display_message ?? null) : null
  const pendingProvenance = nextPrompt?.has_prompt ? (nextPrompt.provenance as PromptProvenance | null ?? null) : null

  return {
    isActive,
    isPaused,
    phase,
    stage,
    iteration,
    goal,
    startedAt,
    terminationConditions,
    sweepId,
    runStats,
    activeAlerts,
    start,
    pause,
    resume,
    stop,
    setTerminationConditions,
    applySetup,
    onResponseComplete,
    pendingPrompt,
    pendingProvenance,
    pendingDisplayMessage,
    consumePrompt: consumePromptFn,
    eventQueue,
    reorderQueue,
    removeFromQueue,
    insertIntoQueue,
  }
}
