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
import type { Alert } from '@/lib/api-client'

// Snapshot for diff detection
interface RunSnapshot {
  id: string
  status: ExperimentRun['status']
}

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

const MIN_INTERVAL_MS = 5000

export function useWildLoop({
  chatSession,
  runs,
  alerts,
  mode,
}: UseWildLoopParams): UseWildLoopResult {
  const [state, setState] = useState<WildLoopState | null>(null)
  const [systemEvents, setSystemEvents] = useState<WildSystemEvent[]>([])

  // Refs for tracking
  const prevRunSnapshot = useRef<RunSnapshot[]>([])
  const lastSendTime = useRef<number>(0)
  const iterationTimerRef = useRef<NodeJS.Timeout | null>(null)

  const isActive = state !== null && state.phase !== 'idle'
  const isPaused = state?.isPaused ?? false

  // Request browser notification permission
  const requestNotificationPermission = useCallback(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Send browser notification
  const sendNotification = useCallback((title: string, body: string) => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body })
      } catch {
        // Notification API may not be available
      }
    }
  }, [])

  // Add system event
  const addSystemEvent = useCallback((type: WildSystemEvent['type'], summary: string, extra?: { runId?: string; alertId?: string }) => {
    const event: WildSystemEvent = {
      id: `wild-event-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      summary,
      timestamp: new Date(),
      runId: extra?.runId,
      alertId: extra?.alertId,
    }
    setSystemEvents(prev => [...prev, event])
    return event
  }, [])

  // Estimate tokens from text
  const estimateTokens = (text: string) => Math.ceil(text.length / 4)

  // Check termination conditions
  const checkTermination = useCallback((currentState: WildLoopState): string | null => {
    const { conditions, iteration, startedAt, estimatedTokens } = currentState
    if (conditions.maxIterations && iteration >= conditions.maxIterations) {
      return `Reached max iterations (${conditions.maxIterations})`
    }
    if (conditions.timeLimitMs && Date.now() - startedAt >= conditions.timeLimitMs) {
      return `Time limit reached`
    }
    if (conditions.tokenBudget && estimatedTokens >= conditions.tokenBudget) {
      return `Token budget exhausted (~${estimatedTokens} tokens)`
    }
    return null
  }, [])

  // Start the loop
  const startLoop = useCallback(async (goal: string, conditions: TerminationCondition) => {
    requestNotificationPermission()

    // Create a new session for the wild loop
    const sessionId = await chatSession.createNewSession()
    if (!sessionId) return

    const newState: WildLoopState = {
      phase: 'planning',
      goal,
      iteration: 0,
      startedAt: Date.now(),
      conditions,
      estimatedTokens: 0,
      isPaused: false,
    }
    setState(newState)
    setSystemEvents([])
    prevRunSnapshot.current = runs.map(r => ({ id: r.id, status: r.status }))

    addSystemEvent('loop-start', `Wild loop started: "${goal}"`)

    // Send initial prompt
    const prompt = [
      `[WILD MODE - Autonomous Experiment Loop]`,
      ``,
      `Goal: ${goal}`,
      ``,
      `You are now in autonomous mode. Design experiments, create sweeps, and iterate until the goal is met.`,
      conditions.maxIterations ? `Max iterations: ${conditions.maxIterations}` : '',
      conditions.timeLimitMs ? `Time limit: ${Math.round(conditions.timeLimitMs / 60000)}m` : '',
      conditions.customCondition ? `Stop when: ${conditions.customCondition}` : '',
      ``,
      `Current runs: ${runs.length} total, ${runs.filter(r => r.status === 'running').length} running.`,
      ``,
      `Begin by analyzing the current state and proposing your first experiment.`,
    ].filter(Boolean).join('\n')

    await chatSession.sendMessage(prompt, 'wild', sessionId)

    setState(prev => prev ? {
      ...prev,
      phase: 'monitoring',
      iteration: 1,
      estimatedTokens: estimateTokens(prompt),
    } : null)
  }, [chatSession, runs, addSystemEvent, requestNotificationPermission])

  // Pause the loop
  const pauseLoop = useCallback(() => {
    setState(prev => prev ? { ...prev, isPaused: true } : null)
    addSystemEvent('loop-pause', 'Wild loop paused by user')
  }, [addSystemEvent])

  // Resume the loop
  const resumeLoop = useCallback(() => {
    setState(prev => prev ? { ...prev, isPaused: false } : null)
    addSystemEvent('loop-resume', 'Wild loop resumed')
  }, [addSystemEvent])

  // Stop the loop
  const stopLoop = useCallback(async () => {
    if (!state) return

    addSystemEvent('loop-stop', `Wild loop stopped after ${state.iteration} iterations`)
    sendNotification('Wild Loop Stopped', `Completed ${state.iteration} iterations for: ${state.goal}`)

    // Send summary message
    if (chatSession.currentSessionId) {
      const summary = `[WILD MODE TERMINATED] Loop ended after ${state.iteration} iterations. ~${state.estimatedTokens} tokens used.`
      await chatSession.sendMessage(summary, 'wild')
    }

    setState(null)

    if (iterationTimerRef.current) {
      clearTimeout(iterationTimerRef.current)
      iterationTimerRef.current = null
    }
  }, [state, chatSession, addSystemEvent, sendNotification])

  // Diff engine: detect run state changes
  useEffect(() => {
    if (!isActive || isPaused || chatSession.streamingState.isStreaming) return

    const now = Date.now()
    if (now - lastSendTime.current < MIN_INTERVAL_MS) return

    const prevSnap = prevRunSnapshot.current
    const currentSnap: RunSnapshot[] = runs.map(r => ({ id: r.id, status: r.status }))

    const changes: string[] = []

    // Detect status transitions
    for (const curr of currentSnap) {
      const prev = prevSnap.find(p => p.id === curr.id)
      if (!prev) {
        // New run appeared
        const run = runs.find(r => r.id === curr.id)
        changes.push(`New run "${run?.name || curr.id}" appeared with status: ${curr.status}`)
        addSystemEvent('run-started', `Run "${run?.name || curr.id}" started`, { runId: curr.id })
      } else if (prev.status !== curr.status) {
        const run = runs.find(r => r.id === curr.id)
        const name = run?.name || curr.id
        if (curr.status === 'completed') {
          changes.push(`Run "${name}" completed successfully`)
          addSystemEvent('run-completed', `Run "${name}" completed`, { runId: curr.id })
        } else if (curr.status === 'failed') {
          changes.push(`Run "${name}" FAILED`)
          addSystemEvent('run-failed', `Run "${name}" failed`, { runId: curr.id })
          sendNotification('Run Failed', `Run "${name}" has failed`)
        } else {
          changes.push(`Run "${name}" changed status: ${prev.status} -> ${curr.status}`)
        }
      }
    }

    // Check for new critical alerts
    const pendingAlerts = alerts.filter(a => a.status === 'pending' && a.severity === 'critical')
    for (const alert of pendingAlerts) {
      const run = runs.find(r => r.id === alert.run_id)
      changes.push(`CRITICAL ALERT on "${run?.name || alert.run_id}": ${alert.message}`)
      addSystemEvent('alert', `Critical alert: ${alert.message}`, { alertId: alert.id, runId: alert.run_id })
      sendNotification('Critical Alert', alert.message)
    }

    prevRunSnapshot.current = currentSnap

    if (changes.length === 0) return

    // Send contextual message
    setState(prev => prev ? { ...prev, phase: 'reacting' } : null)
    lastSendTime.current = now

    const eventMessage = [
      `[WILD LOOP - Event Update (Turn ${state?.iteration ?? 0})]`,
      ``,
      ...changes.map(c => `- ${c}`),
      ``,
      `Analyze these changes and decide next actions. If the goal "${state?.goal}" is met, recommend stopping.`,
    ].join('\n')

    chatSession.sendMessage(eventMessage, 'wild').then(() => {
      setState(prev => {
        if (!prev) return null
        const next: WildLoopState = {
          ...prev,
          phase: 'monitoring',
          iteration: prev.iteration + 1,
          estimatedTokens: prev.estimatedTokens + estimateTokens(eventMessage),
        }

        // Check termination
        const reason = checkTermination(next)
        if (reason) {
          addSystemEvent('loop-stop', `Auto-stopped: ${reason}`)
          sendNotification('Wild Loop Ended', reason)
          return null
        }
        return next
      })
    })
  }, [runs, alerts, isActive, isPaused, chatSession, state, addSystemEvent, sendNotification, checkTermination])

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
