'use client'

import { useState } from 'react'
import { TerminationConditions } from '@/lib/types'

interface WildTerminationDialogProps {
  open: boolean
  onClose: () => void
  currentConditions: TerminationConditions
  onSave: (conditions: TerminationConditions) => void
}

export function WildTerminationDialog({
  open,
  onClose,
  currentConditions,
  onSave,
}: WildTerminationDialogProps) {
  const [maxIterations, setMaxIterations] = useState<string>(
    currentConditions.maxIterations?.toString() || ''
  )
  const [timeMinutes, setTimeMinutes] = useState<string>(
    currentConditions.maxTimeSeconds ? String(Math.floor(currentConditions.maxTimeSeconds / 60)) : ''
  )
  const [maxTokens, setMaxTokens] = useState<string>(
    currentConditions.maxTokens?.toString() || ''
  )
  const [customCondition, setCustomCondition] = useState<string>(
    currentConditions.customCondition || ''
  )

  if (!open) return null

  const handleSave = () => {
    const conditions: TerminationConditions = {}
    if (maxIterations) conditions.maxIterations = parseInt(maxIterations)
    if (timeMinutes) conditions.maxTimeSeconds = parseInt(timeMinutes) * 60
    if (maxTokens) conditions.maxTokens = parseInt(maxTokens)
    if (customCondition.trim()) conditions.customCondition = customCondition.trim()
    onSave(conditions)
    onClose()
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(4px)',
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: '#1a1a2e',
        borderRadius: '16px',
        border: '1px solid rgba(139, 92, 246, 0.3)',
        padding: '24px',
        width: '340px',
        maxWidth: 'calc(100vw - 32px)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <h3 style={{
          margin: '0 0 20px',
          fontSize: '16px',
          fontWeight: 700,
          color: '#e2e8f0',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ color: '#a855f7' }}>⚙️</span>
          Termination Conditions
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Iterations */}
          <div>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#94a3b8',
              marginBottom: '6px',
            }}>
              🔄 Max Iterations
            </label>
            <input
              type="number"
              placeholder="∞ (no limit)"
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'rgba(30, 30, 50, 0.8)',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                borderRadius: '8px',
                color: '#e2e8f0',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Time */}
          <div>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#94a3b8',
              marginBottom: '6px',
            }}>
              ⏱ Time Limit (minutes)
            </label>
            <input
              type="number"
              placeholder="∞ (no limit)"
              value={timeMinutes}
              onChange={(e) => setTimeMinutes(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'rgba(30, 30, 50, 0.8)',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                borderRadius: '8px',
                color: '#e2e8f0',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Token Budget */}
          <div>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#94a3b8',
              marginBottom: '6px',
            }}>
              💰 Token Budget
            </label>
            <input
              type="number"
              placeholder="∞ (no limit)"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'rgba(30, 30, 50, 0.8)',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                borderRadius: '8px',
                color: '#e2e8f0',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Custom Condition */}
          <div>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#94a3b8',
              marginBottom: '6px',
            }}>
              📝 Custom Stop Condition
            </label>
            <textarea
              placeholder="e.g. &quot;Stop when accuracy > 95%&quot;"
              value={customCondition}
              onChange={(e) => setCustomCondition(e.target.value)}
              rows={2}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'rgba(30, 30, 50, 0.8)',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                borderRadius: '8px',
                color: '#e2e8f0',
                fontSize: '13px',
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Actions */}
        <div style={{
          display: 'flex',
          gap: '8px',
          marginTop: '20px',
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '8px',
              color: '#94a3b8',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: '8px 16px',
              background: '#7c3aed',
              border: 'none',
              borderRadius: '8px',
              color: 'white',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
