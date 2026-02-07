'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import { updateWildLoopStatus, configureWildLoop, setWildMode } from '@/lib/api'

export interface WildLoopSignal {
  type: 'CONTINUE' | 'COMPLETE' | 'NEEDS_HUMAN'
}

export interface UseWildLoopResult {
  isActive: boolean
  isPaused: boolean
  phase: WildLoopPhase
  iteration: number
  goal: string | null
  startedAt: number | null
  terminationConditions: TerminationConditions
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
 * Parse signal tags from agent response text.
 * Looks for <signal>CONTINUE|COMPLETE|NEEDS_HUMAN</signal> in the response.
 */
function parseSignal(text: string): WildLoopSignal | null {
  const match = text.match(/<signal>(CONTINUE|COMPLETE|NEEDS_HUMAN)<\/signal>/)
  if (match) {
    return { type: match[1] as WildLoopSignal['type'] }
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

  const isActiveRef = useRef(isActive)
  const isPausedRef = useRef(isPaused)
  const iterationRef = useRef(iteration)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { iterationRef.current = iteration }, [iteration])

  const start = useCallback((newGoal: string, newSessionId: string) => {
    const now = Date.now() / 1000
    setIsActive(true)
    setIsPaused(false)
    setPhase('starting')
    setIteration(0)
    setGoal(newGoal)
    setStartedAt(now)
    setSessionId(newSessionId)
    setPendingPrompt(null)

    // Sync to backend
    setWildMode(true).catch(console.error)
    updateWildLoopStatus({
      phase: 'starting',
      iteration: 0,
      goal: newGoal,
      session_id: newSessionId,
      is_paused: false,
    }).catch(console.error)
    configureWildLoop({
      goal: newGoal,
      session_id: newSessionId,
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
    setPhase('monitoring')
    // Trigger a status check prompt
    setPendingPrompt(
      `[WILD LOOP RESUMED] Continue monitoring the experiment. Check current run/sweep status and proceed. What is the current state?`
    )
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
    const conds = terminationConditions
    const iter = iterationRef.current

    // Iteration limit
    if (conds.maxIterations && iter >= conds.maxIterations) {
      return true
    }

    // Time limit
    if (conds.maxTimeSeconds && startedAt) {
      const elapsed = (Date.now() / 1000) - startedAt
      if (elapsed >= conds.maxTimeSeconds) {
        return true
      }
    }

    return false
  }, [terminationConditions, startedAt])

  /**
   * Called by the chat system after each assistant response finishes streaming.
   * Parses the signal and decides whether to continue, stop, or pause.
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
      // Build next prompt — let the agent continue
      const nextPrompt = nextIteration <= 1
        ? `[WILD LOOP - Iteration ${nextIteration}] Design the experiment plan based on the goal. Create sweeps or runs as needed. Report what you plan to do.`
        : `[WILD LOOP - Iteration ${nextIteration}] Check the status of all runs and sweeps. Report on any completions, failures, or alerts. Take appropriate action.`

      // Small delay to prevent hammering
      setTimeout(() => {
        if (isActiveRef.current && !isPausedRef.current) {
          setPendingPrompt(nextPrompt)
        }
      }, 2000)
    } else if (signal.type === 'COMPLETE') {
      stop()
    } else if (signal.type === 'NEEDS_HUMAN') {
      pause()
      // TODO: trigger browser notification
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Wild Loop needs attention', {
          body: 'The autonomous agent requires human intervention.',
          icon: '/favicon.ico',
        })
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
