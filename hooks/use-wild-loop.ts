'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import type { PromptProvenance } from '@/lib/types'
import {
  updateWildLoopStatus, configureWildLoop, setWildMode,
  getSweep, listSweeps, listAlerts, listRuns, startSweep, getRunLogs,
  createSweep, respondToAlert, listPromptSkills, enqueueWildEvent,
  buildWildPrompt,
} from '@/lib/api'
import type { PromptSkill, BuildWildPromptRequest } from '@/lib/api'
import type { Alert, Run, Sweep, CreateSweepRequest } from '@/lib/api'
import { EventQueue } from '@/lib/event-queue'
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
  onResponseComplete: (responseText: string) => void
  pendingPrompt: string | null
  pendingProvenance: PromptProvenance | null
  consumePrompt: () => void
  // Queue API
  eventQueue: QueuedEvent[]
  reorderQueue: (orderedIds: string[]) => void
  removeFromQueue: (id: string) => void
  insertIntoQueue: (event: QueuedEvent, index?: number) => void
}

// ============================================================
// Signal Parsing
// ============================================================

function parseSignal(text: string): WildLoopSignal | null {
  const promiseMatch = text.match(/<promise>(CONTINUE|COMPLETE|NEEDS_HUMAN)<\/promise>/)
  if (promiseMatch) return { type: promiseMatch[1] as WildLoopSignal['type'] }
  const signalMatch = text.match(/<signal>(CONTINUE|COMPLETE|NEEDS_HUMAN)<\/signal>/)
  if (signalMatch) return { type: signalMatch[1] as WildLoopSignal['type'] }
  return null
}

/**
 * Parse a <sweep>{json}</sweep> tag from the agent's response.
 * The agent outputs this structured spec instead of running code directly.
 * The frontend then calls createSweep() with the parsed JSON.
 */
function parseSweepSpec(text: string): CreateSweepRequest | null {
  const match = text.match(/<sweep>([\s\S]*?)<\/sweep>/)
  if (!match) return null
  try {
    const spec = JSON.parse(match[1].trim())
    // Validate required fields
    if (!spec.name || !spec.base_command || !spec.parameters) {
      console.warn('[wild-loop] Sweep spec missing required fields:', spec)
      return null
    }
    return {
      name: spec.name,
      base_command: spec.base_command,
      workdir: spec.workdir,
      parameters: spec.parameters,
      max_runs: spec.max_runs,
      auto_start: false, // Never auto-start — frontend controls this
    }
  } catch (err) {
    console.warn('[wild-loop] Failed to parse sweep spec:', err)
    return null
  }
}

/**
 * Parse a <resolve_alert> tag from the agent's response.
 * Format: <resolve_alert>{"alert_id": "...", "choice": "..."}</resolve_alert>
 */
function parseAlertResolution(text: string): { alertId: string; choice: string } | null {
  const match = text.match(/<resolve_alert>([\s\S]*?)<\/resolve_alert>/)
  if (!match) return null
  try {
    const spec = JSON.parse(match[1].trim())
    if (!spec.alert_id || !spec.choice) return null
    return { alertId: spec.alert_id, choice: spec.choice }
  } catch {
    return null
  }
}

// ============================================================
// Template Rendering Utility
// ============================================================

/**
 * Render a template string by replacing {{variable}} placeholders.
 * Any unresolved placeholders are removed.
 */
function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  // Clean up unreplaced variables
  return result.replace(/\{\{[a-zA-Z_]+\}\}/g, '')
}

// ============================================================
// @deprecated — Prompt Builders (kept as fallback if backend /wild/build-prompt fails)
// Prompt construction is now delegated to the backend via buildWildPrompt().
// These will be removed once the backend endpoint is stable.
// ============================================================

function buildExploringPrompt(goal: string, iteration: number, template?: string): string {
  if (template) {
    return renderTemplate(template, { goal, iteration: String(iteration) })
  }
  // Fallback: original hardcoded prompt
  return [
    `# Wild Loop — Iteration ${iteration} (Exploring)`,
    '',
    `## Your Goal`,
    goal,
    '',
    `## Status`,
    `No sweep has been created yet. You need to define one.`,
    '',
    `## What You Should Do`,
    `1. Explore the codebase and understand what experiments are needed`,
    `2. When ready, output a sweep specification as a JSON block inside \`<sweep>\` tags`,
    `3. The system will automatically create and start the sweep for you`,
    '',
    `## How to Create a Sweep`,
    `Output exactly this format (the system will parse it and call the API for you):`,
    '',
    '```',
    `<sweep>`,
    `{`,
    `  "name": "My Experiment Sweep",`,
    `  "base_command": "python train.py",`,
    `  "parameters": {`,
    `    "lr": [0.0001, 0.001, 0.01],`,
    `    "batch_size": [32, 64]`,
    `  },`,
    `  "max_runs": 10`,
    `}`,
    `</sweep>`,
    '```',
    '',
    `The \`parameters\` field defines a grid — the system will expand it into individual runs.`,
    `The \`base_command\` is the shell command template. Parameters are appended as \`--key=value\`.`,
    '',
    `## Rules`,
    `- Do NOT run commands yourself. Output the \`<sweep>\` spec and the system handles execution.`,
    `- If you need more info before creating a sweep, just explain what you need and output \`<promise>CONTINUE</promise>\``,
    `- Once you output a \`<sweep>\` tag, the system will create & start it automatically.`,
  ].join('\n')
}

function buildRunEventPrompt(goal: string, run: Run, logTail: string, sweepSummary: string, template?: string): string {
  const statusEmoji = run.status === 'failed' ? '❌' : '✅'
  const runInstructions = run.status === 'failed'
    ? `- This run FAILED. Diagnose the issue from the logs above.\n- Take corrective action: fix code, adjust parameters, or create a new run.\n- You can rerun this specific run after fixing the issue.`
    : `- This run SUCCEEDED. Check if the results look correct.\n- If results are suspicious, investigate further.`

  if (template) {
    return renderTemplate(template, {
      goal,
      run_name: run.name,
      run_id: run.id,
      run_status: run.status,
      run_command: run.command,
      log_tail: logTail.slice(-1000),
      sweep_summary: sweepSummary,
      status_emoji: statusEmoji,
      run_instructions: runInstructions,
    })
  }
  // Fallback
  return [
    `# Wild Loop — Run Event (Monitoring)`,
    '',
    `## Your Goal`,
    goal,
    '',
    `## Event: Run "${run.name}" just ${run.status}  ${statusEmoji}`,
    `- **ID**: ${run.id}`,
    `- **Status**: ${run.status}`,
    `- **Command**: \`${run.command}\``,
    '',
    `### Log Tail (last 1000 chars)`,
    '```',
    logTail.slice(-1000),
    '```',
    '',
    `## Current Sweep Status`,
    sweepSummary,
    '',
    `## Instructions`,
    runInstructions,
    `- End with \`<promise>CONTINUE</promise>\``,
  ].join('\n')
}

function buildAlertPrompt(goal: string, alert: Alert, runName: string, template?: string): string {
  const alertChoices = alert.choices.map(c => `\`${c}\``).join(', ')
  const resolveExample = `{"alert_id": "${alert.id}", "choice": "ONE_OF_THE_CHOICES_ABOVE"}`

  if (template) {
    return renderTemplate(template, {
      goal,
      run_name: runName,
      alert_id: alert.id,
      alert_severity: alert.severity,
      alert_message: alert.message,
      alert_choices: alertChoices,
      alert_resolve_example: resolveExample,
    })
  }
  // Fallback
  return [
    `# Wild Loop — Alert`,
    '',
    `## Your Goal`,
    goal,
    '',
    `## ⚠️ Alert from Run "${runName}"`,
    `- **Alert ID**: ${alert.id}`,
    `- **Severity**: ${alert.severity}`,
    `- **Message**: ${alert.message}`,
    `- **Available Choices**: ${alertChoices}`,
    '',
    `## How to Resolve This Alert`,
    `You MUST resolve this alert by outputting a \`<resolve_alert>\` tag with your chosen action:`,
    '',
    '```',
    `<resolve_alert>`,
    resolveExample,
    `</resolve_alert>`,
    '```',
    '',
    `## Instructions`,
    `1. Analyze the alert and decide the best course of action`,
    `2. Output the \`<resolve_alert>\` tag with your chosen response`,
    `3. If the issue needs a code fix, explain what you'd change`,
    `4. End with \`<promise>CONTINUE</promise>\``,
  ].join('\n')
}

function buildAnalysisPrompt(goal: string, runs: Run[], sweepName: string, template?: string): string {
  const runSummaries = runs.map(r =>
    `- **${r.name}**: ${r.status}${r.status === 'failed' ? ' ❌' : ' ✅'}`
  ).join('\n')
  const passed = runs.filter(r => r.status === 'finished').length
  const failed = runs.filter(r => r.status === 'failed').length

  if (template) {
    return renderTemplate(template, {
      goal,
      sweep_name: sweepName,
      total_runs: String(runs.length),
      passed_runs: String(passed),
      failed_runs: String(failed),
      run_summaries: runSummaries,
    })
  }
  // Fallback
  return [
    `# Wild Loop — Analysis (All Runs Complete)`,
    '',
    `## Your Goal`,
    goal,
    '',
    `## Sweep "${sweepName}" Results`,
    `**${runs.length} total** — ${passed} passed, ${failed} failed`,
    '',
    runSummaries,
    '',
    `## Instructions`,
    `- Review all run results above`,
    `- Determine if the original goal has been fully achieved`,
    `- Provide a clear summary report`,
    '',
    `## Response`,
    `- If goal is FULLY achieved with evidence: \`<promise>COMPLETE</promise>\``,
    `- If more experiments are needed: \`<promise>CONTINUE</promise>\` (will start a new exploration cycle)`,
    `- If you need human input: \`<promise>NEEDS_HUMAN</promise>\``,
  ].join('\n')
}

function buildSweepSummary(runs: Run[]): string {
  const running = runs.filter(r => r.status === 'running').length
  const finished = runs.filter(r => r.status === 'finished').length
  const failed = runs.filter(r => r.status === 'failed').length
  const queued = runs.filter(r => ['queued', 'ready'].includes(r.status)).length
  return `Running: ${running} | Completed: ${finished} | Failed: ${failed} | Queued: ${queued}`
}

// ============================================================
// Hook
// ============================================================

const emptyRunStats: RunStats = { total: 0, running: 0, completed: 0, failed: 0, queued: 0 }

export function useWildLoop(): UseWildLoopResult {
  // Core state
  const [isActive, setIsActive] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [phase, setPhase] = useState<WildLoopPhase>('idle')
  const [stage, setStage] = useState<WildLoopStage>('exploring')
  const [iteration, setIteration] = useState(0)
  const [goal, setGoal] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Event queue replaces single-slot pendingPrompt
  const queueRef = useRef(new EventQueue())
  const [queueSnapshot, setQueueSnapshot] = useState<QueuedEvent[]>([])

  // Helper: enqueue + update snapshot + mirror to backend
  const enqueueEvent = useCallback((event: QueuedEvent) => {
    if (queueRef.current.enqueue(event)) {
      setQueueSnapshot([...queueRef.current.items])
      // Fire-and-forget: mirror to backend queue for Step 6 readiness
      enqueueWildEvent({
        priority: event.priority,
        title: event.title,
        prompt: event.prompt,
        type: event.type,
      }).catch(err => console.warn('[wild-loop] Failed to mirror event to backend:', err))
    }
  }, [])

  // Derived pendingPrompt for backward compat with connected-chat-view autoSend
  const pendingPrompt = queueSnapshot.length > 0 ? queueSnapshot[0].prompt : null
  // Provenance of the current pending prompt (for UI transparency)
  const pendingProvenance = queueSnapshot.length > 0 ? (queueSnapshot[0].provenance ?? null) : null
  const [terminationConditions, setTerminationConditionsState] = useState<TerminationConditions>({})

  // Sweep tracking
  const [trackedSweepId, setTrackedSweepId] = useState<string | null>(null)
  const [runStats, setRunStats] = useState<RunStats>(emptyRunStats)
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([])

  // @deprecated — Template cache kept only as fallback if backend buildWildPrompt fails
  const templateCacheRef = useRef<Record<string, string>>({})
  useEffect(() => {
    listPromptSkills()
      .then(skills => {
        const cache: Record<string, string> = {}
        for (const skill of skills) {
          cache[skill.id] = skill.template
        }
        templateCacheRef.current = cache
        console.log('[wild-loop] Loaded prompt skill templates (fallback):', Object.keys(cache))
      })
      .catch(err => console.warn('[wild-loop] Failed to load prompt skills, using fallbacks:', err))
  }, [])

  /**
   * Build a prompt via backend and enqueue it with full provenance.
   * Falls back to the deprecated frontend builders if the backend call fails.
   */
  const enqueueFromBackend = useCallback(async (
    eventId: string,
    priority: number,
    title: string,
    eventType: QueuedEvent['type'],
    req: BuildWildPromptRequest,
    fallbackPrompt?: string,
  ) => {
    try {
      const provenance = await buildWildPrompt(req)
      enqueueEvent({
        id: eventId,
        priority,
        title,
        prompt: provenance.rendered,
        type: eventType,
        createdAt: Date.now(),
        provenance,
      })
    } catch (err) {
      console.warn('[wild-loop] Backend buildWildPrompt failed, using fallback:', err)
      // Fallback: use the deprecated frontend-built prompt
      const prompt = fallbackPrompt || buildExploringPrompt(
        req.goal || 'Continue working',
        req.iteration || 0,
        templateCacheRef.current['wild_exploring'],
      )
      enqueueEvent({
        id: eventId,
        priority,
        title,
        prompt,
        type: eventType,
        createdAt: Date.now(),
      })
    }
  }, [enqueueEvent])

  // Refs for callbacks (avoid stale closures)
  const isActiveRef = useRef(isActive)
  const isPausedRef = useRef(isPaused)
  const iterationRef = useRef(iteration)
  const goalRef = useRef(goal)
  const terminationRef = useRef(terminationConditions)
  const startedAtRef = useRef(startedAt)
  const stageRef = useRef(stage)
  const trackedSweepIdRef = useRef(trackedSweepId)

  // Event tracking
  const knownSweepIdsRef = useRef<Set<string>>(new Set())
  const seenRunStatusesRef = useRef<Map<string, string>>(new Map())
  const processedAlertIdsRef = useRef<Set<string>>(new Set())
  const isBusyRef = useRef(false) // prevents auto-send overlap
  const analysisQueuedRef = useRef(false) // prevents duplicate analysis enqueue from polling race

  // Sync refs
  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { iterationRef.current = iteration }, [iteration])
  useEffect(() => { goalRef.current = goal }, [goal])
  useEffect(() => { terminationRef.current = terminationConditions }, [terminationConditions])
  useEffect(() => { startedAtRef.current = startedAt }, [startedAt])
  useEffect(() => { stageRef.current = stage }, [stage])
  useEffect(() => { trackedSweepIdRef.current = trackedSweepId }, [trackedSweepId])

  // NOTE: Sweep detection is now done in onResponseComplete via <sweep> tag parsing.
  // No polling needed — the agent outputs structured sweep specs that we parse and submit.

  // ========== RUNNING: Poll for run events & alerts ==========
  useEffect(() => {
    if (!isActive || stage !== 'running' || !trackedSweepId) return

    const pollEvents = async () => {
      try {
        const sweep = await getSweep(trackedSweepId)
        const allRuns = await listRuns()
        const sweepRuns = allRuns.filter(r => (sweep.run_ids || []).includes(r.id))

        // Update run stats
        setRunStats({
          total: sweepRuns.length,
          running: sweepRuns.filter(r => r.status === 'running').length,
          completed: sweepRuns.filter(r => r.status === 'finished').length,
          failed: sweepRuns.filter(r => r.status === 'failed').length,
          queued: sweepRuns.filter(r => ['queued', 'ready'].includes(r.status)).length,
        })

        // Fetch alerts for this sweep
        const allAlerts = await listAlerts()
        const sweepAlertRunIds = new Set(sweep.run_ids || [])
        const pendingAlerts = allAlerts.filter(
          a => sweepAlertRunIds.has(a.run_id) && a.status === 'pending'
        )
        setActiveAlerts(pendingAlerts)

        // Enqueue new alerts (higher priority)
        for (const alert of pendingAlerts) {
          if (!processedAlertIdsRef.current.has(alert.id)) {
            processedAlertIdsRef.current.add(alert.id)
            const run = sweepRuns.find(r => r.id === alert.run_id)
            console.log('[wild-loop] Queuing alert event:', alert.id)
            enqueueFromBackend(
              `alert-${alert.id}`,
              20,
              `Alert: ${run?.name || alert.run_id}`,
              'alert',
              {
                prompt_type: 'alert',
                goal: goalRef.current || '',
                alert_id: alert.id,
                alert_severity: alert.severity,
                alert_message: alert.message,
                alert_choices: alert.choices,
                run_name: run?.name || alert.run_id,
              },
              buildAlertPrompt(goalRef.current || '', alert, run?.name || alert.run_id, templateCacheRef.current['wild_alert']),
            )
          }
        }

        // Enqueue run status transitions
        for (const run of sweepRuns) {
          const prev = seenRunStatusesRef.current.get(run.id)
          if (prev !== run.status && ['finished', 'failed'].includes(run.status)) {
            seenRunStatusesRef.current.set(run.id, run.status)
            // Fetch log tail
            let logTail = 'No logs available'
            try {
              const logs = await getRunLogs(run.id)
              logTail = logs.content || 'Empty'
            } catch { /* ignore */ }

            console.log('[wild-loop] Queuing run event:', run.id, run.status)
            const sweepSummary = buildSweepSummary(sweepRuns)
            enqueueFromBackend(
              `run-${run.id}-${run.status}`,
              run.status === 'failed' ? 40 : 50,
              `${run.status === 'failed' ? '❌' : '✅'} Run: ${run.name || run.id}`,
              'run_event',
              {
                prompt_type: 'run_event',
                goal: goalRef.current || '',
                run_id: run.id,
                run_name: run.name,
                run_status: run.status,
                run_command: run.command,
                log_tail: logTail,
                sweep_summary: sweepSummary,
              },
              buildRunEventPrompt(goalRef.current || '', run, logTail, sweepSummary, templateCacheRef.current['wild_monitoring']),
            )
          }
          seenRunStatusesRef.current.set(run.id, run.status)
        }

        // Check if ALL runs are terminal AND no unprocessed alerts → ANALYZING
        const allTerminal = sweepRuns.length > 0 && sweepRuns.every(r =>
          ['finished', 'failed', 'stopped'].includes(r.status)
        )
        const hasUnprocessedAlerts = pendingAlerts.some(
          a => !processedAlertIdsRef.current.has(a.id)
        )
        if (allTerminal && !hasUnprocessedAlerts && pendingAlerts.length === 0 && !analysisQueuedRef.current) {
          analysisQueuedRef.current = true
          console.log('[wild-loop] All runs terminal, no pending alerts → ANALYZING')
          setStage('analyzing')
          setPhase('analyzing')
          const runSummaries = sweepRuns.map(r =>
            `- **${r.name}**: ${r.status}${r.status === 'failed' ? ' ❌' : ' ✅'}`
          ).join('\n')
          const passed = sweepRuns.filter(r => r.status === 'finished').length
          const failed = sweepRuns.filter(r => r.status === 'failed').length
          enqueueFromBackend(
            `analysis-${trackedSweepId}-${Date.now()}`,
            70,
            `Analysis: ${sweep.name || trackedSweepId}`,
            'analysis',
            {
              prompt_type: 'analysis',
              goal: goalRef.current || '',
              sweep_name: sweep.name || trackedSweepId,
              total_runs: sweepRuns.length,
              passed_runs: passed,
              failed_runs: failed,
              run_summaries: runSummaries,
            },
            buildAnalysisPrompt(goalRef.current || '', sweepRuns, sweep.name || trackedSweepId, templateCacheRef.current['wild_analyzing']),
          )
        }
      } catch (err) {
        console.warn('[wild-loop] Failed to poll run events:', err)
      }
    }

    pollEvents() // immediate
    const intervalId = setInterval(pollEvents, 5000)
    return () => clearInterval(intervalId)
  }, [isActive, stage, trackedSweepId])

  // ========== Actions ==========

  const start = useCallback(async (newGoal: string, newSessionId: string) => {
    const now = Date.now() / 1000
    setIsActive(true)
    setIsPaused(false)
    setPhase('exploring')
    setStage('exploring')
    setIteration(0)
    setGoal(newGoal)
    setStartedAt(now)
    setSessionId(newSessionId)
    queueRef.current.clear()
    setQueueSnapshot([])
    setTrackedSweepId(null)
    setRunStats(emptyRunStats)
    setActiveAlerts([])

    // Clear event tracking
    seenRunStatusesRef.current.clear()
    processedAlertIdsRef.current.clear()
    isBusyRef.current = false
    analysisQueuedRef.current = false

    // Snapshot existing sweep IDs so we can detect new ones
    try {
      const existing = await listSweeps()
      knownSweepIdsRef.current = new Set(existing.map(s => s.id))
    } catch {
      knownSweepIdsRef.current = new Set()
    }

    // Backend sync
    setWildMode(true).catch(console.error)
    configureWildLoop({ goal: newGoal, session_id: newSessionId }).catch(console.error)
    updateWildLoopStatus({
      phase: 'exploring', iteration: 0, goal: newGoal,
      session_id: newSessionId, is_paused: false,
    }).catch(console.error)
  }, [])

  const pause = useCallback(() => {
    setIsPaused(true)
    setPhase('paused')
    // Don't clear queue on pause — events stay queued for resume
    isBusyRef.current = false
    updateWildLoopStatus({ phase: 'paused', is_paused: true }).catch(console.error)
  }, [])

  const resume = useCallback(() => {
    setIsPaused(false)
    const currentStage = stageRef.current
    const p: WildLoopPhase = currentStage === 'running' ? 'monitoring' : 'exploring'
    setPhase(p)
    isBusyRef.current = false
    if (currentStage === 'exploring' && queueRef.current.size === 0) {
      const currentGoal = goalRef.current || 'Continue working'
      const nextIter = iterationRef.current + 1
      enqueueFromBackend(
        `explore-resume-${Date.now()}`,
        90,
        'Resume exploring',
        'exploring',
        { prompt_type: 'exploring', goal: currentGoal, iteration: nextIter },
        buildExploringPrompt(currentGoal, nextIter, templateCacheRef.current['wild_exploring']),
      )
    }
    // If queue has items or running stage, auto-send / polling will pick up
    updateWildLoopStatus({ phase: p, is_paused: false }).catch(console.error)
  }, [enqueueEvent, enqueueFromBackend])

  const stop = useCallback(() => {
    setIsActive(false)
    setIsPaused(false)
    setPhase('idle')
    setStage('exploring')
    setIteration(0)
    setGoal(null)
    setStartedAt(null)
    setSessionId(null)
    queueRef.current.clear()
    setQueueSnapshot([])
    setTrackedSweepId(null)
    setRunStats(emptyRunStats)
    setActiveAlerts([])
    isBusyRef.current = false
    analysisQueuedRef.current = false

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
    queueRef.current.dequeue()
    setQueueSnapshot([...queueRef.current.items])
    isBusyRef.current = false
  }, [])

  const checkTermination = useCallback((): boolean => {
    const conds = terminationRef.current
    const iter = iterationRef.current
    if (conds.maxIterations && iter >= conds.maxIterations) return true
    const started = startedAtRef.current
    if (conds.maxTimeSeconds && started) {
      if ((Date.now() / 1000) - started >= conds.maxTimeSeconds) return true
    }
    return false
  }, [])

  // ========== onResponseComplete: stage-aware ==========

  const onResponseComplete = useCallback((responseText: string) => {
    if (!isActiveRef.current || isPausedRef.current) return

    // agent done responding — isBusyRef cleared by consumePrompt
    const signal = parseSignal(responseText)
    const nextIteration = iterationRef.current + 1
    setIteration(nextIteration)
    const currentStage = stageRef.current

    updateWildLoopStatus({ iteration: nextIteration }).catch(console.error)

    if (checkTermination()) { stop(); return }

    // Bug 2 fix: Respect COMPLETE/NEEDS_HUMAN signals regardless of stage
    if (signal?.type === 'COMPLETE') {
      console.log('[wild-loop] Signal COMPLETE received in stage:', currentStage)
      stop()
      return
    }
    if (signal?.type === 'NEEDS_HUMAN') {
      console.log('[wild-loop] Signal NEEDS_HUMAN received in stage:', currentStage)
      pause()
      return
    }

    if (currentStage === 'exploring') {
      // Check if agent output a <sweep> spec
      const sweepSpec = parseSweepSpec(responseText)
      if (sweepSpec) {
        console.log('[wild-loop] Parsed sweep spec from agent:', sweepSpec.name)
        // Frontend creates the sweep via API
        createSweep(sweepSpec).then(async (sweep) => {
          console.log('[wild-loop] Created sweep:', sweep.id)
          setTrackedSweepId(sweep.id)
          setStage('running')
          setPhase('monitoring')
          // Auto-start the sweep
          try {
            await startSweep(sweep.id, 100) // Start all runs in parallel
            console.log('[wild-loop] Auto-started sweep:', sweep.id)
          } catch (err) {
            console.warn('[wild-loop] Failed to auto-start sweep:', err)
          }
        }).catch(err => {
          console.error('[wild-loop] Failed to create sweep from spec:', err)
          // Continue exploring — agent can try again
          const currentGoal = goalRef.current || 'Continue working'
          setTimeout(() => {
            if (isActiveRef.current && !isPausedRef.current) {
              enqueueFromBackend(
                `explore-retry-${Date.now()}`,
                90,
                'Retry exploring',
                'exploring',
                { prompt_type: 'exploring', goal: currentGoal, iteration: nextIteration + 1 },
                buildExploringPrompt(currentGoal, nextIteration + 1, templateCacheRef.current['wild_exploring']),
              )
            }
          }, 3000)
        })
        return // Don't queue exploring prompt — we're transitioning to running
      }

      // No sweep spec — Ralph-style: re-send the exploring prompt after a delay
      const currentGoal = goalRef.current || 'Continue working'
      const delay = nextIteration <= 1 ? 1500 : 3000
      setTimeout(() => {
        if (isActiveRef.current && !isPausedRef.current && stageRef.current === 'exploring') {
          enqueueFromBackend(
            `explore-${nextIteration + 1}-${Date.now()}`,
            90,
            `Exploring (iteration ${nextIteration + 1})`,
            'exploring',
            { prompt_type: 'exploring', goal: currentGoal, iteration: nextIteration + 1 },
            buildExploringPrompt(currentGoal, nextIteration + 1, templateCacheRef.current['wild_exploring']),
          )
        }
      }, delay)
    } else if (currentStage === 'running') {
      // Parse <resolve_alert> from agent response and call API
      const resolution = parseAlertResolution(responseText)
      if (resolution) {
        console.log('[wild-loop] Resolving alert:', resolution.alertId, '→', resolution.choice)
        respondToAlert(resolution.alertId, resolution.choice).then(() => {
          console.log('[wild-loop] Alert resolved:', resolution.alertId)
        }).catch(err => {
          console.warn('[wild-loop] Failed to resolve alert:', err)
        })
      }
      // Event-driven: don't auto-queue. Polling will trigger next prompt.
      // isBusyRef is already false, so next poll can queue events.
    } else if (currentStage === 'analyzing') {
      // COMPLETE and NEEDS_HUMAN already handled above.
      // CONTINUE or no signal: back to exploring for another cycle
      {
        analysisQueuedRef.current = false // reset guard for next cycle
        console.log('[wild-loop] Analysis says more work needed, cycling back to exploring')
        setStage('exploring')
        setPhase('exploring')
        setTrackedSweepId(null)
        seenRunStatusesRef.current.clear()
        processedAlertIdsRef.current.clear()
        // Snapshot current sweeps
        listSweeps().then(sweeps => {
          knownSweepIdsRef.current = new Set(sweeps.map(s => s.id))
        }).catch(console.error)
        const currentGoal = goalRef.current || 'Continue working'
        setTimeout(() => {
          if (isActiveRef.current && !isPausedRef.current) {
            enqueueFromBackend(
              `explore-cycle-${Date.now()}`,
              90,
              `Exploring (post-analysis)`,
              'exploring',
              { prompt_type: 'exploring', goal: currentGoal, iteration: nextIteration + 1 },
              buildExploringPrompt(currentGoal, nextIteration + 1, templateCacheRef.current['wild_exploring']),
            )
          }
        }, 3000)
      }
    }
  }, [checkTermination, stop, pause, enqueueEvent, enqueueFromBackend])

  // Queue mutation callbacks for UI
  const reorderQueue = useCallback((orderedIds: string[]) => {
    queueRef.current.reorder(orderedIds)
    setQueueSnapshot([...queueRef.current.items])
  }, [])

  const removeFromQueue = useCallback((id: string) => {
    queueRef.current.remove(id)
    setQueueSnapshot([...queueRef.current.items])
  }, [])

  const insertIntoQueue = useCallback((event: QueuedEvent, index?: number) => {
    if (index !== undefined) {
      queueRef.current.insertAt(event, index)
    } else {
      queueRef.current.enqueue(event)
    }
    setQueueSnapshot([...queueRef.current.items])
  }, [])

  return {
    isActive, isPaused, phase, stage, iteration, goal, startedAt,
    terminationConditions, sweepId: trackedSweepId, runStats, activeAlerts,
    start, pause, resume, stop, setTerminationConditions,
    onResponseComplete, pendingPrompt, pendingProvenance, consumePrompt,
    eventQueue: queueSnapshot, reorderQueue, removeFromQueue, insertIntoQueue,
  }
}
