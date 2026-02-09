'use client'

import React, { useState } from 'react'
import { Link2 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  REFERENCE_TYPE_BACKGROUND_MAP,
  REFERENCE_TYPE_COLOR_MAP,
  type ReferenceTokenType,
} from '@/lib/reference-token-colors'
import type { ContextReference } from '@/lib/extract-context-references'
import type { Sweep, SweepConfig, ExperimentRun } from '@/lib/types'
import type { Alert } from '@/lib/api-client'
import { SweepArtifact } from './sweep-artifact'
import { SweepStatus } from './sweep-status'

interface ContextReferencesBarProps {
  references: ContextReference[]
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  alerts?: Alert[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
}

function RunPreview({ run }: { run: ExperimentRun }) {
  const statusColors: Record<string, string> = {
    running: '#22c55e',
    completed: '#22c55e',
    failed: '#ef4444',
    queued: '#eab308',
    canceled: '#6b7280',
    ready: '#3b82f6',
  }
  const color = statusColors[run.status] || '#6b7280'

  return (
    <div className="space-y-2 p-3 text-sm">
      <div className="flex items-center gap-2">
        <div
          className="h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        <span className="font-medium text-foreground">{run.name}</span>
      </div>
      {run.alias && (
        <p className="text-xs text-muted-foreground">Alias: {run.alias}</p>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="capitalize">{run.status}</span>
        {run.progress > 0 && (
          <span>{Math.round(run.progress * 100)}%</span>
        )}
      </div>
      {run.metrics && (
        <div className="border-t border-border/50 pt-2 text-xs text-muted-foreground">
          {run.metrics.loss !== undefined && <div>Loss: {run.metrics.loss.toFixed(4)}</div>}
          {run.metrics.accuracy !== undefined && <div>Acc: {(run.metrics.accuracy * 100).toFixed(1)}%</div>}
          {run.metrics.epoch !== undefined && <div>Epoch: {run.metrics.epoch}</div>}
        </div>
      )}
      {run.command && (
        <div className="border-t border-border/50 pt-2">
          <code className="break-all text-[10px] text-muted-foreground/70">
            {run.command.length > 80 ? `${run.command.slice(0, 80)}…` : run.command}
          </code>
        </div>
      )}
    </div>
  )
}

function AlertPreview({ alert }: { alert: Alert }) {
  const severityColors: Record<string, string> = {
    critical: '#ef4444',
    warning: '#f97316',
    info: '#3b82f6',
  }
  const color = severityColors[alert.severity] || '#6b7280'

  return (
    <div className="space-y-2 p-3 text-sm">
      <div className="flex items-center gap-2">
        <div
          className="h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        <span className="font-medium capitalize text-foreground">{alert.severity} Alert</span>
      </div>
      <p className="text-xs text-muted-foreground">{alert.message}</p>
      {alert.run_id && (
        <p className="text-xs text-muted-foreground/70">Run: {alert.run_id}</p>
      )}
    </div>
  )
}

function GenericReferencePreview({ reference }: { reference: ContextReference }) {
  return (
    <div className="p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium capitalize text-foreground">{reference.type}</span>
        <span className="text-xs text-muted-foreground">{reference.id}</span>
      </div>
    </div>
  )
}

function ReferenceChip({
  reference,
  sweeps = [],
  runs = [],
  alerts = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
}: {
  reference: ContextReference
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  alerts?: Alert[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
}) {
  const tokenType = (reference.type in REFERENCE_TYPE_COLOR_MAP ? reference.type : 'chat') as ReferenceTokenType
  const color = REFERENCE_TYPE_COLOR_MAP[tokenType]
  const backgroundColor = REFERENCE_TYPE_BACKGROUND_MAP[tokenType]
  const tokenStyle = {
    color,
    backgroundColor,
    ['--reference-border' as string]: `${color}66`,
  } as React.CSSProperties

  // Build popover content based on the type
  const renderPopoverContent = () => {
    if (reference.type === 'sweep') {
      const sweep = sweeps.find(s => s.id === reference.id)
      if (sweep) {
        return sweep.status === 'draft' ? (
          <SweepArtifact
            config={sweep.config}
            sweep={sweep}
            onEdit={onEditSweep}
            onLaunch={onLaunchSweep}
            isCollapsed={false}
          />
        ) : (
          <SweepStatus
            sweep={sweep}
            runs={runs}
            onRunClick={onRunClick}
            isCollapsed={false}
          />
        )
      }
    }

    if (reference.type === 'run') {
      const run = runs.find(r => r.id === reference.id)
      if (run) return <RunPreview run={run} />
    }

    if (reference.type === 'alert') {
      const alert = alerts.find(a => a.id === reference.id)
      if (alert) return <AlertPreview alert={alert} />
    }

    return <GenericReferencePreview reference={reference} />
  }

  // Short display name (truncate long IDs)
  const displayId = reference.id.length > 16 
    ? `${reference.id.slice(0, 6)}…${reference.id.slice(-6)}`
    : reference.id

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--reference-border)] px-2 py-0.5 text-xs leading-tight outline-none transition-all duration-200 hover:scale-[1.03] hover:border-transparent hover:shadow-sm focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
          style={tokenStyle}
        >
          <span className="opacity-60">@</span>
          <span>{reference.type}</span>
          <span className="opacity-40">:</span>
          <span className="font-mono text-[10px] opacity-70">{displayId}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(94vw,430px)] p-0">
        {renderPopoverContent()}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Displays a "Context:" bar with clickable reference tokens.
 * Each token opens a popover with a preview of the referenced object.
 */
export function ContextReferencesBar({
  references,
  sweeps = [],
  runs = [],
  alerts = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
}: ContextReferencesBarProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (references.length === 0) return null

  return (
    <div className="mt-2 rounded-lg border border-border/40 bg-secondary/20 px-3 py-2 transition-all duration-300">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        <Link2 className="h-3 w-3 shrink-0" />
        <span className="font-medium">Context</span>
        <span className="opacity-50">·</span>
        <span className="opacity-50">{references.length} reference{references.length !== 1 ? 's' : ''}</span>
        <span className={`ml-auto text-[10px] transition-transform ${collapsed ? '' : 'rotate-180'}`}>▾</span>
      </button>

      {!collapsed && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {references.map((ref) => (
            <ReferenceChip
              key={ref.reference}
              reference={ref}
              sweeps={sweeps}
              runs={runs}
              alerts={alerts}
              onEditSweep={onEditSweep}
              onLaunchSweep={onLaunchSweep}
              onRunClick={onRunClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}
