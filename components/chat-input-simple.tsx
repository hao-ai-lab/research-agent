'use client'

import React from 'react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Send,
  X,
  Zap,
  Play,
  AlertTriangle,
  BarChart3,
  MessageSquare,
  Archive,
  ListPlus,
  Trash2,
  ChevronDown,
  ClipboardList,
  Cpu,
  Check,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExperimentRun, Artifact, InsightChart, ChatMessage, Sweep } from '@/lib/types'
import type { Alert as ApiAlert } from '@/lib/api-client'
import type { ChatModelOption, SessionModelSelection } from '@/lib/api-client'
import type { PromptSkill } from '@/lib/api'
import {
  REFERENCE_TYPE_COLOR_MAP,
  type ReferenceTokenType,
} from '@/lib/reference-token-colors'
import { useAppSettings } from '@/lib/app-settings'
import { useIsMobile } from '@/components/ui/use-mobile'

// Re-export types matching the original chat-input.tsx so imports stay compatible.
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
  defaultSkillId?: string | null
  onDefaultSkillChange?: (skillId: string | null) => void
  isWildLoopActive?: boolean
  onSteer?: (message: string, priority: number) => void
  onOpenReplyExcerpt?: (excerpt: { fileName: string; text: string }) => void
  contextTokenCount?: number
  modelOptions?: ChatModelOption[]
  selectedModel?: SessionModelSelection | null
  isModelUpdating?: boolean
  onModelChange?: (model: SessionModelSelection) => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Resize helpers
// ---------------------------------------------------------------------------
const INITIAL_HEIGHT_PX = 48
const MAX_HEIGHT_PX = 200

function autoResize(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  const next = Math.min(Math.max(textarea.scrollHeight, INITIAL_HEIGHT_PX), MAX_HEIGHT_PX)
  textarea.style.height = `${next}px`
}

// ---------------------------------------------------------------------------
// Regex to detect @type:id reference tokens
// ---------------------------------------------------------------------------
const REFERENCE_REGEX = /(?<!\S)@(?:run|sweep|artifact|alert|chart|chat|skill):[A-Za-z0-9:._-]+/g

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
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
  defaultSkillId = null,
  onDefaultSkillChange,
  isWildLoopActive = false,
  onSteer,
  onOpenReplyExcerpt,
  modelOptions = [],
  selectedModel = null,
  isModelUpdating = false,
  onModelChange,
}: ChatInputProps) {
  const { settings } = useAppSettings()
  const isMobile = useIsMobile()

  // ---- core state ----
  const [message, setMessage] = useState('')
  const [replyExcerpt, setReplyExcerpt] = useState<{ text: string; fileName: string } | null>(null)
  const [isModeOpen, setIsModeOpen] = useState(false)
  const [isModelOpen, setIsModelOpen] = useState(false)
  const [isQueueExpanded, setIsQueueExpanded] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  // ---- @mention autocomplete state ----
  const [isMentionOpen, setIsMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [mentionFilter, setMentionFilter] = useState<MentionType | 'all'>('all')

  // ---- sweep mode redirect ----
  useEffect(() => {
    if (mode === 'sweep') onModeChange('agent')
  }, [mode, onModeChange])

  // ---- auto resize ----
  useEffect(() => {
    if (textareaRef.current) autoResize(textareaRef.current)
  }, [message])

  // ---- insert draft ----
  useEffect(() => {
    if (!insertDraft?.text) return
    setMessage((prev) => {
      if (!prev) return insertDraft.text
      const sep = prev.endsWith(' ') ? '' : ' '
      return `${prev}${sep}${insertDraft.text}`
    })
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [insertDraft?.id, insertDraft?.text])

  // ---- insert reply excerpt ----
  useEffect(() => {
    if (!insertReplyExcerpt?.text) return
    setReplyExcerpt({
      text: insertReplyExcerpt.text,
      fileName: insertReplyExcerpt.fileName || 'excerpt.txt',
    })
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [insertReplyExcerpt?.id, insertReplyExcerpt?.text, insertReplyExcerpt?.fileName])

  // ---- clear excerpt on conversation change ----
  useEffect(() => { setReplyExcerpt(null) }, [conversationKey])

  // =========================================================================
  // Mention items – built from runs / sweeps / alerts / artifacts / charts
  // =========================================================================
  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = []
    const runById = new Map(runs.map((r) => [r.id, r]))
    const alertIds = new Set<string>()

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

    runs.forEach((run) => {
      items.push({
        id: `run:${run.id}`,
        type: 'run',
        label: run.alias || run.name,
        sublabel: run.config?.model || run.status,
        color: run.color,
        icon: <Play className="h-3 w-3" />,
      })
      ;(run.alerts || []).forEach((alert, idx) => {
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
      run.artifacts?.forEach((artifact) => {
        items.push({
          id: `artifact:${artifact.id}`,
          type: 'artifact',
          label: artifact.name,
          sublabel: `${run.alias || run.name} - ${artifact.type}`,
          icon: <Archive className="h-3 w-3" />,
        })
      })
    })

    artifacts.forEach((artifact) => {
      if (!items.find((i) => i.id === `artifact:${artifact.id}`)) {
        items.push({
          id: `artifact:${artifact.id}`,
          type: 'artifact',
          label: artifact.name,
          sublabel: artifact.type,
          icon: <Archive className="h-3 w-3" />,
        })
      }
    })

    charts.forEach((chart) => {
      items.push({
        id: `chart:${chart.id}`,
        type: 'chart',
        label: chart.title,
        sublabel: chart.type,
        icon: <BarChart3 className="h-3 w-3" />,
      })
    })

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

    messages
      .filter((m) => m.role === 'user' && m.content.trim())
      .slice(-10)
      .forEach((msg) => {
        items.push({
          id: `chat:${msg.id}`,
          type: 'chat',
          label: msg.content.slice(0, 40) + (msg.content.length > 40 ? '...' : ''),
          sublabel: new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          icon: <MessageSquare className="h-3 w-3" />,
        })
      })

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

  const filteredMentionItems = useMemo(() => {
    let items = mentionItems
    if (mentionFilter !== 'all') items = items.filter((i) => i.type === mentionFilter)
    if (mentionQuery) {
      const q = mentionQuery.toLowerCase()
      items = items.filter((i) => i.label.toLowerCase().includes(q) || i.sublabel?.toLowerCase().includes(q))
    }
    return items.slice(0, 8)
  }, [mentionItems, mentionQuery, mentionFilter])

  useEffect(() => { setSelectedMentionIndex(0) }, [filteredMentionItems])

  const selectableSkills = useMemo(
    () => skills.filter((skill) => !skill.internal),
    [skills]
  )

  // =========================================================================
  // Highlighted message overlay – text color only, no background
  // =========================================================================
  const highlightedMessage = useMemo(() => {
    if (!message) return null
    const parts: React.ReactNode[] = []
    const regex = new RegExp(REFERENCE_REGEX.source, 'g')
    let cursor = 0
    let match: RegExpExecArray | null
    let key = 0

    while ((match = regex.exec(message)) !== null) {
      const token = match[0]
      const start = match.index
      const end = start + token.length

      if (start > cursor) {
        parts.push(<span key={`t-${key++}`}>{message.slice(cursor, start)}</span>)
      }

      // Extract the type part from @type:id
      const maybeType = token.slice(1).split(':')[0] as MentionType
      const color = maybeType in REFERENCE_TYPE_COLOR_MAP
        ? REFERENCE_TYPE_COLOR_MAP[maybeType]
        : undefined

      parts.push(
        <span key={`m-${key++}`} style={color ? { color } : undefined}>
          {token}
        </span>,
      )
      cursor = end
    }

    if (cursor < message.length) {
      parts.push(<span key={`t-${key++}`}>{message.slice(cursor)}</span>)
    }
    return parts
  }, [message])

  // =========================================================================
  // Build outgoing message (with optional quote block)
  // =========================================================================
  const buildOutgoingMessage = useCallback(() => {
    if (!replyExcerpt) return message
    const quoteBlock = replyExcerpt.text.split('\n').map((l) => `> ${l}`).join('\n')
    return message.trim() ? `${quoteBlock}\n\n${message}` : quoteBlock
  }, [message, replyExcerpt])

  // =========================================================================
  // Insert mention from dropdown
  // =========================================================================
  const insertMention = useCallback(
    (item: MentionItem) => {
      if (mentionStartIndex === null) return
      const before = message.slice(0, mentionStartIndex)
      const after = message.slice(textareaRef.current?.selectionStart || message.length)
      const token = `@${item.id} `
      setMessage(before + token + after)
      setIsMentionOpen(false)
      setMentionStartIndex(null)
      setMentionQuery('')
      setMentionFilter('all')
      setTimeout(() => {
        if (textareaRef.current) {
          const pos = before.length + token.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(pos, pos)
        }
      }, 0)
    },
    [mentionStartIndex, message],
  )

  // =========================================================================
  // Submit
  // =========================================================================
  const handleSubmit = () => {
    const outgoing = buildOutgoingMessage()
    const canSubmit = Boolean(message.trim() || replyExcerpt)
    if (!canSubmit) return

    if (isStreaming && onQueue && (message.trim() || replyExcerpt)) {
      onQueue(outgoing.trim())
    } else if (isWildLoopActive && onSteer && message.trim()) {
      onSteer(message.trim(), 15)
    } else {
      onSend(outgoing, [], mode)
    }

    setMessage('')
    setReplyExcerpt(null)
    setIsMentionOpen(false)
    setMentionStartIndex(null)
    setMentionQuery('')
    setTimeout(() => {
      if (textareaRef.current) textareaRef.current.style.height = `${INITIAL_HEIGHT_PX}px`
    }, 0)
  }

  // =========================================================================
  // Keyboard
  // =========================================================================
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Navigate mention dropdown
    if (isMentionOpen && filteredMentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedMentionIndex((p) => (p < filteredMentionItems.length - 1 ? p + 1 : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedMentionIndex((p) => (p > 0 ? p - 1 : filteredMentionItems.length - 1))
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

    // Enter / Shift+Enter
    const reverseEnter = isMobile && (settings.appearance.mobileEnterToNewline ?? false)
    if (reverseEnter) {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); handleSubmit() }
    } else {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
    }
  }

  // =========================================================================
  // Text change – detect @mention trigger
  // =========================================================================
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const cursorPos = e.target.selectionStart
    setMessage(value)
    autoResize(e.target)

    // Sync scroll for highlight overlay
    if (highlightRef.current) highlightRef.current.scrollTop = e.target.scrollTop

    // Detect @mention trigger
    const before = value.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = before.slice(atIdx + 1)
      if (!afterAt.includes(' ')) {
        setMentionStartIndex(atIdx)
        setIsMentionOpen(true)
        // Auto-detect filter prefix
        if (afterAt.startsWith('run:')) { setMentionFilter('run'); setMentionQuery(afterAt.slice(4)) }
        else if (afterAt.startsWith('sweep:')) { setMentionFilter('sweep'); setMentionQuery(afterAt.slice(6)) }
        else if (afterAt.startsWith('alert:')) { setMentionFilter('alert'); setMentionQuery(afterAt.slice(6)) }
        else if (afterAt.startsWith('artifact:')) { setMentionFilter('artifact'); setMentionQuery(afterAt.slice(9)) }
        else if (afterAt.startsWith('chart:')) { setMentionFilter('chart'); setMentionQuery(afterAt.slice(6)) }
        else if (afterAt.startsWith('chat:')) { setMentionFilter('chat'); setMentionQuery(afterAt.slice(5)) }
        else if (afterAt.startsWith('skill:')) { setMentionFilter('skill'); setMentionQuery(afterAt.slice(6)) }
        else { setMentionFilter('all'); setMentionQuery(afterAt) }
        return
      }
    }
    setIsMentionOpen(false)
    setMentionStartIndex(null)
    setMentionQuery('')
    setMentionFilter('all')
  }

  // =========================================================================
  // Model selector helpers
  // =========================================================================
  const defaultModelOption = modelOptions.find((o) => o.is_default) || modelOptions[0] || null
  const effectiveSelectedModel = selectedModel || (
    defaultModelOption
      ? { provider_id: defaultModelOption.provider_id, model_id: defaultModelOption.model_id }
      : null
  )
  const modelOptionsByProvider = useMemo(() => {
    const groups = new Map<string, ChatModelOption[]>()
    modelOptions.forEach((o) => {
      const existing = groups.get(o.provider_id) || []
      existing.push(o)
      groups.set(o.provider_id, existing)
    })
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pid, opts]) => ({ providerId: pid, options: opts.slice().sort((a, b) => a.model_id.localeCompare(b.model_id)) }))
  }, [modelOptions])

  // =========================================================================
  // Mention type color map for filter pills
  // =========================================================================
  const mentionTypeColorMap = REFERENCE_TYPE_COLOR_MAP

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div
      className={
        layout === 'centered'
          ? 'rounded-2xl border border-border bg-background px-4 pb-4 pt-3 shadow-[0_8px_20px_rgba(15,23,42,0.07)]'
          : 'border-t border-border bg-background px-4 pb-4 pt-3'
      }
    >
      {/* Reply excerpt chip */}
      {replyExcerpt && (
        <div className="mb-2 flex flex-wrap gap-2">
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpenReplyExcerpt?.(replyExcerpt)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpenReplyExcerpt?.(replyExcerpt) } }}
            className="group relative w-[220px] rounded-2xl border border-border/80 bg-card/80 p-3 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            title="Open excerpt preview"
          >
            <button type="button" onClick={(ev) => { ev.stopPropagation(); setReplyExcerpt(null) }} className="absolute right-2 top-2 z-10 text-muted-foreground hover:text-foreground" aria-label="Remove quoted excerpt">
              <X className="h-3.5 w-3.5" />
            </button>
            <p className="pr-5 text-sm font-medium leading-tight text-foreground break-words group-hover:text-primary">{replyExcerpt.fileName}</p>
            <p className="mt-2 text-xs text-muted-foreground">{replyExcerpt.text.split('\n').length} lines</p>
            <span className="mt-2 inline-flex rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">TXT</span>
          </div>
        </div>
      )}

      {/* Queue drawer */}
      {queue.length > 0 && (
        <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden">
          <button type="button" onClick={() => setIsQueueExpanded(!isQueueExpanded)} className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-amber-500/10 transition-colors">
            <div className="flex items-center gap-2">
              <ListPlus className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{queue.length} message{queue.length > 1 ? 's' : ''} queued</span>
            </div>
            <ChevronDown className={`h-3.5 w-3.5 text-amber-500 transition-transform ${isQueueExpanded ? 'rotate-180' : ''}`} />
          </button>
          {isQueueExpanded && (
            <div className="border-t border-amber-500/20 max-h-32 overflow-y-auto">
              {queue.map((queuedMsg, index) => (
                <div key={index} className="flex items-start gap-2 px-3 py-2 hover:bg-amber-500/5 group">
                  <span className="text-[10px] text-amber-500/70 font-medium mt-0.5 shrink-0">#{index + 1}</span>
                  <p className="flex-1 text-xs text-foreground/80 line-clamp-2">{queuedMsg}</p>
                  {onRemoveFromQueue && (
                    <button type="button" onClick={() => onRemoveFromQueue(index)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0" title="Remove from queue">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Textarea with @mention dropdown and highlight overlay */}
      <div className="relative mb-1.5">
        {/* @mention dropdown */}
        {isMentionOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
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
                        color: item.color || 'var(--muted-foreground)',
                      }}
                    >
                      {item.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{item.label}</p>
                      {item.sublabel && <p className="text-[10px] text-muted-foreground truncate">{item.sublabel}</p>}
                    </div>
                    <span
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase"
                      style={{ color: mentionTypeColorMap[item.type], borderColor: `${mentionTypeColorMap[item.type]}66` }}
                    >
                      @{item.type}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {mentionQuery ? `No results for "${mentionQuery}"` : mentionFilter === 'all' ? 'No items available.' : `No ${mentionFilter} items available.`}
                </div>
              )}
            </div>

            {/* Filter row */}
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
                        mentionFilter === type ? 'border-transparent' : 'border-transparent text-muted-foreground hover:bg-secondary'
                      }`}
                      style={
                        mentionFilter === type
                          ? type === 'all'
                            ? { backgroundColor: 'hsl(var(--secondary))', color: 'hsl(var(--foreground))', borderColor: 'hsl(var(--border))' }
                            : { color: mentionTypeColorMap[type], borderColor: `${mentionTypeColorMap[type]}66` }
                          : undefined
                      }
                    >
                      <span className="block truncate">{type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}</span>
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

        {/* Textarea + highlight overlay */}
        <div className="relative rounded-lg border border-border bg-card focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          {/* Highlight overlay – text color only, no background */}
          <div
            ref={highlightRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-3 text-base leading-6 text-foreground"
          >
            {message ? highlightedMessage : (
              <span className="text-muted-foreground">Ask me about your research</span>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onScroll={(e) => {
              if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop
            }}
            placeholder="Ask me about your research"
            disabled={disabled}
            rows={1}
            className="relative z-10 w-full resize-none bg-transparent px-4 py-3 text-base leading-6 text-transparent caret-foreground placeholder:text-transparent focus:outline-none disabled:opacity-50"
            style={{
              minHeight: `${INITIAL_HEIGHT_PX}px`,
              maxHeight: `${MAX_HEIGHT_PX}px`,
              caretColor: 'var(--foreground)',
              color: 'transparent',
            }}
          />
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
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
                <button type="button" onClick={() => { onModeChange('agent'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'agent' ? 'bg-secondary border border-border/60' : 'hover:bg-secondary'}`}>
                  <MessageSquare className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'agent' ? 'text-foreground' : 'text-muted-foreground'}`} />
                  <div><p className="text-xs font-medium text-foreground">Agent Mode</p><p className="text-[10px] text-muted-foreground">Normal chat — ask and discuss</p></div>
                </button>
                <button type="button" onClick={() => { onModeChange('plan'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'plan' ? 'bg-orange-500/10 border border-orange-500/35 dark:bg-orange-500/18 dark:border-orange-400/45' : 'hover:bg-secondary'}`}>
                  <ClipboardList className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'plan' ? 'text-orange-600 dark:text-orange-300' : 'text-muted-foreground'}`} />
                  <div><p className="text-xs font-medium text-foreground">Plan Mode</p><p className="text-[10px] text-muted-foreground">Think first — propose a plan before acting</p></div>
                </button>
                <button type="button" onClick={() => { onModeChange('wild'); setIsModeOpen(false) }} className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${mode === 'wild' ? 'bg-violet-500/10 border border-violet-500/35 dark:bg-violet-500/18 dark:border-violet-400/45' : 'hover:bg-secondary'}`}>
                  <Zap className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-violet-600 dark:text-violet-300' : 'text-muted-foreground'}`} />
                  <div><p className="text-xs font-medium text-foreground">Wild Mode</p><p className="text-[10px] text-muted-foreground">Autonomous loop — agent runs experiments</p></div>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Model selector */}
          {onModelChange && modelOptions.length > 0 && (
            <Popover open={isModelOpen} onOpenChange={setIsModelOpen}>
              <PopoverTrigger asChild>
                <button type="button" disabled={isModelUpdating} className="chat-toolbar-pill flex max-w-[190px] min-w-9 items-center gap-1 rounded-lg border border-border/60 bg-secondary px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-60" title="Select model">
                  <Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{effectiveSelectedModel?.model_id || 'Model'}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-72 p-1.5">
                <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Provider &gt; Model ID</p>
                <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                  {modelOptionsByProvider.map((group) => (
                    <div key={group.providerId} className="rounded-md border border-border/50 bg-background/60 p-1">
                      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.providerId}</p>
                      <div className="flex flex-col gap-0.5">
                        {group.options.map((option) => {
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

          {/* Default skill selector */}
          {onDefaultSkillChange && selectableSkills.length > 0 && (
            <div className="chat-toolbar-pill flex items-center gap-1 rounded-lg border border-border/60 bg-secondary px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-secondary/80">
              <Wand2 className="h-3 w-3 shrink-0 text-violet-500" />
              <label htmlFor="default-skill-select" className="sr-only">Default skill</label>
              <select
                id="default-skill-select"
                value={defaultSkillId ?? ''}
                onChange={(event) => onDefaultSkillChange(event.target.value || null)}
                className="max-w-[180px] min-w-[120px] truncate bg-transparent text-[11px] text-foreground focus:outline-none"
                title="Default skill for first message in a new chat"
              >
                <option value="">No default skill</option>
                {selectableSkills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Stop + Send */}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {isStreaming && onStop && (
            <Button onClick={onStop} variant="outline" size="sm" className="h-9 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10">
              Stop
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={!message.trim() && !replyExcerpt}
            size="icon"
            className={`chat-toolbar-icon ml-auto shrink-0 rounded-lg disabled:opacity-30 relative ${
              isStreaming && onQueue
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : isWildLoopActive && onSteer
                  ? 'bg-orange-500 text-white hover:bg-orange-600'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
            title="Send message"
          >
            {isStreaming && onQueue ? (
              <>
                <ListPlus />
                {queueCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background">{queueCount}</span>
                )}
              </>
            ) : (
              <Send />
            )}
            <span className="sr-only">{isStreaming && onQueue ? 'Queue message' : isWildLoopActive && onSteer ? 'Steer agent' : 'Send message'}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
