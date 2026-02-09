'use client'

import { useMemo, type ComponentType } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Clock3,
  FlaskConical,
  ListChecks,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Alert } from '@/lib/api-client'
import type { ExperimentRun, Sweep } from '@/lib/types'

interface ChatStarterCardsProps {
  runs: ExperimentRun[]
  sweeps: Sweep[]
  alerts: Alert[]
  onPromptSelect: (prompt: string) => void
  onOpenContextual?: () => void
}

interface StarterCard {
  id: string
  title: string
  description: string
  prompt: string
  cta: string
  icon: ComponentType<{ className?: string }>
  toneClass: string
}

function getLatestRun(runs: ExperimentRun[]) {
  return [...runs]
    .filter((run) => !run.isArchived)
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0]
}

function getLatestSweep(sweeps: Sweep[]) {
  return [...sweeps].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
}

export function ChatStarterCards({
  runs,
  sweeps,
  alerts,
  onPromptSelect,
  onOpenContextual,
}: ChatStarterCardsProps) {
  const cards = useMemo<StarterCard[]>(() => {
    const latestRun = getLatestRun(runs)
    const latestSweep = getLatestSweep(sweeps)
    const pendingAlert = alerts
      .filter((alert) => alert.status === 'pending')
      .sort((a, b) => b.timestamp - a.timestamp)[0]

    const runningJobs = runs.filter((run) => run.status === 'running').length
    const queuedJobs = runs.filter((run) => run.status === 'queued' || run.status === 'ready').length

    return [
      {
        id: 'observe-run',
        title: 'Observe latest run',
        description: latestRun
          ? `Inspect ${latestRun.alias || latestRun.name} and summarize next action.`
          : 'Ask for a quick health check once your first run starts.',
        prompt: latestRun
          ? `@run:${latestRun.id} summarize what just happened, the primary metric trend, and the safest next experiment.`
          : 'Help me set up the first run and explain what to monitor first.',
        cta: latestRun ? 'Analyze run' : 'Start setup',
        icon: FlaskConical,
        toneClass: 'from-sky-500/12 to-cyan-500/5 border-sky-500/25',
      },
      {
        id: 'recent-sweep',
        title: 'Review recent sweep',
        description: latestSweep
          ? `Compare candidates from ${latestSweep.config.name} and choose what to continue.`
          : 'Draft a sweep and define the decision metric up front.',
        prompt: latestSweep
          ? `@sweep:${latestSweep.id} rank the best configurations so far, explain why they win, and recommend the next 3 runs.`
          : 'Draft a sweep plan with 3-5 parameter combinations and a clear primary metric.',
        cta: latestSweep ? 'Review sweep' : 'Draft sweep',
        icon: Sparkles,
        toneClass: 'from-indigo-500/12 to-violet-500/5 border-indigo-500/25',
      },
      {
        id: 'metric-check',
        title: 'Primary metric check',
        description: latestRun?.metrics
          ? `Pull the primary metric from ${latestRun.alias || latestRun.name} and explain the movement.`
          : 'Ask for metric instrumentation if current runs lack metrics.',
        prompt: latestRun
          ? `@run:${latestRun.id} what is the primary metric right now, what changed recently, and what threshold should trigger action?`
          : 'I need a compact metric dashboard plan for this project.',
        cta: 'Inspect metric',
        icon: BarChart3,
        toneClass: 'from-emerald-500/10 to-teal-500/5 border-emerald-500/25',
      },
      {
        id: 'resolve-alert',
        title: 'Resolve recent alert',
        description: pendingAlert
          ? `Triage the latest ${pendingAlert.severity} alert with a safe response path.`
          : 'No pending alerts. Ask for proactive risk checks.',
        prompt: pendingAlert
          ? `@alert:${pendingAlert.id} diagnose this alert, evaluate allowed responses, and recommend the safest one.`
          : 'No active alerts. Give me a preventive checklist for the next 3 runs.',
        cta: pendingAlert ? 'Triage alert' : 'Prevent issues',
        icon: AlertTriangle,
        toneClass: 'from-amber-500/12 to-orange-500/5 border-amber-500/30',
      },
      {
        id: 'scheduler',
        title: 'Schedule jobs better',
        description: `${runningJobs} running and ${queuedJobs} waiting. Ask the agent to rebalance queue and cluster usage.`,
        prompt: `Given ${runningJobs} running jobs and ${queuedJobs} queued jobs, propose a scheduling strategy that maximizes learning-per-hour and minimizes wasted GPU time.`,
        cta: 'Plan schedule',
        icon: Clock3,
        toneClass: 'from-rose-500/10 to-pink-500/5 border-rose-500/25',
      },
      {
        id: 'contextual',
        title: 'Use contextual chatting',
        description: 'Open the contextual workspace where referenced artifacts stay visible while you chat.',
        prompt: 'Open contextual chatting and preload the latest run, sweep, and alert context.',
        cta: onOpenContextual ? 'Open workspace' : 'Generate prompt',
        icon: ListChecks,
        toneClass: 'from-primary/15 to-primary/5 border-primary/30',
      },
    ]
  }, [runs, sweeps, alerts, onOpenContextual])

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Context-first research chat</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a suggested workflow card, then iterate in natural language.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <Card
              key={card.id}
              className={`border bg-gradient-to-br ${card.toneClass} transition-colors hover:border-foreground/20`}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  {card.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">{card.description}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full justify-center text-xs"
                  onClick={() => {
                    if (card.id === 'contextual' && onOpenContextual) {
                      onOpenContextual()
                      return
                    }
                    onPromptSelect(card.prompt)
                  }}
                >
                  {card.cta}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
