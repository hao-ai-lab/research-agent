'use client'

import { useState, useEffect } from 'react'
import { Zap, Pause, Play, Square, Eye, Brain, RotateCw, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WildLoopState } from '@/lib/types'

interface WildLoopBannerProps {
  state: WildLoopState
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

const phaseConfig: Record<WildLoopState['phase'], { icon: typeof Zap; label: string }> = {
  idle: { icon: Zap, label: 'Idle' },
  planning: { icon: Brain, label: 'Planning' },
  monitoring: { icon: Eye, label: 'Monitoring' },
  reacting: { icon: RotateCw, label: 'Reacting' },
  waiting: { icon: Clock, label: 'Waiting' },
}

export function WildLoopBanner({ state, onPause, onResume, onStop }: WildLoopBannerProps) {
  const [elapsed, setElapsed] = useState('00:00')

  useEffect(() => {
    const update = () => {
      const diff = Date.now() - state.startedAt
      const mins = Math.floor(diff / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setElapsed(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [state.startedAt])

  const { icon: PhaseIcon, label: phaseLabel } = phaseConfig[state.phase]
  const maxIter = state.conditions.maxIterations

  return (
    <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 bg-gradient-to-r from-purple-600/20 to-purple-500/10 border-b border-purple-500/20">
      <div className="flex items-center gap-2 min-w-0">
        <Zap className={`h-3.5 w-3.5 text-purple-400 shrink-0 ${state.isPaused ? '' : 'wild-pulse'}`} />
        <div className="flex items-center gap-1.5 text-[11px] text-purple-300 min-w-0">
          <PhaseIcon className="h-3 w-3 shrink-0" />
          <span className="font-medium">{phaseLabel}</span>
          <span className="text-purple-400/60">|</span>
          <span>Turn {state.iteration}{maxIter ? `/${maxIter}` : ''}</span>
          <span className="text-purple-400/60">|</span>
          <span>{elapsed}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-purple-400 hover:text-purple-300 hover:bg-purple-500/20"
          onClick={state.isPaused ? onResume : onPause}
        >
          {state.isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-purple-400 hover:text-destructive hover:bg-destructive/20"
          onClick={onStop}
        >
          <Square className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
