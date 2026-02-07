'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import { updateWildLoopStatus, configureWildLoop, setWildMode, createWildSweep, getSweep, listAlerts } from '@/lib/api'
import type { Alert } from '@/lib/api'

export interface WildLoopSignal {
  type: 'CONTINUE' | 'COMPLETE' | 'NEEDS_HUMAN'
}

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
  iteration: number
  goal: string | null
  startedAt: number | null
  terminationConditions: TerminationConditions
  // Job monitoring
  sweepId: string | null
  runStats: RunStats
  activeAlerts: Alert[]
  // Actions
  start: (goal: string, sessionId: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setTerminationConditions: (conditions: TerminationConditions) => void
  // Called by chat system after each response completes
  onResponseComplete: (responseText: string) => void
  // The next auto-prompt to send (null when no prompt needed)
  pendingPrompt: string | null
  consumePrompt: () => void
}

/**
 * Parse promise tags from agent response text.
 * Supports both <promise>...</promise> (Ralph-style) and <signal>...</signal> (legacy).
 */
function parseSignal(text: string): WildLoopSignal | null {
  // Try <promise> first (Ralph-style), then <signal> (legacy)
  const promiseMatch = text.match(/<promise>(CONTINUE|COMPLETE|NEEDS_HUMAN)<\/promise>/)
  if (promiseMatch) {
    return { type: promiseMatch[1] as WildLoopSignal['type'] }
  }
  const signalMatch = text.match(/<signal>(CONTINUE|COMPLETE|NEEDS_HUMAN)<\/signal>/)
  if (signalMatch) {
    return { type: signalMatch[1] as WildLoopSignal['type'] }
  }
  return null
}

/**
 * Map signal + iteration context into a phase for display.
 */
function inferPhase(iteration: number, signal: WildLoopSignal | null): WildLoopPhase {
  if (!signal) return iteration <= 1 ? 'onboarding' : 'monitoring'
  switch (signal.type) {
    case 'CONTINUE':
      return iteration <= 2 ? 'designing' : 'monitoring'
    case 'COMPLETE':
      return 'complete'
    case 'NEEDS_HUMAN':
      return 'waiting_for_human'
  }
}

const emptyRunStats: RunStats = { total: 0, running: 0, completed: 0, failed: 0, queued: 0 }

export function useWildLoop(): UseWildLoopResult {
  const [isActive, setIsActive] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [phase, setPhase] = useState<WildLoopPhase>('idle')
  const [iteration, setIteration] = useState(0)
  const [goal, setGoal] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [terminationConditions, setTerminationConditionsState] = useState<TerminationConditions>({})

  // Job monitoring state
  const [sweepId, setSweepId] = useState<string | null>(null)
  const [runStats, setRunStats] = useState<RunStats>(emptyRunStats)
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([])

  // Use refs for values accessed in callbacks to avoid stale closures
  const isActiveRef = useRef(isActive)
  const isPausedRef = useRef(isPaused)
  const iterationRef = useRef(iteration)
  const goalRef = useRef(goal)
  const terminationRef = useRef(terminationConditions)
  const startedAtRef = useRef(startedAt)
  const sweepIdRef = useRef(sweepId)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { iterationRef.current = iteration }, [iteration])
  useEffect(() => { goalRef.current = goal }, [goal])
  useEffect(() => { terminationRef.current = terminationConditions }, [terminationConditions])
  useEffect(() => { startedAtRef.current = startedAt }, [startedAt])
  useEffect(() => { sweepIdRef.current = sweepId }, [sweepId])

  // ========== Job Monitoring: Poll sweep progress + alerts ==========
  useEffect(() => {
    if (!isActive || !sweepId) return

    const pollStatus = async () => {
      try {
        // Fetch sweep progress
        const sweep = await getSweep(sweepId)
        const progress = sweep.progress
        setRunStats({
          total: progress.total ?? 0,
          running: progress.running ?? 0,
          completed: progress.completed ?? 0,
          failed: progress.failed ?? 0,
          queued: (progress.queued ?? 0) + (progress.ready ?? 0),
        })

        // Fetch alerts filtered to runs in this sweep
        const runIds = new Set(sweep.run_ids || [])
        if (runIds.size > 0) {
          const allAlerts = await listAlerts()
          const relevant = allAlerts.filter(
            a => runIds.has(a.run_id) && a.status === 'pending'
          )
          setActiveAlerts(relevant)
        } else {
          setActiveAlerts([])
        }
      } catch (err) {
        console.warn('[wild-loop] Failed to poll sweep status:', err)
      }
    }

    // Poll immediately, then every 5s
    pollStatus()
    const intervalId = setInterval(pollStatus, 5000)
    return () => clearInterval(intervalId)
  }, [isActive, sweepId])

  const start = useCallback(async (newGoal: string, newSessionId: string) => {
    const now = Date.now() / 1000
    setIsActive(true)
    setIsPaused(false)
    setPhase('starting')
    setIteration(0)
    setGoal(newGoal)
    setStartedAt(now)
    setSessionId(newSessionId)
    setPendingPrompt(null)

    // Create wild sweep for job tracking
    try {
      const sweep = await createWildSweep(`Wild: ${newGoal.slice(0, 50)}`, newGoal)
      setSweepId(sweep.id)
      console.log('[wild-loop] Created wild sweep:', sweep.id)
    } catch (err) {
      console.error('[wild-loop] Failed to create wild sweep:', err)
      // Continue without sweep — loop still works, just no job monitoring
    }

    // Sync to backend — set goal + session + wild mode on
    setWildMode(true).catch(console.error)
    configureWildLoop({
      goal: newGoal,
      session_id: newSessionId,
    }).catch(console.error)
    updateWildLoopStatus({
      phase: 'starting',
      iteration: 0,
      goal: newGoal,
      session_id: newSessionId,
      is_paused: false,
    }).catch(console.error)
  }, [])

  const pause = useCallback(() => {
    setIsPaused(true)
    setPhase('paused')
    setPendingPrompt(null)
    updateWildLoopStatus({ phase: 'paused', is_paused: true }).catch(console.error)
  }, [])

  const resume = useCallback(() => {
    setIsPaused(false)
    const currentGoal = goalRef.current || 'Continue working on the experiment'
    setPhase('monitoring')
    // Trigger a continuation prompt using the same goal (Ralph-style: same prompt)
    setPendingPrompt(currentGoal)
    updateWildLoopStatus({ phase: 'monitoring', is_paused: false }).catch(console.error)
  }, [])

  const stop = useCallback(() => {
    setIsActive(false)
    setIsPaused(false)
    setPhase('idle')
    setIteration(0)
    setGoal(null)
    setStartedAt(null)
    setSessionId(null)
    setPendingPrompt(null)
    // Clear job monitoring
    setSweepId(null)
    setRunStats(emptyRunStats)
    setActiveAlerts([])

    setWildMode(false).catch(console.error)
    updateWildLoopStatus({ phase: 'idle', iteration: 0, is_paused: false }).catch(console.error)
  }, [])

  const setTerminationConditions = useCallback((conditions: TerminationConditions) => {
    setTerminationConditionsState(conditions)
    configureWildLoop({
      max_iterations: conditions.maxIterations ?? undefined,
      max_time_seconds: conditions.maxTimeSeconds ?? undefined,
      max_tokens: conditions.maxTokens ?? undefined,
      custom_condition: conditions.customCondition ?? undefined,
    }).catch(console.error)
  }, [])

  const consumePrompt = useCallback(() => {
    setPendingPrompt(null)
  }, [])

  /** Check if termination conditions are met */
  const checkTermination = useCallback((): boolean => {
    const conds = terminationRef.current
    const iter = iterationRef.current

    // Iteration limit
    if (conds.maxIterations && iter >= conds.maxIterations) {
      return true
    }

    // Time limit
    const started = startedAtRef.current
    if (conds.maxTimeSeconds && started) {
      const elapsed = (Date.now() / 1000) - started
      if (elapsed >= conds.maxTimeSeconds) {
        return true
      }
    }

    return false
  }, [])

  /**
   * Called by the chat system after each assistant response finishes streaming.
   * Parses the promise tag and decides whether to continue, stop, or pause.
   * 
   * KEY RALPH INSIGHT: We send the SAME goal every iteration.
   * The agent sees updated experiment state (injected by backend) each time.
   */
  const onResponseComplete = useCallback((responseText: string) => {
    if (!isActiveRef.current || isPausedRef.current) return

    const signal = parseSignal(responseText)
    const nextIteration = iterationRef.current + 1
    setIteration(nextIteration)

    const nextPhase = inferPhase(nextIteration, signal)
    setPhase(nextPhase)

    // Sync iteration to backend
    updateWildLoopStatus({
      phase: nextPhase,
      iteration: nextIteration,
    }).catch(console.error)

    // Check termination
    if (checkTermination()) {
      stop()
      return
    }

    if (!signal || signal.type === 'CONTINUE') {
      // Ralph-style: send the SAME goal again as the prompt.
      // The backend will wrap it with updated experiment state and iteration counter.
      const currentGoal = goalRef.current || 'Continue working'
      
      // Delay before next iteration to prevent hammering
      const delay = nextIteration <= 1 ? 1500 : 3000
      setTimeout(() => {
        if (isActiveRef.current && !isPausedRef.current) {
          setPendingPrompt(currentGoal)
        }
      }, delay)
    } else if (signal.type === 'COMPLETE') {
      // Demo/prototype mode: treat COMPLETE as CONTINUE.
      // The agent often declares completion prematurely (e.g. after creating a sweep
      // but before actually running experiments). Keep the loop going — user can
      // stop manually via the Stop button or termination conditions.
      console.log('[wild-loop] Agent signaled COMPLETE, treating as CONTINUE (demo mode)')
      const currentGoal = goalRef.current || 'Continue working'
      const delay = 3000
      setTimeout(() => {
        if (isActiveRef.current && !isPausedRef.current) {
          setPendingPrompt(currentGoal)
        }
      }, delay)
    } else if (signal.type === 'NEEDS_HUMAN') {
      pause()
      // Browser notification
      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification('Wild Loop needs attention', {
            body: 'The autonomous agent requires human intervention.',
            icon: '/favicon.ico',
          })
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission()
        }
      }
    }
  }, [checkTermination, stop, pause])

  return {
    isActive,
    isPaused,
    phase,
    iteration,
    goal,
    startedAt,
    terminationConditions,
    // Job monitoring
    sweepId,
    runStats,
    activeAlerts,
    // Actions
    start,
    pause,
    resume,
    stop,
    setTerminationConditions,
    onResponseComplete,
    pendingPrompt,
    consumePrompt,
  }
}
