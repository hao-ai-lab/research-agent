'use client'

import { WildLoopPhase, TerminationConditions } from '@/lib/types'
import { useState, useEffect, useCallback } from 'react'

const phaseConfig: Record<WildLoopPhase, { icon: string; label: string; color: string }> = {
  idle: { icon: '⏸', label: 'Idle', color: '#888' },
  starting: { icon: '🚀', label: 'Starting', color: '#a855f7' },
  onboarding: { icon: '🎯', label: 'Understanding Goal', color: '#a855f7' },
  designing: { icon: '🧪', label: 'Designing Experiment', color: '#8b5cf6' },
  monitoring: { icon: '📡', label: 'Monitoring', color: '#7c3aed' },
  analyzing: { icon: '🔍', label: 'Analyzing Results', color: '#6d28d9' },
  fixing: { icon: '🔧', label: 'Fixing Issues', color: '#f59e0b' },
  complete: { icon: '✅', label: 'Complete', color: '#22c55e' },
  paused: { icon: '⏯️', label: 'Paused', color: '#f59e0b' },
  waiting_for_human: { icon: '🙋', label: 'Waiting for You', color: '#ef4444' },
}

interface WildLoopBannerProps {
  phase: WildLoopPhase
  iteration: number
  goal: string | null
  startedAt: number | null
  isPaused: boolean
  terminationConditions: TerminationConditions
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onConfigureTermination: () => void
}

export function WildLoopBanner({
  phase,
  iteration,
  goal,
  startedAt,
  isPaused,
  terminationConditions,
  onPause,
  onResume,
  onStop,
  onConfigureTermination,
}: WildLoopBannerProps) {
  const [elapsed, setElapsed] = useState('0:00')

  useEffect(() => {
    if (!startedAt) return
    const interval = setInterval(() => {
      const secs = Math.floor(Date.now() / 1000 - startedAt)
      const mins = Math.floor(secs / 60)
      const hrs = Math.floor(mins / 60)
      if (hrs > 0) {
        setElapsed(`${hrs}:${String(mins % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`)
      } else {
        setElapsed(`${mins}:${String(secs % 60).padStart(2, '0')}`)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  const config = phaseConfig[phase] || phaseConfig.idle

  const termDisplay = useCallback(() => {
    const parts: string[] = []
    if (terminationConditions.maxIterations) {
      parts.push(`${iteration}/${terminationConditions.maxIterations} iters`)
    }
    if (terminationConditions.maxTimeSeconds) {
      const mins = Math.floor(terminationConditions.maxTimeSeconds / 60)
      parts.push(`${mins}m limit`)
    }
    if (terminationConditions.customCondition) {
      parts.push('custom')
    }
    return parts.length ? parts.join(' · ') : null
  }, [terminationConditions, iteration])

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(124, 58, 237, 0.1) 100%)',
      borderBottom: `2px solid ${config.color}`,
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '13px',
      color: '#e2e8f0',
      flexWrap: 'wrap',
    }}>
      {/* Phase indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontWeight: 600,
        color: config.color,
        minWidth: 0,
      }}>
        <span style={{ fontSize: '16px' }}>{config.icon}</span>
        <span style={{ whiteSpace: 'nowrap' }}>{config.label}</span>
      </div>

      {/* Stats */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: 1,
        minWidth: 0,
        color: '#94a3b8',
        fontSize: '12px',
      }}>
        <span style={{
          background: 'rgba(139, 92, 246, 0.2)',
          padding: '2px 8px',
          borderRadius: '10px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          color: '#c4b5fd',
        }}>
          #{iteration}
        </span>
        <span style={{ whiteSpace: 'nowrap' }}>⏱ {elapsed}</span>
        {termDisplay() && (
          <span
            onClick={onConfigureTermination}
            style={{
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: '8px',
              background: 'rgba(139, 92, 246, 0.1)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '120px',
            }}
            title="Click to configure termination"
          >
            {termDisplay()}
          </span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        {isPaused ? (
          <button
            onClick={onResume}
            style={{
              background: '#7c3aed',
              border: 'none',
              color: 'white',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ▶ Resume
          </button>
        ) : (
          <button
            onClick={onPause}
            style={{
              background: 'rgba(139, 92, 246, 0.2)',
              border: '1px solid rgba(139, 92, 246, 0.3)',
              color: '#c4b5fd',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            ⏸ Pause
          </button>
        )}
        <button
          onClick={onStop}
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#fca5a5',
            padding: '4px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          ◼ Stop
        </button>
      </div>

      {/* Goal - second row if present */}
      {goal && (
        <div style={{
          width: '100%',
          fontSize: '11px',
          color: '#94a3b8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingTop: '4px',
          borderTop: '1px solid rgba(139, 92, 246, 0.15)',
          marginTop: '2px',
        }}>
          🎯 {goal}
        </div>
      )}
    </div>
  )
}
