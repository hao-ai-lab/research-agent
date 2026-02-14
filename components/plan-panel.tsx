'use client'

import { useCallback, useEffect, useState } from 'react'
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Clock,
	Loader2,
	PanelLeftOpen,
	Play,
    Plus,
    Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Plan, PlanStatus } from '@/lib/api'
import {
    listPlans,
    approvePlan,
    executePlan,
    deletePlan,
    updatePlan,
} from '@/lib/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: PlanStatus) {
    switch (status) {
        case 'draft':
            return 'bg-amber-500/15 text-amber-500 border-amber-500/30'
        case 'approved':
            return 'bg-blue-500/15 text-blue-500 border-blue-500/30'
        case 'executing':
            return 'bg-violet-500/15 text-violet-500 border-violet-500/30'
        case 'completed':
            return 'bg-green-500/15 text-green-500 border-green-500/30'
        case 'archived':
            return 'bg-muted text-muted-foreground border-muted-foreground/30'
        default:
            return 'bg-secondary text-muted-foreground border-border'
    }
}

function formatAge(ts: number) {
    const diff = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60))
    if (diff < 60) return `${diff}m ago`
    const hours = Math.floor(diff / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// PlanCard
// ---------------------------------------------------------------------------

interface PlanCardProps {
    plan: Plan
    onApprove: (id: string) => void
    onExecute: (id: string) => void
    onDelete: (id: string) => void
    onComplete: (id: string) => void
}

function PlanCard({ plan, onApprove, onExecute, onDelete, onComplete }: PlanCardProps) {
    const [expanded, setExpanded] = useState(false)

    return (
        <div className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-card/80">
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                            {plan.title || 'Untitled Plan'}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {plan.goal.slice(0, 80)}{plan.goal.length > 80 ? '…' : ''}
                        </p>
                    </div>
                </button>
                <Badge
                    variant="outline"
                    className={`shrink-0 text-[10px] capitalize ${statusColor(plan.status)}`}
                >
                    {plan.status}
                </Badge>
            </div>

            {/* Actions row */}
            <div className="mt-2 flex items-center gap-1.5">
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatAge(plan.created_at)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                    {plan.status === 'draft' && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => onApprove(plan.id)}
                        >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Approve
                        </Button>
                    )}
                    {plan.status === 'approved' && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => onExecute(plan.id)}
                        >
                            <Play className="mr-1 h-3 w-3" />
                            Execute
                        </Button>
                    )}
                    {plan.status === 'executing' && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => onComplete(plan.id)}
                        >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Complete
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => onDelete(plan.id)}
                    >
                        <Trash2 className="h-3 w-3" />
                    </Button>
                </div>
            </div>

            {/* Expanded markdown body */}
            {expanded && plan.raw_markdown && (
                <div className="mt-3 rounded-md border border-border/50 bg-secondary/30 p-3">
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                        {plan.raw_markdown}
                    </pre>
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// PlanPanel (main export)
// ---------------------------------------------------------------------------

interface PlanPanelProps {
	showDesktopSidebarToggle?: boolean
	onDesktopSidebarToggle?: () => void
}

export function PlanPanel({
	showDesktopSidebarToggle = false,
	onDesktopSidebarToggle,
}: PlanPanelProps) {
    const [plans, setPlans] = useState<Plan[]>([])
    const [loading, setLoading] = useState(true)

    const refresh = useCallback(async () => {
        try {
            const data = await listPlans()
            setPlans(data)
        } catch (err) {
            console.error('Failed to load plans:', err)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        refresh()
        const interval = setInterval(refresh, 10_000)
        return () => clearInterval(interval)
    }, [refresh])

    const handleApprove = useCallback(
        async (id: string) => {
            try {
                await approvePlan(id)
                await refresh()
            } catch (err) {
                console.error('Failed to approve plan:', err)
            }
        },
        [refresh]
    )

    const handleExecute = useCallback(
        async (id: string) => {
            try {
                await executePlan(id)
                await refresh()
            } catch (err) {
                console.error('Failed to execute plan:', err)
            }
        },
        [refresh]
    )

    const handleComplete = useCallback(
        async (id: string) => {
            try {
                await updatePlan(id, { status: 'completed' })
                await refresh()
            } catch (err) {
                console.error('Failed to complete plan:', err)
            }
        },
        [refresh]
    )

    const handleDelete = useCallback(
        async (id: string) => {
            try {
                await deletePlan(id)
                await refresh()
            } catch (err) {
                console.error('Failed to delete plan:', err)
            }
        },
        [refresh]
    )

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        )
    }

		return (
			<div className="flex h-full flex-col">
				{/* Header */}
				<div className="shrink-0 border-b border-border px-4 py-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							{showDesktopSidebarToggle && onDesktopSidebarToggle && (
								<Button
									variant="outline"
									size="icon-sm"
									onClick={onDesktopSidebarToggle}
									className="hidden h-9 w-9 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
									title="Show sidebar"
								>
									<PanelLeftOpen className="h-4 w-4" />
									<span className="sr-only">Show sidebar</span>
								</Button>
							)}
							<ClipboardList className="h-5 w-5 text-accent" />
							<h2 className="text-sm font-semibold text-foreground">Plans</h2>
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                            {plans.length}
                        </Badge>
                    </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                    Use Plan mode in chat to generate structured experiment plans.
                </p>
            </div>

            {/* List */}
            <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-2 p-4">
                    {plans.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 py-12 text-center">
                            <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
                            <p className="text-sm text-muted-foreground">No plans yet</p>
                            <p className="text-xs text-muted-foreground/70">
                                Switch to <strong>Plan mode</strong> in chat to create one.
                            </p>
                        </div>
                    ) : (
                        plans.map((plan) => (
                            <PlanCard
                                key={plan.id}
                                plan={plan}
                                onApprove={handleApprove}
                                onExecute={handleExecute}
                                onDelete={handleDelete}
                                onComplete={handleComplete}
                            />
                        ))
                    )}
                </div>
            </ScrollArea>
        </div>
    )
}
