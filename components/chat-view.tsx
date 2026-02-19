'use client'

import { useRef, useEffect, useState, useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input-simple'
import { ArtifactsPanel } from './artifacts-panel'
import type {
  ChatMessage as ChatMessageType,
  ExperimentRun,
  Artifact,
  Sweep,
  SweepConfig,
  InsightChart,
} from '@/lib/types'

const SCROLL_BOTTOM_THRESHOLD_PX = 64

interface ChatViewProps {
  messages: ChatMessageType[]
  runs: ExperimentRun[]
  sweeps?: Sweep[]
  charts?: InsightChart[]
  onSendMessage: (message: string, attachments?: File[], mode?: ChatMode) => void
  onRunClick: (run: ExperimentRun) => void
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  showArtifacts?: boolean
  collapseChats?: boolean
  collapseArtifactsInChat?: boolean
}

export function ChatView({
  messages,
  runs,
  sweeps = [],
  charts = [],
  onSendMessage,
  onRunClick,
  onEditSweep,
  onLaunchSweep,
  mode,
  onModeChange,
  showArtifacts = false,
  collapseChats = false,
  collapseArtifactsInChat = false,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollEnabledRef = useRef(true)

  const getScrollViewport = () => {
    if (!scrollRef.current) return null
    return scrollRef.current.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]')
  }

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    const updateAutoScrollState = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      autoScrollEnabledRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX
    }

    viewport.addEventListener('scroll', updateAutoScrollState, { passive: true })
    return () => viewport.removeEventListener('scroll', updateAutoScrollState)
  }, [messages.length, collapseChats])

  useEffect(() => {
    if (!autoScrollEnabledRef.current) return
    const viewport = getScrollViewport()
    if (!viewport) return
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, collapseChats])

  // Collect all artifacts from runs
  const allArtifacts = useMemo(() => {
    const artifacts: Artifact[] = []
    runs.forEach(run => {
      if (run.artifacts) {
        artifacts.push(...run.artifacts)
      }
    })
    return artifacts.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }, [runs])

  // Group messages into pairs (user + assistant)
  const messagePairs = useMemo(() => {
    const pairs: { user: ChatMessageType; assistant?: ChatMessageType }[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'user') {
        const nextMsg = messages[i + 1]
        if (nextMsg && nextMsg.role === 'assistant') {
          pairs.push({ user: msg, assistant: nextMsg })
          i++ // skip next message since we've included it
        } else {
          pairs.push({ user: msg })
        }
      } else if (msg.role === 'assistant' && pairs.length === 0) {
        // Handle case where first message is from assistant
        pairs.push({ user: { id: 'system', role: 'user', content: '', timestamp: msg.timestamp }, assistant: msg })
      }
    }
    return pairs
  }, [messages])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main Chat Area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Artifacts Panel - Collapsible section below nav */}
        {showArtifacts && (
          <ArtifactsPanel artifacts={allArtifacts} />
        )}

        {/* Scrollable Chat Area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full" ref={scrollRef}>
            <div className="pb-4">
              <div className="mt-4 space-y-1 px-2.5">
                {collapseChats ? (
                  // Collapsed view - show pairs
                  messagePairs.map((pair, index) => (
                    <CollapsibleChatPair
                      key={pair.user.id || index}
                      pair={pair}
                      collapseArtifacts={collapseArtifactsInChat}
                      sweeps={sweeps}
                      runs={runs}
                      onEditSweep={onEditSweep}
                      onLaunchSweep={onLaunchSweep}
                      onRunClick={onRunClick}
                    />
                  ))
                ) : (
                  // Normal view
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={message.role === 'user'
                        ? 'sticky top-0 z-20 -mx-2.5 mb-1 border-b border-border/60 bg-background/95 px-2.5 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/85 overflow-hidden'
                        : undefined}
                    >
                      <ChatMessage 
                        message={message} 
                        collapseArtifacts={collapseArtifactsInChat}
                        sweeps={sweeps}
                        runs={runs}
                        onEditSweep={onEditSweep}
                        onLaunchSweep={onLaunchSweep}
                        onRunClick={onRunClick}
                      />
                    </div>
                  ))
                )}
              </div>

              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                    <span className="text-2xl">🔬</span>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground">
                    Research Assistant
                  </h3>
                  <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                    Ask me anything about your experiments, training runs, or ML
                    research. I can help analyze loss curves, debug issues, and
                    suggest improvements.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {[
                      'Analyze my latest run',
                      'Why did training fail?',
                      'Compare model configs',
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => onSendMessage(suggestion)}
                        className="rounded-full border border-border bg-secondary px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary/80 active:scale-95"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Chat Input - Fixed at bottom */}
        <div className="shrink-0">
          <ChatInput 
            onSend={onSendMessage} 
            mode={mode}
            onModeChange={onModeChange}
            runs={runs}
            artifacts={allArtifacts}
            charts={charts}
            messages={messages}
          />
        </div>
      </div>
    </div>
  )
}

// Collapsible chat pair component
function CollapsibleChatPair({
  pair,
  collapseArtifacts = false,
  sweeps = [],
  runs = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
}: {
  pair: { user: ChatMessageType; assistant?: ChatMessageType }
  collapseArtifacts?: boolean
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
}) {
  const [expanded, setExpanded] = useState(false)
  
  // Don't render if user message is empty (system placeholder)
  if (!pair.user.content) return null

  const preview = pair.user.content.slice(0, 60) + (pair.user.content.length > 60 ? '...' : '')
  
  const formatDateTime = (date: Date) => {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `${dateStr}, ${timeStr}`
  }

  return (
    <div className="border-b border-border/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 text-left hover:bg-secondary/50 transition-colors flex items-center gap-2"
      >
        <span className={`text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-sm text-muted-foreground truncate flex-1">{preview}</span>
        <span className="text-xs text-muted-foreground/60" suppressHydrationWarning>
          {formatDateTime(new Date(pair.user.timestamp))}
        </span>
      </button>
      {expanded && (
        <div className="pb-2">
          <ChatMessage
            message={pair.user}
            collapseArtifacts={collapseArtifacts}
            sweeps={sweeps}
            runs={runs}
            onEditSweep={onEditSweep}
            onLaunchSweep={onLaunchSweep}
            onRunClick={onRunClick}
          />
          {pair.assistant && (
            <ChatMessage
              message={pair.assistant}
              collapseArtifacts={collapseArtifacts}
              sweeps={sweeps}
              runs={runs}
              onEditSweep={onEditSweep}
              onLaunchSweep={onLaunchSweep}
              onRunClick={onRunClick}
            />
          )}
        </div>
      )}
    </div>
  )
}
