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
  Bug,
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExperimentRun, Artifact, InsightChart, ChatMessage } from '@/lib/types'

export type ChatMode = 'wild' | 'debug' | 'sweep'

export type MentionType = 'run' | 'artifact' | 'alert' | 'chart' | 'chat'

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
  disabled?: boolean
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  runs?: ExperimentRun[]
  artifacts?: Artifact[]
  charts?: InsightChart[]
  messages?: ChatMessage[]
}

export function ChatInput({
  onSend,
  disabled,
  mode,
  onModeChange,
  runs = [],
  artifacts = [],
  charts = [],
  messages = [],
}: ChatInputProps) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isAttachOpen, setIsAttachOpen] = useState(false)
  const [isModeOpen, setIsModeOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isMentionOpen, setIsMentionOpen] = useState(false)
  const [isCommandOpen, setIsCommandOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [mentionFilter, setMentionFilter] = useState<MentionType | 'all'>('all')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionPopoverRef = useRef<HTMLDivElement>(null)

  // Build mention items from data
  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = []

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

      // Alerts from runs
      alerts.forEach((alert, idx) => {
        items.push({
          id: `alert:${run.id}:${idx}`,
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

    return items
  }, [runs, artifacts, charts, messages])

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

  // Reset selected index when filtered items change
  useEffect(() => {
    setSelectedMentionIndex(0)
  }, [filteredMentionItems])

  const handleSubmit = () => {
    if (message.trim() || attachments.length > 0) {
      onSend(message, attachments, mode)
      setMessage('')
      setAttachments([])
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
        return
      }
    }
    
    // Close mention popover if no active mention
    setIsMentionOpen(false)
    setMentionStartIndex(null)
    setMentionQuery('')
    setMentionFilter('all')
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
    setIsRecording(!isRecording)
    // In a real app, this would start/stop audio recording
  }

  const insertText = (text: string) => {
    setMessage((prev) => prev + text)
    textareaRef.current?.focus()
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

      {/* Text input with inline mention autocomplete */}
      <div className="relative mb-1.5">
        {/* Mention autocomplete dropdown */}
        {isMentionOpen && filteredMentionItems.length > 0 && (
          <div 
            ref={mentionPopoverRef}
            className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
          >
            {/* Type filter tabs */}
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-secondary/30">
              <span className="text-[10px] text-muted-foreground mr-1">Filter:</span>
              {(['all', 'run', 'artifact', 'alert', 'chart', 'chat'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setMentionFilter(type)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    mentionFilter === type
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            
            {/* Mention items */}
            <div className="max-h-[200px] overflow-y-auto py-1">
              {filteredMentionItems.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => insertMention(item)}
                  onMouseEnter={() => setSelectedMentionIndex(index)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    index === selectedMentionIndex
                      ? 'bg-secondary'
                      : 'hover:bg-secondary/50'
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
              ))}
            </div>
            
            {/* Hint */}
            <div className="px-2 py-1 border-t border-border bg-secondary/20">
              <p className="text-[10px] text-muted-foreground">
                <kbd className="px-1 py-0.5 bg-secondary rounded text-[9px]">↑↓</kbd> navigate
                <kbd className="ml-2 px-1 py-0.5 bg-secondary rounded text-[9px]">Enter</kbd> select
                <kbd className="ml-2 px-1 py-0.5 bg-secondary rounded text-[9px]">Esc</kbd> close
              </p>
            </div>
          </div>
        )}

        {/* No results state */}
        {isMentionOpen && filteredMentionItems.length === 0 && mentionQuery && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-card border border-border rounded-lg shadow-lg px-3 py-2">
            <p className="text-xs text-muted-foreground">No results for "{mentionQuery}"</p>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="Message Research Assistant... (type @ to mention)"
          disabled={disabled}
          rows={1}
          className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          style={{ minHeight: '40px', maxHeight: '100px' }}
        />
      </div>

      {/* Action buttons - bottom row */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          {/* Mode toggle */}
          <Popover open={isModeOpen} onOpenChange={setIsModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                  mode === 'wild'
                    ? 'bg-accent/20 text-accent'
                    : mode === 'debug'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-purple-500/20 text-purple-400'
                }`}
              >
                {mode === 'wild' ? (
                  <Zap className="h-3 w-3" />
                ) : mode === 'debug' ? (
                  <Bug className="h-3 w-3" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {mode === 'wild' ? 'Wild' : mode === 'debug' ? 'Debug' : 'Sweep'}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-56 p-1.5">
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('wild')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'wild'
                      ? 'bg-accent/10 border border-accent/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Zap
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'wild' ? 'text-accent' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Wild Mode</p>
                    <p className="text-[10px] text-muted-foreground">Auto-launch experiments</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onModeChange('debug')
                    setIsModeOpen(false)
                  }}
                  className={`flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    mode === 'debug'
                      ? 'bg-blue-400/10 border border-blue-400/30'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <Bug
                    className={`h-4 w-4 mt-0.5 shrink-0 ${mode === 'debug' ? 'text-blue-400' : 'text-muted-foreground'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-foreground">Debug Mode</p>
                    <p className="text-[10px] text-muted-foreground">Careful, detailed</p>
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

          {isRecording && (
            <span className="flex items-center gap-1 text-[10px] text-destructive animate-pulse ml-1">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Rec
            </span>
          )}
          {/* Add attachment */}
          <Popover open={isAttachOpen} onOpenChange={setIsAttachOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
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
              </div>
            </PopoverContent>
          </Popover>

          {/* Mention - triggers @ autocomplete */}
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-7 w-7"
            onClick={() => {
              insertText('@')
              // Manually trigger mention mode
              setMentionStartIndex(message.length)
              setMentionQuery('')
              setIsMentionOpen(true)
            }}
          >
            <AtSign className="h-4 w-4" />
          </Button>

          {/* Commands */}
          <Popover open={isCommandOpen} onOpenChange={setIsCommandOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Command className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-48 p-1.5">
              <p className="text-[10px] text-muted-foreground mb-1.5 px-2">Quick commands</p>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    insertText('/launch ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/launch</span>
                  <span className="text-muted-foreground text-[10px]">New run</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/analyze ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/analyze</span>
                  <span className="text-muted-foreground text-[10px]">Analyze</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/compare ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-accent">/compare</span>
                  <span className="text-muted-foreground text-[10px]">Compare</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    insertText('/sweep ')
                    setIsCommandOpen(false)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                >
                  <span className="text-purple-400">/sweep</span>
                  <span className="text-muted-foreground text-[10px]">Create sweep</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Microphone */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${isRecording ? 'text-destructive bg-destructive/10' : ''}`}
            onClick={toggleRecording}
          >
            {isRecording ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Send button */}
        <Button
          onClick={handleSubmit}
          disabled={disabled || (!message.trim() && attachments.length === 0)}
          size="icon"
          className="h-7 w-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30"
        >
          <Send className="h-3.5 w-3.5" />
          <span className="sr-only">Send message</span>
        </Button>
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
