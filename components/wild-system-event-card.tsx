'use client'

import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Play,
  Pause,
  Square,
} from 'lucide-react'
import type { WildSystemEvent } from '@/lib/types'

interface WildSystemEventCardProps {
  event: WildSystemEvent
}

const eventConfig: Record<WildSystemEvent['type'], { icon: typeof Zap; colorClass: string }> = {
  'run-completed': { icon: CheckCircle2, colorClass: 'text-green-400 bg-green-500/10 border-green-500/20' },
  'run-failed': { icon: XCircle, colorClass: 'text-red-400 bg-red-500/10 border-red-500/20' },
  'run-started': { icon: Play, colorClass: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  'alert': { icon: AlertTriangle, colorClass: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  'sweep': { icon: Zap, colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  'loop-start': { icon: Zap, colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  'loop-stop': { icon: Square, colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  'loop-pause': { icon: Pause, colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  'loop-resume': { icon: Play, colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
}

export function WildSystemEventCard({ event }: WildSystemEventCardProps) {
  const { icon: Icon, colorClass } = eventConfig[event.type]
  const time = event.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex justify-center py-1.5">
      <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] ${colorClass}`}>
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate max-w-[200px]">{event.summary}</span>
        <span className="text-muted-foreground/60 shrink-0">{time}</span>
      </div>
    </div>
  )
}
