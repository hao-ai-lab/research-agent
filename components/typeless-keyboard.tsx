'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, MicOff, Delete, CornerDownLeft, AtSign, Globe, Pencil, Languages, Volume2, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

export type TypelessMode = 'dictate' | 'edit' | 'translate'

interface TypelessKeyboardProps {
  mode: TypelessMode
  onModeChange: (mode: TypelessMode) => void
  isRecording: boolean
  onRecordingToggle: () => void
  rawTranscript: string
  onKeyPress: (key: 'space' | 'delete' | 'return' | 'at') => void
  targetLanguage: string
  onTargetLanguageChange: (lang: string) => void
  wordsToday: number
  timeSavedSeconds: number
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'it', label: 'Italian' },
  { code: 'ru', label: 'Russian' },
]

export function TypelessKeyboard({
  mode,
  onModeChange,
  isRecording,
  onRecordingToggle,
  rawTranscript,
  onKeyPress,
  targetLanguage,
  onTargetLanguageChange,
  wordsToday,
  timeSavedSeconds,
}: TypelessKeyboardProps) {
  const [showLanguages, setShowLanguages] = useState(false)
  const [pulseIntensity, setPulseIntensity] = useState(0)
  const pulseRef = useRef<NodeJS.Timeout | null>(null)

  // Simulate voice level pulse when recording
  useEffect(() => {
    if (isRecording) {
      pulseRef.current = setInterval(() => {
        setPulseIntensity(Math.random() * 0.7 + 0.3)
      }, 150)
    } else {
      if (pulseRef.current) clearInterval(pulseRef.current)
      setPulseIntensity(0)
    }
    return () => {
      if (pulseRef.current) clearInterval(pulseRef.current)
    }
  }, [isRecording])

  const formatTimeSaved = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    return `${mins}m ${seconds % 60}s`
  }

  const handleTranslateSwipe = useCallback(() => {
    onModeChange('translate')
    setShowLanguages(true)
  }, [onModeChange])

  const modeIcon = {
    dictate: <Volume2 className="w-3.5 h-3.5" />,
    edit: <Pencil className="w-3.5 h-3.5" />,
    translate: <Languages className="w-3.5 h-3.5" />,
  }

  const modeLabel = {
    dictate: 'Dictate',
    edit: 'Edit',
    translate: 'Translate',
  }

  return (
    <div className="flex flex-col bg-card/95 backdrop-blur-xl border-t border-border/50 select-none">
      {/* Transcript preview area */}
      {(isRecording || rawTranscript) && (
        <div className="px-4 pt-3 pb-1">
          <div className="bg-muted/60 rounded-xl px-3 py-2 min-h-[2.5rem] max-h-[4.5rem] overflow-y-auto">
            <p className={cn(
              "text-sm leading-relaxed",
              isRecording ? "text-foreground" : "text-muted-foreground"
            )}>
              {rawTranscript || (
                <span className="text-muted-foreground/60 italic">
                  {mode === 'dictate' && "Listening..."}
                  {mode === 'edit' && "Describe your changes..."}
                  {mode === 'translate' && "Speak to translate..."}
                </span>
              )}
              {isRecording && <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-middle" />}
            </p>
          </div>
        </div>
      )}

      {/* Mode tabs */}
      <div className="flex items-center justify-center gap-1.5 px-4 pt-3 pb-2">
        {(['dictate', 'edit', 'translate'] as TypelessMode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              onModeChange(m)
              if (m === 'translate') setShowLanguages(true)
              else setShowLanguages(false)
            }}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200",
              mode === m
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/80"
            )}
          >
            {modeIcon[m]}
            {modeLabel[m]}
          </button>
        ))}
      </div>

      {/* Language selector (translate mode) */}
      {mode === 'translate' && showLanguages && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
            <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => {
                  onTargetLanguageChange(lang.code)
                  setShowLanguages(false)
                }}
                className={cn(
                  "shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                  targetLanguage === lang.code
                    ? "bg-primary/20 text-primary border border-primary/30"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main keyboard area */}
      <div className="px-4 pt-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          {/* @ key */}
          <button
            onClick={() => onKeyPress('at')}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-muted/60 text-muted-foreground hover:bg-muted active:scale-95 transition-all"
          >
            <AtSign className="w-4 h-4" />
          </button>

          {/* Central mic button */}
          <div className="flex-1 flex items-center justify-center">
            <div className="relative">
              {/* Pulse rings */}
              {isRecording && (
                <>
                  <div
                    className="absolute inset-0 rounded-full bg-primary/20 animate-ping"
                    style={{ animationDuration: '1.5s' }}
                  />
                  <div
                    className="absolute rounded-full bg-primary/10 transition-all duration-150"
                    style={{
                      inset: `${-12 * pulseIntensity}px`,
                    }}
                  />
                  <div
                    className="absolute rounded-full bg-primary/5 transition-all duration-150"
                    style={{
                      inset: `${-24 * pulseIntensity}px`,
                    }}
                  />
                </>
              )}

              <button
                onClick={onRecordingToggle}
                className={cn(
                  "relative w-16 h-16 rounded-full flex items-center justify-center transition-all duration-200 shadow-lg",
                  isRecording
                    ? "bg-destructive text-destructive-foreground scale-110 shadow-destructive/25"
                    : "bg-primary text-primary-foreground hover:scale-105 active:scale-95 shadow-primary/25"
                )}
              >
                {isRecording ? (
                  <MicOff className="w-6 h-6" />
                ) : (
                  <Mic className="w-6 h-6" />
                )}
              </button>

              {/* Swipe up indicator for translate */}
              {mode === 'dictate' && !isRecording && (
                <button
                  onClick={handleTranslateSwipe}
                  className="absolute -top-5 left-1/2 -translate-x-1/2 flex flex-col items-center text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Spacebar */}
          <button
            onClick={() => onKeyPress('space')}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-muted/60 text-muted-foreground hover:bg-muted active:scale-95 transition-all"
          >
            <span className="text-[10px] font-medium tracking-wider">SPC</span>
          </button>
        </div>
      </div>

      {/* Bottom row: delete + return */}
      <div className="flex items-center justify-between px-4 pb-3 gap-2">
        <button
          onClick={() => onKeyPress('delete')}
          className="flex-1 h-9 flex items-center justify-center gap-1.5 rounded-xl bg-muted/40 text-muted-foreground hover:bg-muted active:scale-[0.98] transition-all"
        >
          <Delete className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Delete</span>
        </button>

        {/* Wave visualization */}
        <div className="flex-1 flex items-center justify-center gap-[2px] h-9 px-2">
          {isRecording ? (
            Array.from({ length: 16 }).map((_, i) => (
              <div
                key={i}
                className="w-[2px] rounded-full bg-primary transition-all duration-100"
                style={{
                  height: `${4 + Math.sin((Date.now() / 200) + i * 0.5) * 8 * pulseIntensity + Math.random() * 4 * pulseIntensity}px`,
                }}
              />
            ))
          ) : (
            Array.from({ length: 16 }).map((_, i) => (
              <div
                key={i}
                className="w-[2px] h-1 rounded-full bg-muted-foreground/20"
              />
            ))
          )}
        </div>

        <button
          onClick={() => onKeyPress('return')}
          className="flex-1 h-9 flex items-center justify-center gap-1.5 rounded-xl bg-primary/15 text-primary hover:bg-primary/25 active:scale-[0.98] transition-all"
        >
          <CornerDownLeft className="w-3.5 h-3.5" />
          <span className="text-[11px] font-medium">Return</span>
        </button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center justify-center gap-3 px-4 pb-3 pt-0.5">
        <Badge variant="secondary" className="text-[10px] font-normal gap-1 px-2 py-0.5 rounded-full">
          {wordsToday} words today
        </Badge>
        <Badge variant="secondary" className="text-[10px] font-normal gap-1 px-2 py-0.5 rounded-full">
          {formatTimeSaved(timeSavedSeconds)} saved
        </Badge>
      </div>
    </div>
  )
}
