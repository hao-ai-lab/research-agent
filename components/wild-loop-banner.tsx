'use client'

import { useState, useEffect } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Zap, Pause, Play, Square, Eye, Brain, RotateCw, Clock, FileText } from 'lucide-react'
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
  starting: { icon: Zap, label: 'Starting' },
  planning: { icon: Brain, label: 'Planning' },
  monitoring: { icon: Eye, label: 'Monitoring' },
  reacting: { icon: RotateCw, label: 'Reacting' },
  waiting: { icon: Clock, label: 'Waiting' },
  waiting_for_human: { icon: Clock, label: 'Waiting for Human' },
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-purple-400 hover:text-purple-300 hover:bg-purple-500/20"
            >
              <FileText className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50">
              <span className="text-xs font-medium">Ralph Logs</span>
              <span className="text-[10px] text-muted-foreground">{state.logs?.length || 0} entries</span>
            </div>
            <ScrollArea className="h-64">
              <div className="p-3 text-xs font-mono space-y-1">
                {state.logs && state.logs.length > 0 ? (
                  state.logs.map((log, i) => (
                    <div key={i} className="text-muted-foreground break-all">
                      {log}
                    </div>
                  ))
                ) : (
                  <div className="text-muted-foreground italic">No logs yet...</div>
                )}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
        
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
