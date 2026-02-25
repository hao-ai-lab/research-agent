'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { TypelessKeyboard, type TypelessMode } from '@/components/typeless-keyboard'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import {
  MessageSquare,
  Mail,
  StickyNote,
  Code,
  Wifi,
  Battery,
  Signal,
  RotateCcw,
  Sparkles,
  Clock,
} from 'lucide-react'

// Filler words to strip from dictation
const FILLER_WORDS = [
  /\b(um|uh|uhm|uhh|umm|hmm|hm|er|erm|ah|ahh|like,?\s)/gi,
  /\b(you know,?\s?)/gi,
  /\b(i mean,?\s?)/gi,
  /\b(sort of,?\s?)/gi,
  /\b(kind of,?\s?)/gi,
  /\b(basically,?\s?)/gi,
]

// Simple "AI polish" for demonstration
function polishText(raw: string): string {
  let text = raw.trim()

  // Remove filler words
  for (const pattern of FILLER_WORDS) {
    text = text.replace(pattern, '')
  }

  // Clean up double spaces
  text = text.replace(/\s{2,}/g, ' ')

  // Capitalize first letter
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1)
  }

  // Ensure sentence ends with period if it doesn't have punctuation
  if (text.length > 0 && !/[.!?]$/.test(text)) {
    text += '.'
  }

  return text.trim()
}

// Simulated translation for prototype
const TRANSLATIONS: Record<string, Record<string, string>> = {
  es: {
    'Hello, how are you?': 'Hola, ¿cómo estás?',
    'Thank you very much.': 'Muchas gracias.',
    'Good morning.': 'Buenos días.',
    'See you later.': 'Hasta luego.',
  },
  fr: {
    'Hello, how are you?': 'Bonjour, comment allez-vous?',
    'Thank you very much.': 'Merci beaucoup.',
    'Good morning.': 'Bonjour.',
    'See you later.': 'À plus tard.',
  },
  de: {
    'Hello, how are you?': 'Hallo, wie geht es Ihnen?',
    'Thank you very much.': 'Vielen Dank.',
    'Good morning.': 'Guten Morgen.',
    'See you later.': 'Bis später.',
  },
  ja: {
    'Hello, how are you?': 'こんにちは、お元気ですか？',
    'Thank you very much.': 'ありがとうございます。',
    'Good morning.': 'おはようございます。',
    'See you later.': 'また後で。',
  },
  zh: {
    'Hello, how are you?': '你好，你好吗？',
    'Thank you very much.': '非常感谢。',
    'Good morning.': '早上好。',
    'See you later.': '回头见。',
  },
  ko: {
    'Hello, how are you?': '안녕하세요, 어떠세요?',
    'Thank you very much.': '감사합니다.',
    'Good morning.': '좋은 아침입니다.',
    'See you later.': '나중에 봐요.',
  },
}

function simulateTranslation(text: string, targetLang: string): string {
  const translations = TRANSLATIONS[targetLang]
  if (translations) {
    // Try exact match first
    if (translations[text]) return translations[text]
    // Try case-insensitive match
    const key = Object.keys(translations).find(
      k => k.toLowerCase() === text.toLowerCase()
    )
    if (key) return translations[key]
  }
  // Fallback: return text with [translated] prefix
  const langNames: Record<string, string> = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German',
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic',
    pt: 'Portuguese', hi: 'Hindi', it: 'Italian', ru: 'Russian',
  }
  return `[${langNames[targetLang] || targetLang}] ${text}`
}

type SimulatedApp = 'notes' | 'email' | 'chat' | 'code'

const APP_CONFIGS: Record<SimulatedApp, { icon: typeof StickyNote; label: string; placeholder: string }> = {
  notes: { icon: StickyNote, label: 'Notes', placeholder: 'Start typing or tap the mic to dictate...' },
  email: { icon: Mail, label: 'Mail', placeholder: 'Compose your email...' },
  chat: { icon: MessageSquare, label: 'Messages', placeholder: 'Type a message...' },
  code: { icon: Code, label: 'Editor', placeholder: '// Start coding or dictate your code...' },
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionErrorEvent {
  error: string
}

export function TypelessView() {
  const [mode, setMode] = useState<TypelessMode>('dictate')
  const [isRecording, setIsRecording] = useState(false)
  const [rawTranscript, setRawTranscript] = useState('')
  const [documentText, setDocumentText] = useState('')
  const [selectedApp, setSelectedApp] = useState<SimulatedApp>('notes')
  const [targetLanguage, setTargetLanguage] = useState('es')
  const [wordsToday, setWordsToday] = useState(0)
  const [timeSavedSeconds, setTimeSavedSeconds] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [history, setHistory] = useState<string[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<InstanceType<typeof window.webkitSpeechRecognition> | null>(null)
  const recordingStartRef = useRef<number>(0)

  // Check Web Speech API support
  useEffect(() => {
    const hasSpeechApi = typeof window !== 'undefined' && (
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
    )
    setSpeechSupported(hasSpeechApi)
  }, [])

  // Initialize speech recognition
  const initRecognition = useCallback(() => {
    if (typeof window === 'undefined') return null

    const SpeechRecognition = (window as typeof window & {
      SpeechRecognition?: typeof window.webkitSpeechRecognition
    }).SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return null

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      setRawTranscript((prev) => {
        const base = final ? prev + final : prev
        return interim ? base + interim : base
      })
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('Speech recognition error:', event.error)
      if (event.error !== 'no-speech') {
        setIsRecording(false)
      }
    }

    recognition.onend = () => {
      // Auto-restart if still recording (handles browser timeout)
      if (recognitionRef.current && isRecording) {
        try {
          recognitionRef.current.start()
        } catch {
          setIsRecording(false)
        }
      }
    }

    return recognition
  }, [isRecording])

  const handleRecordingToggle = useCallback(() => {
    if (isRecording) {
      // Stop recording
      setIsRecording(false)
      if (recognitionRef.current) {
        recognitionRef.current.stop()
        recognitionRef.current = null
      }

      // Calculate time saved
      const elapsed = Math.round((Date.now() - recordingStartRef.current) / 1000)
      const estimatedTypingTime = elapsed * 3 // Assume typing would take 3x longer
      setTimeSavedSeconds(prev => prev + Math.max(0, estimatedTypingTime - elapsed))

      // Process the transcript
      if (rawTranscript.trim()) {
        setIsProcessing(true)

        // Simulate AI processing delay
        setTimeout(() => {
          let processed: string

          if (mode === 'translate') {
            const polished = polishText(rawTranscript)
            processed = simulateTranslation(polished, targetLanguage)
          } else if (mode === 'edit') {
            // In edit mode, the transcript is an instruction for editing
            processed = `[Edit applied: "${rawTranscript.trim()}"]`
          } else {
            processed = polishText(rawTranscript)
          }

          // Count words
          const wordCount = processed.split(/\s+/).filter(Boolean).length
          setWordsToday(prev => prev + wordCount)

          // Save to history
          setHistory(prev => [...prev, processed])

          // Insert into document
          if (mode === 'edit') {
            // For edit mode, append the instruction result
            setDocumentText(prev => {
              if (prev) return prev + '\n' + processed
              return processed
            })
          } else {
            setDocumentText(prev => {
              if (prev) return prev + ' ' + processed
              return processed
            })
          }

          setRawTranscript('')
          setIsProcessing(false)
        }, 600)
      } else {
        setRawTranscript('')
      }
    } else {
      // Start recording
      if (!speechSupported) return

      setRawTranscript('')
      recordingStartRef.current = Date.now()

      const recognition = initRecognition()
      if (recognition) {
        recognitionRef.current = recognition
        try {
          recognition.start()
          setIsRecording(true)
        } catch (e) {
          console.error('Failed to start recognition:', e)
        }
      }
    }
  }, [isRecording, rawTranscript, mode, targetLanguage, speechSupported, initRecognition])

  const handleKeyPress = useCallback((key: 'space' | 'delete' | 'return' | 'at') => {
    switch (key) {
      case 'space':
        setDocumentText(prev => prev + ' ')
        break
      case 'delete':
        setDocumentText(prev => prev.slice(0, -1))
        break
      case 'return':
        setDocumentText(prev => prev + '\n')
        break
      case 'at':
        setDocumentText(prev => prev + '@')
        break
    }
  }, [])

  const handleUndo = useCallback(() => {
    if (history.length === 0) return
    const lastEntry = history[history.length - 1]
    setDocumentText(prev => {
      // Remove the last entry from document text
      const idx = prev.lastIndexOf(lastEntry)
      if (idx >= 0) {
        const before = prev.slice(0, idx).trimEnd()
        const after = prev.slice(idx + lastEntry.length)
        return (before + after).trim()
      }
      return prev
    })
    setHistory(prev => prev.slice(0, -1))
  }, [history])

  const handleClear = useCallback(() => {
    setDocumentText('')
    setHistory([])
  }, [])

  const appConfig = APP_CONFIGS[selectedApp]
  const AppIcon = appConfig.icon

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Phone status bar */}
      <div className="flex items-center justify-between px-5 py-1.5 bg-card/80 backdrop-blur-sm">
        <span className="text-[11px] font-semibold text-foreground">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <div className="flex items-center gap-1.5">
          <Signal className="w-3 h-3 text-foreground" />
          <Wifi className="w-3 h-3 text-foreground" />
          <Battery className="w-3.5 h-3.5 text-foreground" />
        </div>
      </div>

      {/* App switcher */}
      <div className="flex items-center gap-1 px-3 py-2 bg-card/50 border-b border-border/30">
        {(Object.keys(APP_CONFIGS) as SimulatedApp[]).map((app) => {
          const config = APP_CONFIGS[app]
          const Icon = config.icon
          return (
            <button
              key={app}
              onClick={() => setSelectedApp(app)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all",
                selectedApp === app
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Icon className="w-3 h-3" />
              {config.label}
            </button>
          )
        })}
      </div>

      {/* App header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card/30">
        <div className="flex items-center gap-2">
          <AppIcon className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{appConfig.label}</h2>
          {isProcessing && (
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0 rounded-full animate-pulse">
              <Sparkles className="w-2.5 h-2.5" />
              Polishing...
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {history.length > 0 && (
            <button
              onClick={handleUndo}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
              title="Undo last dictation"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          {documentText && (
            <button
              onClick={handleClear}
              className="px-2 py-1 rounded-lg text-[10px] font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Document text area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="px-4 py-3 min-h-full">
            {!speechSupported && (
              <div className="mb-3 p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                <p className="text-xs text-destructive font-medium">
                  Speech recognition is not supported in this browser.
                  Please use Chrome, Edge, or Safari for voice features.
                </p>
              </div>
            )}

            {documentText ? (
              <div className="space-y-1">
                <p className={cn(
                  "text-sm leading-relaxed whitespace-pre-wrap",
                  selectedApp === 'code' ? "font-mono text-xs" : "text-foreground"
                )}>
                  {documentText}
                  <span className="inline-block w-0.5 h-4 bg-primary/60 ml-0.5 animate-pulse align-middle" />
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center pt-16 gap-3">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <AppIcon className="w-7 h-7 text-primary/60" />
                </div>
                <p className="text-sm text-muted-foreground/60 text-center max-w-[240px]">
                  {appConfig.placeholder}
                </p>
                <div className="flex items-center gap-1.5 text-muted-foreground/40">
                  <Clock className="w-3 h-3" />
                  <span className="text-[10px]">6x faster than typing</span>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Hidden textarea for system keyboard fallback */}
      <textarea
        ref={textareaRef}
        className="sr-only"
        value={documentText}
        onChange={(e) => setDocumentText(e.target.value)}
        aria-label="Document text"
      />

      {/* Typeless Keyboard */}
      <TypelessKeyboard
        mode={mode}
        onModeChange={setMode}
        isRecording={isRecording}
        onRecordingToggle={handleRecordingToggle}
        rawTranscript={rawTranscript}
        onKeyPress={handleKeyPress}
        targetLanguage={targetLanguage}
        onTargetLanguageChange={setTargetLanguage}
        wordsToday={wordsToday}
        timeSavedSeconds={timeSavedSeconds}
      />
    </div>
  )
}
