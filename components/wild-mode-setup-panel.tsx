'use client'

import { useState, useCallback } from 'react'
import { Clock, SlidersHorizontal, ListChecks } from 'lucide-react'
import type { WildModeSetup, AutonomyLevel } from '@/lib/types'
import styles from './wild-mode-setup-panel.module.css'

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

const AUTONOMY_OPTIONS: { level: AutonomyLevel; icon: string; label: string }[] = [
    { level: 'cautious', icon: '', label: 'Cautious' },
    { level: 'balanced', icon: '', label: 'Balanced' },
    { level: 'full', icon: '', label: 'Full' },
]

export function WildModeSetupPanel({ onLaunch }: WildModeSetupPanelProps) {
    const [awayMinutes, setAwayMinutes] = useState(360)
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

    // Auto-apply settings whenever they change
    const apply = useCallback(() => {
        onLaunch({
            awayDurationMinutes: awayMinutes,
            autonomyLevel,
            queueModifyEnabled,
        })
    }, [awayMinutes, autonomyLevel, queueModifyEnabled, onLaunch])

    // Wrap setters to also trigger apply
    const selectPreset = useCallback((minutes: number) => {
        handlePresetClick(minutes)
        // Schedule apply after state update
        setTimeout(() => onLaunch({
            awayDurationMinutes: minutes,
            autonomyLevel,
            queueModifyEnabled,
        }), 0)
    }, [handlePresetClick, autonomyLevel, queueModifyEnabled, onLaunch])

    const selectAutonomy = useCallback((level: AutonomyLevel) => {
        setAutonomyLevel(level)
        setTimeout(() => onLaunch({
            awayDurationMinutes: awayMinutes,
            autonomyLevel: level,
            queueModifyEnabled,
        }), 0)
    }, [awayMinutes, queueModifyEnabled, onLaunch])

    const toggleQueue = useCallback(() => {
        const next = !queueModifyEnabled
        setQueueModifyEnabled(next)
        setTimeout(() => onLaunch({
            awayDurationMinutes: awayMinutes,
            autonomyLevel,
            queueModifyEnabled: next,
        }), 0)
    }, [awayMinutes, autonomyLevel, queueModifyEnabled, onLaunch])

    // For custom input, apply on blur or Enter
    const applyCustom = useCallback(() => {
        apply()
    }, [apply])

    return (
        <div className={styles.root}>
            <div className={styles.grid}>
                {/* Duration */}
                <div className={styles.sectionDuration}>
                    <div className={styles.label}>
                        <Clock size={12} /> Duration
                    </div>
                    <div className={styles.chips}>
                        {DURATION_PRESETS.map((p) => (
                            <button
                                key={p.minutes}
                                type="button"
                                className={selectedPreset === p.minutes ? styles.chipActive : styles.chip}
                                onClick={() => selectPreset(p.minutes)}
                            >
                                {p.label}
                            </button>
                        ))}
                        <input
                            type="number"
                            className={styles.customInput}
                            placeholder="hrs"
                            min="0.5"
                            step="0.5"
                            value={customHours}
                            onChange={(e) => handleCustomChange(e.target.value)}
                            onBlur={applyCustom}
                            onKeyDown={(e) => { if (e.key === 'Enter') applyCustom() }}
                        />
                        <span className={styles.customSuffix}>h</span>
                    </div>
                </div>

                {/* Autonomy */}
                <div className={styles.sectionAutonomy}>
                    <div className={styles.label}>
                        <SlidersHorizontal size={12} /> Autonomy
                    </div>
                    <div className={styles.autonomyBtns}>
                        {AUTONOMY_OPTIONS.map((opt) => (
                            <button
                                key={opt.level}
                                type="button"
                                className={autonomyLevel === opt.level ? styles.autoBtnActive : styles.autoBtn}
                                onClick={() => selectAutonomy(opt.level)}
                                title={opt.level === 'cautious'
                                    ? 'Pauses on failures, asks before creating runs'
                                    : opt.level === 'balanced'
                                        ? 'Handles routine events, pauses on critical alerts'
                                        : 'Runs freely, resolves alerts independently'}
                            >
                                {/* <span className={styles.autoIcon}>{opt.icon}</span> */}
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Queue toggle */}
                <div className={styles.sectionQueue}>
                    <div className={styles.label}>
                        <ListChecks size={12} /> Queue Edit
                    </div>
                    <button
                        type="button"
                        className={styles.queueToggle}
                        onClick={toggleQueue}
                    >
                        <div className={queueModifyEnabled ? styles.toggleTrackOn : styles.toggleTrackOff}>
                            <div className={styles.toggleThumb} style={{ left: queueModifyEnabled ? '18px' : '2px' }} />
                        </div>
                        <span className={styles.toggleLabel}>{queueModifyEnabled ? 'On' : 'Off'}</span>
                    </button>
                </div>
            </div>
        </div>
    )
}
