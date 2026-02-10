'use client'

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { ExperimentRun, Sweep } from '@/lib/types'

/* ---------- Default evaluation prompts ---------- */
const DEFAULT_EVAL_PROMPTS = [
  'A cat walking on a beach at sunset',
  'A futuristic city with flying cars',
  'A cozy log cabin in a snowy forest',
  'A cyberpunk street market with neon lights',
  'An astronaut exploring a crystal cave',
]

/* ---------- Props ---------- */
interface VisualComparisonGridProps {
  runs: ExperimentRun[]
  sweeps?: Sweep[]
}

/* ---------- Component ---------- */
export function VisualComparisonGrid({ runs, sweeps = [] }: VisualComparisonGridProps) {
  const [rightStep, setRightStep] = useState(5)
  const [ratings, setRatings] = useState<Record<string, number>>({})
  const [focusRow, setFocusRow] = useState(0)
  const [focusCol, setFocusCol] = useState(0)
  const [focusSide, setFocusSide] = useState<'left' | 'right'>('left')
  const containerRef = useRef<HTMLDivElement>(null)

  const prompts = DEFAULT_EVAL_PROMPTS

  /* Group runs by sweep; show all runs if no sweep filter */
  const displayRuns = useMemo(() => {
    /* Prefer runs belonging to a sweep, fall back to all runs */
    const sweepRuns = runs.filter((r) => r.sweepId)
    return sweepRuns.length > 0 ? sweepRuns : runs
  }, [runs])

  /* ---------- Keyboard handlers ---------- */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      /* Arrow navigation */
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (focusSide === 'left') {
          setFocusSide('right')
        } else {
          setFocusSide('left')
          setFocusCol((prev) => Math.min(prev + 1, prompts.length - 1))
        }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (focusSide === 'right') {
          setFocusSide('left')
        } else {
          setFocusSide('right')
          setFocusCol((prev) => Math.max(prev - 1, 0))
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusRow((prev) => Math.min(prev + 1, displayRuns.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusRow((prev) => Math.max(prev - 1, 0))
      }

      /* 0-9 rating */
      if (/^[0-9]$/.test(e.key)) {
        const rating = Number(e.key)
        const run = displayRuns[focusRow]
        if (run) {
          const step = focusSide === 'left' ? 0 : rightStep
          const key = `${run.id}_P${focusCol + 1}_${step}`
          setRatings((prev) => ({ ...prev, [key]: rating }))
        }
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [focusRow, focusCol, focusSide, displayRuns, prompts.length, rightStep])

  /* ---------- Average score per run ---------- */
  const avgByRun = useCallback(
    (runId: string) => {
      const entries = Object.entries(ratings).filter(([k]) => k.startsWith(`${runId}_`))
      if (entries.length === 0) return 0
      return entries.reduce((sum, [, v]) => sum + v, 0) / entries.length
    },
    [ratings],
  )

  /* ---------- Render helpers ---------- */
  const videoPlaceholder = (
    runId: string,
    runIndex: number,
    promptIndex: number,
    step: number,
    side: 'left' | 'right',
    isFocused: boolean,
  ) => {
    const ratingKey = `${runId}_P${promptIndex + 1}_${step}`
    const rating = ratings[ratingKey]
    const runLabel = `RUN-${String(runIndex).padStart(3, '0')}`
    const label = `VIDEO: ${runLabel}_P${promptIndex + 1}`

    return (
      <div
        className={cn(
          'relative flex flex-col items-center justify-center rounded-md border bg-black/80 transition-all',
          isFocused
            ? 'border-blue-500 ring-2 ring-blue-500/40'
            : 'border-border/50',
        )}
        style={{ minWidth: 130, height: 90 }}
      >
        {/* Rating badge */}
        <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Star className="h-3 w-3" />
          <span>{rating ?? 0}</span>
        </div>

        {/* Placeholder content */}
        <span className="text-[10px] text-muted-foreground/60 select-none">{label}</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col overflow-hidden" tabIndex={-1}>
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-foreground">Visual Comparison Grid</h2>
          <Badge variant="outline" className="h-6 rounded px-2 text-[11px] text-muted-foreground">
            0-9 Keys to Rate
          </Badge>
          <Badge variant="outline" className="h-6 rounded px-2 text-[11px] text-muted-foreground">
            Arrows to Navigate
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            <Label htmlFor="right-step" className="text-xs text-muted-foreground whitespace-nowrap">
              Right Step
            </Label>
            <Input
              id="right-step"
              type="number"
              min={0}
              value={rightStep}
              onChange={(e) => setRightStep(Math.max(0, Number(e.target.value)))}
              className="h-7 w-16 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Grid */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="min-w-max">
          {/* Column headers */}
          <div className="sticky top-0 z-10 flex border-b border-border bg-background">
            {/* Row label column */}
            <div className="flex shrink-0 items-end gap-2 border-r border-border px-3 py-2" style={{ minWidth: 160 }}>
              <span className="text-xs font-semibold text-foreground">Run</span>
              <span className="text-xs font-semibold text-foreground ml-auto">Avg</span>
            </div>

            {prompts.map((prompt, pi) => (
              <div
                key={pi}
                className="flex flex-col border-r border-border px-2 py-2"
                style={{ minWidth: 290 }}
              >
                <span className="text-xs font-semibold text-foreground">P{pi + 1}</span>
                <span className="text-[11px] text-muted-foreground leading-tight truncate max-w-[270px]">
                  {prompt}
                </span>
              </div>
            ))}
          </div>

          {/* Rows */}
          {displayRuns.map((run, ri) => {
            const avg = avgByRun(run.id)
            const runLabel = `RUN-${String(ri).padStart(3, '0')}`

            return (
              <div
                key={run.id}
                className={cn(
                  'flex border-b border-border',
                  focusRow === ri ? 'bg-secondary/30' : 'hover:bg-secondary/10',
                )}
              >
                {/* Run label */}
                <div
                  className="flex shrink-0 items-center gap-2 border-r border-border px-3 py-2"
                  style={{ minWidth: 160 }}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: run.color || '#6b7280' }}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">
                      {run.alias || run.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{runLabel}</div>
                  </div>
                  <span className="ml-auto text-sm font-semibold text-foreground tabular-nums">
                    {avg.toFixed(1)}
                  </span>
                </div>

                {/* Prompt cells */}
                {prompts.map((_prompt, pi) => (
                  <div
                    key={pi}
                    className="flex items-center gap-1.5 border-r border-border px-2 py-2"
                    style={{ minWidth: 290 }}
                  >
                    {videoPlaceholder(
                      run.id,
                      ri,
                      pi,
                      0,
                      'left',
                      focusRow === ri && focusCol === pi && focusSide === 'left',
                    )}
                    {videoPlaceholder(
                      run.id,
                      ri,
                      pi,
                      rightStep,
                      'right',
                      focusRow === ri && focusCol === pi && focusSide === 'right',
                    )}
                  </div>
                ))}
              </div>
            )
          })}

          {/* Empty state */}
          {displayRuns.length === 0 && (
            <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
              No runs available for evaluation. Create a sweep with runs to get started.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
