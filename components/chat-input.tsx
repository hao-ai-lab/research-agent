'use client'

import React from 'react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Send,
  Plus,
  X,
  Paperclip,
  ImageIcon,
  FileText,
  Zap,
  AtSign,
  Command,
  Mic,
  MicOff,
  Sparkles,
  Play,
  AlertTriangle,
  BarChart3,
  MessageSquare,
  Archive,
  ListPlus,
  Trash2,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExperimentRun, Artifact, InsightChart, ChatMessage } from '@/lib/types'
import type { Alert as ApiAlert } from '@/lib/api-client'

export type ChatMode = 'agent' | 'wild' | 'sweep'

export type MentionType = 'run' | 'artifact' | 'alert' | 'chart' | 'chat'

export interface MentionItem {
  id: string
  type: MentionType
  label: string
  sublabel?: string
  color?: string
  icon?: React.ReactNode
}

interface SlashCommandItem {
  command: '/launch' | '/analyze' | '/compare' | '/sweep' | '/develop'
  description: string
  color: string
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  { command: '/launch', description: 'New run', color: '#22c55e' },
  { command: '/analyze', description: 'Analyze results', color: '#60a5fa' },
  { command: '/compare', description: 'Compare runs', color: '#f59e0b' },
  { command: '/sweep', description: 'Create sweep', color: '#a855f7' },
  { command: '/develop', description: 'Echo locally (dev)', color: '#14b8a6' },
]

interface ChatInputProps {
  onSend: (message: string, attachments?: File[], mode?: ChatMode) => void
  onStop?: () => void
  disabled?: boolean
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  runs?: ExperimentRun[]
  alerts?: ApiAlert[]
  artifacts?: Artifact[]
  charts?: InsightChart[]
  messages?: ChatMessage[]
  // Queue support
  isStreaming?: boolean
  onQueue?: (message: string) => void
  queueCount?: number
  queue?: string[]
  onRemoveFromQueue?: (index: number) => void
  insertDraft?: { id: number; text: string } | null
}

export function ChatInput({
  onSend,
  onStop,
  disabled,
  mode,
  onModeChange,
  runs = [],
  alerts = [],
  artifacts = [],
  charts = [],
  messages = [],
  isStreaming = false,
  onQueue,
  queueCount = 0,
  queue = [],
  onRemoveFromQueue,
  insertDraft = null,
}: ChatInputProps) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isAttachOpen, setIsAttachOpen] = useState(false)
  const [isModeOpen, setIsModeOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isMentionOpen, setIsMentionOpen] = useState(false)
  const [isCommandOpen, setIsCommandOpen] = useState(false)
  const [isSlashOpen, setIsSlashOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashStartIndex, setSlashStartIndex] = useState<number | null>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const [mentionFilter, setMentionFilter] = useState<MentionType | 'all'>('all')
  const [isQueueExpanded, setIsQueueExpanded] = useState(true)
  const [dictationSupported, setDictationSupported] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const mentionPopoverRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)

  // Build mention items from data
  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = []
    const runById = new Map(runs.map(run => [run.id, run]))
    const alertIds = new Set<string>()

    // Runs
    runs.forEach(run => {
      const alerts = run.alerts || []
      items.push({
        id: `run:${run.id}`,
        type: 'run',
        label: run.alias || run.name,
        sublabel: run.config?.model || run.status,
        color: run.color,
        icon: <Play className="h-3 w-3" />,
      })

      // Alerts from runs (legacy/mock)
      alerts.forEach((alert, idx) => {
        const alertId = `alert:${run.id}:${idx}`
        if (alertIds.has(alertId)) return
        alertIds.add(alertId)
        items.push({
          id: alertId,
          type: 'alert',
          label: alert.message.slice(0, 40) + (alert.message.length > 40 ? '...' : ''),
          sublabel: `${run.alias || run.name} - ${alert.type}`,
          color: alert.type === 'error' ? '#f87171' : alert.type === 'warning' ? '#facc15' : '#60a5fa',
          icon: <AlertTriangle className="h-3 w-3" />,
        })
      })

      // Artifacts from runs
      run.artifacts?.forEach(artifact => {
        items.push({
          id: `artifact:${artifact.id}`,
          type: 'artifact',
          label: artifact.name,
          sublabel: `${run.alias || run.name} - ${artifact.type}`,
          icon: <Archive className="h-3 w-3" />,
        })
      })
    })

    // Standalone artifacts
    artifacts.forEach(artifact => {
      if (!items.find(i => i.id === `artifact:${artifact.id}`)) {
        items.push({
          id: `artifact:${artifact.id}`,
          type: 'artifact',
          label: artifact.name,
          sublabel: artifact.type,
          icon: <Archive className="h-3 w-3" />,
        })
      }
    })

    // Charts
    charts.forEach(chart => {
      items.push({
        id: `chart:${chart.id}`,
        type: 'chart',
        label: chart.title,
        sublabel: chart.type,
        icon: <BarChart3 className="h-3 w-3" />,
      })
    })

    // Chat messages (only user messages as segments)
    messages
      .filter(m => m.role === 'user' && m.content.trim())
      .slice(-10) // Last 10 user messages
      .forEach(msg => {
        items.push({
          id: `chat:${msg.id}`,
          type: 'chat',
          label: msg.content.slice(0, 40) + (msg.content.length > 40 ? '...' : ''),
          sublabel: new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          icon: <MessageSquare className="h-3 w-3" />,
        })
      })

    // Alerts from API
    alerts.forEach((alert) => {
      const alertId = `alert:${alert.id}`
      if (alertIds.has(alertId)) return
      alertIds.add(alertId)
      const run = runById.get(alert.run_id)
      const severity = alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'
      items.push({
        id: alertId,
        type: 'alert',
        label: alert.message.slice(0, 40) + (alert.message.length > 40 ? '...' : ''),
        sublabel: `${run?.alias || run?.name || alert.run_id} - ${severity}`,
        color: severity === 'error' ? '#f87171' : severity === 'warning' ? '#facc15' : '#60a5fa',
        icon: <AlertTriangle className="h-3 w-3" />,
      })
    })

    return items
  }, [runs, artifacts, charts, messages, alerts])

  // Filter mention items based on query and type filter
  const filteredMentionItems = useMemo(() => {
    let items = mentionItems

    // Filter by type
    if (mentionFilter !== 'all') {
      items = items.filter(item => item.type === mentionFilter)
    }

    // Filter by query
    if (mentionQuery) {
      const query = mentionQuery.toLowerCase()
      items = items.filter(item =>
        item.label.toLowerCase().includes(query) ||
        item.sublabel?.toLowerCase().includes(query)
      )
    }

    return items.slice(0, 8) // Limit to 8 results
  }, [mentionItems, mentionQuery, mentionFilter])

  const filteredSlashCommands = useMemo(() => {
    const query = slashQuery.trim().toLowerCase()
    if (!query) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((item) => {
      const commandName = item.command.slice(1).toLowerCase()
      return commandName.includes(query) || item.description.toLowerCase().includes(query)
    })
  }, [slashQuery])

  const commandColorMap = useMemo(() => {
    const map = new Map<string, string>()
    SLASH_COMMANDS.forEach((item) => {
      map.set(item.command.toLowerCase(), item.color)
    })
    return map
  }, [])

  const highlightedMessage = useMemo(() => {
    if (!message) return null
    const parts: React.ReactNode[] = []
    const commandRegex = /\/[a-zA-Z][\w-]*/g
    let cursor = 0
    let match: RegExpExecArray | null
    let keyIndex = 0

    while ((match = commandRegex.exec(message)) !== null) {
      const token = match[0]
      const matchStart = match.index
      const matchEnd = matchStart + token.length

      if (matchStart > cursor) {
        parts.push(
          <span key={`plain-${keyIndex++}`}>
            {message.slice(cursor, matchStart)}
          </span>
        )
      }

      const color = commandColorMap.get(token.toLowerCase())
      parts.push(
        <span key={`command-${keyIndex++}`} style={color ? { color } : undefined}>
          {token}
        </span>
      )

      cursor = matchEnd
    }

    if (cursor < message.length) {
      parts.push(
        <span key={`plain-${keyIndex++}`}>
          {message.slice(cursor)}
        </span>
      )
    }

    return parts
  }, [message, commandColorMap])

  // Reset selected index when filtered items change
  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [filteredMentionItems])

  useEffect(() => {
    setSelectedSlashIndex(0)
  }, [filteredSlashCommands])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

    if (!SpeechRecognition) {
      setDictationSupported(false)
      recognitionRef.current = null
      return
    }

    setDictationSupported(true)
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          transcript += result[0]?.transcript || ''
        }
      }
      const normalized = transcript.trim()
      if (!normalized) return
      setMessage((prev) => (prev.trim().length > 0 ? `${prev} ${normalized}` : normalized))
    }

    recognition.onend = () => {
      setIsRecording(false)
    }

    recognition.onerror = (error: any) => {
      console.error('Dictation error:', error)
      setIsRecording(false)
    }

    recognitionRef.current = recognition

    return () => {
      try {
        recognition.stop()
      } catch {
        // Ignore stop errors during teardown.
      }
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
  }, [message])

  useEffect(() => {
    if (!insertDraft?.text) return
    setMessage((prev) => {
      if (!prev) return insertDraft.text
      const separator = prev.endsWith(' ') ? '' : ' '
      return `${prev}${separator}${insertDraft.text}`
    })
    setTimeout(() => {
      textareaRef.current?.focus()
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
      }
    }, 0)
  }, [insertDraft?.id, insertDraft?.text])

  const handleSubmit = () => {
    if (message.trim() || attachments.length > 0) {
      // If streaming and onQueue is provided, queue the message instead of sending
      if (isStreaming && onQueue && message.trim()) {
        onQueue(message.trim())
      } else {
        onSend(message, attachments, mode)
      }
      setMessage('')
      setAttachments([])
      setIsMentionOpen(false)
      setMentionStartIndex(null)
      setMentionQuery('')
      setIsSlashOpen(false)
      setSlashStartIndex(null)
      setSlashQuery('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle mention navigation
    if (isMentionOpen && filteredMentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedMentionIndex(prev => 
          prev < filteredMentionItems.length - 1 ? prev + 1 : 0
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedMentionIndex(prev => 
          prev > 0 ? prev - 1 : filteredMentionItems.length - 1
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredMentionItems[selectedMentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsMentionOpen(false)
        setMentionStartIndex(null)
        setMentionQuery('')
        return
      }
    }

    // Handle slash command navigation
    if (isSlashOpen && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSlashIndex((prev) =>
          prev < filteredSlashCommands.length - 1 ? prev + 1 : 0
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSlashIndex((prev) =>
          prev > 0 ? prev - 1 : filteredSlashCommands.length - 1
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertSlashCommand(filteredSlashCommands[selectedSlashIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsSlashOpen(false)
        setSlashStartIndex(null)
        setSlashQuery('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const cursorPos = e.target.selectionStart
    setMessage(value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
    if (highlightRef.current) {
      highlightRef.current.scrollTop = e.target.scrollTop
    }

    // Detect @ mention trigger
    const textBeforeCursor = value.slice(0, cursorPos)
    const atIndex = textBeforeCursor.lastIndexOf('@')
    
    if (atIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(atIndex + 1)
      // Check if there's no space between @ and cursor (still in mention mode)
      if (!textAfterAt.includes(' ')) {
        setMentionStartIndex(atIndex)
        setMentionQuery(textAfterAt)
        setIsMentionOpen(true)
        
        // Auto-detect filter from query prefix
        if (textAfterAt.startsWith('run:')) {
          setMentionFilter('run')
          setMentionQuery(textAfterAt.slice(4))
        } else if (textAfterAt.startsWith('alert:')) {
          setMentionFilter('alert')
          setMentionQuery(textAfterAt.slice(6))
        } else if (textAfterAt.startsWith('artifact:')) {
          setMentionFilter('artifact')
          setMentionQuery(textAfterAt.slice(9))
        } else if (textAfterAt.startsWith('chart:')) {
          setMentionFilter('chart')
          setMentionQuery(textAfterAt.slice(6))
        } else if (textAfterAt.startsWith('chat:')) {
          setMentionFilter('chat')
          setMentionQuery(textAfterAt.slice(5))
        } else {
          setMentionFilter('all')
        }
        setIsSlashOpen(false)
        setSlashStartIndex(null)
        setSlashQuery('')
        return
      }
    }

    // Close mention popover if no active mention
    setIsMentionOpen(false)
    setMentionStartIndex(null)
    setMentionQuery('')
    setMentionFilter('all')

    // Detect / command trigger (at token start)
    const slashMatch = textBeforeCursor.match(/(^|\s)(\/[a-zA-Z-]*)$/)
    if (slashMatch) {
      const slashToken = slashMatch[2] || ''
      const slashTokenStart = cursorPos - slashToken.length
      setSlashStartIndex(slashTokenStart)
      setSlashQuery(slashToken.slice(1))
      setIsSlashOpen(true)
      return
    }

    setIsSlashOpen(false)
    setSlashStartIndex(null)
    setSlashQuery('')
  }

  const insertMention = useCallback((item: MentionItem) => {
    if (mentionStartIndex === null) return
    
    const beforeMention = message.slice(0, mentionStartIndex)
    const afterMention = message.slice(textareaRef.current?.selectionStart || message.length)
    const mentionText = `@${item.id} `
    
    setMessage(beforeMention + mentionText + afterMention)
    setIsMentionOpen(false)
    setMentionStartIndex(null)
    setMentionQuery('')
    setMentionFilter('all')
    
    // Focus and move cursor after mention
    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = beforeMention.length + mentionText.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    }, 0)
  }, [mentionStartIndex, message])

  const insertSlashCommand = useCallback((item: SlashCommandItem) => {
    if (slashStartIndex === null) return

    const currentCursor = textareaRef.current?.selectionStart ?? message.length
    const beforeSlash = message.slice(0, slashStartIndex)
    const afterSlash = message.slice(currentCursor)
    const commandText = `${item.command} `

    setMessage(beforeSlash + commandText + afterSlash)
    setIsSlashOpen(false)
    setSlashStartIndex(null)
    setSlashQuery('')

    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = beforeSlash.length + commandText.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    }, 0)
  }, [message, slashStartIndex])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments((prev) => [...prev, ...Array.from(e.target.files!)])
    }
    setIsAttachOpen(false)
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  const toggleRecording = () => {
    if (!dictationSupported || !recognitionRef.current) return
    if (isRecording) {
      recognitionRef.current.stop()
      setIsRecording(false)
      return
    }
    try {
      recognitionRef.current.start()
      setIsRecording(true)
    } catch (error) {
      console.error('Failed to start dictation:', error)
      setIsRecording(false)
    }
  }

  const insertText = (text: string) => {
    setMessage((prev) => prev + text)
    textareaRef.current?.focus()
  }

  const openMentionFromToolbar = (type: MentionType | 'all') => {
    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? message.length
    const before = message.slice(0, cursorPos)
    const after = message.slice(cursorPos)
    const nextMessage = `${before}@${after}`

    setMessage(nextMessage)
    setIsAttachOpen(false)
    setMentionStartIndex(cursorPos)
    setMentionQuery('')
    setMentionFilter(type)
    setIsMentionOpen(true)
    setIsSlashOpen(false)
    setSlashStartIndex(null)
    setSlashQuery('')

    setTimeout(() => {
      const input = textareaRef.current
      if (!input) return
      const newCursorPos = cursorPos + 1
      input.focus()
      input.setSelectionRange(newCursorPos, newCursorPos)
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`
    }, 0)
  }

  // Removed format/emoji popovers for compact design - using insertText for @ mentions and commands

  return (
    <div className="border-t border-border bg-background px-3 pb-3 pt-2">
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs"
            >
              <FileText className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[80px] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(index)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Message Queue Drawer */}
      {queue.length > 0 && (
        <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          {/* Queue header */}
          <button
            type="button"
            onClick={() => setIsQueueExpanded(!isQueueExpanded)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-amber-500/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ListPlus className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {queue.length} message{queue.length > 1 ? 's' : ''} queued
              </span>
            </div>
            <ChevronDown 
              className={`h-3.5 w-3.5 text-amber-500 transition-transform ${
                isQueueExpanded ? 'rotate-180' : ''
              }`} 
            />
          </button>
          
          {/* Queue items */}
          {isQueueExpanded && (
            <div className="border-t border-amber-500/20 max-h-32 overflow-y-auto">
              {queue.map((queuedMsg, index) => (
                <div 
                  key={index}
                  className="flex items-start gap-2 px-3 py-2 hover:bg-amber-500/5 group"
                >
                  <span className="text-[10px] text-amber-500/70 font-medium mt-0.5 shrink-0">
                    #{index + 1}
                  </span>
                  <p className="flex-1 text-xs text-foreground/80 line-clamp-2">
                    {queuedMsg}
                  </p>
                  {onRemoveFromQueue && (
                    <button
                      type="button"
                      onClick={() => onRemoveFromQueue(index)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0"
                      title="Remove from queue"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Text input with inline mention/slash autocomplete */}
      <div className="relative mb-1.5">
        {isMentionOpen && (
          <div
            ref={mentionPopoverRef}
            className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
          >
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-secondary/30">
              <span className="text-[10px] text-muted-foreground mr-1">Filter:</span>
              <div className="flex-1 min-w-0 overflow-x-auto">
                <div className="flex min-w-max items-center gap-1 pr-1">
                  {(['all', 'run', 'artifact', 'alert', 'chart', 'chat'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setMentionFilter(type)}
                      className={`shrink-0 max-w-[88px] px-2 py-0.5 text-[10px] rounded transition-colors ${
                        mentionFilter === type
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      <span className="block truncate">
                        {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="max-h-[200px] overflow-y-auto py-1">
              {filteredMentionItems.length > 0 ? (
                filteredMentionItems.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => insertMention(item)}
                    onMouseEnter={() => setSelectedMentionIndex(index)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                      index === selectedMentionIndex ? 'bg-secondary' : 'hover:bg-secondary/50'
                    }`}
                  >
                    <span
                      className="flex items-center justify-center h-5 w-5 rounded shrink-0"
                      style={{
                        backgroundColor: item.color ? `${item.color}20` : 'var(--secondary)',
                        color: item.color || 'var(--muted-foreground)'
                      }}
                    >
                      {item.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{item.label}</p>
                      {item.sublabel && (
                        <p className="text-[10px] text-muted-foreground truncate">{item.sublabel}</p>
                      )}
                    </div>
                    <span className="text-[9px] text-muted-foreground/60 uppercase shrink-0">
                      {item.type}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {mentionQuery
                    ? `No results for "${mentionQuery}"`
                    : mentionFilter === 'all'
                      ? 'No items available.'
                      : `No ${mentionFilter} items available.`}
                </div>
              )}
            </div>

            <div className="px-2 py-1 border-t border-border bg-secondary/20">
              <p className="text-[10px] text-muted-foreground">
                <kbd className="px-1 py-0.5 bg-secondary rounded text-[9px]">↑↓</kbd> navigate
                <kbd className="ml-2 px-1 py-0.5 bg-secondary rounded text-[9px]">Enter</kbd> select
                <kbd className="ml-2 px-1 py-0.5 bg-secondary rounded text-[9px]">Esc</kbd> close
              </p>
            </div>
          </div>
        )}

        {isSlashOpen && !isMentionOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border bg-secondary/30">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Commands</p>
            </div>
            <div className="max-h-[220px] overflow-y-auto py-1">
              {filteredSlashCommands.length > 0 ? (
                filteredSlashCommands.map((item, index) => (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => insertSlashCommand(item)}
                    onMouseEnter={() => setSelectedSlashIndex(index)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors ${
                      index === selectedSlashIndex ? 'bg-secondary' : 'hover:bg-secondary/50'
                    }`}
                  >
                    <span className="text-xs font-medium" style={{ color: item.color }}>
                      {item.command}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{item.description}</span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  No commands match "{slashQuery}".
                </div>
              )}
            </div>
            <div className="px-2 py-1 border-t border-border bg-secondary/20">
              <p className="text-[10px] text-muted-foreground">
                <kbd className="px-1 py-0.5 bg-secondary rounded text-[9px]">↑↓</kbd> navigate
                <kbd className="ml-2 px-1 py-0.5 bg-secondary rounded text-[9px]">Tab/Enter</kbd> insert
              </p>
            </div>
          </div>
        )}

        <div className="relative rounded-lg border border-border bg-card focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <div
            ref={highlightRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-5 text-foreground"
          >
            {message ? highlightedMessage : (
              <span className="text-muted-foreground">Message Research Assistant... (type @ or /)</span>
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onScroll={(e) => {
              if (highlightRef.current) {
                highlightRef.current.scrollTop = e.currentTarget.scrollTop
              }
            }}
            placeholder="Message Research Assistant... (type @ or /)"
            disabled={disabled}
            rows={1}
            className="relative z-10 w-full resize-none bg-transparent px-3 py-2 pr-11 text-sm leading-5 text-transparent caret-foreground placeholder:text-transparent focus:outline-none disabled:opacity-50"
            style={{
              minHeight: '40px',
              maxHeight: '100px',
              caretColor: 'hsl(var(--foreground))',
              color: 'transparent',
              WebkitTextFillColor: 'transparent',
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className={`chat-toolbar-icon absolute bottom-1.5 right-1.5 z-20 h-7 w-7 ${isRecording ? 'text-destructive bg-destructive/10' : ''}`}
            onClick={toggleRecording}
            disabled={!dictationSupported}
            title={dictationSupported ? (isRecording ? 'Stop dictation' : 'Start dictation') : 'Dictation not supported'}
          >
            {isRecording ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
          {isRecording && (
            <span className="absolute bottom-3.5 right-10 z-20 flex items-center gap-1 text-[10px] text-destructive animate-pulse">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Rec
            </span>
          )}
        </div>
      </div>

      {/* Action buttons - bottom row */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          {/* Mode toggle */}
          <Popover open={isModeOpen} onOpenChange={setIsModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`chat-toolbar-pill flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                  mode === 'agent'
                    ? 'bg-accent/20 text-accent'
                    : mode === 'wild'
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'bg-blue-500/20 text-blue-400'
                }`}
              >
                {mode === 'agent' ? (
                  <MessageSquare className="h-3 w-3" />
                ) : mode === 'wild' ? (
                  <Zap className="h-3 w-3" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {mode === 'agent' ? 'Agent' : mode === 'wild' ? 'Wild' : 'Sweep'}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-56 p-1.5">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('agent')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'agent'
                      ? 'bg-accent/10 border border-accent/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <MessageSquare
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'agent' ? 'text-accent' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Agent Mode</p>
                    <p className="text-[10px] text-muted-foreground">Normal chat — ask and discuss</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('wild')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'wild'
                      ? 'bg-purple-400/10 border border-purple-400/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Zap
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-purple-400' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Wild Mode</p>
                    <p className="text-[10px] text-muted-foreground">Autonomous loop — agent runs experiments</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('sweep')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'sweep'
                      ? 'bg-purple-400/10 border border-purple-400/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Sparkles
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'sweep' ? 'text-purple-400' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Sweep Mode</p>
                    <p className="text-[10px] text-muted-foreground">Create experiment sweeps</p>
                  </div>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Add attachment */}
          <Popover open={isAttachOpen} onOpenChange={setIsAttachOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="chat-toolbar-icon h-7 w-7">
                <Plus className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-40 p-1.5">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span>Upload file</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  <span>Upload image</span>
                </button>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  onClick={() => openMentionFromToolbar('run')}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Add run</span>
                </button>
                <button
                  type="button"
                  onClick={() => openMentionFromToolbar('artifact')}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <Archive className="h-3.5 w-3.5" />
                  <span>Add artifact</span>
                </button>
                <button
                  type="button"
                  onClick={() => openMentionFromToolbar('chat')}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span>Add chat</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Mention - triggers @ autocomplete */}
          <Button 
            variant="ghost" 
            size="icon" 
            className="chat-toolbar-icon h-7 w-7"
            onClick={() => openMentionFromToolbar('all')}
          >
            <AtSign className="h-4 w-4" />
          </Button>

          {/* Commands */}
          <Popover open={isCommandOpen} onOpenChange={setIsCommandOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="chat-toolbar-icon h-7 w-7">
                <Command className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-1.5">
              <p className="text-[10px] text-muted-foreground mb-1.5 px-2">Quick commands</p>
              <div className="flex flex-col gap-0.5">
                {SLASH_COMMANDS.map((item) => (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => {
                      insertText(`${item.command} `)
                      setIsCommandOpen(false)
                    }}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                  >
                    <span style={{ color: item.color }}>{item.command}</span>
                    <span className="text-muted-foreground text-[10px]">{item.description}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Stop + Send/Queue buttons */}
        <div className="flex items-center gap-1">
          {isStreaming && onStop && (
            <Button
              onClick={onStop}
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              Stop
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={!message.trim() && attachments.length === 0}
            size="icon"
            className={`h-7 w-7 rounded-md disabled:opacity-30 relative ${
              isStreaming && onQueue
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {isStreaming && onQueue ? (
              <>
                <ListPlus className="h-3.5 w-3.5" />
                {queueCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background">
                    {queueCount}
                  </span>
                )}
              </>
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">{isStreaming && onQueue ? 'Queue message' : 'Send message'}</span>
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  )
}
