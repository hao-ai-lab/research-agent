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

  // Use refs for values accessed in callbacks to avoid stale closures
  const isActiveRef = useRef(isActive)
  const isPausedRef = useRef(isPaused)
  const iterationRef = useRef(iteration)
  const goalRef = useRef(goal)
  const terminationRef = useRef(terminationConditions)
  const startedAtRef = useRef(startedAt)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { iterationRef.current = iteration }, [iteration])
  useEffect(() => { goalRef.current = goal }, [goal])
  useEffect(() => { terminationRef.current = terminationConditions }, [terminationConditions])
  useEffect(() => { startedAtRef.current = startedAt }, [startedAt])

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
      stop()
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
