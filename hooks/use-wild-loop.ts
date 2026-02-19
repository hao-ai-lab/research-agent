'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import type { WildModeSetup } from '@/lib/types'
import {
  startWildV2,
  stopWildV2,
  pauseWildV2,
  resumeWildV2,
  getWildV2Status,
  steerWildV2,
} from '@/lib/api'
import type { WildV2Status, WildV2IterationHistory } from '@/lib/api'
import type { Alert } from '@/lib/api'
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
  // State
  isActive: boolean
  isPaused: boolean
  phase: WildLoopPhase
  stage: WildLoopStage
  iteration: number
  maxIterations: number
  goal: string | null
  startedAt: number | null
  terminationConditions: TerminationConditions
  sweepId: string | null
  runStats: RunStats
  activeAlerts: Alert[]

  // V2-specific
  v2Status: string | null        // running | paused | done | failed
  tasks: string                  // tasks.md content
  history: WildV2IterationHistory[]
  noProgressStreak: number
  shortIterationCount: number
  pendingEvents: Array<{ id: string; type: string; title: string; detail: string }>

  // Lifecycle
  start: (goal: string, sessionId: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setTerminationConditions: (conditions: TerminationConditions) => void
  applySetup: (setup: WildModeSetup) => void
  steer: (context: string) => void

  // Queue API
  eventQueue: QueuedEvent[]
  reorderQueue: (orderedIds: string[]) => void
  removeFromQueue: (id: string) => void
  insertIntoQueue: (event: QueuedEvent, index?: number) => void
}

const DEFAULT_RUN_STATS: RunStats = { total: 0, running: 0, completed: 0, failed: 0, queued: 0 }

/**
 * useWildLoop — Thin polling client for the V2 backend-driven Wild Loop engine.
 *
 * V2 Architecture: The backend (WildV2Engine) runs its own async loop,
 * creating OpenCode sessions and sending prompts autonomously.
 * This hook only:
 *   1. Polls GET /wild/v2/status every 2s to read backend state
 *   2. Exposes lifecycle methods (start/stop/pause/resume/steer)
 *   3. Maps V2 status to frontend display state
 *
 * Unlike V1, there is NO prompt polling, no autoSend, no response-complete bridge.
 * The backend handles all iteration logic.
 */
export function useWildLoop(): UseWildLoopResult {
  // ---- State (derived from backend polling) ----
  const [status, setStatus] = useState<WildV2Status | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status

  // Store the latest WildModeSetup so start() can include evo_sweep_enabled
  const setupRef = useRef<WildModeSetup | null>(null)

  // ---- Poll backend status every 2s ----
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const s = await getWildV2Status()
        if (!cancelled) setStatus(s)
      } catch (err) {
        console.warn('[wild-loop-v2] Status poll failed:', err)
      }
    }

    poll() // immediate first poll
    const id = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // ---- Lifecycle actions ----

  const start = useCallback(async (goal: string, sessionId: string) => {
    try {
      console.log('[wild-loop-v2] Starting: goal=%s session=%s', goal, sessionId)
      const s = await startWildV2({
        goal,
        chat_session_id: sessionId,
        evo_sweep_enabled: setupRef.current?.evoSweepEnabled ?? false,
      })
      setStatus(s)
    } catch (err) {
      console.error('[wild-loop-v2] Start failed:', err)
    }
  }, [])

  const stop = useCallback(async () => {
    try {
      console.log('[wild-loop-v2] Stopping')
      const s = await stopWildV2()
      setStatus(s)
    } catch (err) {
      console.error('[wild-loop-v2] Stop failed:', err)
    }
  }, [])

  const pause = useCallback(async () => {
    try {
      console.log('[wild-loop-v2] Pausing')
      const s = await pauseWildV2()
      setStatus(s)
    } catch (err) {
      console.error('[wild-loop-v2] Pause failed:', err)
    }
  }, [])

  const resume = useCallback(async () => {
    try {
      console.log('[wild-loop-v2] Resuming')
      const s = await resumeWildV2()
      setStatus(s)
    } catch (err) {
      console.error('[wild-loop-v2] Resume failed:', err)
    }
  }, [])

  const steer = useCallback(async (context: string) => {
    try {
      console.log('[wild-loop-v2] Steering with context:', context.slice(0, 50))
      await steerWildV2(context)
    } catch (err) {
      console.error('[wild-loop-v2] Steer failed:', err)
    }
  }, [])

  // ---- Termination conditions (configure via start params) ----

  const setTerminationConditions = useCallback(async (_conditions: TerminationConditions) => {
    // V2 sets max_iterations at start time. Runtime updates not yet supported.
    console.warn('[wild-loop-v2] Runtime termination config not yet supported in V2')
  }, [])

  // ---- Queue operations ----

  const reorderQueue = useCallback((_orderedIds: string[]) => {
    console.warn('[wild-loop-v2] Queue reorder not yet implemented')
  }, [])

  const removeFromQueue = useCallback((_id: string) => {
    console.warn('[wild-loop-v2] Queue remove not yet implemented')
  }, [])

  const insertIntoQueue = useCallback(async (_event: QueuedEvent, _index?: number) => {
    console.warn('[wild-loop-v2] Queue insert not yet implemented')
  }, [])

  // ---- Apply setup from WildModeSetupPanel ----

  const applySetup = useCallback(async (_setup: WildModeSetup) => {
    // Store setup for use when start() is called
    setupRef.current = _setup
    console.log('[wild-loop-v2] Setup saved (evoSweep=%s)', _setup.evoSweepEnabled)
  }, [])

  // ---- Derive return values from V2 backend state ----

  const isActive = status?.active ?? false
  const isPaused = status?.status === 'paused'
  const v2Status = status?.status ?? null
  const iteration = status?.iteration ?? 0
  const maxIterations = status?.max_iterations ?? 25
  const goal = status?.goal ?? null
  const startedAt = status?.started_at ?? null
  const tasks = status?.plan ?? ''
  const history = status?.history ?? []
  const noProgressStreak = status?.no_progress_streak ?? 0
  const shortIterationCount = status?.short_iteration_count ?? 0
  const pendingEvents = status?.pending_events ?? []

  // Map V2 status to V1-compatible phase for UI components that use it
  const phase: WildLoopPhase = isActive
    ? isPaused ? 'paused' : 'exploring'
    : 'idle'

  // Derive stage from iteration progress
  const stage: WildLoopStage = 'exploring'

  const runStats: RunStats = status?.system_health
    ? {
      total: status.system_health.total,
      running: status.system_health.running,
      completed: status.system_health.completed,
      failed: status.system_health.failed,
      queued: status.system_health.queued,
    }
    : DEFAULT_RUN_STATS

  const terminationConditions: TerminationConditions = {
    maxIterations: maxIterations,
    maxTimeSeconds: null,
    maxTokens: null,
    customCondition: null,
  }

  // Map pending events to QueuedEvent type for the EventQueuePanel
  const eventQueue: QueuedEvent[] = pendingEvents.map((e) => ({
    id: e.id,
    priority: 5,
    title: e.title,
    prompt: e.detail,
    type: e.type as QueuedEvent['type'],
    createdAt: Date.now(),
  }))

  return {
    isActive,
    isPaused,
    phase,
    stage,
    iteration,
    maxIterations,
    goal,
    startedAt,
    terminationConditions,
    sweepId: null,
    runStats,
    activeAlerts: [],
    v2Status,
    tasks,
    history,
    noProgressStreak,
    shortIterationCount,
    pendingEvents,
    start,
    pause,
    resume,
    stop,
    setTerminationConditions,
    applySetup,
    steer,
    eventQueue,
    reorderQueue,
    removeFromQueue,
    insertIntoQueue,
  }
}
