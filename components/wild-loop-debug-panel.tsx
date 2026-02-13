'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { RefreshCw, X, ChevronDown, ChevronRight, Bug, Circle, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { getWildLoopStatus, getWildEventQueue, configureWildLoop, getWildV2Status } from '@/lib/api'
import type { WildLoopStatus, WildEventQueueItem, WildV2Status } from '@/lib/api'
import { useAppSettings } from '@/lib/app-settings'

interface WildLoopDebugPanelProps {
    onClose: () => void
}

export function WildLoopDebugPanel({ onClose }: WildLoopDebugPanelProps) {
    const { settings, setSettings } = useAppSettings()
    const [status, setStatus] = useState<WildLoopStatus | null>(null)
    const [queue, setQueue] = useState<{ queue_size: number; events: WildEventQueueItem[] } | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [statusOpen, setStatusOpen] = useState(true)
    const [queueOpen, setQueueOpen] = useState(true)
    const [entitiesOpen, setEntitiesOpen] = useState(true)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [v2PlanOpen, setV2PlanOpen] = useState(true)
    const [v2TasksOpen, setV2TasksOpen] = useState(true)
    const [v2LogOpen, setV2LogOpen] = useState(false)
    const [v2Status, setV2Status] = useState<WildV2Status | null>(null)
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
    const prevIterationRef = useRef<number | null>(null)

    const refreshInterval = settings.developer?.debugRefreshIntervalSeconds ?? 2

    const refresh = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const [statusData, queueData, v2Data] = await Promise.all([
                getWildLoopStatus(),
                getWildEventQueue(),
                getWildV2Status().catch(() => ({ active: false } as WildV2Status)),
            ])
            setStatus(statusData)
            setQueue(queueData)
            setV2Status(v2Data)
            setLastRefreshed(new Date())

            // Detect iteration changes for extra refresh (already handled by interval)
            if (prevIterationRef.current !== null && statusData.iteration !== prevIterationRef.current) {
                // Iteration changed — data is already fresh from this call
            }
            prevIterationRef.current = statusData.iteration
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch')
        } finally {
            setLoading(false)
        }
    }, [])

    // Auto-refresh on mount + interval
    useEffect(() => {
        refresh()
        if (refreshInterval > 0) {
            const id = setInterval(refresh, refreshInterval * 1000)
            return () => clearInterval(id)
        }
    }, [refresh, refreshInterval])

    const setRefreshInterval = (seconds: number) => {
        setSettings({
            ...settings,
            developer: {
                ...settings.developer,
                debugRefreshIntervalSeconds: seconds,
            },
        })
    }

    const phaseColor = (phase: string) => {
        switch (phase) {
            case 'idle': return 'text-muted-foreground'
            case 'exploring': return 'text-blue-400'
            case 'monitoring': return 'text-green-400'
            case 'analyzing': return 'text-yellow-400'
            case 'fixing': return 'text-red-400'
            case 'paused': return 'text-orange-400'
            default: return 'text-foreground'
        }
    }

    const priorityLabel = (p: number) => {
        if (p <= 10) return { label: 'User', color: 'text-purple-400' }
        if (p <= 20) return { label: 'Critical', color: 'text-red-400' }
        if (p <= 30) return { label: 'Warning', color: 'text-yellow-400' }
        if (p <= 50) return { label: 'Run', color: 'text-blue-400' }
        if (p <= 70) return { label: 'Analysis', color: 'text-cyan-400' }
        return { label: 'Explore', color: 'text-muted-foreground' }
    }

    const statusColor = (s: string) => {
        switch (s) {
            case 'running': return 'text-blue-400'
            case 'finished': case 'completed': return 'text-green-400'
            case 'failed': return 'text-red-400'
            case 'queued': case 'ready': return 'text-muted-foreground'
            case 'pending': return 'text-yellow-400'
            default: return 'text-foreground'
        }
    }

    const totalEntities = (status?.created_sweeps?.length ?? 0) + (status?.created_runs?.length ?? 0)

    return (
        <div className="flex h-full w-[350px] flex-col border-l border-border bg-background/95 backdrop-blur-sm">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                    <Bug className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Wild Loop Debug</span>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={refresh}
                        disabled={loading}
                        title="Refresh"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={onClose}
                        title="Close"
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            {/* Last refreshed + interval indicator */}
            {lastRefreshed && (
                <div className="px-3 py-1 text-[10px] text-muted-foreground/60 border-b border-border/50 flex items-center justify-between">
                    <span>Last refreshed: {lastRefreshed.toLocaleTimeString()}</span>
                    {refreshInterval > 0 && (
                        <span className="text-muted-foreground/40">⟳ {refreshInterval}s</span>
                    )}
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="px-3 py-2 text-xs text-red-400 bg-red-400/10 border-b border-red-400/20">
                    {error}
                </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {/* Settings Section */}
                <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                    <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
                        {settingsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <Settings className="h-3 w-3 text-muted-foreground" />
                        <span>Settings</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                        <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-3 text-xs">
                            <div>
                                <label className="text-muted-foreground text-[10px] font-medium block mb-1">
                                    Auto-refresh interval (seconds)
                                </label>
                                <div className="flex items-center gap-2">
                                    {[0, 1, 2, 5, 10].map((s) => (
                                        <button
                                            key={s}
                                            className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${refreshInterval === s
                                                ? 'bg-primary text-primary-foreground border-primary'
                                                : 'border-border/50 hover:bg-secondary text-muted-foreground'
                                                }`}
                                            onClick={() => setRefreshInterval(s)}
                                        >
                                            {s === 0 ? 'Off' : `${s}s`}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </CollapsibleContent>
                </Collapsible>

                {/* V2 Plan Section */}
                {v2Status && v2Status.active && (
                    <Collapsible open={v2PlanOpen} onOpenChange={setV2PlanOpen}>
                        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-green-500/15">
                            {v2PlanOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            <span>🤖 V2 Loop</span>
                            <span className="ml-auto text-[10px] text-green-400">
                                iter {v2Status.iteration}/{v2Status.max_iterations} • {v2Status.status}
                            </span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-2">
                            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-3 text-xs">
                                {/* Goal */}
                                <div>
                                    <div className="text-[10px] text-muted-foreground mb-1 font-medium">Goal</div>
                                    <div className="text-foreground">{v2Status.goal || '—'}</div>
                                </div>

                                {/* Session Dir */}
                                {v2Status.session_dir && (
                                    <div>
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">Session Dir</div>
                                        <code className="text-[10px] text-blue-400 break-all">{v2Status.session_dir}</code>
                                    </div>
                                )}

                                {/* 📄 tasks.md */}
                                {v2Status.plan && (
                                    <Collapsible open={v2TasksOpen} onOpenChange={setV2TasksOpen}>
                                        <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors">
                                            {v2TasksOpen ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                                            📄 tasks.md
                                            <span className="ml-auto text-[9px] text-muted-foreground/60">
                                                {v2Status.plan.length} chars
                                            </span>
                                        </CollapsibleTrigger>
                                        <CollapsibleContent>
                                            <pre className="mt-1 text-[10px] bg-secondary/30 rounded p-2 overflow-x-auto max-h-[250px] overflow-y-auto whitespace-pre-wrap border border-border/30">
                                                {v2Status.plan}
                                            </pre>
                                        </CollapsibleContent>
                                    </Collapsible>
                                )}

                                {/* 📄 iteration_log.md */}
                                {v2Status.iteration_log && (
                                    <Collapsible open={v2LogOpen} onOpenChange={setV2LogOpen}>
                                        <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors">
                                            {v2LogOpen ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                                            📄 iteration_log.md
                                            <span className="ml-auto text-[9px] text-muted-foreground/60">
                                                {v2Status.iteration_log.length} chars
                                            </span>
                                        </CollapsibleTrigger>
                                        <CollapsibleContent>
                                            <pre className="mt-1 text-[10px] bg-secondary/30 rounded p-2 overflow-x-auto max-h-[250px] overflow-y-auto whitespace-pre-wrap border border-border/30">
                                                {v2Status.iteration_log}
                                            </pre>
                                        </CollapsibleContent>
                                    </Collapsible>
                                )}

                                {/* System Health */}
                                {v2Status.system_health && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">System Health</div>
                                        <div className="flex flex-wrap gap-2 text-[10px]">
                                            <span className="text-blue-400">▶ {v2Status.system_health.running}/{v2Status.system_health.max_concurrent}</span>
                                            <span className="text-muted-foreground">⏳ {v2Status.system_health.queued}</span>
                                            <span className="text-green-400">✓ {v2Status.system_health.completed}</span>
                                            <span className="text-red-400">✗ {v2Status.system_health.failed}</span>
                                        </div>
                                    </div>
                                )}

                                {/* Struggle Signals */}
                                {((v2Status.no_progress_streak ?? 0) > 0 || (v2Status.short_iteration_count ?? 0) > 0) && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">⚠ Struggle Signals</div>
                                        <div className="flex flex-wrap gap-3 text-[10px]">
                                            {(v2Status.no_progress_streak ?? 0) > 0 && (
                                                <span className="text-orange-400">No-progress streak: {v2Status.no_progress_streak}</span>
                                            )}
                                            {(v2Status.short_iteration_count ?? 0) > 0 && (
                                                <span className="text-yellow-400">Short iterations: {v2Status.short_iteration_count}</span>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Pending Events */}
                                {v2Status.pending_events_count != null && v2Status.pending_events_count > 0 && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">
                                            Pending Events ({v2Status.pending_events_count})
                                        </div>
                                        <div className="space-y-1">
                                            {(v2Status.pending_events || []).slice(0, 5).map((ev) => (
                                                <div key={ev.id} className="text-[10px] flex items-start gap-1">
                                                    <Circle className="h-2 w-2 mt-0.5 text-yellow-400 fill-yellow-400/30" />
                                                    <div className="min-w-0">
                                                        <div className="truncate">{ev.title}</div>
                                                        <div className="text-[9px] text-muted-foreground truncate">
                                                            {ev.type}
                                                            {ev.mode ? ` • ${ev.mode}` : ''}
                                                            {ev.severity ? ` • ${ev.severity}` : ''}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* OpenEvolve Jobs */}
                                {v2Status.openevolve_jobs && v2Status.openevolve_jobs.length > 0 && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">
                                            OpenEvolve Jobs ({v2Status.openevolve_jobs.length})
                                        </div>
                                        <div className="space-y-1 max-h-[140px] overflow-y-auto">
                                            {v2Status.openevolve_jobs.map((job) => (
                                                <div
                                                    key={job.id}
                                                    className="rounded border border-border/30 bg-secondary/20 px-2 py-1 text-[10px]"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="truncate text-foreground">{job.name || job.id}</span>
                                                        <span className={statusColor(job.status)}>{job.status}</span>
                                                    </div>
                                                    <div className="text-[9px] text-muted-foreground truncate">
                                                        {job.mode} • iter {job.last_iteration ?? 'n/a'}
                                                    </div>
                                                    {job.latest_checkpoint && (
                                                        <div className="text-[9px] text-blue-400 truncate" title={job.latest_checkpoint}>
                                                            {job.latest_checkpoint}
                                                        </div>
                                                    )}
                                                    <div className="text-[9px] text-muted-foreground truncate">
                                                        best={job.best_program_id ?? 'n/a'} score={job.best_score ?? 'n/a'}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Iteration History */}
                                {v2Status.history && v2Status.history.length > 0 && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">
                                            Iteration History ({v2Status.history.length})
                                        </div>
                                        <div className="space-y-1 max-h-[150px] overflow-y-auto">
                                            {v2Status.history.slice().reverse().map((h) => (
                                                <div key={h.iteration} className="text-[10px] flex items-start gap-1.5 rounded bg-secondary/30 px-2 py-1">
                                                    <span className="text-muted-foreground shrink-0">#{h.iteration}</span>
                                                    <span className="truncate flex-1" title={h.summary}>{h.summary}</span>
                                                    {h.promise && (
                                                        <span className={`shrink-0 font-medium ${h.promise === 'DONE' ? 'text-green-400' :
                                                            h.promise === 'WAITING' ? 'text-yellow-400' : 'text-muted-foreground'
                                                            }`}>{h.promise}</span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CollapsibleContent>
                    </Collapsible>
                )}

                {/* Status Section */}
                <Collapsible open={statusOpen} onOpenChange={setStatusOpen}>
                    <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
                        {statusOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span>Wild Status</span>
                        {status && (
                            <span className={`ml-auto text-[10px] ${phaseColor(status.phase)}`}>
                                {status.phase}
                            </span>
                        )}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                        {status ? (
                            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-2 text-xs">
                                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                    <span className="text-muted-foreground">Phase:</span>
                                    <span className={`font-medium ${phaseColor(status.phase)}`}>{status.phase}</span>

                                    <span className="text-muted-foreground">Active:</span>
                                    <span className={status.is_active ? 'text-green-400' : 'text-muted-foreground'}>{String(status.is_active)}</span>

                                    <span className="text-muted-foreground">Paused:</span>
                                    <span className={status.is_paused ? 'text-orange-400' : 'text-muted-foreground'}>{String(status.is_paused)}</span>

                                    <span className="text-muted-foreground">Stage:</span>
                                    <span>{status.stage || '—'}</span>

                                    <span className="text-muted-foreground">Iteration:</span>
                                    <span>{status.iteration}</span>

                                    <span className="text-muted-foreground">Goal:</span>
                                    <span className="truncate" title={status.goal || undefined}>{status.goal || '—'}</span>

                                    <span className="text-muted-foreground">Session:</span>
                                    <span className="font-mono text-[10px] truncate" title={status.session_id || undefined}>
                                        {status.session_id ? status.session_id.slice(0, 12) + '…' : '—'}
                                    </span>

                                    <span className="text-muted-foreground">Sweep:</span>
                                    <span className="font-mono text-[10px]">{status.sweep_id || '—'}</span>

                                    <span className="text-muted-foreground">Queue:</span>
                                    <span>{status.queue_size} events</span>

                                    <span className="text-muted-foreground">Plan:</span>
                                    <button
                                        className={`text-left font-medium cursor-pointer hover:underline ${status.plan_autonomy === 'agent' ? 'text-green-400' : 'text-blue-400'
                                            }`}
                                        onClick={async () => {
                                            const next = status.plan_autonomy === 'agent' ? 'collaborative' : 'agent'
                                            try {
                                                await configureWildLoop({ plan_autonomy: next })
                                                refresh()
                                            } catch { }
                                        }}
                                        title={`Click to switch to ${status.plan_autonomy === 'agent' ? 'collaborative' : 'agent'} mode`}
                                    >
                                        {status.plan_autonomy === 'agent' ? '🤖 Agent decides' : '🤝 Collaborative'}
                                    </button>
                                </div>

                                {/* Run stats */}
                                {status.run_stats && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">Run Stats</div>
                                        <div className="flex flex-wrap gap-2 text-[10px]">
                                            <span>Total: {status.run_stats.total}</span>
                                            <span className="text-green-400">✓ {status.run_stats.completed}</span>
                                            <span className="text-blue-400">▶ {status.run_stats.running}</span>
                                            <span className="text-red-400">✗ {status.run_stats.failed}</span>
                                            <span className="text-muted-foreground">⏳ {status.run_stats.queued}</span>
                                        </div>
                                    </div>
                                )}

                                {/* Termination */}
                                {status.termination && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">Termination</div>
                                        <div className="text-[10px] space-y-0.5">
                                            {status.termination.max_iterations != null && (
                                                <div>Max iterations: {status.termination.max_iterations}</div>
                                            )}
                                            {status.termination.max_time_seconds != null && (
                                                <div>Max time: {status.termination.max_time_seconds}s</div>
                                            )}
                                            {status.termination.max_tokens != null && (
                                                <div>Max tokens: {status.termination.max_tokens}</div>
                                            )}
                                            {!status.termination.max_iterations && !status.termination.max_time_seconds && !status.termination.max_tokens && (
                                                <div className="text-muted-foreground">No limits set</div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Active alerts */}
                                {status.active_alerts && status.active_alerts.length > 0 && (
                                    <div className="border-t border-border/30 pt-2">
                                        <div className="text-[10px] text-muted-foreground mb-1 font-medium">Active Alerts ({status.active_alerts.length})</div>
                                        <div className="space-y-1">
                                            {status.active_alerts.slice(0, 5).map((alert, i) => (
                                                <div key={i} className="text-[10px] flex items-start gap-1">
                                                    <Circle className="h-2 w-2 mt-0.5 text-yellow-400 fill-yellow-400/30" />
                                                    <span className="truncate">{alert.message}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-xs text-muted-foreground p-3">
                                {loading ? 'Loading...' : 'No data'}
                            </div>
                        )}
                    </CollapsibleContent>
                </Collapsible>

                {/* Created Entities Section */}
                <Collapsible open={entitiesOpen} onOpenChange={setEntitiesOpen}>
                    <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
                        {entitiesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span>Created Entities</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                            {totalEntities} items
                        </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                        {totalEntities === 0 ? (
                            <div className="text-xs text-muted-foreground p-3 text-center">
                                No sweeps or runs created yet
                            </div>
                        ) : (
                            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-3 text-xs">
                                {/* Created Sweeps */}
                                {status?.created_sweeps && status.created_sweeps.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-muted-foreground mb-1.5 font-medium">
                                            Sweeps ({status.created_sweeps.length})
                                        </div>
                                        <div className="space-y-1">
                                            {status.created_sweeps.map((sweep) => (
                                                <div
                                                    key={sweep.id}
                                                    className="flex items-center gap-2 rounded border border-border/30 bg-secondary/10 px-2 py-1.5"
                                                >
                                                    <span className={`text-[10px] font-medium ${statusColor(sweep.status)}`}>
                                                        {sweep.status}
                                                    </span>
                                                    <span className="truncate flex-1 text-[10px]" title={sweep.name}>
                                                        {sweep.name}
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground/60 shrink-0">
                                                        {sweep.run_count} runs
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Created Runs */}
                                {status?.created_runs && status.created_runs.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-muted-foreground mb-1.5 font-medium">
                                            Runs ({status.created_runs.length})
                                        </div>
                                        <div className="space-y-1">
                                            {status.created_runs.map((run) => (
                                                <div
                                                    key={run.id}
                                                    className="flex items-center gap-2 rounded border border-border/30 bg-secondary/10 px-2 py-1.5"
                                                >
                                                    <span className={`text-[10px] font-medium ${statusColor(run.status)}`}>
                                                        {run.status}
                                                    </span>
                                                    <span className="truncate flex-1 text-[10px]" title={run.name}>
                                                        {run.name}
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0">
                                                        {run.id}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </CollapsibleContent>
                </Collapsible>

                {/* Queue Section */}
                <Collapsible open={queueOpen} onOpenChange={setQueueOpen}>
                    <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
                        {queueOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span>Event Queue</span>
                        {queue && (
                            <span className="ml-auto text-[10px] text-muted-foreground">
                                {queue.queue_size} items
                            </span>
                        )}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2">
                        {queue ? (
                            queue.events.length === 0 ? (
                                <div className="text-xs text-muted-foreground p-3 text-center">
                                    Queue is empty
                                </div>
                            ) : (
                                <div className="space-y-1.5">
                                    {queue.events.map((event, index) => {
                                        const pl = priorityLabel(event.priority)
                                        return (
                                            <div
                                                key={event.id}
                                                className="rounded-lg border border-border/50 bg-secondary/20 p-2.5 text-xs space-y-1"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-muted-foreground/60 w-4">#{index + 1}</span>
                                                    <span className={`text-[10px] font-medium ${pl.color}`}>{pl.label}</span>
                                                    <span className="text-muted-foreground/60">p{event.priority}</span>
                                                    <span className="ml-auto text-[10px] text-muted-foreground/50">{event.type}</span>
                                                </div>
                                                <div className="font-medium text-foreground truncate" title={event.title}>
                                                    {event.title}
                                                </div>
                                                {event.prompt && (
                                                    <div className="text-[10px] text-muted-foreground/70 line-clamp-2" title={event.prompt}>
                                                        {event.prompt.slice(0, 120)}{event.prompt.length > 120 ? '…' : ''}
                                                    </div>
                                                )}
                                                <div className="text-[10px] text-muted-foreground/50">
                                                    {new Date(event.created_at * 1000).toLocaleTimeString()}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            )
                        ) : (
                            <div className="text-xs text-muted-foreground p-3">
                                {loading ? 'Loading...' : 'No data'}
                            </div>
                        )}
                    </CollapsibleContent>
                </Collapsible>

                {/* Raw JSON toggle */}
                <details className="text-xs">
                    <summary className="text-muted-foreground/50 cursor-pointer hover:text-muted-foreground text-[10px]">
                        Raw JSON
                    </summary>
                    <pre className="mt-2 rounded-lg border border-border/30 bg-secondary/10 p-2 text-[10px] overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">
                        {JSON.stringify({ status, queue }, null, 2)}
                    </pre>
                </details>
            </div>
        </div>
    )
}
