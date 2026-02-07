'use client'

import type { ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  FlaskConical,
  LineChart,
  Radar,
  Sparkles,
  Clock3,
  Activity,
  Siren,
  History,
} from 'lucide-react'
import type { ChatMode } from '@/components/chat-input'
import type { ExperimentRun, Sweep } from '@/lib/types'
import type { Alert as ApiAlert } from '@/lib/api-client'
import type { ChatSession } from '@/lib/api'

export interface ChatEntryPromptOptions {
  newSession?: boolean
  mode?: ChatMode
}

interface ChatEntryCardsProps {
  mode: ChatMode
  runs: ExperimentRun[]
  alerts: ApiAlert[]
  sweeps: Sweep[]
  sessions: ChatSession[]
  onPrompt: (prompt: string, options?: ChatEntryPromptOptions) => void | Promise<void>
  onDraftSweep: (prompt: string) => void
  onOpenSession: (sessionId: string) => void | Promise<void>
}

const severityRank: Record<ApiAlert['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp * 1000)
  const minutes = Math.floor(diffMs / 60_000)
  const hours = Math.floor(diffMs / 3_600_000)
  const days = Math.floor(diffMs / 86_400_000)

  if (minutes < 60) return `${minutes || 1}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function ActionCard({
  title,
  description,
  className,
  icon,
  onClick,
}: {
  title: string
  description: string
  className: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex flex-col rounded-xl border p-3 text-left transition-all hover:-translate-y-[1px] hover:shadow-md ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="rounded-lg border border-current/20 p-1.5">{icon}</div>
        <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs opacity-80">{description}</p>
    </button>
  )
}

export function ChatEntryCards({
  mode,
  runs,
  alerts,
  sweeps,
  sessions,
  onPrompt,
  onDraftSweep,
  onOpenSession,
}: ChatEntryCardsProps) {
  const pendingAlerts = alerts
    .filter((alert) => alert.status === 'pending')
    .sort((a, b) => {
      const rankDiff = severityRank[a.severity] - severityRank[b.severity]
      if (rankDiff !== 0) return rankDiff
      return b.timestamp - a.timestamp
    })

  const activeRuns = runs
    .filter((run) => run.status === 'running' || run.status === 'queued')
    .slice(0, 3)

  const activeSweeps = sweeps
    .filter((sweep) => sweep.status === 'running' || sweep.status === 'pending')
    .slice(0, 2)

  const latestCompletedRun = runs
    .filter((run) => run.status === 'completed')
    .sort((a, b) => {
      const aTime = a.endTime?.getTime() || a.startTime.getTime()
      const bTime = b.endTime?.getTime() || b.startTime.getTime()
      return bTime - aTime
    })[0]

  const recentSessions = sessions.slice(0, 3)
  const topAlert = pendingAlerts[0]

  const defaultSweepPrompt =
    'Create a sweep for learning rate from 1e-4 to 1e-2 and batch size 16, 32, 64. Optimize validation loss with 18 runs and 3 parallel workers.'

  return (
    <div className="w-full max-w-3xl space-y-4">
      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Chat-First Workflows</h3>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <ActionCard
            title="Create Sweep"
            description="Describe goals in natural language and open a drafted sweep config."
            className="border-cyan-400/35 bg-gradient-to-br from-cyan-500/12 via-cyan-500/5 to-transparent text-cyan-700 dark:text-cyan-300"
            icon={<FlaskConical className="h-4 w-4" />}
            onClick={() => onDraftSweep(defaultSweepPrompt)}
          />

          <ActionCard
            title="Monitor Jobs"
            description="Get an operational brief on running and queued jobs with blockers."
            className="border-emerald-400/35 bg-gradient-to-br from-emerald-500/12 via-emerald-500/5 to-transparent text-emerald-700 dark:text-emerald-300"
            icon={<Radar className="h-4 w-4" />}
            onClick={() =>
              onPrompt(
                'Give me a concise monitoring brief of active and queued jobs. Highlight blockers and next best interventions.',
                { mode: 'agent' }
              )
            }
          />

          <ActionCard
            title="Handle Events"
            description="Open a focused chat to triage an alert and choose the safest response."
            className="border-amber-400/35 bg-gradient-to-br from-amber-500/14 via-amber-500/6 to-transparent text-amber-700 dark:text-amber-300"
            icon={<AlertTriangle className="h-4 w-4" />}
            onClick={() => {
              if (topAlert) {
                onPrompt(
                  `Please triage alert @alert:${topAlert.id}. Explain root cause, risk, and recommend the safest response from the allowed choices.`,
                  { newSession: true, mode: 'agent' }
                )
                return
              }

              onPrompt('Review event health and tell me what I should monitor next.', {
                newSession: true,
                mode: 'agent',
              })
            }}
          />

          <ActionCard
            title="Analyze Results"
            description="Summarize outcomes and compare what worked versus failed."
            className="border-violet-400/35 bg-gradient-to-br from-violet-500/14 via-violet-500/6 to-transparent text-violet-700 dark:text-violet-300"
            icon={<LineChart className="h-4 w-4" />}
            onClick={() => {
              if (latestCompletedRun) {
                onPrompt(
                  `Analyze results for run @run:${latestCompletedRun.id}. Summarize strengths, weaknesses, and what to run next.`,
                  { mode: 'agent' }
                )
                return
              }

              onPrompt('Analyze my recent experiment outcomes and recommend the next experiment.', {
                mode: 'agent',
              })
            }}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Recommended Right Now</h3>
        </div>

        <div className="space-y-2">
          {pendingAlerts.slice(0, 2).map((alert) => (
            <button
              key={alert.id}
              type="button"
              onClick={() =>
                onPrompt(
                  `Investigate pending alert @alert:${alert.id}. Propose immediate mitigation and the best safe action.`,
                  { newSession: true, mode: 'agent' }
                )
              }
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-left hover:bg-amber-500/12"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-amber-700 dark:text-amber-300">
                  <Siren className="mr-1 inline h-3 w-3" />
                  {alert.message}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {alert.severity} alert • {formatRelativeTime(alert.timestamp)}
                </p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}

          {activeRuns.slice(0, 2).map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() =>
                onPrompt(
                  `Monitor run @run:${run.id}. Give a status snapshot, risk factors, and the most useful next command.`,
                  { mode: 'agent' }
                )
              }
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/7 px-3 py-2 text-left hover:bg-emerald-500/11"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  <Activity className="mr-1 inline h-3 w-3" />
                  {run.alias || run.name}
                </p>
                <p className="text-[11px] text-muted-foreground">{run.status} • {run.progress}% progress</p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}

          {activeSweeps.map((sweep) => (
            <button
              key={sweep.id}
              type="button"
              onClick={() =>
                onPrompt(
                  `Check sweep ${sweep.id}. Summarize progress, failures, and what should be adjusted next.`,
                  { mode: 'agent' }
                )
              }
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-cyan-500/25 bg-cyan-500/8 px-3 py-2 text-left hover:bg-cyan-500/12"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-cyan-700 dark:text-cyan-300">
                  Sweep {sweep.id}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {sweep.status} • {sweep.progress.completed}/{sweep.progress.total} completed
                </p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}

          {recentSessions.slice(0, 2).map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onOpenSession(session.id)}
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 bg-secondary/20 px-3 py-2 text-left hover:bg-secondary/35"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground">
                  <History className="mr-1 inline h-3 w-3 text-muted-foreground" />
                  {session.title}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {session.message_count} messages • {formatRelativeTime(session.created_at)}
                </p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}

          {pendingAlerts.length === 0 &&
            activeRuns.length === 0 &&
            activeSweeps.length === 0 &&
            recentSessions.length === 0 && (
              <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                Nothing urgent yet. Start a sweep or ask for a monitoring plan.
              </div>
            )}
        </div>

        {mode === 'sweep' && (
          <p className="mt-3 text-[11px] text-cyan-700 dark:text-cyan-300">
            Sweep mode is active. Sending a prompt will open the drafted sweep form.
          </p>
        )}
      </div>
    </div>
  )
}
