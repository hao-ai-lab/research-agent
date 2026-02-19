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
  Wand2,
  ListPlus,
  Trash2,
  ChevronDown,
  ClipboardList,
  Cpu,
  Check,
  MoreHorizontal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ExperimentRun, Artifact, InsightChart, ChatMessage, Sweep } from '@/lib/types'
import type { Alert as ApiAlert } from '@/lib/api-client'
import type { ChatModelOption, SessionModelSelection } from '@/lib/api-client'
import type { PromptSkill } from '@/lib/api'
import {
  REFERENCE_TYPE_BACKGROUND_MAP,
  REFERENCE_TYPE_COLOR_MAP,
  type ReferenceTokenType,
} from '@/lib/reference-token-colors'
import { useAppSettings } from '@/lib/app-settings'
import { useIsMobile } from '@/components/ui/use-mobile'

export type ChatMode = 'agent' | 'wild' | 'sweep' | 'plan'

export type MentionType = ReferenceTokenType

export interface MentionItem {
  id: string
  type: MentionType
  label: string
  sublabel?: string
  color?: string
  icon?: React.ReactNode
}

interface SlashCommandItem {
  command: string
  description: string
  color: string
  isSkill?: boolean
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
  sweeps?: Sweep[]
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
  insertReplyExcerpt?: { id: number; text: string; fileName?: string } | null
  conversationKey?: string
  layout?: 'docked' | 'centered'
  skills?: PromptSkill[]
  // Wild loop steer support
  isWildLoopActive?: boolean
  onSteer?: (message: string, priority: number) => void
  onOpenReplyExcerpt?: (excerpt: { fileName: string; text: string }) => void
  // Context token count
  contextTokenCount?: number
  modelOptions?: ChatModelOption[]
  selectedModel?: SessionModelSelection | null
  isModelUpdating?: boolean
  onModelChange?: (model: SessionModelSelection) => Promise<void> | void
}

const DEFAULT_CHAT_INPUT_INITIAL_HEIGHT_PX = 48
const MAX_CHAT_INPUT_HEIGHT_PX = 170

function getTextareaMinHeight(textarea: HTMLTextAreaElement): number {
  if (typeof window === 'undefined') return DEFAULT_CHAT_INPUT_INITIAL_HEIGHT_PX
  const parsed = Number.parseFloat(window.getComputedStyle(textarea).minHeight)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHAT_INPUT_INITIAL_HEIGHT_PX
  return parsed
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  const minHeight = getTextareaMinHeight(textarea)
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), MAX_CHAT_INPUT_HEIGHT_PX)
  textarea.style.height = `${nextHeight}px`
}

export function ChatInput({
  onSend,
  onStop,
  disabled,
  mode,
  onModeChange,
  runs = [],
  sweeps = [],
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
  insertReplyExcerpt = null,
  conversationKey = 'default',
  layout = 'docked',
  skills = [],
  isWildLoopActive = false,
  onSteer,
  onOpenReplyExcerpt,
  contextTokenCount = 0,
  modelOptions = [],
  selectedModel = null,
  isModelUpdating = false,
  onModelChange,
}: ChatInputProps) {
  const { settings } = useAppSettings()
  const isMobile = useIsMobile()

  const referenceMentionRegex = /(?<!\S)@(?:run|sweep|artifact|alert|chart|chat|skill):[A-Za-z0-9:._-]+/g
  const genericMentionRegex = /(?<!\S)@[A-Za-z0-9:._-]*/g

  type MentionRange = {
    start: number
    end: number
    token: string
    isReference: boolean
  }

  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [replyExcerpt, setReplyExcerpt] = useState<{ text: string; fileName: string } | null>(null)
  const [isAttachOpen, setIsAttachOpen] = useState(false)
  const [isModeOpen, setIsModeOpen] = useState(false)
  const [isModelOpen, setIsModelOpen] = useState(false)
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
  const [steerPriority, setSteerPriority] = useState(15)
  const [dictationSupported, setDictationSupported] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const mentionPopoverRef = useRef<HTMLDivElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelLabelContainerRef = useRef<HTMLSpanElement>(null)
  const modelCompactMeasureRef = useRef<HTMLSpanElement>(null)
  const controlsRowRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const [modelLabelMode, setModelLabelMode] = useState<'model' | 'icon'>('model')
  const [isCompactControlsOpen, setIsCompactControlsOpen] = useState(false)
  const [isUltraCompactLayout, setIsUltraCompactLayout] = useState(false)

  useEffect(() => {
    // Sweep mode is no longer exposed in the UI.
    if (mode === 'sweep') {
      onModeChange('agent')
    }
  }, [mode, onModeChange])

  // Build mention items from data
  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = []
    const runById = new Map(runs.map(run => [run.id, run]))
    const alertIds = new Set<string>()

    // Sweeps
    sweeps.forEach((sweep) => {
      items.push({
        id: `sweep:${sweep.id}`,
        type: 'sweep',
        label: sweep.config.name || `Sweep ${sweep.id}`,
        sublabel: `${sweep.status} · ${sweep.progress.running} running · ${sweep.progress.completed} done`,
        color: '#a855f7',
        icon: <Sparkles className="h-3 w-3" />,
      })
    })

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

    // Skills
    skills.forEach((skill) => {
      items.push({
        id: `skill:${skill.id}`,
        type: 'skill',
        label: skill.name,
        sublabel: skill.description || skill.id,
        color: '#8b5cf6',
        icon: <Wand2 className="h-3 w-3" />,
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
  }, [runs, sweeps, artifacts, charts, skills, messages, alerts])

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

  const allSlashCommands = useMemo(() => {
    const skillItems: SlashCommandItem[] = skills.map((s) => ({
      command: `/${s.id}`,
      description: s.description || s.name,
      color: '#8b5cf6',
      isSkill: true,
    }))
    return [...SLASH_COMMANDS, ...skillItems]
  }, [skills])

  const filteredSlashCommands = useMemo(() => {
    const query = slashQuery.trim().toLowerCase()
    if (!query) return allSlashCommands
    return allSlashCommands.filter((item) => {
      const commandName = item.command.slice(1).toLowerCase()
      return commandName.includes(query) || item.description.toLowerCase().includes(query)
    })
  }, [slashQuery, allSlashCommands])

  const commandColorMap = useMemo(() => {
    const map = new Map<string, string>()
    allSlashCommands.forEach((item) => {
      map.set(item.command.toLowerCase(), item.color)
    })
    return map
  }, [allSlashCommands])

  const mentionTypeColorMap = REFERENCE_TYPE_COLOR_MAP
  const mentionTypeBackgroundMap = REFERENCE_TYPE_BACKGROUND_MAP

  const getMentionRanges = useCallback((text: string): MentionRange[] => {
    const ranges: MentionRange[] = []
    const occupied = new Set<number>()

    let refMatch: RegExpExecArray | null
    const refRegex = new RegExp(referenceMentionRegex.source, 'g')
    while ((refMatch = refRegex.exec(text)) !== null) {
      const start = refMatch.index
      const token = refMatch[0]
      const end = start + token.length
      for (let i = start; i < end; i++) occupied.add(i)
      ranges.push({ start, end, token, isReference: true })
    }

    let genericMatch: RegExpExecArray | null
    const genericRegex = new RegExp(genericMentionRegex.source, 'g')
    while ((genericMatch = genericRegex.exec(text)) !== null) {
      const start = genericMatch.index
      const token = genericMatch[0]
      const end = start + token.length
      if (token.length === 0) continue
      let overlaps = false
      for (let i = start; i < end; i++) {
        if (occupied.has(i)) {
          overlaps = true
          break
        }
      }
      if (!overlaps) {
        ranges.push({ start, end, token, isReference: false })
      }
    }

    return ranges.sort((a, b) => a.start - b.start)
  }, [genericMentionRegex.source, referenceMentionRegex.source])

  const highlightedMessage = useMemo(() => {
    if (!message) return null
    const parts: React.ReactNode[] = []
    const tokenRegex = /((?<!\S)@(?:run|sweep|artifact|alert|chart|chat|skill):[A-Za-z0-9:._-]+|(?<!\S)@[A-Za-z0-9:._-]*|(?<!\S)\/[a-zA-Z][\w-]*)/g
    let cursor = 0
    let match: RegExpExecArray | null
    let keyIndex = 0

    while ((match = tokenRegex.exec(message)) !== null) {
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

      if (token.startsWith('/')) {
        const color = commandColorMap.get(token.toLowerCase())
        parts.push(
          <span key={`command-${keyIndex++}`} style={color ? { color } : undefined}>
            {token}
          </span>
        )
      } else {
        const maybeType = token.slice(1).split(':')[0] as MentionType
        const mentionType = maybeType in mentionTypeColorMap ? maybeType : null
        const mentionColor = mentionType ? mentionTypeColorMap[mentionType] : 'hsl(var(--foreground))'
        const mentionBackground = mentionType ? mentionTypeBackgroundMap[mentionType] : 'hsl(var(--secondary))'
        parts.push(
          <span
            key={`mention-${keyIndex++}`}
            className="rounded-[6px]"
            style={{
              color: mentionColor,
              backgroundColor: mentionBackground,
            }}
          >
            {token}
          </span>
        )
      }

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
  }, [message, commandColorMap, mentionTypeBackgroundMap, mentionTypeColorMap])

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
    resizeTextarea(textareaRef.current)
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
        resizeTextarea(textareaRef.current)
      }
    }, 0)
  }, [insertDraft?.id, insertDraft?.text])

  useEffect(() => {
    if (!insertReplyExcerpt?.text) return
    setReplyExcerpt({
      text: insertReplyExcerpt.text,
      fileName: insertReplyExcerpt.fileName || 'excerpt_from_previous_message.txt',
    })
    setTimeout(() => {
      textareaRef.current?.focus()
    }, 0)
  }, [insertReplyExcerpt?.id, insertReplyExcerpt?.text, insertReplyExcerpt?.fileName])

  useEffect(() => {
    setReplyExcerpt(null)
  }, [conversationKey])

  const buildOutgoingMessage = useCallback(() => {
    const baseMessage = message.trim()
    if (!replyExcerpt) {
      return message
    }
    const quoteBlock = replyExcerpt.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return baseMessage ? `${quoteBlock}\n\n${message}` : quoteBlock
  }, [message, replyExcerpt])

  const handleSubmit = () => {
    const outgoingMessage = buildOutgoingMessage()
    const canSubmit = Boolean(message.trim() || attachments.length > 0 || replyExcerpt)
    if (canSubmit) {
      // If streaming and onQueue is provided, queue the message instead of sending
      if (isStreaming && onQueue && (message.trim() || replyExcerpt)) {
        onQueue(outgoingMessage.trim())
      } else if (isWildLoopActive && onSteer && message.trim()) {
        onSteer(message.trim(), steerPriority)
      } else {
        onSend(outgoingMessage, attachments, mode)
      }
      setMessage('')
      setAttachments([])
      setReplyExcerpt(null)
      setIsMentionOpen(false)
      setMentionStartIndex(null)
      setMentionQuery('')
      setIsSlashOpen(false)
      setSlashStartIndex(null)
      setSlashQuery('')
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
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

    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? 0
    const selectionEnd = textarea?.selectionEnd ?? selectionStart

    if (e.key === 'Backspace' && selectionStart === selectionEnd) {
      const ranges = getMentionRanges(message)
      const cursor = selectionStart

      // Delete mention chip with one backspace when cursor is right after "<mention> ".
      if (cursor > 0 && message[cursor - 1] === ' ') {
        const rangeBefore = ranges.find((range) => range.end === cursor - 1)
        if (rangeBefore) {
          e.preventDefault()
          const nextMessage = message.slice(0, rangeBefore.start) + message.slice(cursor)
          setMessage(nextMessage)
          setTimeout(() => {
            textareaRef.current?.focus()
            textareaRef.current?.setSelectionRange(rangeBefore.start, rangeBefore.start)
          }, 0)
          return
        }
      }

      // If caret is inside a mention chip, delete the whole chip.
      const activeRange = ranges.find((range) => cursor > range.start && cursor <= range.end)
      if (activeRange) {
        e.preventDefault()
        const removeUntil = message[activeRange.end] === ' ' ? activeRange.end + 1 : activeRange.end
        const nextMessage = message.slice(0, activeRange.start) + message.slice(removeUntil)
        setMessage(nextMessage)
        setTimeout(() => {
          textareaRef.current?.focus()
          textareaRef.current?.setSelectionRange(activeRange.start, activeRange.start)
        }, 0)
        return
      }
    }

    if (e.key === 'Delete' && selectionStart === selectionEnd) {
      const ranges = getMentionRanges(message)
      const cursor = selectionStart
      const activeRange = ranges.find((range) => cursor >= range.start && cursor < range.end)
      if (activeRange) {
        e.preventDefault()
        const removeUntil = message[activeRange.end] === ' ' ? activeRange.end + 1 : activeRange.end
        const nextMessage = message.slice(0, activeRange.start) + message.slice(removeUntil)
        setMessage(nextMessage)
        setTimeout(() => {
          textareaRef.current?.focus()
          textareaRef.current?.setSelectionRange(activeRange.start, activeRange.start)
        }, 0)
        return
      }
    }

    // Determine if we should reverse Enter/Shift+Enter behavior on mobile
    const shouldReverseEnterBehavior = isMobile && (settings.appearance.mobileEnterToNewline ?? false)

    if (shouldReverseEnterBehavior) {
      // When enabled on mobile: Enter adds newline, Shift+Enter sends
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
      // Let Enter without shift insert newline (browser default)
    } else {
      // Default behavior: Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
      // Let Shift+Enter insert newline (browser default)
    }
  }

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const cursorPos = e.target.selectionStart
    setMessage(value)
    resizeTextarea(e.target)
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
        } else if (textAfterAt.startsWith('sweep:')) {
          setMentionFilter('sweep')
          setMentionQuery(textAfterAt.slice(6))
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
        } else if (textAfterAt.startsWith('skill:')) {
          setMentionFilter('skill')
          setMentionQuery(textAfterAt.slice(6))
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
      resizeTextarea(input)
    }, 0)
  }

  // Removed format/emoji popovers for compact design - using insertText for @ mentions and commands

  const defaultModelOption = modelOptions.find((option) => option.is_default) || modelOptions[0] || null
  const effectiveSelectedModel = selectedModel || (
    defaultModelOption
      ? { provider_id: defaultModelOption.provider_id, model_id: defaultModelOption.model_id }
      : null
  )
  const selectedModelFullLabel = effectiveSelectedModel
    ? `${effectiveSelectedModel.provider_id} > ${effectiveSelectedModel.model_id}`
    : 'Model'
  const selectedModelCompactLabel = effectiveSelectedModel?.model_id || 'Model'
  const selectedModelLabel = selectedModelCompactLabel

  useEffect(() => {
    const updateModelLabelMode = () => {
      const button = modelButtonRef.current
      const container = modelLabelContainerRef.current
      const compactMeasure = modelCompactMeasureRef.current
      if (!button || !container || !compactMeasure) return

      const iconOnlyThreshold = 74
      if (button.clientWidth <= iconOnlyThreshold) {
        setModelLabelMode('icon')
        return
      }
      setModelLabelMode(compactMeasure.offsetWidth <= container.clientWidth ? 'model' : 'icon')
    }

    updateModelLabelMode()
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(updateModelLabelMode)
      if (modelButtonRef.current) {
        resizeObserver.observe(modelButtonRef.current)
      }
      if (modelLabelContainerRef.current) {
        resizeObserver.observe(modelLabelContainerRef.current)
      }
      return () => resizeObserver.disconnect()
    }

    window.addEventListener('resize', updateModelLabelMode)
    return () => window.removeEventListener('resize', updateModelLabelMode)
  }, [selectedModelCompactLabel])

  const modelOptionsByProvider = useMemo(() => {
    const groups = new Map<string, ChatModelOption[]>()
    modelOptions.forEach((option) => {
      const key = option.provider_id
      const existing = groups.get(key) || []
      existing.push(option)
      groups.set(key, existing)
    })
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([providerId, options]) => ({
        providerId,
        options: options.slice().sort((a, b) => a.model_id.localeCompare(b.model_id)),
      }))
  }, [modelOptions])

  useEffect(() => {
    const updateCompactLayout = () => {
      const width = controlsRowRef.current?.clientWidth || 0
      setIsUltraCompactLayout(width > 0 && width <= 430)
    }

    updateCompactLayout()
    if (typeof ResizeObserver !== 'undefined' && controlsRowRef.current) {
      const observer = new ResizeObserver(updateCompactLayout)
      observer.observe(controlsRowRef.current)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updateCompactLayout)
    return () => window.removeEventListener('resize', updateCompactLayout)
  }, [])

  return (
    <div
      className={
        layout === 'centered'
          ? 'rounded-2xl border border-border bg-background px-4 pb-4 pt-3 shadow-[0_8px_20px_rgba(15,23,42,0.07)]'
          : 'border-t border-border bg-background px-4 pb-4 pt-3'
      }
    >
      {/* Attachments preview */}
      {(replyExcerpt || attachments.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {replyExcerpt && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpenReplyExcerpt?.(replyExcerpt)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenReplyExcerpt?.(replyExcerpt)
                }
              }}
              className="group relative w-[220px] rounded-2xl border border-border/80 bg-card/80 p-3 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              title="Open excerpt preview"
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setReplyExcerpt(null)
                }}
                className="absolute right-2 top-2 z-10 text-muted-foreground hover:text-foreground"
                aria-label="Remove quoted excerpt"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <p className="pr-5 text-sm font-medium leading-tight text-foreground break-words group-hover:text-primary">
                {replyExcerpt.fileName}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {replyExcerpt.text.split('\n').length} lines
              </p>
              <span className="mt-2 inline-flex rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                TXT
              </span>
            </div>
          )}
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
                    <span
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase"
                      style={{
                        color: mentionTypeColorMap[item.type],
                        backgroundColor: mentionTypeBackgroundMap[item.type],
                        borderColor: `${mentionTypeColorMap[item.type]}66`,
                      }}
                    >
                      @{item.type}
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

            <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border bg-secondary/30">
              <span className="text-[10px] text-muted-foreground mr-1">Filter:</span>
              <div className="flex-1 min-w-0 overflow-x-auto">
                <div className="flex min-w-max items-center gap-1 pr-1">
                  {(['all', 'run', 'sweep', 'artifact', 'alert', 'chart', 'chat', 'skill'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setMentionFilter(type)}
                      className={`shrink-0 max-w-[88px] rounded border px-2 py-0.5 text-[10px] transition-colors ${
                        mentionFilter === type
                          ? 'border-transparent'
                          : 'border-transparent text-muted-foreground hover:bg-secondary'
                      }`}
                      style={
                        mentionFilter === type
                          ? type === 'all'
                            ? {
                                backgroundColor: 'hsl(var(--secondary))',
                                color: 'hsl(var(--foreground))',
                                borderColor: 'hsl(var(--border))',
                              }
                            : {
                                color: mentionTypeColorMap[type],
                                backgroundColor: mentionTypeBackgroundMap[type],
                                borderColor: `${mentionTypeColorMap[type]}66`,
                              }
                          : undefined
                      }
                    >
                      <span className="block truncate">
                        {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
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
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-4 text-base leading-6 text-foreground"
          >
            {message ? highlightedMessage : (
              <span className="text-muted-foreground">Ask me about your research</span>
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onSelect={(e) => {
              const input = e.currentTarget
              if (input.selectionStart !== input.selectionEnd) return
              // Keep caret pinned to the far-right end of text.
              requestAnimationFrame(() => {
                const end = input.value.length
                input.setSelectionRange(end, end)
              })
            }}
            onScroll={(e) => {
              if (highlightRef.current) {
                highlightRef.current.scrollTop = e.currentTarget.scrollTop
              }
            }}
            placeholder="Ask me about your research"
            disabled={disabled}
            rows={1}
            className="relative z-10 w-full resize-none bg-transparent px-4 py-3 pr-12 text-base leading-6 text-transparent caret-foreground placeholder:text-transparent focus:outline-none disabled:opacity-50"
            style={{
              minHeight: `var(--app-chat-input-initial-height, ${DEFAULT_CHAT_INPUT_INITIAL_HEIGHT_PX}px)`,
              maxHeight: `${MAX_CHAT_INPUT_HEIGHT_PX}px`,
              caretColor: 'var(--foreground)',
              color: 'transparent',
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className={`chat-toolbar-icon absolute bottom-2 right-2 z-20 ${isRecording ? 'text-destructive bg-destructive/10' : ''}`}
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
            <span className="absolute bottom-4 right-12 z-20 flex items-center gap-1 text-[10px] text-destructive animate-pulse">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Rec
            </span>
          )}
        </div>
      </div>

      {/* Action buttons - bottom row */}
      <div ref={controlsRowRef} className="flex flex-wrap items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {isUltraCompactLayout ? (
            <Popover open={isCompactControlsOpen} onOpenChange={setIsCompactControlsOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="chat-toolbar-icon" title="More controls">
                  <MoreHorizontal />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-72 p-2">
                <div className="space-y-2">
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Mode</p>
                    <div className="grid grid-cols-3 gap-1">
                      {(['agent', 'plan', 'wild'] as ChatMode[]).map((nextMode) => (
                        <button
                          key={nextMode}
                          type="button"
                          onClick={() => {
                            onModeChange(nextMode)
                          }}
                          className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                            nextMode === 'agent'
                              ? mode === nextMode
                                ? 'border-border/60 bg-secondary text-foreground'
                                : 'border-border/40 text-foreground/80 hover:bg-secondary/70'
                              : nextMode === 'plan'
                              ? mode === nextMode
                                ? 'border-orange-500/45 bg-orange-500/18 text-orange-300'
                                : 'border-orange-500/25 bg-orange-500/8 text-orange-300/80 hover:bg-orange-500/14'
                              : mode === nextMode
                              ? 'border-violet-500/45 bg-violet-500/18 text-violet-300'
                              : 'border-violet-500/25 bg-violet-500/8 text-violet-300/80 hover:bg-violet-500/14'
                          }`}
                        >
                          {nextMode === 'agent' ? 'Agent' : nextMode === 'plan' ? 'Plan' : 'Wild'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {onModelChange && modelOptions.length > 0 && (
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Model</p>
                      <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/50 p-1">
                        {modelOptionsByProvider.flatMap((providerGroup) =>
                          providerGroup.options.map((option) => {
                            const key = `${option.provider_id}:${option.model_id}`
                            const isSelected = Boolean(
                              effectiveSelectedModel &&
                              option.provider_id === effectiveSelectedModel.provider_id &&
                              option.model_id === effectiveSelectedModel.model_id
                            )
                            return (
                              <button
                                key={key}
                                type="button"
                                disabled={isModelUpdating}
                                onClick={() => {
                                  void (async () => {
                                    await onModelChange({ provider_id: option.provider_id, model_id: option.model_id })
                                  })()
                                }}
                                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                                  isSelected ? 'bg-secondary text-foreground' : 'hover:bg-secondary/70'
                                }`}
                              >
                                <div className="h-3.5 w-3.5 shrink-0 text-primary">{isSelected ? <Check className="h-3.5 w-3.5" /> : null}</div>
                                <span className="min-w-0 flex-1 truncate">{option.model_id}</span>
                              </button>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Insert</p>
                    <div className="grid grid-cols-2 gap-1">
                      <button type="button" onClick={() => { fileInputRef.current?.click() }} className="rounded-md border border-border/40 px-2 py-1 text-xs hover:bg-secondary/70">Upload</button>
                      <button type="button" onClick={() => { openMentionFromToolbar('all') }} className="rounded-md border border-border/40 px-2 py-1 text-xs hover:bg-secondary/70">@ mention</button>
                      <button type="button" onClick={() => { openMentionFromToolbar('run') }} className="rounded-md border border-border/40 px-2 py-1 text-xs hover:bg-secondary/70">Run</button>
                      <button type="button" onClick={() => { openMentionFromToolbar('sweep') }} className="rounded-md border border-border/40 px-2 py-1 text-xs hover:bg-secondary/70">Sweep</button>
                      <button type="button" onClick={() => { openMentionFromToolbar('skill') }} className="rounded-md border border-border/40 px-2 py-1 text-xs hover:bg-secondary/70">Skill</button>
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Commands</p>
                    <div className="max-h-24 space-y-1 overflow-y-auto rounded-md border border-border/50 p-1">
                      {SLASH_COMMANDS.map((item) => (
                        <button
                          key={item.command}
                          type="button"
                          onClick={() => {
                            insertText(`${item.command} `)
                          }}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-secondary/70"
                        >
                          <span style={{ color: item.color }}>{item.command}</span>
                          <span className="text-[10px] text-muted-foreground">{item.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <>
              {/* Mode toggle */}
              <Popover open={isModeOpen} onOpenChange={setIsModeOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`chat-toolbar-pill flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      mode === 'agent'
                        ? 'border border-border/60 bg-secondary text-foreground shadow-sm hover:bg-secondary/80'
                        : mode === 'wild'
                        ? 'border border-violet-500/35 bg-violet-500/15 text-violet-700 dark:border-violet-400/50 dark:bg-violet-500/24 dark:text-violet-300'
                        : mode === 'plan'
                        ? 'border border-orange-500/35 bg-orange-500/15 text-orange-700 dark:border-orange-400/50 dark:bg-orange-500/24 dark:text-orange-300'
                        : 'border border-blue-500/35 bg-blue-500/14 text-blue-700 dark:border-blue-400/50 dark:bg-blue-500/24 dark:text-blue-300'
                    }`}
                  >
                    {mode === 'agent' ? <MessageSquare className="h-3 w-3" /> : mode === 'wild' ? <Zap className="h-3 w-3" /> : <ClipboardList className="h-3 w-3" />}
                    {mode === 'wild' ? 'Wild' : mode === 'plan' ? 'Plan' : 'Agent'}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-56 p-1.5">
                  <div className="flex flex-col gap-0.5">
                    <button type="button" onClick={() => { onModeChange('agent'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'agent' ? 'bg-secondary border border-border/60' : 'hover:bg-secondary'}`}><MessageSquare className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'agent' ? 'text-foreground' : 'text-muted-foreground'}`} /><div><p className="text-xs font-medium text-foreground">Agent Mode</p><p className="text-[10px] text-muted-foreground">Normal chat — ask and discuss</p></div></button>
                    <button type="button" onClick={() => { onModeChange('plan'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'plan' ? 'bg-orange-500/10 border border-orange-500/35 dark:bg-orange-500/18 dark:border-orange-400/45' : 'hover:bg-secondary'}`}><ClipboardList className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'plan' ? 'text-orange-600 dark:text-orange-300' : 'text-muted-foreground'}`} /><div><p className="text-xs font-medium text-foreground">Plan Mode</p><p className="text-[10px] text-muted-foreground">Think first — propose a plan before acting</p></div></button>
                    <button type="button" onClick={() => { onModeChange('wild'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'wild' ? 'bg-violet-500/10 border border-violet-500/35 dark:bg-violet-500/18 dark:border-violet-400/45' : 'hover:bg-secondary'}`}><Zap className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-violet-600 dark:text-violet-300' : 'text-muted-foreground'}`} /><div><p className="text-xs font-medium text-foreground">Wild Mode</p><p className="text-[10px] text-muted-foreground">Autonomous loop — agent runs experiments</p></div></button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Model selector */}
              {onModelChange && modelOptions.length > 0 && (
                <Popover open={isModelOpen} onOpenChange={setIsModelOpen}>
                  <PopoverTrigger asChild>
                    <button
                      ref={modelButtonRef}
                      type="button"
                      disabled={isModelUpdating}
                      className="chat-toolbar-pill flex max-w-[190px] min-w-9 items-center gap-1 rounded-lg border border-border/60 bg-secondary px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-60"
                      title="Select model"
                    >
                      <Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span ref={modelLabelContainerRef} className={`relative min-w-0 flex-1 truncate ${modelLabelMode === 'icon' ? 'hidden' : ''}`}>
                        <span className="block truncate">{selectedModelLabel}</span>
                        <span ref={modelCompactMeasureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap">{selectedModelCompactLabel}</span>
                      </span>
                      <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground ${modelLabelMode === 'icon' ? 'hidden' : ''}`} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-72 p-1.5">
                    <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Provider &gt; Model ID</p>
                    <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                      {modelOptionsByProvider.map((providerGroup) => (
                        <div key={providerGroup.providerId} className="rounded-md border border-border/50 bg-background/60 p-1">
                          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{providerGroup.providerId}</p>
                          <div className="flex flex-col gap-0.5">
                            {providerGroup.options.map((option) => {
                              const isSelected = Boolean(effectiveSelectedModel && option.provider_id === effectiveSelectedModel.provider_id && option.model_id === effectiveSelectedModel.model_id)
                              return (
                                <button key={`${option.provider_id}:${option.model_id}`} type="button" disabled={isModelUpdating} onClick={() => { void (async () => { try { await onModelChange({ provider_id: option.provider_id, model_id: option.model_id }) } finally { setIsModelOpen(false) } })() }} className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${isSelected ? 'border border-border/70 bg-secondary' : 'border border-transparent hover:bg-secondary/70'}`}>
                                  <div className="h-4 w-4 shrink-0 text-primary">{isSelected ? <Check className="h-4 w-4" /> : null}</div>
                                  <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{option.model_id}</p>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              {/* Add attachment */}
              <Popover open={isAttachOpen} onOpenChange={setIsAttachOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="chat-toolbar-icon"><Plus /></Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-40 p-1.5">
                  <div className="flex flex-col gap-0.5">
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><Paperclip className="h-3.5 w-3.5" /><span>Upload file</span></button>
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><ImageIcon className="h-3.5 w-3.5" /><span>Upload image</span></button>
                    <div className="my-1 border-t border-border" />
                    <button type="button" onClick={() => openMentionFromToolbar('run')} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><Play className="h-3.5 w-3.5" /><span>Add run</span></button>
                    <button type="button" onClick={() => openMentionFromToolbar('sweep')} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><Sparkles className="h-3.5 w-3.5 text-violet-500" /><span>Add sweep</span></button>
                    <button type="button" onClick={() => openMentionFromToolbar('artifact')} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><Archive className="h-3.5 w-3.5" /><span>Add artifact</span></button>
                    <button type="button" onClick={() => openMentionFromToolbar('skill')} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><Wand2 className="h-3.5 w-3.5 text-violet-500" /><span>Add skill</span></button>
                  </div>
                </PopoverContent>
              </Popover>

              <Button variant="ghost" size="icon" className="chat-toolbar-icon" onClick={() => openMentionFromToolbar('all')}><AtSign /></Button>

              <Popover open={isCommandOpen} onOpenChange={setIsCommandOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="chat-toolbar-icon"><Command /></Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-48 p-1.5">
                  <p className="text-[10px] text-muted-foreground mb-1.5 px-2">Quick commands</p>
                  <div className="flex flex-col gap-0.5">
                    {SLASH_COMMANDS.map((item) => (
                      <button key={item.command} type="button" onClick={() => { insertText(`${item.command} `); setIsCommandOpen(false) }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"><span style={{ color: item.color }}>{item.command}</span><span className="text-muted-foreground text-[10px]">{item.description}</span></button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>

        {/* Stop + Send/Queue buttons */}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {/* Context token count - circular indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="chat-toolbar-icon relative flex items-center justify-center cursor-help">
                <svg className="h-[65%] w-[65%] -rotate-90" viewBox="0 0 24 24">
                  {/* Background circle */}
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className="text-border"
                  />
                  {/* Progress circle */}
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={`${Math.min((contextTokenCount / 200000) * 62.83, 62.83)} 62.83`}
                    className={contextTokenCount / 200000 > 0.8 ? 'text-destructive' : contextTokenCount / 200000 > 0.6 ? 'text-warning' : 'text-primary'}
                  />
                </svg>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="font-medium">Context Usage</p>
              <p className="text-muted-foreground">
                {contextTokenCount >= 1000 ? `${(contextTokenCount / 1000).toFixed(1)}k` : contextTokenCount} / 200k tokens ({((contextTokenCount / 200000) * 100).toFixed(1)}%)
              </p>
            </TooltipContent>
          </Tooltip>

          {isStreaming && onStop && (
            <Button
              onClick={onStop}
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              Stop
            </Button>
          )}

          {/* Priority selector */}
          {!isStreaming && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="chat-toolbar-pill flex items-center gap-0.5 rounded-lg border border-border/50 bg-secondary/60 px-2 font-medium text-foreground hover:bg-secondary/80 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  title="Message priority"
                >
                  <span className="text-muted-foreground/70" style={{ fontSize: '0.7em' }}>P</span>
                  <span>{steerPriority}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className="w-96 p-0"
                sideOffset={8}
              >
                <div className="border-b border-border/40 px-4 py-2.5">
                  <p className="text-sm font-semibold text-foreground">(Experimental) Message Priority</p>
                  <p className="text-[11px] text-muted-foreground">Lower number = higher priority</p>
                </div>
                <div className="p-2 space-y-0.5">
                  {[
                    { value: 10, label: 'Steer', desc: 'Immediately steer LLM with your message' },
                    { value: 15, label: 'Queued', desc: 'Normal user message.' },
                    { value: 20, label: 'Critical alert', desc: 'Urgent failures' },
                    { value: 30, label: 'Warning', desc: 'Non-critical alerts' },
                    { value: 50, label: 'Event', desc: 'Run completions or normal event'},
                    { value: 70, label: 'Analysis', desc: 'Post-sweep analysis' },
                    { value: 90, label: 'Exploring', desc: 'Lowest — loop iterations' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSteerPriority(opt.value)}
                      className={`flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left hover:bg-secondary/80 transition-colors ${
                        steerPriority === opt.value ? 'bg-secondary text-foreground' : 'text-foreground/80'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-7 shrink-0 font-mono text-sm font-bold text-muted-foreground tabular-nums">{opt.value}</span>
                        <span className="font-semibold text-sm">{opt.label}</span>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{opt.desc}</span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-border/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-muted-foreground whitespace-nowrap">Custom:</label>
                    <input
                      type="number"
                      min={-1000}
                      max={1000}
                      value={steerPriority}
                      onChange={(e) => {
                        // const v = parseInt(e.target.value, 10)
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v >= -1000 && v <= 1000) setSteerPriority(v)
                      }}
                      className="h-7 w-full rounded-md border border-border/40 bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}

        <Button
            onClick={handleSubmit}
            disabled={!message.trim() && attachments.length === 0 && !replyExcerpt}
            size="icon"
            className={`chat-toolbar-icon ml-auto shrink-0 rounded-lg disabled:opacity-30 relative ${
              isStreaming && onQueue
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : isWildLoopActive && onSteer
                  ? 'bg-orange-500 text-white hover:bg-orange-600'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
            title={`Send with priority P${steerPriority}`}
          >
            {isStreaming && onQueue ? (
              <>
                <ListPlus />
                {queueCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background">
                    {queueCount}
                  </span>
                )}
              </>
            ) : isWildLoopActive && onSteer ? (
              <Send />
            ) : (
              <Send />
            )}
            <span className="sr-only">
              {isStreaming && onQueue ? 'Queue message' : isWildLoopActive && onSteer ? 'Steer agent' : 'Send message'}
            </span>
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
