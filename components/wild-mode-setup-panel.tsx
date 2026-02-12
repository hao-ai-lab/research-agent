'use client'

import { useState, useCallback } from 'react'
import type { WildModeSetup, AutonomyLevel } from '@/lib/types'

interface WildModeSetupPanelProps {
    onLaunch: (setup: WildModeSetup) => void
}

const DURATION_PRESETS = [
    { label: '1h', minutes: 60 },
    { label: '3h', minutes: 180 },
    { label: '6h', minutes: 360 },
    { label: '12h', minutes: 720 },
    { label: '24h', minutes: 1440 },
]

const AUTONOMY_OPTIONS: { level: AutonomyLevel; icon: string; title: string; description: string }[] = [
    {
        level: 'cautious',
        icon: '🛡️',
        title: 'Cautious',
        description: 'Pauses on failures, asks before creating new runs',
    },
    {
        level: 'balanced',
        icon: '⚖️',
        title: 'Balanced',
        description: 'Handles routine events, pauses on critical alerts',
    },
    {
        level: 'full',
        icon: '🚀',
        title: 'Full Autonomy',
        description: 'Runs freely, resolves alerts, creates sweeps independently',
    },
]

export function WildModeSetupPanel({ onLaunch }: WildModeSetupPanelProps) {
    const [awayMinutes, setAwayMinutes] = useState(360) // default 6h
    const [customHours, setCustomHours] = useState('')
    const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>('balanced')
    const [queueModifyEnabled, setQueueModifyEnabled] = useState(true)
    const [selectedPreset, setSelectedPreset] = useState<number | null>(360)

    const handlePresetClick = useCallback((minutes: number) => {
        setAwayMinutes(minutes)
        setSelectedPreset(minutes)
        setCustomHours('')
    }, [])

    const handleCustomChange = useCallback((value: string) => {
        setCustomHours(value)
        const parsed = parseFloat(value)
        if (!Number.isNaN(parsed) && parsed > 0) {
            setAwayMinutes(Math.round(parsed * 60))
            setSelectedPreset(null)
        }
    }, [])

    const handleLaunch = useCallback(() => {
        onLaunch({
            awayDurationMinutes: awayMinutes,
            autonomyLevel,
            queueModifyEnabled,
        })
    }, [awayMinutes, autonomyLevel, queueModifyEnabled, onLaunch])

    const formatDuration = (minutes: number) => {
        if (minutes < 60) return `${minutes}m`
        const h = Math.floor(minutes / 60)
        const m = minutes % 60
        return m > 0 ? `${h}h ${m}m` : `${h}h`
    }

    return (
        <div style={{
            width: '100%',
            maxWidth: '640px',
            margin: '0 auto',
        }}>
            {/* Header */}
            <div style={{
                textAlign: 'center',
                marginBottom: '28px',
            }}>
                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#e2e8f0',
                    marginBottom: '6px',
                }}>
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '36px',
                        height: '36px',
                        borderRadius: '10px',
                        background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                        fontSize: '18px',
                    }}>🐺</span>
                    Wild Mode Setup
                </div>
                <p style={{
                    fontSize: '13px',
                    color: '#64748b',
                    margin: '4px 0 0',
                }}>
                    Configure how the agent operates while you&apos;re away
                </p>
            </div>

            <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
            }}>
                {/* Section 1: Away Duration */}
                <div style={{
                    background: 'rgba(30, 30, 50, 0.6)',
                    border: '1px solid rgba(139, 92, 246, 0.15)',
                    borderRadius: '14px',
                    padding: '18px 20px',
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        fontWeight: 600,
                        color: '#c4b5fd',
                        marginBottom: '14px',
                    }}>
                        <span>⏱</span>
                        Away Duration
                        <span style={{
                            marginLeft: 'auto',
                            fontSize: '12px',
                            fontWeight: 500,
                            color: '#a855f7',
                            background: 'rgba(168, 85, 247, 0.12)',
                            padding: '2px 8px',
                            borderRadius: '6px',
                        }}>
                            {formatDuration(awayMinutes)}
                        </span>
                    </div>

                    {/* Preset Buttons */}
                    <div style={{
                        display: 'flex',
                        gap: '8px',
                        marginBottom: '12px',
                    }}>
                        {DURATION_PRESETS.map((preset) => (
                            <button
                                key={preset.minutes}
                                type="button"
                                onClick={() => handlePresetClick(preset.minutes)}
                                style={{
                                    flex: 1,
                                    padding: '8px 0',
                                    fontSize: '13px',
                                    fontWeight: 600,
                                    borderRadius: '8px',
                                    border: selectedPreset === preset.minutes
                                        ? '1px solid #a855f7'
                                        : '1px solid rgba(148, 163, 184, 0.15)',
                                    background: selectedPreset === preset.minutes
                                        ? 'rgba(168, 85, 247, 0.2)'
                                        : 'rgba(30, 30, 50, 0.5)',
                                    color: selectedPreset === preset.minutes
                                        ? '#c4b5fd'
                                        : '#94a3b8',
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    {/* Custom Input */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                    }}>
                        <span style={{ fontSize: '12px', color: '#64748b' }}>Custom:</span>
                        <input
                            type="number"
                            placeholder="hours"
                            min="0.5"
                            step="0.5"
                            value={customHours}
                            onChange={(e) => handleCustomChange(e.target.value)}
                            style={{
                                flex: 1,
                                padding: '6px 10px',
                                background: 'rgba(15, 15, 30, 0.6)',
                                border: '1px solid rgba(139, 92, 246, 0.15)',
                                borderRadius: '6px',
                                color: '#e2e8f0',
                                fontSize: '13px',
                                outline: 'none',
                                maxWidth: '100px',
                            }}
                        />
                        <span style={{ fontSize: '12px', color: '#64748b' }}>hours</span>
                    </div>
                </div>

                {/* Section 2: Autonomy Level */}
                <div style={{
                    background: 'rgba(30, 30, 50, 0.6)',
                    border: '1px solid rgba(139, 92, 246, 0.15)',
                    borderRadius: '14px',
                    padding: '18px 20px',
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        fontWeight: 600,
                        color: '#c4b5fd',
                        marginBottom: '14px',
                    }}>
                        <span>🎛</span>
                        Autonomy Level
                    </div>

                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                    }}>
                        {AUTONOMY_OPTIONS.map((opt) => {
                            const isSelected = autonomyLevel === opt.level
                            return (
                                <button
                                    key={opt.level}
                                    type="button"
                                    onClick={() => setAutonomyLevel(opt.level)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        padding: '12px 14px',
                                        borderRadius: '10px',
                                        border: isSelected
                                            ? '1px solid #a855f7'
                                            : '1px solid rgba(148, 163, 184, 0.1)',
                                        background: isSelected
                                            ? 'rgba(168, 85, 247, 0.12)'
                                            : 'rgba(15, 15, 30, 0.4)',
                                        cursor: 'pointer',
                                        textAlign: 'left',
                                        transition: 'all 0.15s ease',
                                        width: '100%',
                                    }}
                                >
                                    <span style={{
                                        fontSize: '20px',
                                        flexShrink: 0,
                                        width: '28px',
                                        textAlign: 'center',
                                    }}>{opt.icon}</span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            fontSize: '13px',
                                            fontWeight: 600,
                                            color: isSelected ? '#e2e8f0' : '#94a3b8',
                                            marginBottom: '2px',
                                        }}>
                                            {opt.title}
                                        </div>
                                        <div style={{
                                            fontSize: '11px',
                                            color: isSelected ? '#94a3b8' : '#64748b',
                                            lineHeight: '1.4',
                                        }}>
                                            {opt.description}
                                        </div>
                                    </div>
                                    {/* Selection indicator */}
                                    <div style={{
                                        width: '16px',
                                        height: '16px',
                                        borderRadius: '50%',
                                        border: isSelected
                                            ? '2px solid #a855f7'
                                            : '2px solid rgba(148, 163, 184, 0.2)',
                                        background: isSelected
                                            ? 'radial-gradient(circle, #a855f7 40%, transparent 41%)'
                                            : 'transparent',
                                        flexShrink: 0,
                                    }} />
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Section 3: Queue Modification */}
                <div style={{
                    background: 'rgba(30, 30, 50, 0.6)',
                    border: '1px solid rgba(139, 92, 246, 0.15)',
                    borderRadius: '14px',
                    padding: '18px 20px',
                }}>
                    <button
                        type="button"
                        onClick={() => setQueueModifyEnabled((prev) => !prev)}
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '12px',
                            width: '100%',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textAlign: 'left',
                        }}
                    >
                        <span style={{ fontSize: '18px', marginTop: '1px' }}>📋</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginBottom: '6px',
                            }}>
                                <span style={{
                                    fontSize: '14px',
                                    fontWeight: 600,
                                    color: '#c4b5fd',
                                }}>
                                    Queue Modification
                                </span>
                            </div>
                            <p style={{
                                fontSize: '12px',
                                color: '#64748b',
                                margin: 0,
                                lineHeight: '1.5',
                            }}>
                                {queueModifyEnabled
                                    ? 'Agent can inspect queued events, reorder priorities, drop duplicates, and replan the queue strategy'
                                    : 'Agent processes queue items in strict order without modification'}
                            </p>
                        </div>
                        {/* Toggle */}
                        <div style={{
                            width: '40px',
                            height: '22px',
                            borderRadius: '11px',
                            background: queueModifyEnabled
                                ? 'linear-gradient(135deg, #7c3aed, #a855f7)'
                                : 'rgba(148, 163, 184, 0.2)',
                            position: 'relative',
                            transition: 'background 0.2s ease',
                            flexShrink: 0,
                            marginTop: '2px',
                        }}>
                            <div style={{
                                width: '16px',
                                height: '16px',
                                borderRadius: '50%',
                                background: '#fff',
                                position: 'absolute',
                                top: '3px',
                                left: queueModifyEnabled ? '21px' : '3px',
                                transition: 'left 0.2s ease',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                            }} />
                        </div>
                    </button>
                </div>

                {/* Launch Button */}
                <button
                    type="button"
                    onClick={handleLaunch}
                    style={{
                        width: '100%',
                        padding: '14px 20px',
                        fontSize: '15px',
                        fontWeight: 700,
                        borderRadius: '12px',
                        border: 'none',
                        background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                        color: '#fff',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        boxShadow: '0 4px 16px rgba(124, 58, 237, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        letterSpacing: '0.3px',
                    }}
                    onMouseEnter={(e) => {
                        ; (e.target as HTMLButtonElement).style.boxShadow = '0 6px 24px rgba(124, 58, 237, 0.45)'
                            ; (e.target as HTMLButtonElement).style.transform = 'translateY(-1px)'
                    }}
                    onMouseLeave={(e) => {
                        ; (e.target as HTMLButtonElement).style.boxShadow = '0 4px 16px rgba(124, 58, 237, 0.3)'
                            ; (e.target as HTMLButtonElement).style.transform = 'translateY(0)'
                    }}
                >
                    🐺 Launch Wild Mode
                </button>

                {/* Status Summary */}
                <div style={{
                    textAlign: 'center',
                    fontSize: '11px',
                    color: '#475569',
                    lineHeight: '1.6',
                }}>
                    {formatDuration(awayMinutes)} session · {autonomyLevel} autonomy · queue modify {queueModifyEnabled ? 'on' : 'off'}
                </div>
            </div>
        </div>
    )
}
