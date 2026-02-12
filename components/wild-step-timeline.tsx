'use client'

import type { WildStepRecord } from '@/lib/api'

// Step type → icon + color config
const stepConfig: Record<string, { icon: string; color: string; bg: string }> = {
    exploring: { icon: '🔭', color: 'text-violet-400', bg: 'bg-violet-500/15' },
    run_event: { icon: '🏃', color: 'text-blue-400', bg: 'bg-blue-500/15' },
    alert: { icon: '⚠️', color: 'text-amber-400', bg: 'bg-amber-500/15' },
    analysis: { icon: '🔍', color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
    sweep_created: { icon: '🧪', color: 'text-cyan-400', bg: 'bg-cyan-500/15' },
    signal: { icon: '📡', color: 'text-pink-400', bg: 'bg-pink-500/15' },
    monitoring: { icon: '📡', color: 'text-blue-400', bg: 'bg-blue-500/15' },
    analyzing: { icon: '🔍', color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
    running: { icon: '🏃', color: 'text-blue-400', bg: 'bg-blue-500/15' },
}
const defaultConfig = { icon: '⚙️', color: 'text-muted-foreground', bg: 'bg-secondary' }

function formatRelativeTime(timestamp: number): string {
    const now = Date.now() / 1000
    const diff = Math.max(0, Math.floor(now - timestamp))
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`
}

interface WildStepTimelineProps {
    steps: WildStepRecord[]
    maxVisible?: number
}

export function WildStepTimeline({ steps, maxVisible = 8 }: WildStepTimelineProps) {
    if (steps.length === 0) {
        return (
            <div className="px-4 py-3 text-center">
                <p className="text-[11px] text-muted-foreground italic">No steps recorded yet</p>
            </div>
        )
    }

    // Show most recent steps first, limited to maxVisible
    const visibleSteps = steps.slice(-maxVisible).reverse()
    const hiddenCount = Math.max(0, steps.length - maxVisible)

    return (
        <div className="px-4 py-2.5">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Step History
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                    {steps.length} step{steps.length !== 1 ? 's' : ''}
                </span>
            </div>

            <div className="relative max-h-[240px] overflow-y-auto scrollbar-thin">
                {/* Timeline line */}
                <div className="absolute left-[9px] top-3 bottom-3 w-px bg-border/60" />

                <div className="space-y-0.5">
                    {visibleSteps.map((step, idx) => {
                        const cfg = stepConfig[step.type] || defaultConfig
                        const isLatest = idx === 0

                        return (
                            <div
                                key={`${step.step_number}-${step.timestamp}`}
                                className={`relative flex items-start gap-2.5 py-1.5 pl-0 pr-1 rounded-md transition-colors ${isLatest ? 'bg-violet-500/5' : ''
                                    }`}
                            >
                                {/* Timeline dot */}
                                <div className={`relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ${cfg.bg} ${isLatest ? 'ring-1 ring-violet-500/40' : ''
                                    }`}>
                                    <span className="text-[10px] leading-none">{cfg.icon}</span>
                                </div>

                                {/* Content */}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className={`text-[11px] font-medium leading-tight ${cfg.color} truncate`}>
                                            {step.title}
                                        </span>
                                        {isLatest && (
                                            <span className="shrink-0 rounded-full bg-violet-500/20 px-1.5 py-px text-[9px] font-semibold text-violet-300">
                                                latest
                                            </span>
                                        )}
                                    </div>
                                    {step.summary && (
                                        <p className="text-[10px] text-muted-foreground leading-snug line-clamp-1 mt-0.5">
                                            {step.summary}
                                        </p>
                                    )}
                                    <span className="text-[9px] text-muted-foreground/60 tabular-nums">
                                        {formatRelativeTime(step.timestamp)}
                                    </span>
                                </div>
                            </div>
                        )
                    })}
                </div>

                {hiddenCount > 0 && (
                    <div className="relative flex items-center gap-2.5 py-1.5 pl-0">
                        <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-secondary">
                            <span className="text-[9px] text-muted-foreground font-medium">…</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground italic">
                            {hiddenCount} earlier step{hiddenCount !== 1 ? 's' : ''}
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
}
