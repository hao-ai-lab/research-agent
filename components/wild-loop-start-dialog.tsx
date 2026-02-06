'use client'

import { useState } from 'react'
import { Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useRef, useEffect } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { TerminationCondition } from '@/lib/types'

interface WildLoopStartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: (goal: string, conditions: TerminationCondition) => void
}

const timeLimitPresets = [
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '2h', ms: 2 * 60 * 60 * 1000 },
  { label: 'No limit', ms: 0 },
]

export function WildLoopStartDialog({ open, onOpenChange, onStart }: WildLoopStartDialogProps) {
  const [goal, setGoal] = useState('')
  const [timeLimitMs, setTimeLimitMs] = useState(60 * 60 * 1000) // default 1h
  const [maxIterations, setMaxIterations] = useState<string>('10')
  const [tokenBudget, setTokenBudget] = useState<string>('')
  const [customCondition, setCustomCondition] = useState('')

  const handleStart = () => {
    if (!goal.trim()) return
    const conditions: TerminationCondition = {}
    if (timeLimitMs > 0) conditions.timeLimitMs = timeLimitMs
    const maxIter = parseInt(maxIterations)
    if (!isNaN(maxIter) && maxIter > 0) conditions.maxIterations = maxIter
    const tokens = parseInt(tokenBudget)
    if (!isNaN(tokens) && tokens > 0) conditions.tokenBudget = tokens
    if (customCondition.trim()) conditions.customCondition = customCondition.trim()

    onStart(goal.trim(), conditions)
    onOpenChange(false)
    // Reset
    setGoal('')
    setTimeLimitMs(60 * 60 * 1000)
    setMaxIterations('10')
    setTokenBudget('')
    setCustomCondition('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-32px)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-purple-400" />
            Configure Wild Mode
          </DialogTitle>
          <DialogDescription>
            The agent runs autonomously — no human interrupts unless it signals a critical decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Goal */}
          <div className="space-y-1.5">
            <Label className="text-xs">Goal *</Label>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleStart()
                }
              }}
              placeholder="e.g., Find the best config"
              className="text-sm min-h-[60px] resize-none"
            />
          </div>

          {/* Time limit */}
          <div className="space-y-1.5">
            <Label className="text-xs">Time Limit</Label>
            <div className="flex gap-1.5">
              {timeLimitPresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setTimeLimitMs(preset.ms)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    timeLimitMs === preset.ms
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                      : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Max iterations */}
          <div className="space-y-1.5">
            <Label className="text-xs">Max Iterations</Label>
            <Input
              type="number"
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              placeholder="10"
              className="text-sm"
              min={1}
            />
          </div>

          {/* Token budget */}
          <div className="space-y-1.5">
            <Label className="text-xs">Token Budget (optional)</Label>
            <Input
              type="number"
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              placeholder="100000"
              className="text-sm"
              min={1000}
              step={1000}
            />
          </div>

          {/* Custom condition */}
          <div className="space-y-1.5">
            <Label className="text-xs">Custom Stop Condition (optional)</Label>
            <Input
              value={customCondition}
              onChange={(e) => setCustomCondition(e.target.value)}
              placeholder="e.g., accuracy > 95%"
              className="text-sm"
            />
          </div>

          {/* Start button */}
          <Button
            onClick={handleStart}
            disabled={!goal.trim()}
            className="w-full bg-purple-600 hover:bg-purple-700 text-white"
          >
            <Zap className="h-4 w-4 mr-2" />
            Start Wild Mode
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
